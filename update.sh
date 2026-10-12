#!/usr/bin/env bash
# Review Agent — production шинэчлэл.
#   ./update.sh            шинэ код татаж, шалгаад, сервисийг дахин асаана (ажиллаж буй review байвал зогсоно)
#   ./update.sh --force    ажиллаж буй review-г тасалж шинэчилнэ
#   ./update.sh --rollback өмнөх хувилбар руу буцна
# Өгөгдөл (jobs/, logs/, archive/, web/users.json, сертификат…) git-д байхгүй тул шинэчлэлд хөндөгдөхгүй.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE="${SERVICE:-review-agent}"
BRANCH="${BRANCH:-main}"
PORT="${PORT:-8443}"
cd "$APP_DIR"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
restart() { systemctl --user restart "$SERVICE"; }
healthy() {
  for _ in $(seq 1 15); do
    curl -fsk -o /dev/null "https://127.0.0.1:${PORT}/" && return 0
    sleep 1
  done
  return 1
}

if [ "${1:-}" = "--rollback" ]; then
  prev="$(cat .deploy-prev 2>/dev/null || true)"
  [ -n "$prev" ] || { log "Буцах хувилбар олдсонгүй"; exit 1; }
  log "Буцаж байна → $prev"
  git reset --hard "$prev"
  restart
  healthy && log "OK ($(git rev-parse --short HEAD))" || { log "Сервис эхэлсэнгүй: journalctl --user -u $SERVICE -n 50"; exit 1; }
  exit 0
fi

# Ажиллаж буй / дараалалд байгаа review байвал дахин асаахад тасарна
busy="$(grep -lE '"status": *"(running|extracting)"' jobs/*/state.json 2>/dev/null || true)"
if [ -n "$busy" ] && [ "${1:-}" != "--force" ]; then
  log "Review ажиллаж байна — дуусахыг хүлээгээд дахин ажиллуулна уу (эсвэл --force):"
  echo "$busy" | sed 's#/state.json##'
  exit 2
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "Сервер дээр кодыг гараар өөрчилсөн байна — шинэчлэхгүй. 'git status' харна уу."
  exit 1
fi

before="$(git rev-parse HEAD)"
git fetch --quiet origin "$BRANCH"
after="$(git rev-parse "origin/$BRANCH")"
if [ "$before" = "$after" ]; then
  log "Шинэчлэл алга ($(git rev-parse --short HEAD))"
  exit 0
fi

log "Шинэ өөрчлөлт:"
git --no-pager log --oneline "$before..$after"
git merge --quiet --ff-only "origin/$BRANCH"

# Синтакс шалгалт — алдаатай бол буцаана
for f in server/*.js; do
  if ! node --check "$f"; then
    log "Синтакс алдаа: $f — буцааж байна"
    git reset --hard --quiet "$before"
    exit 1
  fi
done

echo "$before" > .deploy-prev
restart
if healthy; then
  log "Амжилттай: $(git rev-parse --short "$before") → $(git rev-parse --short HEAD)"
else
  log "Сервис хариу өгөхгүй байна — өмнөх хувилбар руу буцааж байна"
  git reset --hard --quiet "$before"
  restart
  healthy && log "Өмнөх хувилбар сэргэлээ" || log "Анхаар: сервис эхлэхгүй байна — journalctl --user -u $SERVICE -n 50"
  exit 1
fi
