#!/usr/bin/env bash
# Деплой «Ставки» на сервер без Docker: сборка локально, rsync в /srv/stavka/releases/<время>,
# переключение ссылки current, перезапуск службы, проверка здоровья. Откат — переключить ссылку назад.
# Использование: deploy/deploy.sh [ssh-host]   (по умолчанию host «uni» из ~/.ssh/config)
set -euo pipefail
HOST="${1:-uni}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
REL="/srv/stavka/releases/$STAMP"

cd "$ROOT"
echo "→ сборка"
npm run build -w webapp >/dev/null
npm run build -w server >/dev/null
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"

echo "→ копирование на $HOST:$REL (commit $COMMIT)"
ssh "$HOST" "mkdir -p $REL /srv/stavka/data"
rsync -az --delete \
  --exclude node_modules --exclude '.git' --exclude 'data' --exclude '.env' --exclude '.env.*' --exclude 'webapp/node_modules' --exclude 'server/node_modules' \
  package.json package-lock.json packs server webapp/dist "$HOST:$REL/"
ssh "$HOST" "cd $REL && mkdir -p webapp && [ -d webapp/dist ] || mv dist webapp/dist 2>/dev/null || true; cd $REL && npm ci --omit=dev --no-audit --no-fund -w server --include-workspace-root >/dev/null 2>&1 || npm ci --omit=dev --no-audit --no-fund >/dev/null; echo $COMMIT > COMMIT"

echo "→ переключение current и перезапуск"
ssh "$HOST" "ln -sfn $REL /srv/stavka/current.tmp && mv -Tf /srv/stavka/current.tmp /srv/stavka/current && sudo -n systemctl restart stavka 2>/dev/null || sudo systemctl restart stavka"
sleep 4
ssh "$HOST" "curl -fsS http://127.0.0.1:8081/api/health" && echo && echo "✔ задеплоено: $REL"
ssh "$HOST" "ls -1dt /srv/stavka/releases/* | tail -n +4 | xargs -r rm -rf"
