#!/usr/bin/env bash
set -euo pipefail
# GAS 원본 저장소의 src 경로. 다른 위치에 뒀다면 GAS_SRC 로 덮어쓴다.
SRC="${GAS_SRC:-$(cd "$(dirname "$0")/.." && pwd)/../timetable-editor-gas/src}"
DST="$(cd "$(dirname "$0")/.." && pwd)/src/core"
mkdir -p "$DST"
for f in Core_Model Core_Validate Core_Recommend; do
  cp "$SRC/$f.js" "$DST/$f.js"
  echo "synced $f.js"
done
