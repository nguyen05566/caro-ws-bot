// ==UserScript==
// @name         gamevh Caro Auto-Bot (20xu+)
// @namespace    gamevh.caro.bot
// @version      1.3.0
// @description  Auto tạo bàn caro + tự chơi (heuristic AI) trên gamevh.net — hook WS, dùng session thật
// @author       you
// @match        https://gamevh.net/*
// @match        https://*.gamevh.net/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // ======================= CẤU HÌNH =======================
  const CFG = {
    betIdDefault: 0,          // 0=20xu, 1=40, 2=100, 3=200, 4=400, 5=1000, 6=2000
    moveDelayMin: 1200,       // ms trễ nước đi
    moveDelayMax: 2800,
    retryDelay: 1200,         // ms thử lại sau nước bị từ chối
    rematchDelay: 2500,       // ms — SET_READY mời ván mới sau GAMEOVER
    rematchTimeout: 30000,    // ms — không start lại → rời bàn, tạo bàn mới
    createRetry: 10000,
    createIdle: 6000,
  };

  const CMD = {
    PONG: 300, PING: 301, LEAVE_PLACE: 401, ENTER_CHILD_PLACE: 402,
    CREATE_RULE: 405, PLAYER_ENTERED: 406, PLAYER_EXITED: 407, KICK_PLAYER: 410,
    LIST_TABLE: 412, LIST_BET_AMT: 413, TABLE_DATA: 415,
    START_MATCH: 417, GAMEOVER: 418, ENTER_STATE: 419, SET_TURN: 420,
    SET_PLAYER_STATUS: 421, BALANCE_CHANGED: 431, SET_READY: 434,
    PLAY: 502, MOVE: 529,
  };

  const EMPTY = -1, CIRCLE = 0, CROSS = 1;
  const symName = (s) => s === CIRCLE ? 'O' : s === CROSS ? 'X' : '?';

  // ======================= TRẠNG THÁI =======================
  const S = {
    on: false,
    ws: null,
    betId: CFG.betIdDefault,
    atTable: false,
    creating: false,
    playing: false,
    pendingMove: false,
    readySent: false,
    w: 15, h: 19,
    grid: [], history: [],
    mySymbol: null,          // học từ echo MOVE của nước tôi được chấp nhận
    mySid: null,             // học từ SET_TURN lúc gửi nước được chấp nhận
    turnSid: null,           // sid của lượt hiện tại
    probeSid: null,          // sid lúc gửi nước chờ echo
    blockUntilMove: false,
    balance: 0, balanceAtGo: null,
    wld: [0, 0, 0], wagered: 0,
    turnTimer: null, rematchTimer: null, createTimer: null,
    lastCreate: 0, lastGoAt: 0,
    myLastSent: null,        // [x,y] nước tôi vừa gửi (chưa echo)
    myLastSym: undefined,    // symbol đã gán tạm cho nước vừa gửi
    bannedCell: null,        // ô bị chối — bỏ qua khi retry
  };

  // ======================= UI =======================
  const ui = {};
  function buildUI() {
    if (ui.root || !document.documentElement) return;
    const st = document.createElement('div');
    st.id = 'gvbot-root';
    st.innerHTML = `
<div style="all:initial;position:fixed;top:8px;right:8px;z-index:999999;font-family:Arial,sans-serif;">
  <div id="gvbot-panel" style="display:none;width:255px;background:rgba(20,25,35,.95);color:#dde;
       border:1px solid #456;border-radius:8px;padding:8px;font-size:12px;box-shadow:0 2px 12px #0008;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <b style="color:#8f8">CARO BOT v1.3</b>
      <span id="gvbot-hide" style="cursor:pointer;color:#89a">—to</span>
    </div>
    <div style="margin:4px 0;">
      <label>Cược:
        <select id="gvbot-bet" style="background:#223;color:#dde;border:1px solid #456;border-radius:4px;">
          <option value="0">20 xu</option><option value="1">40 xu</option>
          <option value="2">100 xu</option><option value="3">200 xu</option>
          <option value="4">400 xu</option><option value="5">1,000 xu</option>
          <option value="6">2,000 xu</option>
        </select>
      </label>
      <button id="gvbot-toggle" style="float:right;background:#a33;color:#fff;border:0;
        border-radius:4px;padding:2px 10px;cursor:pointer;font-weight:bold;">BẬT</button>
    </div>
    <div style="margin:2px 0;"><button id="gvbot-leave" style="background:#345;color:#ccd;
        border:1px solid #567;border-radius:4px;padding:1px 8px;cursor:pointer;font-size:11px;">Rời bàn (thủ công)</button></div>
    <div id="gvbot-status" style="color:#fd5;min-height:14px;">Chưa kết nối WS</div>
    <div id="gvbot-stats" style="color:#abc;"></div>
    <div id="gvbot-log" style="margin-top:4px;max-height:120px;overflow-y:auto;color:#9ab;
         font-size:10px;line-height:1.35;white-space:pre-wrap;"></div>
  </div>
  <div id="gvbot-fab" style="background:#a33;color:#fff;border-radius:50%;width:38px;height:38px;
       display:flex;align-items:center;justify-content:center;cursor:pointer;font-weight:bold;
       box-shadow:0 2px 8px #0008;font-size:11px;border:2px solid #fff3;">BOT</div>
</div>`;
    document.documentElement.appendChild(st);
    ui.panel = st.querySelector('#gvbot-panel');
    ui.fab = st.querySelector('#gvbot-fab');
    ui.status = st.querySelector('#gvbot-status');
    ui.stats = st.querySelector('#gvbot-stats');
    ui.log = st.querySelector('#gvbot-log');
    ui.bet = st.querySelector('#gvbot-bet');
    ui.toggle = st.querySelector('#gvbot-toggle');
    st.querySelector('#gvbot-hide').onclick = () => { ui.panel.style.display = 'none'; ui.fab.style.display = 'flex'; };
    ui.fab.onclick = () => { ui.panel.style.display = 'block'; ui.fab.style.display = 'none'; };
    ui.bet.value = String(S.betId);
    ui.bet.onchange = () => { S.betId = parseInt(ui.bet.value, 10) || 0; };
    ui.toggle.onclick = () => setOn(!S.on);
    st.querySelector('#gvbot-leave').onclick = () => {
      S.atTable = false; S.playing = false; S.readySent = false;
      S.mySymbol = null; S.mySid = null; S.myLastSent = null; S.creating = false;
      clearInterval(S.readyLoop);
      send(frameLeave(), 'LEAVE (thủ công)');
      log('Đã gửi LEAVE — nếu tạo bàn không được, reload trang');
    };
  }
  function setOn(v) {
    S.on = v;
    if (ui.toggle) {
      ui.toggle.textContent = v ? 'TẮT' : 'BẬT';
      ui.toggle.style.background = v ? '#a33' : '#2a4';
    }
    log(v ? '▶ BOT BẬT' : '⏸ BOT TẮT');
    if (v) scheduleCreate(CFG.createIdle);
    else {
      clearTimeout(S.createTimer); clearTimeout(S.turnTimer);
      clearTimeout(S.rematchTimer);
      clearInterval(S.readyLoop);
      S.creating = false; S.pendingMove = false;
    }
  }
  function log(msg) {
    console.log('[GVBOT]', msg);
    if (ui.log) {
      const t = new Date().toTimeString().slice(0, 8);
      ui.log.textContent = (`${t} ${msg}\n` + ui.log.textContent).split('\n').slice(0, 40).join('\n');
    }
  }
  function status(msg) { if (ui.status) ui.status.textContent = msg; }
  function stats() {
    if (ui.stats) ui.stats.textContent =
      `Balance: ${S.balance.toLocaleString('vi-VN')} xu | W/L/D: ${S.wld[0]}/${S.wld[1]}/${S.wld[2]}`;
  }

  // ======================= BINARY CODEC =======================
  class BR {
    constructor(d) { this.d = new DataView(d); this.u8a = new Uint8Array(d); this.pos = 0; }
    rem() { return this.d.byteLength - this.pos; }
    u8() { return this.d.getUint8(this.pos++); }
    i8() { return this.d.getInt8(this.pos++); }
    i16() { const v = this.d.getInt16(this.pos); this.pos += 2; return v; }
    u16() { const v = this.d.getUint16(this.pos); this.pos += 2; return v; }
    i32() { const v = this.d.getInt32(this.pos); this.pos += 4; return v; }
    i64() {
      const hi = this.d.getInt32(this.pos), lo = this.d.getUint32(this.pos + 4);
      this.pos += 8; return hi * 4294967296 + lo;
    }
    ra() { const n = this.u8(); const s = String.fromCharCode(...this.u8a.subarray(this.pos, this.pos + n)); this.pos += n; return s; }
    ru() { const n = this.u16(); let s = ''; for (let i = 0; i < n; i++) { s += String.fromCharCode(this.d.getUint16(this.pos)); this.pos += 2; } return s; }
    rb() { const r = this.u8a.subarray(this.pos); this.pos = this.d.byteLength; return r; }
  }
  const u16b = (v) => [(v >> 8) & 255, v & 255];
  function frameReady() { return new Uint8Array(u16b(CMD.SET_READY)); }
  function frameLeave() { return new Uint8Array([...u16b(CMD.LEAVE_PLACE), 0, 0]); }
  function frameCreate(betId) {
    const p = [...u16b(CMD.CREATE_RULE), betId & 255, 2];
    for (const [k, v] of [['formattedName', ''], ['password', '']]) {
      p.push(k.length, ...Array.from(k).map(c => c.charCodeAt(0) & 255));
      const e = []; for (const c of v) { const cp = c.codePointAt(0); e.push((cp >> 8) & 255, cp & 255); }
      p.push((e.length >> 8) & 255, e.length & 255, ...e);
    }
    return new Uint8Array(p);
  }
  function framePlay(pos) { return new Uint8Array([...u16b(CMD.PLAY), (pos >> 8) & 255, pos & 255]); }

  // ======================= BÀN CỜ =======================
  function resizeBoard(w, h) {
    S.w = w; S.h = h;
    S.grid = Array.from({ length: h }, () => new Array(w).fill(EMPTY));
    S.history = [];
  }
  function loadRLE(bytes) {
    let pos = 0;
    for (let i = 0; i < bytes.length && pos < S.w * S.h; i++) {
      const v = bytes[i];
      if (v > 127) pos += 256 - v;
      else {
        const y = Math.floor(pos / S.w), x = pos % S.w;
        if (y < S.h && x < S.w) { S.grid[y][x] = v; S.history.push([x, y, v]); }
        pos++;
      }
    }
  }
  function inBounds(x, y) { return x >= 0 && y >= 0 && x < S.w && y < S.h; }
  function myTurnNow() {
    if (!S.playing) return false;
    return S.mySid === null || S.turnSid === null || S.turnSid === S.mySid;
  }

  // ======================= HEURISTIC AI =======================
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const PATTERNS = {
    '5,0': 1e7, '5,1': 1e7, '5,2': 1e7,
    '4,2': 1e6, '4,1': 1e5, '4,0': 0,
    '3,2': 5e4, '3,1': 5e3, '3,0': 0,
    '2,2': 2e3, '2,1': 400, '2,0': 0,
    '1,2': 100, '1,1': 25, '1,0': 0,
  };
  function lineInfo(x, y, dx, dy, sym) {
    let cnt = 1, openEnds = 0;
    for (const sign of [1, -1]) {
      let i = 1;
      while (true) {
        const xx = x + dx * i * sign, yy = y + dy * i * sign;
        if (!inBounds(xx, yy)) break;
        const v = S.grid[yy][xx];
        if (v === sym) { cnt++; i++; }
        else { if (v === EMPTY) openEnds++; break; }
      }
    }
    return [cnt, openEnds];
  }
  function cellScore(x, y, sym) {
    let total = 0;
    for (const [dx, dy] of DIRS) {
      const [cnt, oe] = lineInfo(x, y, dx, dy, sym);
      total += PATTERNS[Math.min(cnt, 5) + ',' + oe] || 0;
    }
    return total;
  }
  function candidates() {
    const cand = new Set();
    for (const [sx, sy] of S.history) {
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
        const x = sx + dx, y = sy + dy;
        if (inBounds(x, y) && S.grid[y][x] === EMPTY) cand.add(x + ',' + y);
      }
    }
    if (!cand.size) {
      const cx = Math.floor(S.w / 2), cy = Math.floor(S.h / 2);
      for (let r = 0; r <= 3 && !cand.size; r++)
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const x = cx + dx, y = cy + dy;
          if (inBounds(x, y) && S.grid[y][x] === EMPTY) cand.add(x + ',' + y);
        }
    }
    const list = [...cand].map(s => s.split(',').map(Number));
    if (S.bannedCell && list.length > 1) {
      const filtered = list.filter(([x, y]) => x !== S.bannedCell[0] || y !== S.bannedCell[1]);
      if (filtered.length) return filtered;
    }
    return list;
  }
  function bestMove() {
    const cands = candidates();
    if (!cands.length) return null;
    const sym = S.mySymbol === null ? CIRCLE : S.mySymbol;
    const opp = sym === CIRCLE ? CROSS : CIRCLE;
    for (const [x, y] of cands) for (const [dx, dy] of DIRS) {
      const [cnt] = lineInfo(x, y, dx, dy, sym);
      if (cnt >= 5) return [x, y];
    }
    const blocks = [];
    for (const [x, y] of cands) for (const [dx, dy] of DIRS) {
      const [cnt] = lineInfo(x, y, dx, dy, opp);
      if (cnt >= 5) { blocks.push([x, y]); break; }
    }
    if (blocks.length) {
      let best = blocks[0], bs = -1;
      for (const [x, y] of blocks) { const s = cellScore(x, y, sym); if (s > bs) { bs = s; best = [x, y]; } }
      return best;
    }
    let best = null, bestScore = -1;
    for (const [x, y] of cands) {
      const atk = cellScore(x, y, sym), dfn = cellScore(x, y, opp);
      let score = atk + dfn * 0.9;
      if (atk >= 1e6) score += 5e6;
      score -= (Math.abs(x - S.w / 2) + Math.abs(y - S.h / 2)) * 0.5;
      score += Math.random();
      if (score > bestScore) { bestScore = score; best = [x, y]; }
    }
    return best || cands[0];
  }

  // ======================= GỬI + ĐI NƯỚC =======================
  function send(bytes, label) {
    if (!S.ws || S.ws.readyState !== 1) { log('✗ WS chưa mở'); return; }
    try { S.ws.send(bytes.buffer); if (label) log('↑ ' + label); } catch (e) { log('✗ send: ' + e.message); }
  }

  function scheduleMove(delayMs) {
    S.pendingMove = true;
    clearTimeout(S.turnTimer);
    S.turnTimer = setTimeout(doMove, delayMs);
  }

  function doMove() {
    S.pendingMove = false;
    if (!S.on || !S.playing || S.blockUntilMove || !myTurnNow()) return;
    try {
      const mv = bestMove();
      if (!mv) return;
      const [x, y] = mv;
      if (x === undefined || S.grid[y][x] !== EMPTY) return;
      const pos = y * S.w + x;
      const sym = S.mySymbol === null ? CIRCLE : S.mySymbol;
      S.grid[y][x] = sym;
      S.history.push([x, y, sym]);
      S.myLastSent = [x, y];
      S.myLastSym = sym;
      S.probeSid = S.turnSid;
      send(framePlay(pos), `PLAY (${x},${y}) ${symName(sym)}`);
    } catch (e) { log('✗ doMove: ' + e.message); }
  }

  function undoMyLastSent() {
    if (!S.myLastSent) return;
    const [x, y] = S.myLastSent;
    const sym = S.myLastSym === undefined ? S.mySymbol : S.myLastSym;
    if (inBounds(x, y) && S.grid[y][x] === sym) {
      S.grid[y][x] = EMPTY;
      const i = S.history.findIndex(h => h[0] === x && h[1] === y);
      if (i >= 0) S.history.splice(i, 1);
    }
    S.myLastSent = null;
    S.myLastSym = undefined;
    S.blockUntilMove = false;
  }

  // ======================= TẠO / RỜI BÀN =======================
  function scheduleCreate(delay) {
    if (!S.on) return;
    clearTimeout(S.createTimer);
    S.createTimer = setTimeout(tryCreate, delay || 500);
  }
  function tryCreate() {
    if (!S.on || S.atTable || S.creating || !S.ws || S.ws.readyState !== 1) return;
    S.creating = true;
    S.lastCreate = Date.now();
    send(frameCreate(S.betId), 'CREATE_RULE bet=' + betLabel(S.betId));
    setTimeout(() => { if (S.creating) { S.creating = false; scheduleCreate(CFG.createRetry); } }, 12000);
  }
  function keepReadyLoop() {
    // ở lại bàn, lặp SET_READY để bảng hiện 'Sẵn sàng' trong lobby
    clearInterval(S.readyLoop);
    S.readyLoop = setInterval(() => {
      if (S.on && S.atTable && !S.playing && !S.pendingMove) {
        S.readySent = true;
        send(frameReady(), 'SET_READY (loop)');
      }
    }, 20000);
  }
  function betLabel(id) {
    const ladder = [20, 40, 100, 200, 400, 1000, 2000];
    return (ladder[id] !== undefined ? ladder[id] : 'id' + id) + 'xu';
  }

  // ======================= XỬ LÝ FRAME =======================
  function handleFrame(hex) {
    const buf = new Uint8Array(hex.length / 2);
    for (let i = 0; i < buf.length; i++) buf[i] = parseInt(hex.substr(i * 2, 2), 16);
    if (buf.length < 2) return;
    const br = new BR(buf.buffer);
    const cmd = br.u16();
    switch (cmd) {
      case CMD.CREATE_RULE: {
        if (br.rem() < 1) break;
        const st = br.i8();
        if (st === 0) {
          S.creating = false; S.atTable = true; S.readySent = false;
          S.mySymbol = null; S.playing = false;
          log('✓ Bàn đã tạo (' + betLabel(S.betId) + ') — chờ đối thủ');
          status('Đã tạo bàn — chờ đối thủ...');
          keepReadyLoop();
        } else {
          S.creating = false;
          let msg = '';
          try { if (br.rem() >= 2) msg = br.ru(); } catch (e) {}
          log('✗ Tạo bàn lỗi ' + st + (msg ? ': ' + msg : ''));
          scheduleCreate(CFG.createRetry);
        }
        break;
      }
      case CMD.SET_TURN: {
        if (br.rem() < 5) break;
        const sid = br.i8();
        if (sid === -2) {
          // đếm ngược pre-game → sẵn sàng
          if (S.atTable && !S.readySent && S.on) {
            S.readySent = true;
            send(frameReady(), 'SET_READY');
          }
        } else if (S.playing) {
          S.turnSid = sid;
          if (!S.pendingMove && !S.blockUntilMove && myTurnNow()) scheduleMove(300 + Math.random() * 500);
        }
        break;
      }
      case CMD.START_MATCH: {
        try {
          const pc = br.u8();
          for (let i = 0; i < pc; i++) { br.i8(); br.i32(); }
          const w = br.u8(), h = br.u8();
          resizeBoard(w, h);
          br.i16();
          loadRLE(br.rb());
          S.playing = true; S.readySent = false; S.pendingMove = false;
          S.myLastSent = null; S.myLastSym = undefined; S.bannedCell = null;
          S.mySymbol = null; S.mySid = null; S.turnSid = null; S.probeSid = null;
          S.blockUntilMove = false;
          S.balanceAtGo = S.balance;
          clearTimeout(S.rematchTimer);
          log('▶ START ' + w + 'x' + h + ' — chờ xác định chỗ ngồi/symbol...');
          status('Ván bắt đầu');
        } catch (e) { log('✗ START parse: ' + e.message); }
        break;
      }
      case CMD.MOVE: {
        if (br.rem() < 3) break;
        const pos = br.i16(), sym = br.i8();
        const y = Math.floor(pos / S.w), x = pos % S.w;
        if (!inBounds(x, y)) break;
        const isMyEcho = S.myLastSent && S.myLastSent[0] === x && S.myLastSent[1] === y;
        if (S.grid[y][x] === EMPTY) { S.grid[y][x] = sym; S.history.push([x, y, sym]); }
        else if (S.grid[y][x] !== sym) { S.grid[y][x] = sym; }
        if (isMyEcho) {
          const oldSym = S.mySymbol;
          S.mySymbol = sym;
          if (S.mySid === null && S.probeSid !== null) {
            S.mySid = S.probeSid;
            log('✓ Tôi là sid=' + S.mySid + ', quân ' + symName(sym));
          } else if (oldSym !== null && oldSym !== sym) log('✓ Symbol ván này: ' + symName(sym));
          S.myLastSent = null; S.myLastSym = undefined; S.bannedCell = null;
        }
        S.blockUntilMove = false;
        break;
      }
      case CMD.PLAY: {
        if (br.rem() >= 1) {
          const st = br.i8();
          if (st !== 0) {
            log('✗ Nước bị từ chối (' + st + ') — thử chỗ khác');
            S.bannedCell = S.myLastSent ? S.myLastSent.slice() : null;
            undoMyLastSent();
            S.pendingMove = false;
            S.blockUntilMove = false;
            scheduleMove(CFG.retryDelay);
          }
        }
        break;
      }
      case CMD.GAMEOVER: {
        S.playing = false; S.pendingMove = false; S.myLastSent = null;
        clearTimeout(S.turnTimer);
        const entries = [];
        try {
          const cnt = br.u8();
          for (let i = 0; i < cnt; i++) {
            const sid = br.i8(), res = br.i8(), amt = br.i64();
            entries.push({ sid, res, amt });
          }
        } catch (e) { log('✗ GAMEOVER parse: ' + e.message); }
        let msg = '';
        try { if (br.rem() >= 2) msg = br.ru(); } catch (e) {}
        const delta = S.balanceAtGo !== null ? S.balance - S.balanceAtGo : null;
        S.balanceAtGo = null;

        let mine = entries.find(e => S.mySid !== null && e.sid === S.mySid);
        if (!mine && entries.length) {
          if (/thua/i.test(msg)) mine = entries.find(e => e.amt < 0) || entries.find(e => [2, 4, 12].includes(e.res));
          else if (/thắng|thang/i.test(msg)) mine = entries.find(e => e.amt > 0) || entries.find(e => [1, 11].includes(e.res));
          if (mine && S.mySid === null) S.mySid = mine.sid;
        }
        const amt = mine ? mine.amt : delta;
        const win = mine ? (amt > 0 || [1, 11].includes(mine.res)) : (delta !== null && delta > 0);
        const lose = mine ? (amt < 0 || [2, 4, 12].includes(mine.res)) : (delta !== null && delta < 0);
        if (win) { S.wld[0]++; log('✓✓ THẮNG ' + (amt > 0 ? '+' : '') + Number(amt).toLocaleString('vi-VN') + ' xu'); }
        else if (lose) { S.wld[1]++; log('✗ THUA ' + Number(amt).toLocaleString('vi-VN') + ' xu'); }
        else { S.wld[2]++; log('= Hòa / không rõ (sid=' + S.mySid + ', amt=' + amt + ')'); }
        if (msg) log('  ' + msg);
        stats();
        S.lastGoAt = Date.now();
        status('Hết ván — mời ván mới...');
        clearTimeout(S.rematchTimer);
        S.rematchTimer = setTimeout(() => {
          if (S.on && S.atTable && !S.playing) {
            S.readySent = true;
            send(frameReady(), 'SET_READY (rematch)');
            keepReadyLoop();
          }
        }, CFG.rematchDelay);
        break;
      }
      case CMD.BALANCE_CHANGED: {
        // flag=-1/0: balance của mình; flag=1: của đối thủ → bỏ qua
        if (br.rem() >= 9) {
          const flag = br.i8(), val = br.i64();
          if (flag === -1 || flag === 0) { S.balance = val; stats(); }
        }
        break;
      }
      case CMD.LIST_BET_AMT: {
        try {
          if (br.rem() >= 2) {
            const n = br.u16();
            const bets = [];
            for (let i = 0; i < n && br.rem() >= 4; i++) bets.push(br.i32());
            if (bets.length) log('Bet ladder: ' + bets.map((v, i) => v + '(id' + i + ')').join(', '));
          }
        } catch (e) {}
        break;
      }
      case CMD.PLAYER_EXITED: {
        // ở lại bàn — SET_READY chờ người mới (LEAVE làm hỏng place-state WS)
        if (S.atTable && S.on) {
          S.playing = false; S.mySymbol = null; S.mySid = null; S.myLastSent = null; S.bannedCell = null;
          log('Đối thủ rời — chờ người mới...');
          status('Chờ đối thủ mới...');
          setTimeout(() => {
            if (S.on && S.atTable && !S.playing) { S.readySent = true; send(frameReady(), 'SET_READY (chờ người mới)'); }
          }, 3000);
        }
        break;
      }
      case CMD.KICK_PLAYER: {
        log('✗ Bị kick — thử SET_READY lại');
        S.playing = false; S.readySent = false;
        break;
      }
    }
  }

  // ======================= WEBSOCKET HOOK =======================
  const OrigWS = window.WebSocket;
  function HookedWS(url, protocols) {
    const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
    const isGame = /gameServer|gamevh|game8/i.test(String(url));
    ws.addEventListener('open', () => {
      if (!isGame) return;
      S.ws = ws;
      log('● WS connect: ' + url);
      status('WS kết nối — bấm BẬT để auto');
    });
    ws.addEventListener('close', () => {
      if (S.ws === ws) {
        S.ws = null; S.atTable = false; S.playing = false; S.creating = false;
        log('○ WS đóng');
        status('Mất kết nối WS');
      }
    });
    ws.addEventListener('message', (e) => {
      if (!isGame) return;
      const d = e.data;
      if (d instanceof ArrayBuffer) { handleFrame(bufToHex(new Uint8Array(d))); return; }
      if (typeof d === 'string') return;
      if (d instanceof Blob) d.arrayBuffer().then(ab => handleFrame(bufToHex(new Uint8Array(ab)))).catch(() => {});
    });
    if (isGame) window.__gvBotWS = ws;
    return ws;
  }
  HookedWS.prototype = OrigWS.prototype;
  HookedWS.OPEN = OrigWS.OPEN; HookedWS.CLOSED = OrigWS.CLOSED;
  HookedWS.CLOSING = OrigWS.CLOSING; HookedWS.CONNECTING = OrigWS.CONNECTING;
  window.WebSocket = HookedWS;

  function bufToHex(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
    return s;
  }

  // ======================= KHỞI ĐỘNG =======================
  function boot() {
    buildUI();
    log('Userscript v1.3 — vào game Cờ Caro rồi bấm BẬT');
    setInterval(() => {
      if (S.on && !S.atTable && !S.creating && Date.now() - S.lastCreate > CFG.createIdle) tryCreate();
    }, 2000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
