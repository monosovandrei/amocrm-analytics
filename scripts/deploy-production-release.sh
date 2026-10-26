#!/usr/bin/env bash
set -euo pipefail
# Build artifacts and dependencies must remain readable by the service and nginx,
# even when the operator protects the deployment log with a private umask.
umask 022

BRANCH="${BRANCH:-main}"
WORKTREE="${WORKTREE:-/opt/analytics-worktree}"
LIVE_LINK="${LIVE_LINK:-/opt/analytics}"
RELEASES_DIR="${RELEASES_DIR:-/opt/analytics-releases}"
BACKUPS_DIR="${BACKUPS_DIR:-/opt/analytics-backups}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
READY_URL="${READY_URL:-http://127.0.0.1:4000/api/v1/health/ready}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4000/api/v1/health}"
METRIC_VERSION_VALUE="${METRIC_VERSION:-2026-10-23.1}"

SERVICES=(
  analytics-tcp-mtu.service
  analytics.service
  analytics-sync-worker.service
  analytics-report-worker.service
  analytics-notification-worker.service
  analytics-export-worker.service
  analytics-bootstrap-worker.service
)

REQUIRED_WORKERS=(sync report notification export bootstrap)
RETIRED_SERVICES=(analytics-crm-control-worker.service)

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

for command_name in git rsync npm node curl systemctl systemd-run install; do
  require "$command_name"
done
if ! command -v pg_dump >/dev/null 2>&1; then require docker; fi

if [[ ! -d "$WORKTREE/.git" ]]; then
  echo "Deploy worktree not found: $WORKTREE" >&2
  exit 1
fi

mkdir -p "$RELEASES_DIR" "$BACKUPS_DIR"

cd "$WORKTREE"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

COMMIT="$(git rev-parse --short=12 HEAD)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE="$RELEASES_DIR/$COMMIT-$STAMP"
PREVIOUS_RELEASE="$(readlink -f "$LIVE_LINK" 2>/dev/null || true)"

mkdir -p "$RELEASE"
rsync -a --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.env.bak-*' \
  --exclude='apps/api/.env.bak-*' \
  "$WORKTREE/" "$RELEASE/"

cp "$WORKTREE/.env" "$RELEASE/.env"
chmod 600 "$RELEASE/.env"
sed -i '/^BUILD_ID=/d; /^REVISION=/d; /^METRIC_VERSION=/d' "$RELEASE/.env"
printf '\nBUILD_ID="%s"\nREVISION="%s"\nMETRIC_VERSION="%s"\n' "$COMMIT" "$COMMIT" "$METRIC_VERSION_VALUE" >> "$RELEASE/.env"
# sed replaces the inode when run by root; preserve the runtime user's access.
chown --reference="$WORKTREE/.env" "$RELEASE/.env"
chmod 600 "$RELEASE/.env"
rm -f "$RELEASE/apps/api/.env"
ln -s ../../.env "$RELEASE/apps/api/.env"
printf '%s\n' "$COMMIT" > "$RELEASE/REVISION"

cd "$RELEASE"
npm ci
npm run db:generate
npm run typecheck
systemd-run --scope --quiet --unit="analytics-test-$COMMIT-$STAMP" \
  -p MemoryHigh=1400M -p MemoryMax=1800M -p MemorySwapMax=0 -p CPUWeight=20 \
  node --max-old-space-size=256 scripts/run-api-tests-bounded.cjs
npm run frontend:gate
npm run build

DATABASE_URL_VALUE="$(node -e '
const fs = require("fs");
const line = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/).find((item) => item.startsWith("DATABASE_URL="));
if (!line) process.exit(2);
let value = line.slice("DATABASE_URL=".length).trim();
if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("\x27") && value.endsWith("\x27"))) value = value.slice(1, -1);
const databaseUrl = new URL(value);
databaseUrl.searchParams.delete("schema");
process.stdout.write(databaseUrl.toString());
' "$RELEASE/.env")"
BACKUP_FILE="$BACKUPS_DIR/pre-$COMMIT-$STAMP.dump"
install -m 0600 /dev/null "$BACKUP_FILE"
if command -v pg_dump >/dev/null 2>&1; then
  pg_dump "$DATABASE_URL_VALUE" --format=custom --file="$BACKUP_FILE"
else
  # Local production database is containerized; never copy its credentials to stdout.
  docker exec analytics-postgres pg_dump -U amocrm -d amocrm_analytics --format=custom > "$BACKUP_FILE"
