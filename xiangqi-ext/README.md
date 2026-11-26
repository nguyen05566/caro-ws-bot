# gamevh Xiangqi Bot — Extension (Pikafish WASM)

Bot cờ tướng tự chơi trên **gamevh.net/p/xiangqi** chạy dạng Chrome MV3 extension
(dùng được cho **Lemur Browser** trên Android), engine **Pikafish WASM + NNUE**.

## Kiến trúc

```
content.js  ──inject──▶  page.js (page world)
                            │  hook WebSocket, giao thức gamevh
                            │  tạo bàn 100xu, SET_READY, đọc START/MOVE
                            │  FEN ◀──────────────▶ blob Worker
                            │                       └─ pikafish.js/wasm/nnue (engine/)
```

- `rules.json` (declarativeNetRequest) đặt header `COOP: same-origin` + `COEP: credentialless`
  cho gamevh.net → trang **cross-origin isolated** → pthread của Pikafish chạy được
  trong blob worker ngay trong page (không cần server riêng).
- Engine không dùng offscreen document (extension page không được COI).

## Cài vào Lemur Browser

1. Chép `xiangqi-ext.crx` (kèm repo) vào máy, hoặc tự đóng gói:
   `chrome --headless=new --disable-dev-shm-usage --pack-extension=xiangqi-ext`
   (giữ `xiangqi-ext/xiangqi-ext.pem` để giữ nguyên extension ID giữa các lần update).
2. Lemur → Extensions → import file local (.crx) → bật extension.
3. Mở `https://gamevh.net/p/xiangqi`, đăng nhập, bấm nút **XQ** góc phải → **BẬT**.

Build lại engine (nếu đổi source):

```bash
source /tmp/opencode/emsdk/emsdk_env.sh        # Emscripten 3.1.74
cd /tmp/opencode/pika && bash build_st.sh      # pikafish.js/wasm (pthread + net pinned)
# net bắt buộc sha256 7d13d735…900e (bản pinned, xem /tmp/opencode/pika/dist)
cp dist/pikafish.js dist/pikafish.wasm dist/pikafish.nnue  ../../caro-ws-bot/xiangqi-ext/engine/
```

## Giao thức xiangqi gamevh.net (đã bẻ)

| Cmd | Frame | Ý nghĩa |
|-----|-------|---------|
| CREATE_RULE 405 | `0195 <bet_id u8> 02 …keys…` | bet_id 0 = **100 xu** (ladder nhỏ nhất) |
| SET_READY 434 | `01b2` | gửi sau 3s khi vào bàn / sau GAMEOVER |
| START 417 | count=2, mỗi player (sid i8 + pid i32), rồi **32 entry `[id,id,pos,side]`** | pos = y*9+x, y=0 trên (ĐEN), y=9 dưới (ĐỎ) |
| SET_TURN 420 | `01a4 <sid>` | sid = người **vừa đi** (không phải người đến lượt!) |
| PLAY 502 | `01f6 <from u8> <to u8>` | nước của ta |
| MOVE 529 | `0211 <from u8> <to u8> <flag u8>` | flag 0 = ĐỎ vừa đi, 1 = ĐEN |
| GAMEOVER 418 | như caro | kết thúc ván |

Mapping UCI ↔ bàn: file `a..i` = x 0..8, rank `r` → `y = 9 − r`, `pos = (9−rank)*9 + file`.

## Lưu ý

- Engine Pikafish GPL-3.0; net NNUE có license riêng (cấm dùng để gian lận online /
  thương mại) — dùng sai rủi ro tự chịu.
- Bot chỉ tự đi khi tới lượt (`MOVE` của đối thủ hoặc `SET_TURN` sid ≠ mình).
