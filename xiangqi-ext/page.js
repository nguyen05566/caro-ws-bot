(() => {
  'use strict';
  if (window.__xqBotLoaded) return;
  window.__xqBotLoaded = true;
  const CMD = { CREATE_RULE: 405, ENTERED: 406, EXITED: 407, LIST_BET: 413,
    START: 417, GAMEOVER: 418, TURN: 420, STATUS: 421, BALANCE: 431,
    READY: 434, PLAY: 502, MOVE: 529 };
  const N = 90;
  const EMPTY = 0;

  const S = {
    on: false, ws: null, atTable: false, playing: false, balance: 0,
    board: new Array(N).fill(EMPTY), mySid: null, mySide: null,
    myTurn: false, lastSent: null, lastSentOk: false, ready: false,
    reqId: 0, pending: null, retryTimer: null, readyTimer: null,
    moveTimer: null, firstMoveSeen: false, turns: 0, wld: [0, 0, 0],
  };

  const initial = {};
  const backRed = ['R','N','B','A','K','A','B','N','R'];
  const backBlack = ['r','n','b','a','k','a','b','n','r'];
  for (let x = 0; x < 9; x++) {
    initial[9 * 9 + x] = backRed[x];
    initial[0 * 9 + x] = backBlack[x];
  }
  for (const x of [1, 7]) { initial[7 * 9 + x] = 'C'; initial[2 * 9 + x] = 'c'; }
  for (const x of [0, 2, 4, 6, 8]) { initial[6 * 9 + x] = 'P'; initial[3 * 9 + x] = 'p'; }

  function log(msg) {
    console.log('[XQBOT]', msg);
    if (ui.log) ui.log.textContent = (new Date().toTimeString().slice(0, 8) + ' ' + msg + '\n' + ui.log.textContent).split('\n').slice(0, 40).join('\n');
  }
  function status(msg) { if (ui.status) ui.status.textContent = msg; }
  function stats() { if (ui.stats) ui.stats.textContent = `Balance: ${S.balance} xu | W/L/D: ${S.wld.join('/')}`; }

  const ui = {};
  function buildUI() {
    if (ui.root) return;
    const el = document.createElement('div');
    el.innerHTML = `<div style="all:initial;position:fixed;top:8px;right:8px;z-index:999999;font-family:Arial,sans-serif">
      <div id="xq-panel" style="display:none;width:240px;background:#141922ee;color:#dde;border:1px solid #456;border-radius:8px;padding:8px;font-size:12px">
        <div style="display:flex;justify-content:space-between"><b style="color:#8f8">XIANGQI BOT</b><span id="xq-hide" style="cursor:pointer">—</span></div>
        <div style="margin:5px 0"><button id="xq-toggle" style="background:#a33;color:#fff;border:0;border-radius:4px;padding:2px 10px">BẬT</button>
        <span style="color:#fd5">Cược 100xu</span></div>
        <div id="xq-status" style="color:#fd5">Chưa kết nối</div>
        <div id="xq-stats" style="color:#abc"></div>
        <div id="xq-log" style="max-height:110px;overflow:auto;font-size:10px;color:#9ab;white-space:pre-wrap"></div>
      </div><div id="xq-fab" style="background:#a33;color:#fff;border-radius:50%;width:38px;height:38px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:11px;border:2px solid #fff3">XQ</div></div>`;
    document.documentElement.appendChild(el);
    ui.root = el;
    ui.panel = el.querySelector('#xq-panel'); ui.fab = el.querySelector('#xq-fab');
    ui.status = el.querySelector('#xq-status'); ui.stats = el.querySelector('#xq-stats');
    ui.log = el.querySelector('#xq-log'); ui.toggle = el.querySelector('#xq-toggle');
    el.querySelector('#xq-hide').onclick = () => { ui.panel.style.display = 'none'; ui.fab.style.display = 'flex'; };
    ui.fab.onclick = () => { ui.panel.style.display = 'block'; ui.fab.style.display = 'none'; };
    ui.toggle.onclick = () => {
      S.on = !S.on;
      ui.toggle.textContent = S.on ? 'TẮT' : 'BẬT';
      ui.toggle.style.background = S.on ? '#2a4' : '#a33';
      log(S.on ? '▶ BOT BẬT' : '⏸ TẮT');
      if (S.on) { post({ type: 'ENGINE_START' }); setTimeout(create, 4000); }
    };
  }

  function post(msg) { window.postMessage({ source: 'gv-xq-bot', ...msg }, '*'); }

  // Engine chay ngay trong page-world blob worker (trang duoc COOP/COEP nhờ DNR)
  let eWorker = null, eBuf = null, netBuf = null, wasmBuf = null, lines = [], want = null, initStarted = false;
  async function initEngine(base) {
    if (initStarted) return;
    initStarted = true;
    try {
      log('Dang tai Pikafish WASM...');
      const fJs = fetch(base + 'pikafish.js').then(r => r.text());
      const fWasm = fetch(base + 'pikafish.wasm').then(r => r.arrayBuffer());
      const fNet = fetch(base + 'pikafish.nnue').then(r => r.arrayBuffer());
      const [js, wasm, net] = await Promise.all([fJs, fWasm, fNet]);
      wasmBuf = wasm; netBuf = net; eBuf = js;
      const driver = `
let M=null, lines=[], curId=0;
const IS_PTHREAD = self.name && self.name.indexOf('em-pthread') === 0;
const emit = s => { lines.push(s); if(lines.length>300) lines.shift(); postMessage({type:'line', s}); };
if (!IS_PTHREAD) self.onmessage = e => {
  const m = e.data;
  if (m.type === 'BOOT') {
    postMessage({type:'line',s:'BOOT: importing '+m.base});
    try { importScripts(m.base + 'pikafish.js'); }
    catch (err) { postMessage({type:'line',s:'BOOT: import fail ' + err}); return; }
    postMessage({type:'line',s:'BOOT: imported, Pikafish=' + typeof self.Pikafish});
    self.Pikafish({ locateFile: p => m.base + p, print: emit, printErr: emit, mainScriptUrlOrBlob: m.blobUrl }).then(mod => {
      M = mod;
      postMessage({type:'line',s:'BOOT: module instantiated'});
      return fetch(m.base + 'pikafish.nnue').then(r => r.arrayBuffer()).then(buf => {
        M.FS.writeFile('/pikafish.nnue', new Uint8Array(buf));
        postMessage({type:'line',s:'BOOT: net written'});
        M._pikafish_initialize();
        postMessage({type:'line',s:'BOOT: engine initialized'});
        const cmd = s => M.ccall('pikafish_command', null, ['string'], [s]);
        cmd('setoption name Threads value 1');
        cmd('setoption name Hash value 128');
        postMessage({type:'ready'});
      });
    }).catch(err => postMessage({type:'error', msg:String(err)}));
    return;
  }
  if (m.type === 'GO' && M) {
    curId = m.id; lines = [];
    const cmd = s => M.ccall('pikafish_command', null, ['string'], [s]);
    cmd('position fen ' + m.fen + ' ' + m.side);
    cmd('go movetime ' + (m.movetime || 2000));
    poll();
  }
};
function poll() {
  const bm = lines.slice().reverse().find(l => l.indexOf('bestmove') === 0);
  if (bm) { postMessage({type:'result', id:curId, move:(bm.split(/\\s+/)[1]||'')}); return; }
  setTimeout(poll, 40);
}
`;
      const blob = new Blob([js, '\n', driver], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      eWorker = new Worker(blobUrl);
      eWorker.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'ready') { S.ready = true; log('✓ Pikafish WASM sẵn sàng'); }
        else if (d.type === 'error') log('✗ Engine: ' + d.msg);
        else if (d.type === 'result' && S.pending && d.id === S.pending) { S.pending = null; playUci(d.move); }
        else if (d.type === 'line' && d.s.indexOf('bestmove') === 0) log('ENGINE ' + d.s);
      };
      eWorker.onerror = (e) => log('✗ Worker: ' + e.message);
      eWorker.postMessage({ type: 'BOOT', base: base, blobUrl: blobUrl });
    } catch (err) { log('✗ Engine init: ' + err.message); }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'gv-xq-ext') return;
    if (e.data.type === 'ENGINE_BASE') initEngine(e.data.base);
  });

  function send(bytes, label) {
    if (!S.ws || S.ws.readyState !== 1) return;
    S.ws.send(new Uint8Array(bytes).buffer);
    if (label) log('↑ ' + label);
  }
  function u16(v) { return [(v >> 8) & 255, v & 255]; }
  function frameCreate() {
    const p = [...u16(CMD.CREATE_RULE), 0, 2];
    for (const k of ['formattedName', 'password']) p.push(k.length, ...Array.from(k).map(c => c.charCodeAt(0)), 0, 0);
    return p;
  }
  const frameReady = () => u16(CMD.READY);
  const framePlay = (from, to) => [...u16(CMD.PLAY), from, to];
  function create() {
    if (!S.on || S.atTable || !S.ws || S.ws.readyState !== 1) return;
    send(frameCreate(), 'CREATE_RULE 100xu');
    setTimeout(create, 10000);
  }
  function scheduleReady() {
    clearTimeout(S.readyTimer);
    S.readyTimer = setTimeout(() => {
      if (S.on && S.atTable && !S.playing) { send(frameReady(), 'SET_READY'); scheduleReadyKeep(); }
    }, 3000);
  }
  function scheduleReadyKeep() {
    clearInterval(S.readyLoop);
    S.readyLoop = setInterval(() => { if (S.on && S.atTable && !S.playing && !S.pending) send(frameReady(), 'SET_READY (loop)'); }, 20000);
  }

  function fen() {
    const rows = [];
    for (let y = 0; y < 10; y++) {
      let row = '', gap = 0;
      for (let x = 0; x < 9; x++) {
        const v = S.board[y * 9 + x];
        if (v === EMPTY) gap++;
        else { if (gap) { row += gap; gap = 0; } row += v; }
      }
      if (gap) row += gap;
      rows.push(row);
    }
    return rows.join('/') + ' ' + (S.mySide === 'r' ? 'w' : 'b') + ' - - 0 1';
  }
  function uciToPos(s) {
    const file = s.charCodeAt(0) - 97, rank = parseInt(s[1], 10);
    return (9 - rank) * 9 + file;
  }
  function isMine(p) { const v = S.board[p]; return S.mySide === 'r' ? v >= 'A' && v <= 'Z' : v >= 'a' && v <= 'z'; }

  function askEngine() {
    if (!S.ready || S.pending || !eWorker || !S.myTurn || !S.mySide || !S.playing) return;
    S.pending = ++S.reqId;
    eWorker.postMessage({ type: 'GO', id: S.pending, fen: fen(), side: S.mySide === 'r' ? 'w' : 'b', movetime: 2000 });
  }
  function playUci(mv) {
    if (!mv || mv.length < 4) return;
    const from = uciToPos(mv.slice(0, 2)), to = uciToPos(mv.slice(2, 4));
    if (from < 0 || from >= N || to < 0 || to >= N || !isMine(from)) return;
    S.lastSent = [from, to]; S.lastSentOk = false;
    send(framePlay(from, to), `PLAY ${mv} (${from}->${to})`);
  }

  function handleFrame(hex) {
    const b = new Uint8Array(hex.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
    if (b.length < 2) return;
    const cmd = ((b[0] << 8) | b[1]);
    if (cmd === CMD.CREATE_RULE && b.length >= 3) {
      if (b[2] === 0) { S.atTable = true; log('✓ Bàn 100xu đã tạo'); scheduleReady(); }
      else if (b[2] === 255) {
        S.atTable = true;
        log('⚠ Server còn giữ bàn cũ — SET_READY chờ ván mới');
        scheduleReady();
      } else { S.atTable = false; log('✗ Tạo bàn lỗi ' + b[2]); }
    } else if (cmd === CMD.BALANCE && b.length >= 11) {
      const flag = b[2] | 0;
      if (flag === -1 || flag === 0) {
        S.balance = ((b[3] << 24) | (b[4] << 16) | (b[5] << 8) | b[6]);
        stats();
      }
    } else if (cmd === CMD.START) {
      S.playing = true; S.mySid = 0; S.mySide = null; S.turns = 0; S.firstMoveSeen = false; S.myTurn = false;
      S.lastSent = null; S.pending = null; S.board.fill(EMPTY);
      for (const [p, v] of Object.entries(initial)) S.board[p] = v;
      log('▶ START — chờ xác định bên');
      status('Ván bắt đầu');
    } else if (cmd === CMD.TURN && b.length >= 3) {
      const sid = b[2] | 0;
      if (sid >= 0 && S.playing) {
        S.turns++;
        if (S.mySide === null && S.turns === 1) {
          S.mySide = sid === 0 ? 'r' : 'b';
          log('✓ Tôi bên ' + (S.mySide === 'r' ? 'ĐỎ' : 'ĐEN'));
        }
        S.myTurn = sid !== S.mySid;
        if (S.myTurn && S.mySide !== null && !S.pending) setTimeout(askEngine, 200);
      }
    } else if (cmd === CMD.MOVE && b.length >= 5) {
      const from = b[2], to = b[3], flag = b[4] | 0;
      const echo = S.lastSent && S.lastSent[0] === from && S.lastSent[1] === to && S.lastSentOk;
      if (S.playing && !S.firstMoveSeen && !echo) {
        S.firstMoveSeen = true;
        if (S.mySide === null) S.mySide = flag === 0 ? 'b' : 'r';
      }
      if (echo) {
        if (S.mySide === null) S.mySide = flag === 0 ? 'r' : 'b';
        S.lastSent = null; S.lastSentOk = false; S.myTurn = false;
      } else if (S.playing) {
        S.myTurn = true;
        if (S.mySide !== null && !S.pending) setTimeout(askEngine, 300);
      }
      if (S.board[from] !== EMPTY) { S.board[to] = S.board[from]; S.board[from] = EMPTY; }
    } else if (cmd === CMD.PLAY && b.length >= 3) {
      const st = b[2] | 0;
      if (st === 0) S.lastSentOk = true;
      else { log('✗ Nước bị chối (' + st + ')'); S.lastSent = null; S.pending = null; S.myTurn = false; }
    } else if (cmd === CMD.GAMEOVER) {
      S.playing = false; S.lastSent = null; S.pending = null;
      log('■ GAMEOVER'); status('Hết ván');
      scheduleReady();
    } else if (cmd === CMD.EXITED) {
      S.playing = false; S.mySid = null; S.mySide = null;
      log('Đối thủ rời'); scheduleReady();
    }
  }

  const OrigWS = window.WebSocket;
  function HookedWS(url, protocols) {
    const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
    const isGame = /gameServer|gamevh|game8/i.test(String(url));
    ws.addEventListener('open', () => { if (isGame) { S.ws = ws; log('● WS kết nối'); status('WS OK'); } });
    ws.addEventListener('close', () => { if (isGame) { S.ws = null; S.atTable = false; S.playing = false; status('Mất WS'); } });
    ws.addEventListener('message', (e) => {
      if (!isGame) return;
      const rec = (u8) => { let s = ''; for (const v of u8) s += v.toString(16).padStart(2, '0'); handleFrame(s); };
      if (e.data instanceof ArrayBuffer) rec(new Uint8Array(e.data));
      else if (e.data instanceof Blob) e.data.arrayBuffer().then(a => rec(new Uint8Array(a))).catch(() => {});
    });
    return ws;
  }
  HookedWS.prototype = OrigWS.prototype;
  HookedWS.OPEN = OrigWS.OPEN; HookedWS.CLOSED = OrigWS.CLOSED;
  HookedWS.CLOSING = OrigWS.CLOSING; HookedWS.CONNECTING = OrigWS.CONNECTING;
  window.WebSocket = HookedWS;

  function boot() { buildUI(); post({ type: 'REQUEST_BASE' }); log('Xiangqi bot sẵn sàng — bấm BẬT'); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
