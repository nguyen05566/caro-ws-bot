#!/usr/bin/env python3
"""Nhúng gomoku.wasm (base64) vào gamvh.user.js giữa 2 marker."""
import base64
from pathlib import Path

root = Path(__file__).resolve().parent.parent
wasm = (root / "engine" / "gomoku.wasm").read_bytes()
userscript = root / "gamvh.user.js"
src = userscript.read_text()

start = "const AI_WASM_B64 = /* AI_WASM_START */"
end = "/* AI_WASM_END */;"
i = src.find(start)
j = src.find(end)
if i < 0 or j < 0:
    raise SystemExit("marker AI_WASM not found in gamvh.user.js")

b64 = base64.b64encode(wasm).decode("ascii")
out = src[:i] + start + " '" + b64 + "' " + src[j:]
userscript.write_text(out)
print(f"embedded {len(wasm)} bytes -> {len(b64)} base64 chars (userscript {len(out)} bytes)")
