# Caro WS Bot (gamevh / vh9.me)

Pure WebSocket bot cho game Cờ Caro trên Facebook Gaming (gomoku-vh / gamevh).
Không cần browser sau khi capture token — 100% WebSocket.

## Tính năng

- **Tạo bàn 4,000 xu** tự động (`LIST_BET_AMT` → resolve bet_id → `CREATE_RULE`)
- **Chơi thật** bằng **Embryo engine** (`BEGIN`/`TURN` mode, ~2s/nước)
  - Dự phòng: AI heuristic built-in nếu engine thiếu/lỗi/desync
- **Rematch tại chỗ**: GAMEOVER → ở lại bàn, `SET_READY` mời ván tiếp — **không tạo bàn mới**
- **KHÔNG claim reward** (VIDEO_REWARD đã bỏ)
- **KHÔNG surrender** — chơi đến GAMEOVER
- Chỉ rời bàn khi: bị kick / đối thủ bỏ đi / hết runtime / đủ `--max-games`
- Tự **reconnect + rejoin** bàn cũ giữa ván khi mất kết nối
- Tự **capture token** từ cookie Facebook nếu token chưa có (Playwright headless)

## Cài đặt

```bash
pip install websockets playwright
python3 -m playwright install chromium
```

Engine (tuỳ chọn nhưng nên có): `embryo-engine/pbrain-embryo` (aarch64) hoặc
`embryo-engine/pbrain-embryo.x86_64` (static, cho GitHub Actions runner x86_64).
Bot tự chọn binary theo kiến trúc máy (`pbrain-embryo.<uname -m>` ưu tiên trước).
Không có engine → bot tự dùng AI heuristic.

## Sử dụng

```bash
# 1. Đặt cookie Facebook vào ck2.txt (định dạng: name=value; name=value; ...)
# 2. Chạy bot (tự capture token lần đầu)
python3 ws_bot_ck2.py

# Tuỳ chọn
python3 ws_bot_ck2.py \
  --cookie-file ck2.txt \
  --token-file state/tokens/ck2_token.json \
  --bet-xu 4000 \
  --runtime 21600 \
  --max-games 0        # 0 = không giới hạn số ván
```

## Flow

```
cookie → capture_token.py (Playwright) → ws_url + login frames (hex)
       → WS connect → LOGIN replay → ENTER_PLACE Lobby.caro.0
       → LIST_BET_AMT → CREATE_RULE (4000xu) → GET_TABLE_DATA_EX (slot/balance)
       → SET_READY → START_MATCH → PLAY mỗi lượt (Embryo engine)
       → GAMEOVER → STAY → SET_READY → ván tiếp...
```

## Giao thức (tóm tắt)

| Cmd | ID | Ý nghĩa |
|-----|----|---------|
| LOGIN | 302 | replay frames từ capture |
| ENTER_PLACE | 401 | vào lobby/bàn |
| LIST_BET_AMT | 413 | bảng mức cược (4,000 → id 7) |
| CREATE_RULE | 405 | tạo bàn |
| SET_READY | 434 | sẵn sàng |
| START_MATCH | 417 | bắt đầu ván (board RLE 15x19) |
| SET_TURN | 420 | lượt của ai (sid, sid=-2: pre-game countdown) |
| PLAY | 502 | gửi nước (pos = y*15 + x) |
| MOVE | 529 | nước mới (pos, symbol) |
| GAMEOVER | 418 | kết quả (1/11 thắng, 2/4/12 thua) |
| BALANCE_CHANGED | 431 | [i8 flag][i64 balance]... (flag ∈ {-1,0} = của mình) |

## Engine alpha-beta WASM (userscript gamevh.net)

`gamvh.user.js` v1.4 nhúng sẵn engine gomoku alpha-beta (`engine/gomoku.c`, 28KB WASM)
→ chạy offline trên Tampermonkey điện thoại; heuristic JS chỉ là fallback.

```bash
pip install ziglang
cd engine && PY=python3 ./build.sh   # tạo gomoku.wasm + nhúng base64 vào userscript
node test.js                          # test chiến thuật (chặn 4, chốt 4, ô trống)
```

## Lưu ý

- Token hết hạn → xoá `state/tokens/*_token.json`, bot tự capture lại từ cookie.
- Cookie/token là dữ liệu nhạy cảm — đã `.gitignore`, đừng commit.
- Chỉ dùng cho mục đích học tập/nghiên cứu giao thức.
