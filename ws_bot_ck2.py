#!/usr/bin/env python3
"""
ws_bot_ck2.py — Pure WebSocket bot (NO browser after token capture).
Cờ Caro — TẠO BÀN 4,000 XU + CHƠI THẬT (bỏ qua claim reward, KHÔNG surrender).

Flow:
  1. Load token từ state/tokens/ck2_token.json (ws_url + frames).
     Nếu chưa có token, tự động chạy capture_token.py từ ck2.txt (cookie)
     để sinh token trước khi chạy bot.
  2. WS connect → LOGIN (replay frames) → ENTER_PLACE Lobby.caro.0.
  3. LIST_BET_AMT → resolve mức cược 4,000 xu → CREATE_RULE (tạo bàn 4000xu).
  4. SET_READY → chờ START_MATCH → CHƠI bằng EMBRYO ENGINE (TURN/BEGIN mode).
  5. GAMEOVER → KHÔNG tạo bàn mới — Ở LẠI BÀN, SET_READY mời ván tiếp theo.
  6. Chỉ rời bàn khi: bị kick, đối thủ bỏ đi, hoặc hết runtime.

KHÔNG claim VIDEO_REWARD. KHÔNG gửi SURRENDER — bot chơi đến GAMEOVER.
Engine: embryo-engine/pbrain-embryo (dự phòng: AI heuristic built-in).

Usage:
  python3 ws_bot_ck2.py --cookie-file ck2.txt --token-file state/tokens/ck2_token.json
  python3 ws_bot_ck2.py --bet-xu 4000 --runtime 21600
  (nếu token chưa có, bot sẽ tự chạy capture_token.py để sinh từ cookie)
"""
import argparse
import asyncio
import json
import os
import re
import selectors
import struct
import subprocess
import sys
import threading
import time
import random
from pathlib import Path

import websockets

# ======================== BINARY PROTOCOL ========================
CMD_MAP = {
    300: "PONG", 301: "PING", 302: "LOGIN", 303: "ALERT",
    304: "RIBBON_MESSAGE", 311: "BROADCAST", 312: "INVITE", 314: "SET_CLIENT_MODE",
    315: "CONFIG", 316: "REQUEST_FREE_CHIP", 317: "TRANSFER",
    401: "ENTER_PLACE", 402: "ENTER_CHILD_PLACE", 405: "CREATE_RULE", 406: "PLAYER_ENTERED",
    407: "PLAYER_EXITED", 410: "KICK_PLAYER",
    413: "LIST_BET_AMT", 417: "START_MATCH", 418: "GAMEOVER", 419: "ENTER_STATE",
    420: "SET_TURN", 421: "SET_PLAYER_STATUS", 422: "SET_PLAYER_POINT", 423: "SET_PLAYER_ATTR",
    431: "BALANCE_CHANGED", 432: "OWNER_CHANGED", 433: "GET_TABLE_DATA_EX",
    434: "SET_READY", 501: "BET", 502: "PLAY", 505: "CHAT", 518: "HIGHLIGHT",
    529: "MOVE", 533: "ASK_DRAW", 534: "SURRENDER", 535: "RETREAT",
}

