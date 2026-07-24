#!/usr/bin/env bash
set -euo pipefail

BRANCH="${BRANCH:-codex/platform-architecture-foundation}"
WORKTREE="${WORKTREE:-/opt/analytics-worktree}"
LIVE_LINK="${LIVE_LINK:-/opt/analytics}"
RELEASES_DIR="${RELEASES_DIR:-/opt/analytics-releases}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4000/api/v1/health}"

SERVICES=(
  analytics.service
  analytics-sync-worker.service
  analytics-report-worker.service
  analytics-notification-worker.service
  analytics-export-worker.service
  analytics-bootstrap-worker.service
)

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require git
require rsync
require npm
require node
require curl
require systemctl

if [[ ! -d "$WORKTREE/.git" ]]; then
  echo "Deploy worktree not found: $WORKTREE" >&2
  exit 1
fi

mkdir -p "$RELEASES_DIR"

cd "$WORKTREE"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

COMMIT="$(git rev-parse --short HEAD)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE="$RELEASES_DIR/$COMMIT-$STAMP"

mkdir -p "$RELEASE"
rsync -a --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.env.bak-*' \
  --exclude='apps/api/.env.bak-*' \
  "$WORKTREE/" "$RELEASE/"

cp "$WORKTREE/.env" "$RELEASE/.env"
chmod 600 "$RELEASE/.env"
rm -f "$RELEASE/apps/api/.env"
ln -s ../../.env "$RELEASE/apps/api/.env"
printf '%s\n' "$COMMIT" > "$RELEASE/REVISION"

cd "$RELEASE"
npm ci
npm run db:deploy
npm run db:generate
npm run build

ln -sfn "$RELEASE" "$LIVE_LINK.next"
mv -Tf "$LIVE_LINK.next" "$LIVE_LINK"

systemctl restart "${SERVICES[@]}"
systemctl --no-pager --plain is-active "${SERVICES[@]}"

curl -fsS "$HEALTH_URL" | node -e '
const fs = require("fs");
const health = JSON.parse(fs.readFileSync(0, "utf8"));
const red = health.redConditions || {};
const activeRed = Object.entries(red).filter(([key, value]) => value && key !== "workerRestarted");
if (activeRed.length > 0) {
  console.error(JSON.stringify({ status: health.status, activeRed }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  status: health.status,
  syncLagSeconds: health.amo?.syncLagSeconds,
  reportLagSeconds: health.reports?.reportLagSeconds,
  queuedReports: health.reports?.queue?.queued,
  apiP95Ms: health.api?.p95Ms,
  workerRestartedRecently: Boolean(red.workerRestarted)
}, null, 2));
'

find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' |
  sort -rn |
  awk "NR>${KEEP_RELEASES} {print \$2}" |
  xargs -r rm -rf

echo "Deployed $COMMIT to $RELEASE"
