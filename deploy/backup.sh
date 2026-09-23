#!/usr/bin/env bash
# Ежедневная согласованная копия базы SQLite (VACUUM INTO), хранятся последние 7. Ставится в crontab пользователя:
#   0 4 * * * /srv/stavka/current/deploy/backup.sh >> /srv/stavka/data/backup.log 2>&1
set -euo pipefail
DATA="${DATA_DIR:-/srv/stavka/data}"
DEST="$DATA/backups"; mkdir -p "$DEST"
OUT="$DEST/stavka-$(date +%Y%m%d-%H%M%S).db"
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});d.exec(\"VACUUM INTO '\"+process.argv[2]+\"'\");d.close();console.log('backup ok', process.argv[2])" "$DATA/stavka.db" "$OUT"
ls -1t "$DEST"/stavka-*.db | tail -n +8 | xargs -r rm -f