fi
chmod 600 "$BACKUP_FILE"

restore_previous_release() {
  if [[ -z "$PREVIOUS_RELEASE" || ! -d "$PREVIOUS_RELEASE" ]]; then
    echo "No previous application release is available for rollback" >&2; return 1
  fi
  # A previous binary cannot enforce new manager boundaries. Do not restart it
  # unless all non-administrative accounts have been safely suspended first.
  if ! node "$RELEASE/scripts/workspace-safe-rollback.cjs" --apply; then
    echo "Rollback blocked: department access could not be safely suspended. Services remain stopped." >&2
    systemctl stop "${SERVICES[@]}" || true
    return 1
  fi
  ln -sfn "$PREVIOUS_RELEASE" "$LIVE_LINK.next" || return 1
  mv -Tf "$LIVE_LINK.next" "$LIVE_LINK" || return 1
  systemctl enable "${RETIRED_SERVICES[@]}" >/dev/null || return 1
  systemctl restart "${SERVICES[@]}" "${RETIRED_SERVICES[@]}" || return 1
  echo "Previous application restored. Non-admin access suspended; new plans and links preserved." >&2
}

# No old process may serve users while their new permissions are being assigned.
systemctl stop "${SERVICES[@]}" "${RETIRED_SERVICES[@]}"
trap 'trap - ERR; restore_previous_release || true' ERR
if ! npm run db:deploy || ! systemd-run --scope --quiet --unit="analytics-workspace-prepare-$COMMIT-$STAMP" \
  -p MemoryHigh=1152M -p MemoryMax=1280M -p MemorySwapMax=0 -p CPUWeight=20 \
  node --expose-gc --max-old-space-size=512 "$RELEASE/scripts/prepare-workspace-release.cjs" --apply || \
  ! systemd-run --scope --quiet --unit="analytics-performance-prepare-$COMMIT-$STAMP" \
  -p MemoryHigh=1152M -p MemoryMax=1280M -p MemorySwapMax=0 -p CPUWeight=20 \
  node --expose-gc --max-old-space-size=512 "$RELEASE/scripts/prepare-performance-release.cjs" --apply-owner-approved-rollout; then
  restore_previous_release || true
  exit 1
fi

