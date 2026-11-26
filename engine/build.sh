#!/bin/sh
# Build WASM engine: pip install ziglang && PY=python3 ./build.sh
set -e
cd "$(dirname "$0")"
PY=${PY:-python3}
"$PY" -m ziglang cc -target wasm32-freestanding -O3 -nostdlib \
  -Wl,--no-entry \
  -Wl,--export=board_ptr -Wl,--export=init -Wl,--export=best -Wl,--export=is_win \
  -Wl,--export-memory \
  -o gomoku.wasm gomoku.c
"$PY" embed.py
