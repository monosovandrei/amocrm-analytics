#!/usr/bin/env bash
set -euo pipefail

BRANCH="${BRANCH:-main}"
WORKTREE="${WORKTREE:-/opt/analytics-worktree}"
LIVE_LINK="${LIVE_LINK:-/opt/analytics}"
RELEASES_DIR="${RELEASES_DIR:-/opt/analytics-releases}"
BACKUPS_DIR="${BACKUPS_DIR:-/opt/analytics-backups}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
READY_URL="${READY_URL:-http://127.0.0.1:4000/api/v1/health/ready}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4000/api/v1/health}"
METRIC_VERSION_VALUE="${METRIC_VERSION:-2026-08-31.1}"

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

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

for command_name in git rsync npm node curl systemctl install pg_dump; do
  require "$command_name"
done

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
rm -f "$RELEASE/apps/api/.env"
ln -s ../../.env "$RELEASE/apps/api/.env"
printf '%s\n' "$COMMIT" > "$RELEASE/REVISION"

cd "$RELEASE"
npm ci
npm run db:generate
npm run typecheck
npm test
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
pg_dump "$DATABASE_URL_VALUE" --format=custom --file="$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"

npm run db:deploy

for unit in "$RELEASE"/deploy/systemd/*.service; do
  install -m 0644 "$unit" "/etc/systemd/system/$(basename "$unit")"
done
for sysctl_config in "$RELEASE"/deploy/sysctl/*.conf; do
  install -m 0644 "$sysctl_config" "/etc/sysctl.d/$(basename "$sysctl_config")"
done
sysctl -p /etc/sysctl.d/99-amocrm-tcp-mtu.conf >/dev/null
systemctl daemon-reload
systemctl enable "${SERVICES[@]}" >/dev/null

ln -sfn "$RELEASE" "$LIVE_LINK.next"
mv -Tf "$LIVE_LINK.next" "$LIVE_LINK"

restore_previous_release() {
  if [[ -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" ]]; then
    ln -sfn "$PREVIOUS_RELEASE" "$LIVE_LINK.next" || {
      echo "Could not prepare previous release link; rollback stopped before service restart" >&2
      return 1
    }
    mv -Tf "$LIVE_LINK.next" "$LIVE_LINK" || {
      echo "Could not select previous release; rollback stopped before service restart" >&2
      return 1
    }
    systemctl restart "${SERVICES[@]}" || {
      echo "Previous release selected, but a service restart failed; inspect systemctl status" >&2
      return 1
    }
    echo "Application restored to $PREVIOUS_RELEASE. Additive database migrations remain installed." >&2
  else
    echo "No previous application release is available for rollback" >&2
    return 1
  fi
}

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