for unit in "$RELEASE"/deploy/systemd/*.service; do
  install -m 0644 "$unit" "/etc/systemd/system/$(basename "$unit")"
done
for sysctl_config in "$RELEASE"/deploy/sysctl/*.conf; do
  install -m 0644 "$sysctl_config" "/etc/sysctl.d/$(basename "$sysctl_config")"
done
sysctl -p /etc/sysctl.d/99-amocrm-tcp-mtu.conf >/dev/null
systemctl daemon-reload
systemctl enable "${SERVICES[@]}" >/dev/null
systemctl disable "${RETIRED_SERVICES[@]}" >/dev/null

ln -sfn "$RELEASE" "$LIVE_LINK.next"
mv -Tf "$LIVE_LINK.next" "$LIVE_LINK"

if ! systemctl restart "${SERVICES[@]}" || ! systemctl --no-pager --plain is-active "${SERVICES[@]}"; then
  echo "Release service startup failed; restoring previous application release" >&2
  restore_previous_release || true
  exit 1
fi

READY_BODY="$(mktemp)"
HEALTH_BODY="$(mktemp)"
HEALTH_SUMMARY="$(mktemp)"
DEPLOY_OK=0

cleanup_temp() {
  rm -f "$READY_BODY" "$HEALTH_BODY" "$HEALTH_SUMMARY"
}
trap cleanup_temp EXIT

for _ in $(seq 1 90); do
  if curl -fsS "$READY_URL" > "$READY_BODY" 2>/dev/null && curl -fsS "$HEALTH_URL" > "$HEALTH_BODY" 2>/dev/null; then
    if node -e '
const fs = require("fs");
const health = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const expectedBuild = process.argv[2];
const requiredRoles = process.argv.slice(3);
const workers = health.workers?.items ?? [];
const now = Date.now();
const missing = requiredRoles.filter((role) => !workers.some((worker) =>
  worker.role === role && worker.buildId === expectedBuild && now - new Date(worker.heartbeatAt).getTime() <= 60000
));
if (health.buildId !== expectedBuild || missing.length > 0) {
  console.error(JSON.stringify({ apiBuild: health.buildId, expectedBuild, missing }));
  process.exit(1);
}
console.log(JSON.stringify({
  status: health.status,
  buildId: health.buildId,
  metricVersion: health.metricVersion,
  workers: requiredRoles,
  syncLagSeconds: health.amo?.syncLagSeconds,
  reportLagSeconds: health.reports?.reportLagSeconds
}, null, 2));
' "$HEALTH_BODY" "$COMMIT" "${REQUIRED_WORKERS[@]}" > "$HEALTH_SUMMARY" 2>/dev/null; then
      DEPLOY_OK=1
      break
    fi
  fi
  sleep 2
done

if [[ "$DEPLOY_OK" != "1" ]]; then
  echo "Release health check failed; restoring previous application release" >&2
  restore_previous_release || true
  cat "$READY_BODY" >&2 || true
  exit 1
fi

cat "$HEALTH_SUMMARY"

# A healthy process is not enough: publish current definitions, warm the usual
# periods, then compare sections on one read-only database snapshot.
run_report_verification() {
  local check_name="$1"
  shift
  systemd-run --scope --quiet --unit="analytics-verify-$check_name-$COMMIT-$STAMP" \
    -p MemoryHigh=1152M -p MemoryMax=1280M -p MemorySwapMax=0 -p CPUWeight=20 \
    node --expose-gc --max-old-space-size=512 "$@"
}
SOURCE_AUDIT_TO="$(node -e 'process.stdout.write(new Date(Date.now() - 120000).toISOString())')"
if ! run_report_verification prepare "$RELEASE/scripts/prepare-release-reports.cjs" --workspaces || \
   ! run_report_verification consistency "$RELEASE/scripts/verify-workspace-consistency.cjs" || \
   ! (umask 077; run_report_verification performance "$RELEASE/scripts/verify-performance-workspaces.cjs" \
     > "$BACKUPS_DIR/performance-$COMMIT-$STAMP.json") || \
   ! (umask 077; run_report_verification performance-http "$RELEASE/scripts/verify-performance-http.cjs" \
     > "$BACKUPS_DIR/performance-http-$COMMIT-$STAMP.json") || \
   ! (umask 077; run_report_verification source "$RELEASE/scripts/audit-amo-report-funnels.cjs" --live --verify "--to=$SOURCE_AUDIT_TO" \
     > "$BACKUPS_DIR/source-audit-$COMMIT-$STAMP.json"); then
  echo "Release report consistency gate failed; restoring previous application release" >&2
  if restore_previous_release; then
    # Templates are shared database rows, so restore their previous definitions too.
    if ! node "$RELEASE/scripts/prepare-release-reports.cjs" --templates-only "--release-root=$PREVIOUS_RELEASE"; then
      echo "Previous code restored, but built-in report templates could not be restored; manual check required" >&2
    fi
  fi
  exit 1
fi
echo "Source amoCRM audit passed: $BACKUPS_DIR/source-audit-$COMMIT-$STAMP.json"

RELEASES_ROOT="$(readlink -f "$RELEASES_DIR")"
CURRENT_RELEASE="$(readlink -f "$LIVE_LINK")"
DEPLOYED_RELEASE="$(readlink -f "$RELEASE")"

mapfile -t OLD_RELEASES < <(
  find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' |
    sort -rn |
    awk "NR>${KEEP_RELEASES} {sub(/^[^ ]+ /, \"\"); print}"
)
for old_release in "${OLD_RELEASES[@]}"; do
  resolved_release="$(readlink -f "$old_release")" || {
    echo "Refusing to remove unresolved release path: $old_release" >&2
    continue
  }
  if [[ "$resolved_release" == "$DEPLOYED_RELEASE" || "$resolved_release" == "$CURRENT_RELEASE" || "$resolved_release" == "$PREVIOUS_RELEASE" ]]; then
    continue
  fi
  case "$resolved_release" in
    "$RELEASES_ROOT"/*)
      if [[ "$(dirname -- "$resolved_release")" == "$RELEASES_ROOT" ]]; then
        rm -rf -- "$resolved_release"
      else
        echo "Refusing to remove nested release path: $old_release" >&2
      fi
      ;;
    *) echo "Refusing to remove unexpected release path: $old_release" >&2 ;;
  esac
done

echo "Deployed $COMMIT to $RELEASE"
echo "Database backup: $BACKUP_FILE"
trap - ERR
