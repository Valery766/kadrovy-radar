#!/usr/bin/env bash
# Архив зафиксированной версии для загрузки в ЛК (≤ 18 МБ): git archive HEAD + контрольная сумма.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
HASH="$(git rev-parse --short HEAD)"
mkdir -p out
OUT="out/stavka-$HASH.zip"
git archive --format=zip --prefix="stavka-$HASH/" -o "$OUT" HEAD
shasum -a 256 "$OUT" | tee "$OUT.sha256"
ls -la "$OUT"
