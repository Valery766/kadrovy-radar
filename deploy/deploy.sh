#!/usr/bin/env bash
# Деплой «Ставки» на сервер без Docker: сборка локально → rsync в /srv/stavka/releases/<время> →
# npm ci --omit=dev на сервере → переключение ссылки current → перезапуск службы → проверка /api/health.
# Откат: ln -sfn /srv/stavka/releases/<прежний> /srv/stavka/current && sudo systemctl restart stavka
# Использование: deploy/deploy.sh [ssh-host]   (по умолчанию host «uni» из ~/.ssh/config)
set -euo pipefail
HOST="${1:-uni}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
REL="/srv/stavka/releases/$STAMP"
PORT="${STAVKA_PORT:-8081}"

cd "$ROOT"
echo "→ сборка"
npm run build -w webapp >/dev/null
npm run build -w server >/dev/null
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"

echo "→ копирование на $HOST:$REL (commit $COMMIT)"
ssh "$HOST" "mkdir -p $REL /srv/stavka/data"
rsync -azR --delete \
  package.json package-lock.json packs \
  server/package.json server/dist server/assets server/certs \
  webapp/package.json webapp/dist \
  "$HOST:$REL/"
ssh "$HOST" "cd $REL && echo $COMMIT > COMMIT && npm ci --omit=dev --no-audit --no-fund --loglevel=error"

echo "→ переключение current и перезапуск"
ssh "$HOST" "ln -sfn $REL /srv/stavka/current.tmp && mv -Tf /srv/stavka/current.tmp /srv/stavka/current && sudo -n systemctl restart stavka"
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  if ssh "$HOST" "curl -fsS http://127.0.0.1:$PORT/api/health" 2>/dev/null; then echo; echo "✔ задеплоено: $REL"; ssh "$HOST" "ls -1dt /srv/stavka/releases/* | tail -n +4 | xargs -r rm -rf"; exit 0; fi
done
echo "✖ служба не отвечает; журнал:"; ssh "$HOST" "sudo -n journalctl -u stavka -n 40 --no-pager"; exit 1
