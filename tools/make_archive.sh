#!/usr/bin/env bash
# Архив зафиксированной версии для загрузки в ЛК (≤ 18 МБ): git archive HEAD + презентация PDF + контрольная сумма.
# Использование: tools/make_archive.sh [путь к PDF презентации]; по умолчанию out/kadrovy-radar-presentation.pdf, если он есть.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
HASH="$(git rev-parse --short HEAD)"
PDF="${1:-out/kadrovy-radar-presentation.pdf}"
mkdir -p out
OUT="out/kadrovy-radar-$HASH.zip"
rm -f "$OUT" "$OUT.sha256"
git archive --format=zip --prefix="kadrovy-radar-$HASH/" -o "$OUT" HEAD
if [ -f "$PDF" ]; then
  cp "$PDF" "out/kadrovy-radar-presentation-$HASH.pdf"
  (cd out && zip -q "$(basename "$OUT")" "kadrovy-radar-presentation-$HASH.pdf")
  rm -f "out/kadrovy-radar-presentation-$HASH.pdf"
else
  echo "предупреждение: презентация $PDF не найдена — архив без неё" >&2
fi
shasum -a 256 "$OUT" | tee "$OUT.sha256"
SIZE=$(stat -f %z "$OUT" 2>/dev/null || stat -c %s "$OUT")
echo "архив: $OUT — $((SIZE / 1024 / 1024)) МБ (лимит ЛК 18 МБ)"
[ "$SIZE" -le $((18 * 1024 * 1024)) ] || { echo "ОШИБКА: архив больше 18 МБ" >&2; exit 1; }