class BW:
    def __init__(self): self.p = []
    def u8(self, v): self.p.append(struct.pack('>B', v & 0xFF))
    def i8(self, v): self.p.append(struct.pack('>b', v))
    def i16(self, v): self.p.append(struct.pack('>h', v))
    def i32(self, v): self.p.append(struct.pack('>i', v))
    def i64(self, v): self.p.append(struct.pack('>q', v))
    def wa(self, s): e = s.encode('ascii','replace'); self.u8(len(e)); self.p.append(e)
    def wu(self, s): e = s.encode('utf-16-be'); self.i16(len(e)//2); self.p.append(e)
    def wc(self, n):
        cid = next((k for k,v in CMD_MAP.items() if v == n), None)
        if cid: self.p.append(struct.pack('>H', cid))
        else:
            b = n.encode('ascii'); self.i8(-len(b)); self.p.append(b)
        return self
    def build(self): return b''.join(self.p)

class BR:
    def __init__(self, d): self.d = d; self.pos = 0
    def rem(self): return len(self.d) - self.pos
    def u8(self): v = self.d[self.pos]; self.pos += 1; return v
    def i8(self): v = struct.unpack_from('>b', self.d, self.pos)[0]; self.pos += 1; return v
    def i16(self): v = struct.unpack_from('>h', self.d, self.pos)[0]; self.pos += 2; return v
    def u16(self): v = struct.unpack_from('>H', self.d, self.pos)[0]; self.pos += 2; return v
    def i32(self): v = struct.unpack_from('>i', self.d, self.pos)[0]; self.pos += 4; return v
    def i64(self):
        hi = struct.unpack_from('>i', self.d, self.pos)[0]
        lo = struct.unpack_from('>I', self.d, self.pos+4)[0]
        self.pos += 8; return (hi << 32) | lo
    def ra(self): n = self.u8(); s = self.d[self.pos:self.pos+n].decode('ascii','replace'); self.pos += n; return s
    def ru(self):
        n = self.i16()
        if n <= 0: return ""
        s = self.d[self.pos:self.pos+n*2].decode('utf-16-be','replace'); self.pos += n*2; return s
    def rb(self):
        n = self.i16()
        if n <= 0: return []
        if self.pos + n > len(self.d): n = len(self.d) - self.pos
        data = list(self.d[self.pos:self.pos+n]); self.pos += n; return data
    def rc(self):
        f = self.i8()
        if f < 0: n = -f; s = self.d[self.pos:self.pos+n].decode('ascii','replace'); self.pos += n; return s
        s = self.u8(); cid = (f << 8) | s; return CMD_MAP.get(cid, f"CMD_{cid}")

def log(msg=""): print(msg, flush=True)

# ======================== BOARD + CARO AI ========================
EMPTY = -1
CIRCLE = 0
CROSS = 1

DIRS = ((1, 0), (0, 1), (1, 1), (1, -1))

PATTERNS = {
    (5, 0): 10_000_000, (5, 1): 10_000_000, (5, 2): 10_000_000,
    (4, 2): 1_000_000, (4, 1): 100_000, (4, 0): 0,
    (3, 2): 50_000, (3, 1): 5_000, (3, 0): 0,
    (2, 2): 2_000, (2, 1): 400, (2, 0): 0,
    (1, 2): 100, (1, 1): 25, (1, 0): 0,
}

class Board:
    def __init__(self, width=15, height=19):
        self.width = width; self.height = height
        self.grid = [[EMPTY] * width for _ in range(height)]
        self.history = []

    def resize(self, width, height):
        self.width = width; self.height = height
        self.grid = [[EMPTY] * width for _ in range(height)]
        self.history = []

    def in_bounds(self, x, y): return 0 <= x < self.width and 0 <= y < self.height

    def get(self, x, y):
        if self.in_bounds(x, y): return self.grid[y][x]
        return EMPTY

    def put(self, x, y, symbol):
        if self.in_bounds(x, y) and self.grid[y][x] == EMPTY:
            self.grid[y][x] = symbol
            self.history.append((x, y, symbol))

    def undo(self, x, y):
        if self.in_bounds(x, y):
            self.grid[y][x] = EMPTY
            if self.history and self.history[-1][:2] == (x, y): self.history.pop()

    def xy_to_pos(self, x, y): return y * self.width + x
    def pos_to_xy(self, pos): return pos % self.width, pos // self.width

    def load_rle(self, data):
        self.grid = [[EMPTY] * self.width for _ in range(self.height)]
        self.history = []
        pos = 0
        for value in data:
            symbol = value - 256 if value > 127 else value
            if symbol >= 0:
                y, x = pos // self.width, pos % self.width
                if self.in_bounds(x, y): self.grid[y][x] = symbol
                pos += 1
            else:
                pos += -symbol
        for y in range(self.height):
            for x in range(self.width):
                s = self.grid[y][x]
                if s >= 0: self.history.append((x, y, s))

    def get_empty_near_center(self):
        cx, cy = self.width // 2, self.height // 2
        for r in range(max(self.width, self.height)):
            for dx in range(-r, r + 1):
                for dy in range(-r, r + 1):
                    x, y = cx + dx, cy + dy
                    if self.in_bounds(x, y) and self.grid[y][x] == EMPTY: return (x, y)
        return (0, 0)

    def get_empty_near(self, x0, y0):
        for r in range(10):
            for dx in range(-r, r + 1):
                for dy in range(-r, r + 1):
                    x, y = x0 + dx, y0 + dy
                    if self.in_bounds(x, y) and self.grid[y][x] == EMPTY: return (x, y)
        return self.get_empty_near_center()

def _line_info(board, x, y, dx, dy, sym):
    """Số quân liên tiếp + số đầu mở nếu đặt sym tại (x,y)."""
    cnt = 1; open_ends = 0
    for sign in (1, -1):
        i = 1
        while True:
            xx, yy = x + dx * i * sign, y + dy * i * sign
            if not board.in_bounds(xx, yy): break
            v = board.grid[yy][xx]
            if v == sym:
                cnt += 1; i += 1
            else:
                if v == EMPTY: open_ends += 1
                break
    return cnt, open_ends

def _cell_score(board, x, y, sym):
    total = 0
    for dx, dy in DIRS:
        cnt, oe = _line_info(board, x, y, dx, dy, sym)
        total += PATTERNS.get((min(cnt, 5), oe), 0)
    return total

def _candidates(board):
    if not board.history:
        return [(board.width // 2, board.height // 2)]
    cand = set()
    for (sx, sy, _s) in board.history:
        for dx in range(-2, 3):
            for dy in range(-2, 3):
                x, y = sx + dx, sy + dy
                if board.in_bounds(x, y) and board.grid[y][x] == EMPTY:
                    cand.add((x, y))
    return cand

def best_move(board, me, opp):
    cands = _candidates(board)
    if not cands:
        return board.get_empty_near_center()
    # 1) Thắng ngay nếu có thể
    for (x, y) in cands:
        for dx, dy in DIRS:
            cnt, _oe = _line_info(board, x, y, dx, dy, me)
            if cnt >= 5: return (x, y)
    # 2) Chặn đối thủ thắng ngay
    blocks = []
    for (x, y) in cands:
        for dx, dy in DIRS:
            cnt, _oe = _line_info(board, x, y, dx, dy, opp)
            if cnt >= 5:
                blocks.append((x, y)); break
    if blocks:
        return max(blocks, key=lambda c: _cell_score(board, c[0], c[1], me))
    # 3) Chấm điểm: tấn công + phòng thủ
    best, best_score = None, -1.0
    for (x, y) in cands:
        atk = _cell_score(board, x, y, me)
        dfn = _cell_score(board, x, y, opp)
        score = atk + dfn * 0.9
        if atk >= 1_000_000:  # mở bốn → gần như thắng
            score += 5_000_000
        score -= (abs(x - board.width / 2) + abs(y - board.height / 2)) * 0.5
        score += random.uniform(0, 1)
        if score > best_score:
            best_score, best = score, (x, y)
    return best

# ======================== EMBRYO ENGINE (từ arena) ========================
ENGINE_DIR = Path(__file__).resolve().parent / "embryo-engine"
_mach = os.uname().machine  # x86_64 / aarch64
EMBRYO_BINARY = next(
    (n for n in (f"pbrain-embryo.{_mach}", "pbrain-embryo")
     if (ENGINE_DIR / n).exists()),
    "pbrain-embryo")
EMBRYO_TIMEOUT_TURN_MS = 2000
EMBRYO_MATCH_TIMEOUT_MS = 1800000
BOARD_W, BOARD_H = 15, 19

class EmbryoEngine:
    """Wrapper pbrain-embryo (Gomocup protocol).

    Binary này chỉ hỗ trợ BEGIN/TURN ổn định (BOARD mode bị lỗi) nên luôn
    sync theo lượt: giữ _known = số quân engine đã biết, TURN nước cuối
    của đối thủ khi tới lượt mình. Ván mới → RESTART + RECTSTART 15,19.
    """

    def __init__(self):
        self.binary = ENGINE_DIR / EMBRYO_BINARY
        self.proc = None
        self.lock = threading.Lock()
        self._buf = bytearray()
        self._sel = None
        self._synced = False
        self._known = 0

    @property
    def synced(self): return self._synced

    def _alive(self): return self.proc is not None and self.proc.poll() is None

    def _send(self, cmd):
        if self._alive():
            try:
                self.proc.stdin.write((cmd + "\n").encode())
                self.proc.stdin.flush()
            except Exception:
                pass

    def _read_line(self, timeout):
        if not self._alive(): return ""
        deadline = time.monotonic() + timeout
        while True:
            idx = self._buf.find(b"\n")
            if idx >= 0:
                line = bytes(self._buf[:idx]).strip()
                del self._buf[:idx + 1]
                return line.decode("utf-8", "replace")
            rem = deadline - time.monotonic()
            if rem <= 0: return ""
            try:
                if self._sel and self._sel.select(timeout=min(rem, 0.2)):
                    chunk = os.read(self.proc.stdout.fileno(), 4096)
                    if not chunk: return ""
                    self._buf.extend(chunk)
                elif not self._sel:
                    return ""
            except Exception:
                return ""

    def _read_move(self, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            l = self._read_line(0.3)
            if not l:
                if not self._alive(): return None
                continue
            if l.startswith(("MESSAGE", "DEBUG", "ERROR", "UNKNOWN")):
                continue
            m = re.match(r"^\s*(\d+)\s*,\s*(\d+)\s*$", l)
            if m:
                mx, my = int(m.group(1)), int(m.group(2))
                if 0 <= mx < BOARD_W and 0 <= my < BOARD_H:
                    return (mx, my)
        return None

    def _handshake_infos(self):
        self._send(f"INFO timeout_turn {EMBRYO_TIMEOUT_TURN_MS}")
        self._send(f"INFO timeout_match {EMBRYO_MATCH_TIMEOUT_MS}")
        self._send(f"INFO time_left {EMBRYO_MATCH_TIMEOUT_MS}")

    def _wait_ok(self, tries, timeout):
        for _ in range(tries):
            if self._read_line(timeout).strip().upper() == "OK":
                return True
        return False

    def start_game(self):
        """RESTART + RECTSTART 15,19. True nếu engine sẵn sàng (chưa sync)."""
        with self.lock:
            try:
                if self._alive():
                    self._send("RESTART")
                    if self._wait_ok(5, 1.0):
                        self._send("RECTSTART 15,19")
                        if self._wait_ok(5, 1.0):
                            self._handshake_infos()
                            self._synced = False; self._known = 0
                            return True
                    self._stop_locked()
                self._stop_locked()
                if not self.binary.exists(): return False
                self.proc = subprocess.Popen(
                    [str(self.binary)], stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    cwd=str(ENGINE_DIR))
                self._buf = bytearray()
                try:
                    self._sel = selectors.DefaultSelector()
                    self._sel.register(self.proc.stdout, selectors.EVENT_READ)
                except Exception:
                    self._sel = None
                self._send("RECTSTART 15,19")
                if not self._wait_ok(10, 1.0):
                    self._stop_locked(); return False
                self._handshake_infos()
                self._synced = False; self._known = 0
                return True
            except Exception:
                self._stop_locked()
                return False

    def _stop_locked(self):
        if self.proc:
            try: self._send("END")
            except Exception: pass
            try:
                self.proc.terminate(); self.proc.wait(2)
            except Exception:
                try: self.proc.kill()
                except Exception: pass
            self.proc = None
        if self._sel:
            try: self._sel.close()
            except Exception: pass
            self._sel = None
        self._synced = False; self._known = 0

    def stop(self):
        with self.lock:
            self._stop_locked()

    def _desync(self):
        self._synced = False; self._known = 0

    def _fresh_sync(self, board_history, my_side):
        """Sync ván mới: BEGIN (engine đi trước) / TURN (đi sau) /
        match quân auto của server (tâm bàn) bằng BEGIN."""
        L = len(board_history)
        tmo = EMBRYO_TIMEOUT_TURN_MS / 1000.0 + 5
        if L == 0:
            self._send("BEGIN")
            mv = self._read_move(tmo)
            if mv is None: return None
            self._synced = True; self._known = 1
            return mv
        if L == 1:
            x0, y0, s0 = board_history[0]
            if s0 != my_side:
                # đối thủ đánh trước (ta là X) → TURN từ bàn trống
                self._send(f"TURN {x0},{y0}")
                mv = self._read_move(tmo)
                if mv is None: return None
                self._synced = True; self._known = 2
                return mv
            # quân của mình do server auto đặt (tâm) → BEGIN phải trùng
            self._send("BEGIN")
            mv = self._read_move(tmo)
            if mv is None: return None
            if mv == (x0, y0):
                self._synced = True; self._known = 1
            return None
        if L == 2 and board_history[0][2] == my_side:
            # [auto-stone của mình, nước đối thủ] → BEGIN khớp rồi TURN
            self._send("BEGIN")
            mv = self._read_move(tmo)
            if mv is None: return None
            if mv != (board_history[0][0], board_history[0][1]):
                return None
            self._synced = True; self._known = 1
            lx, ly, _ = board_history[1]
            self._send(f"TURN {lx},{ly}")
            mv2 = self._read_move(tmo)
            if mv2 is None:
                self._desync(); return None
            self._known = 3
            return mv2
        return None

    def get_move(self, board_history, my_side):
        """Trả (x,y) hoặc None. my_side: symbol (0/1) của mình."""
        with self.lock:
            if not self._alive(): return None
            try:
                self._send(f"INFO time_left {EMBRYO_MATCH_TIMEOUT_MS}")
                L = len(board_history)
                if not self._synced:
                    return self._fresh_sync(board_history, my_side)
                if L == self._known + 1:
                    lx, ly, _ = board_history[-1]
                    self._send(f"TURN {lx},{ly}")
                    mv = self._read_move(EMBRYO_TIMEOUT_TURN_MS / 1000.0 + 5)
                    if mv is None:
                        self._desync(); return None
                    self._known = L + 1
                    return mv
                self._desync()
                return None
            except Exception:
                self._desync()
                return None

# ======================== WS BOT ========================
BET_LADDER_GUESS = [100, 200, 400, 1000, 2000, 4000, 10000, 20000, 40000]

class WSBot:
    def __init__(self, ws):
        self.ws = ws
        self.balance = 0
        self.slot = -1
        self.current_turn = -99
        self.bet_amts = []
        self.board = Board(15, 19)
        self.my_symbol = CROSS
        self.opponent_symbol = CIRCLE
        self.is_playing = False
        self.ready = False
        self.pending_move = False
        self.wins = 0; self.losses = 0; self.draws = 0
        self.games = 0
        self.max_games = 0
        self.engine = None
        self._engine_fresh = False
        self._engine_ok = (ENGINE_DIR / EMBRYO_BINARY).exists()

    def on_balance_changed(self, br):
        """BALANCE_CHANGED: [i8 flag][i64 balance][i64 x][i64 bet][i64 x].
        flag=-1/0: balance của mình (đáng tin). flag=1: của người khác → bỏ qua."""
        try:
            flag = br.i8()
            bal = br.i64()
            if flag in (-1, 0):
                self.balance = bal
        except Exception:
            pass

    async def send(self, data):
        await self.ws.send(data)

    async def recv_cmd(self, timeout=3):
        try:
            r = await asyncio.wait_for(self.ws.recv(), timeout=timeout)
        except asyncio.TimeoutError:
            return None, None, None
        if isinstance(r, bytes):
            br = BR(r)
            cmd = br.rc()
            return cmd, br, r
        return None, None, None

    async def keepalive_ping(self):
        try:
            w = BW(); w.wc("PING")
            await self.ws.send(w.build())
        except Exception:
            raise

    async def wait_with_keepalive(self, seconds):
        deadline = time.time() + seconds
        last_ping = 0
        while time.time() < deadline:
            remaining = min(deadline - time.time(), 3)
            try:
                cmd, br, raw = await self.recv_cmd(timeout=max(0.5, remaining))
            except asyncio.TimeoutError:
                cmd = None
            if time.time() - last_ping > 15:
                await self.keepalive_ping()
                last_ping = time.time()
            if cmd is not None:
                if cmd == "PING":
                    try: await self.send(BW().wc("PONG").build())
                    except: raise
                elif cmd == "BALANCE_CHANGED" and br and br.rem() >= 9:
                    self.on_balance_changed(br)
                elif cmd == "MOVE" and br and br.rem() >= 3:
                    await self.handle_move(br)
        return None, None, None

    async def send_pong(self):
        await self.ws.send(BW().wc("PONG").build())

    async def drain(self, seconds=2):
        deadline = time.time() + seconds
        while time.time() < deadline:
            try:
                cmd, br, raw = await self.recv_cmd(timeout=1)
            except asyncio.TimeoutError:
                continue
            except Exception:
                raise
            if cmd is None: break
            if cmd == "PING": await self.send_pong()
            elif cmd == "BALANCE_CHANGED" and br and br.rem() >= 9:
                self.on_balance_changed(br)
            elif cmd == "MOVE" and br and br.rem() >= 3:
                await self.handle_move(br)

    async def login_replay(self, frames):
        log("[WS] Replaying login frames...")
        for fb in frames:
            await self.send(fb)
            await asyncio.sleep(0.3)
            try:
                cmd, br, raw = await self.recv_cmd(timeout=1)
                if cmd == "PING": await self.send_pong()
                elif cmd == "BALANCE_CHANGED" and br and br.rem() >= 9:
                    self.on_balance_changed(br)
                    log(f"  [login] balance: {self.balance:,}")
            except: pass

    async def enter_lobby(self):
        log("[WS] ENTER_PLACE Lobby.caro.0...")
        ew = BW(); ew.wc("ENTER_PLACE"); ew.wa("Lobby.caro.0"); ew.wu(""); ew.i8(1)
        await self.send(ew.build())
        await self.drain(3)
        if self.balance == 0:
            await self.read_balance()

    async def read_balance(self):
        w = BW(); w.wc("GET_TABLE_DATA_EX"); w.wa("")
        await self.send(w.build())
        for _ in range(5):
            cmd, br, raw = await self.recv_cmd(timeout=3)
            if cmd is None: break
            if cmd == "BALANCE_CHANGED" and br.rem() >= 9:
                self.on_balance_changed(br)
                return self.balance
            elif cmd == "PING": await self.send_pong()
        return self.balance

    def update_symbols(self):
        self.my_symbol = CIRCLE if self.slot == 0 else CROSS
        self.opponent_symbol = CROSS if self.my_symbol == CIRCLE else CIRCLE

    # ======================== BET AMTS + CREATE TABLE ========================
    async def request_bets(self):
        w = BW(); w.wc("LIST_BET_AMT")
        await self.send(w.build())
        deadline = time.time() + 10
        while time.time() < deadline:
            cmd, br, raw = await self.recv_cmd(timeout=3)
            if cmd is None: continue
            if cmd == "PING": await self.send_pong(); continue
            if cmd == "BALANCE_CHANGED" and br and br.rem() >= 9:
                self.on_balance_changed(br); continue
            if cmd == "MOVE" and br and br.rem() >= 3:
                await self.handle_move(br); continue
            if cmd == "LIST_BET_AMT" and br and br.rem() >= 2:
                status = br.i8()
                if status != 0:
                    log(f"  [BET] LIST_BET_AMT lỗi (status={status})")
                    return False
                count = br.u8()
                self.bet_amts = [(i, br.i32()) for i in range(count)]
                return True
        return False

    def resolve_bet_amt_id(self, bet_xu):
        if not self.bet_amts: return None
        for i, v in self.bet_amts:
            if v == bet_xu: return i
        lower = [(i, v) for i, v in self.bet_amts if 0 < v <= bet_xu]
        if lower:
            i, v = max(lower, key=lambda x: x[1])
            log(f"  [BET] không có mức {bet_xu:,}xu → dùng gần nhất thấp hơn: {v:,}xu (id {i})")
            return i
        i, v = min(self.bet_amts, key=lambda x: x[1])
        log(f"  [BET] không có mức ≤ {bet_xu:,}xu → dùng mức nhỏ nhất: {v:,}xu (id {i})")
        return i

    def guess_bet_id(self, bet_xu):
        for i, v in enumerate(BET_LADDER_GUESS):
            if v == bet_xu: return i
        lower = [v for v in BET_LADDER_GUESS if 0 < v <= bet_xu]
        return BET_LADDER_GUESS.index(max(lower)) if lower else 0

    async def create_table(self, bet_xu=4000, bet_id_override=-1):
        if bet_id_override is not None and bet_id_override > 0:
            bet_id = bet_id_override
            log(f"[CREATE] tạo bàn (bet_id={bet_id} — override)")
        else:
            if not self.bet_amts:
                await self.request_bets()
            bet_id = self.resolve_bet_amt_id(bet_xu)
            if bet_id is None:
                bet_id = self.guess_bet_id(bet_xu)
                log(f"[CREATE] không đọc được LIST_BET_AMT → guess bet_id={bet_id} cho {bet_xu:,}xu")
            else:
                ladder = ", ".join(f"{v:,}(id{i})" for i, v in self.bet_amts)
                log(f"[CREATE] bet ladder: {ladder}")
                log(f"[CREATE] tạo bàn {bet_xu:,}xu → bet_id={bet_id}")
        w = BW(); w.wc("CREATE_RULE"); w.i8(bet_id)
        args = [("matchDuration","1800"),("turnDuration","60"),("accDuration","2"),("blockSoftware","0")]
        w.i8(len(args))
        for n, v in args: w.wa(n); w.wu(v)
        await self.send(w.build())
        deadline = time.time() + 10
        while time.time() < deadline:
            cmd, br, raw = await self.recv_cmd(timeout=3)
            if cmd is None: continue
            if cmd == "PING": await self.send_pong()
            elif cmd == "BALANCE_CHANGED" and br and br.rem() >= 9:
                self.on_balance_changed(br)
            elif cmd == "MOVE" and br and br.rem() >= 3:
                await self.handle_move(br)
            elif cmd == "CREATE_RULE" and br and br.rem() >= 1:
                status = br.i8()
                if status == 0:
                    tid = br.ra() if br.rem() >= 1 else ""
                    log(f"  ✓ Bàn đã tạo! id={tid}")
                    await self.drain(1)
                    return True
                else:
                    log(f"  ✗ CREATE_RULE bị từ chối (status={status})")
                    return False
            elif cmd == "PLAYER_ENTERED":
                log(f"  ✓ Bàn đã tạo! (PLAYER_ENTERED)")
                await self.drain(2)
                return True
        return False

    def parse_table(self, br):
        try:
            status = br.i8()
            if status != 0:
                err = br.ru() if br.rem() >= 2 else ""
                log(f"  [TABLE] không ở trong bàn ({err})")
                self.slot = -1; self.is_playing = False
                return False
            seat_count = br.u8()
            for _ in range(seat_count):
                br.u8(); br.ra(); br.u8()
                child = br.u8()
                for _ in range(child):
                    br.u8(); br.ra(); br.ru(); br.u8(); br.u8()
            br.u8(); self.slot = br.i8()
            self.is_playing = br.u8() == 1
            player_count = br.u8()
            for _ in range(player_count):
                sid = br.i8(); pid = br.i64(); name = br.ru()
                br.u16(); br.ra(); br.i8()
                v1 = br.i64(); br.i64(); br.i64(); br.u8(); br.u8()
                if sid == self.slot:  # i64#1 của entry mình = số dư xu thật
                    self.balance = v1
            cur = br.i8(); br.i16(); br.i16(); br.u8()
            self.current_turn = cur
            move_count = br.u8()
            for _ in range(move_count):
                br.i8(); br.i32()
            width = br.u8(); height = br.u8()
            self.board.resize(width, height)
            br.i16()
            self.board.load_rle(br.rb())
            self.update_symbols()
            log(f"  [TABLE] slot={self.slot} playing={self.is_playing} turn=slot{cur} "
                f"tôi={'X' if self.my_symbol == CROSS else 'O'}")
            return True
        except Exception as e:
            log(f"  [TABLE] parse error: {e}")
            return False

    async def sync_table(self):
        w = BW(); w.wc("GET_TABLE_DATA_EX"); w.wa("")
        await self.send(w.build())
        deadline = time.time() + 8
        while time.time() < deadline:
            cmd, br, raw = await self.recv_cmd(timeout=3)
            if cmd is None: continue
            if cmd == "PING": await self.send_pong(); continue
            if cmd == "BALANCE_CHANGED" and br and br.rem() >= 9:
                self.on_balance_changed(br); continue
            if cmd == "GET_TABLE_DATA_EX":
                return self.parse_table(br)
        return False

    # ======================== PLAY (CHƠI THẬT) ========================
    async def do_move(self):
        if not self.is_playing or self.slot < 0: return
        x = y = None; tag = "heuristic"
        try:
            eng = self.engine
            if eng is not None and self._engine_fresh:
                mv = None
                try:
                    mv = await asyncio.wait_for(
                        asyncio.get_event_loop().run_in_executor(
                            None, lambda: eng.get_move(list(self.board.history), self.my_symbol)),
                        timeout=EMBRYO_TIMEOUT_TURN_MS / 1000.0 + 12)
                except Exception as e:
                    log(f"  [ENGINE] error: {e}"); mv = None
                if mv is not None and self.board.in_bounds(*mv) and self.board.get(*mv) == EMPTY:
                    x, y = mv; tag = "embryo"
                else:
                    if mv is not None:
                        log(f"  [ENGINE] nước không hợp lệ: {mv}")
                    if not eng.synced:
                        self._engine_fresh = False
                        log(f"  [ENGINE] desync/timeout → heuristic (phần còn lại của ván)")
            if x is None:
                move = best_move(self.board, self.my_symbol, self.opponent_symbol)
                if move is None:
                    if self.board.history:
                        lx, ly = self.board.history[-1][0], self.board.history[-1][1]
                    else:
                        lx, ly = 7, 9
                    move = self.board.get_empty_near(lx, ly)
                x, y = move
            if not self.board.in_bounds(x, y) or self.board.get(x, y) != EMPTY:
                x, y = self.board.get_empty_near_center()
            pos = self.board.xy_to_pos(x, y)
            log(f"  [MOVE] ({x},{y}) pos={pos} symbol={'X' if self.my_symbol == CROSS else 'O'} [{tag}]")
            w = BW(); w.wc("PLAY"); w.i16(pos)
            await self.send(w.build())
            self.board.put(x, y, self.my_symbol)
        except Exception as e:
            log(f"  [MOVE] error: {e}")

    async def handle_start(self, br):
        try:
            player_count = br.u8()
            for _ in range(player_count):
                br.i8(); br.i32()
            width = br.u8(); height = br.u8()
            self.board.resize(width, height)
            br.i16()
            self.board.load_rle(br.rb())
            self.update_symbols()
            self.is_playing = True; self.ready = False; self.pending_move = False
            log(f"  [START] board {width}x{height} | slot={self.slot} | "
                f"tôi={'X' if self.my_symbol == CROSS else 'O'}")
            # Engine Embryo cho ván mới (RESTART + RECTSTART)
            if self._engine_ok:
                if self.engine is None:
                    self.engine = EmbryoEngine()
                try:
                    ok = await asyncio.get_event_loop().run_in_executor(
                        None, self.engine.start_game)
                except Exception as e:
                    ok = False; log(f"  [ENGINE] start error: {e}")
                self._engine_fresh = bool(ok)
                log(f"  [ENGINE] embryo {'sẵn sàng (TURN/BEGIN mode)' if ok else 'KHÔNG khả dụng → heuristic'}")
            else:
                self._engine_fresh = False
                log(f"  [ENGINE] không tìm thấy {ENGINE_DIR / EMBRYO_BINARY} → heuristic")
        except Exception as e:
            log(f"  [START] parse error: {e}")

    async def handle_move(self, br):
        try:
            pos = br.i16(); symbol = br.i8()
            x, y = self.board.pos_to_xy(pos)
            tag = "me-echo" if symbol == self.my_symbol else "opponent"
            log(f"  [{tag}] ({x},{y}) {'X' if symbol == CROSS else 'O'}")
            current = self.board.get(x, y)
            if current == symbol:
                return
            if current != EMPTY and current != symbol:
                self.my_symbol = symbol
                self.opponent_symbol = CROSS if symbol == CIRCLE else CIRCLE
                self.board.undo(x, y)
            self.board.put(x, y, symbol)
        except Exception as e:
            log(f"  [MOVE] parse error: {e}")

    async def handle_gameover(self, br):
        self.is_playing = False; self.pending_move = False
        my_result = None; my_amount = 0
        try:
            player_count = br.u8()
            for _ in range(player_count):
                sid = br.i8(); res = br.i8(); amt = br.i64()
                if sid == self.slot:
                    my_result = res; my_amount = amt
            br.ru()
        except Exception as e:
            log(f"  [GAMEOVER] parse error: {e}")
        if my_result in (1, 11):
            self.wins += 1; outcome = "THẮNG"
        elif my_result in (2, 4, 12):
            self.losses += 1; outcome = "THUA"
        else:
            self.draws += 1; outcome = "HÒA"
        if my_amount:
            self.balance = max(0, self.balance + my_amount)
        log(f"  ✓✓ GAMEOVER — {outcome} (result={my_result}, amount={my_amount:+,}) | "
            f"W/L/D = {self.wins}/{self.losses}/{self.draws} | balance: {self.balance:,}")

    async def ready_and_play(self, runtime_deadline, wait_opponent=150, rematch_wait=90):
        bal_before = self.balance
        log(f"  balance: {bal_before:,} | slot={self.slot}")
        games_in_table = 0
        while time.time() < runtime_deadline:
            started = self.is_playing
            if not started:
                # Rejoin giữa ván (mất kết nối rồi vào lại): đang chơi → vào thẳng game
                wait = wait_opponent if games_in_table == 0 else rematch_wait
                if games_in_table == 0:
                    log(f"  [READY] SET_READY — chờ đối thủ vào bàn...")
                else:
                    log(f"  [REMATCH {games_in_table + 1}] SET_READY — mời ván tiếp theo (ở lại bàn)...")
                await self.send(BW().wc("SET_READY").build())
                self.ready = True
                last_ready = time.time()
                wait_until = time.time() + wait
                kicked = False
                while not started and time.time() < wait_until and time.time() < runtime_deadline:
                    try:
                        cmd, br, raw = await self.recv_cmd(timeout=3)
                    except Exception:
                        raise
                    if cmd is None:
                        if time.time() - last_ready > 30:
                            await self.send(BW().wc("SET_READY").build())
                            last_ready = time.time()
                        continue
                    if cmd == "PING":
                        await self.send_pong()
                    elif cmd == "BALANCE_CHANGED" and br and br.rem() >= 9:
                        self.on_balance_changed(br)
                    elif cmd == "MOVE" and br and br.rem() >= 3:
                        await self.handle_move(br)
                    elif cmd == "PLAYER_ENTERED":
                        log(f"  [TABLE] Có người vào bàn")
                        await self.send(BW().wc("SET_READY").build())
                        last_ready = time.time()
                    elif cmd == "SET_TURN" and br and br.rem() >= 5:
                        sid = br.i8()
                        # sid=-2 = đếm ngược pre-game sau khi đối thủ vào bàn
                        if (sid == self.slot or sid == -2) and not self.ready:
                            await self.send(BW().wc("SET_READY").build())
                            self.ready = True; last_ready = time.time()
                    elif cmd == "START_MATCH" and br:
                        await self.handle_start(br)
                        if self.is_playing:
                            started = True
                            log(f"  ✓ GAME STARTED — CHƠI! (không surrender)")
                            break
                    elif cmd == "KICK_PLAYER":
                        log(f"  [KICK] Bị kick khỏi bàn")
                        kicked = True; break
                if kicked:
                    return "kicked"
                if not started:
                    if games_in_table == 0:
                        log(f"  [!] Không có đối thủ / không start trong {wait}s")
                        return "no_opponent"
                    log(f"  [!] Đối thủ không chơi tiếp trong {wait}s → rời bàn")
                    return "rematch_timeout"
            # ===== chơi 1 ván đến GAMEOVER =====
            result = "timeout"
            while time.time() < runtime_deadline:
                try:
                    cmd, br, raw = await self.recv_cmd(timeout=5)
                except Exception:
                    raise
                if cmd is None: continue
                if cmd == "PING":
                    await self.send_pong()
                elif cmd == "BALANCE_CHANGED" and br and br.rem() >= 9:
                    self.on_balance_changed(br)
                elif cmd == "SET_TURN" and br and br.rem() >= 5:
                    sid = br.i8()
                    if sid == self.slot and self.is_playing and not self.pending_move:
                        self.pending_move = True
                        await asyncio.sleep(random.uniform(1.5, 3.0))
                        if self.is_playing:
                            await self.do_move()
                        self.pending_move = False
                elif cmd == "MOVE" and br and br.rem() >= 3:
                    await self.handle_move(br)
                elif cmd == "PLAY" and br and br.rem() >= 1:
                    status = br.i8()
                    if status != 0:
                        log(f"  [PLAY] server từ chối nước (status={status}) → sync lại bàn")
                        self._engine_fresh = False  # board sẽ reload → engine mất sync
                        await self.sync_table()
                elif cmd == "START_MATCH" and br:
                    await self.handle_start(br)
                elif cmd == "GAMEOVER" and br:
                    await self.handle_gameover(br)
                    self.games += 1
                    result = "gameover"
                    break
                elif cmd == "KICK_PLAYER":
                    log(f"  [KICK] Bị kick giữa ván")
                    result = "kicked"; break
                elif cmd == "PLAYER_EXITED":
                    log(f"  [TABLE] Có người rời bàn")
            if result == "kicked":
                return "kicked"
            if result != "gameover":
                return result
            # ===== GAMEOVER → KHÔNG tạo bàn mới, ở lại bàn chơi ván tiếp =====
            games_in_table += 1
            log(f"  [STAY] Ở lại bàn — chơi ván tiếp theo (đã chơi {games_in_table} ván ở bàn này)")
            if self.max_games > 0 and self.games >= self.max_games:
                log(f"[STOP] Đã đủ {self.games}/{self.max_games} ván → dừng")
                return "max_games"
            await asyncio.sleep(random.uniform(3, 6))
        return "timeout"

    def stop_engine(self):
        if self.engine is not None:
            try: self.engine.stop()
            except Exception: pass

    async def leave_table(self):
        ret = BW(); ret.wc("ENTER_PLACE"); ret.wa("Lobby.caro.0"); ret.wu(""); ret.i8(1)
        await self.send(ret.build())
        await self.drain(2)
        self.is_playing = False; self.ready = False; self.pending_move = False

DEFAULT_TOKEN_FILE = "state/tokens/ck2_token.json"
DEFAULT_COOKIE_FILE = "ck2.txt"


def ensure_token_from_cookie(cookie_file, token_file):
    """Nếu token chưa có, tự động chạy capture_token.py từ cookie để sinh token.
    Trả về đường dẫn token file nếu thành công, ngược lại None."""
    if os.path.exists(token_file):
        return token_file
    if not os.path.exists(cookie_file):
        log(f"[TOKEN] Chưa có {token_file} và cũng không có {cookie_file}")
        return None
    log(f"[TOKEN] Chưa có {token_file} — đang tự động capture từ {cookie_file} ...")
    try:
        subprocess.run(
            [sys.executable, "capture_token.py", "--cookie", cookie_file,
             "--output", token_file],
            check=True, timeout=120)
    except Exception as e:
        log(f"[TOKEN] Auto-capture thất bại: {e}")
        return None
    if os.path.exists(token_file):
        log(f"[TOKEN] ✓ Đã sinh token: {token_file}")
        return token_file
    log(f"[TOKEN] Không sinh được token từ {cookie_file}")
    return None


# ======================== MAIN ========================
async def main():
    parser = argparse.ArgumentParser(description="Pure WS bot — tạo bàn 4000xu + CHƠI (no claim, no surrender)")
    parser.add_argument("--token-file", default=DEFAULT_TOKEN_FILE,
                        help=f"Path to token JSON file (default: {DEFAULT_TOKEN_FILE})")
    parser.add_argument("--cookie-file", default=DEFAULT_COOKIE_FILE,
                        help=f"Path to cookie file used to auto-capture token if missing (default: {DEFAULT_COOKIE_FILE})")
    parser.add_argument("--bet-xu", type=int, default=int(os.environ.get("BET_XU", "4000")),
                        help="Mức cược bàn tự tạo (mặc định 4000 xu)")
    parser.add_argument("--bet-id", type=int, default=int(os.environ.get("BET_ID", "-1")),
                        help="Override raw bet_amt_id (>0 để dùng, bỏ qua --bet-xu)")
    parser.add_argument("--runtime", type=int, default=int(os.environ.get("RUNTIME_SECONDS", "21600")))
    parser.add_argument("--max-games", type=int, default=int(os.environ.get("MAX_GAMES", "0")),
                        help="Dừng sau N ván (0 = không giới hạn)")
    args = parser.parse_args()

    token_path = Path(args.token_file)
    resolved = ensure_token_from_cookie(args.cookie_file, args.token_file)
    if not resolved:
        log(f"[FATAL] Không có token ({args.token_file}) và không thể sinh từ cookie ({args.cookie_file})")
        log(f"        Chạy trước: python3 capture_token.py --cookie {args.cookie_file} --output {args.token_file}")
        sys.exit(1)
    data = json.loads(token_path.read_text())
    ws_url = data["ws_url"]
    login_frames = [bytes.fromhex(h) for h in data["frames"]]

    log(f"{'='*60}")
    log(f"PURE WS BOT — TẠO BÀN {args.bet_xu:,}XU + CHƠI (no claim, no surrender)")
    log(f"  Cookie: {args.cookie_file}")
    log(f"  Token: {args.token_file}")
    log(f"  WS: {ws_url}")
    log(f"  Bet: {args.bet_xu:,} xu (bet_id override: {args.bet_id})")
    log(f"  Runtime: {args.runtime}s ({args.runtime//60} min)")
    log(f"{'='*60}")

    deadline = time.time() + args.runtime
    cycle = 0
    total_wins = 0; total_losses = 0; total_draws = 0
    reconnect_count = 0
    consec_no_opponent = 0
    MAX_RECONNECTS = 3
    stop = False
    bot = None

    while time.time() < deadline and reconnect_count < MAX_RECONNECTS and not stop:
        try:
            async with websockets.connect(ws_url, ping_interval=None, max_size=2**20, open_timeout=15) as ws:
                bot = WSBot(ws)
                bot.max_games = max(0, args.max_games)
                await bot.login_replay(login_frames)
                await bot.enter_lobby()
                await bot.read_balance()
                log(f"\nBalance: {bot.balance:,} (reconnects: {reconnect_count})")
                reconnect_count = 0

                while time.time() < deadline:
                    cycle += 1
                    log(f"\n{'='*40} CYCLE {cycle} {'='*40}")

                    if 0 < bot.balance < args.bet_xu:
                        log(f"[STOP] Balance {bot.balance:,} < mức cược {args.bet_xu:,} "
                            f"(claim đã bị tắt) → dừng bot")
                        stop = True
                        break

                    # Phase 1: TẠO BÀN (mặc định 4000xu) — hoặc REJOIN bàn cũ còn tồn
                    log(f"\n[Phase 1] Kiểm tra bàn cũ / tạo bàn {args.bet_xu:,}xu...")
                    if await bot.sync_table():
                        log(f"  [REJOIN] Còn trong bàn cũ — chơi tiếp, không tạo mới")
                    else:
                        created = await bot.create_table(args.bet_xu, args.bet_id)
                        if not created:
                            log(f"  Tạo bàn thất bại — thử lại cycle sau")
                            await asyncio.sleep(10)
                            continue
                        if not await bot.sync_table():
                            log(f"  Không đọc được dữ liệu bàn — bỏ qua cycle")
                            await bot.leave_table()
                            continue

                    # Phase 2: READY → CHƠI đến GAMEOVER (không surrender)
                    log(f"\n[Phase 2] Ready → chờ START_MATCH → CHƠI...")
                    status = await bot.ready_and_play(deadline)
                    if status == "no_opponent":
                        consec_no_opponent += 1
                        if consec_no_opponent >= 3 and bot.balance <= 0:
                            log(f"[STOP] 3 cycle không có đối thủ + balance=0 → dừng bot")
                            stop = True
                            break
                    else:
                        consec_no_opponent = 0
                    log(f"  Cycle {cycle}: {status} | W/L/D={bot.wins}/{bot.losses}/{bot.draws} "
                        f"| balance: {bot.balance:,}")
                    if status == "max_games":
                        await bot.leave_table()
                        stop = True
                        break

                    # Rời bàn → quay lại lobby cho cycle mới
                    await bot.leave_table()

                    remaining = deadline - time.time()
                    if remaining < 30:
                        log(f"\n[Runtime] {remaining:.0f}s left — stopping")
                        break
                    await bot.wait_with_keepalive(5)

                total_wins += bot.wins; total_losses += bot.losses; total_draws += bot.draws

        except Exception as e:
            reconnect_count += 1
            log(f"\n[WS ERROR] {type(e).__name__}: {e} → reconnect {reconnect_count}/{MAX_RECONNECTS}")
            if reconnect_count < MAX_RECONNECTS:
                await asyncio.sleep(5)
        finally:
            if bot is not None:
                bot.stop_engine()

    log(f"\n{'='*60}")
    log(f"FINAL SUMMARY")
    log(f"{'='*60}")
    log(f"  Cycles: {cycle}")
    log(f"  W/L/D: {total_wins}/{total_losses}/{total_draws}")
    if bot is not None:
        log(f"  Final balance: {bot.balance:,} xu")
    log(f"  Reconnects: {reconnect_count}")

if __name__ == "__main__":
    asyncio.run(main())
