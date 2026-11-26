#!/usr/bin/env node
/* Test chiến thuật cho engine WASM: node engine/test.js */
const fs = require('fs');
const path = require('path');

(async () => {
  const bytes = fs.readFileSync(path.join(__dirname, 'gomoku.wasm'));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const e = instance.exports;
  const b = new Uint8Array(e.memory.buffer, e.board_ptr(), 285);
  const pos = (x, y) => y * 15 + x;
  let fails = 0;

  function board(stones) {
    b.fill(0);
    for (const [x, y, v] of stones) b[pos(x, y)] = v;
    e.init();
  }
  function check(name, expect, got) {
    const ok = expect.includes(got);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${got} (x=${got % 15},y=${Math.floor(got / 15)})`);
    if (!ok) fails++;
  }

  board([]);
  check('bàn trống → center', [pos(7, 9)], e.best(1, 6, 120000));

  board([[3, 5, 2], [4, 5, 2], [5, 5, 2], [6, 5, 2], [7, 9, 1]]);
  check('chặn 4 ngang đối thủ', [pos(2, 5), pos(7, 5)], e.best(1, 6, 120000));

  board([[3, 5, 1], [4, 5, 1], [5, 5, 1], [6, 5, 1], [7, 9, 2]]);
  check('tự chốt 4 ngang thắng', [pos(2, 5), pos(7, 5)], e.best(1, 6, 120000));

  function notGap(name, cells, gap) {
    board(cells);
    const mv = e.best(1, 6, 120000);
    const ok = mv !== gap;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: không đánh vào gap (got ${mv})`);
    if (!ok) fails++;
  }

  notGap('OXX.XXO → 5 bị chặn 2 đầu, KHÔNG đánh giữa', [[0, 9, 2], [1, 9, 1], [2, 9, 1], [4, 9, 1], [5, 9, 1], [6, 9, 2]], pos(3, 9));
  notGap('OX.XXXO → 5 bị chặn 2 đầu, KHÔNG đánh giữa', [[0, 9, 2], [1, 9, 1], [3, 9, 1], [4, 9, 1], [5, 9, 1], [6, 9, 2]], pos(2, 9));
  notGap('OXXX.XO → 5 bị chặn 2 đầu, KHÔNG đánh giữa', [[0, 9, 2], [1, 9, 1], [2, 9, 1], [3, 9, 1], [5, 9, 1], [6, 9, 2]], pos(4, 9));

  board([[1, 9, 1], [2, 9, 1], [4, 9, 1], [5, 9, 1]]);
  check('.XX.XX. → 5 hai đầu mở, đánh giữa thắng', [pos(3, 9)], e.best(1, 6, 120000));

  function winCase(name, cells, expect) {
    board(cells);
    const got = e.is_win(pos(3, 9), 1);
    console.log(`${got === expect ? 'PASS' : 'FAIL'} ${name}: is_win=${got} expect=${expect}`);
    if (got !== expect) fails++;
  }

  winCase('5 quân, 2 đầu mở → thắng', [[1,9,1],[2,9,1],[3,9,1],[4,9,1],[5,9,1]], 1);
  winCase('OXXXXO → KHÔNG thắng', [[0,9,2],[1,9,1],[2,9,1],[3,9,1],[4,9,1],[5,9,1],[6,9,2]], 0);
  winCase('OXXXXX. → thắng', [[0,9,2],[1,9,1],[2,9,1],[3,9,1],[4,9,1],[5,9,1]], 1);
  winCase('quá 5 (XXXXXX) → KHÔNG thắng', [[0,9,1],[1,9,1],[2,9,1],[3,9,1],[4,9,1],[5,9,1]], 0);

  board([[7, 9, 1], [8, 9, 2], [7, 10, 1], [8, 10, 2], [6, 9, 1], [9, 9, 2]]);
  const mv = e.best(1, 6, 120000);
  check('không đánh vào ô đã có quân', Array.from({ length: 285 }, (_, i) => i).filter(i => b[i] === 0), mv);

  const t = Date.now();
  e.best(1, 6, 120000);
  console.log('thời gian 1 lượt:', Date.now() - t, 'ms');
  if (fails) process.exit(1);
})();
