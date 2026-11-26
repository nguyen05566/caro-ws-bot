/* Gomoku alpha-beta engine cho gamevh Caro (15x19), biên dịch sang WASM.
 * Board: 0 = trống, 1 = bên đi, 2 = đối thủ. Export: board_ptr/init/best. */

#define W 15
#define H 19
#define N 285
#define WINSCORE 10000000
#define MAXW 800
#define MAXNEAR 24

static unsigned char board[N];
static unsigned char nearc[N];
static unsigned char cnt[2][MAXW];
static int wcells[MAXW][5];
static int cellw[N][MAXNEAR];
static unsigned char cellwn[N];
static int wprev[MAXW], wnext[MAXW];
static int endw[N][8];
static unsigned char endwn[N];
static int nwin;
static int score[2];
static const int WTABLE[6] = {0, 1, 8, 90, 3000, 1000000};
static const int DX[4] = {1, 0, 1, 1};
static const int DY[4] = {0, 1, 1, -1};
static int nodes_left, aborted;
static int built;
static int wval(int w, int pi);

static void addwin(int x, int y, int dx, int dy) {
  int idx = nwin++;
  for (int k = 0; k < 5; k++) {
    int c = (y + k * dy) * W + (x + k * dx);
    wcells[idx][k] = c;
    if (cellwn[c] < MAXNEAR) cellw[c][cellwn[c]++] = idx;
  }
  int bx = x - dx, by = y - dy;
  int ax = x + 4 * dx, ay = y + 4 * dy;
  wprev[idx] = (bx >= 0 && bx < W && by >= 0 && by < H) ? by * W + bx : -1;
  wnext[idx] = (ax >= 0 && ax < W && ay >= 0 && ay < H) ? ay * W + ax : -1;
  if (wprev[idx] >= 0 && endwn[wprev[idx]] < 8) endw[wprev[idx]][endwn[wprev[idx]]++] = idx;
  if (wnext[idx] >= 0 && endwn[wnext[idx]] < 8) endw[wnext[idx]][endwn[wnext[idx]]++] = idx;
}

static void build_windows(void) {
  for (int y = 0; y < H; y++) for (int x = 0; x + 4 < W; x++) addwin(x, y, 1, 0);
  for (int x = 0; x < W; x++) for (int y = 0; y + 4 < H; y++) addwin(x, y, 0, 1);
  for (int y = 0; y + 4 < H; y++) for (int x = 0; x + 4 < W; x++) addwin(x, y, 1, 1);
  for (int y = 0; y + 4 < H; y++) for (int x = 4; x < W; x++) addwin(x, y, -1, 1);
  built = 1;
}

static void bump_near(int c, int delta) {
  int x = c % W, y = c / W;
  for (int dy = -2; dy <= 2; dy++) for (int dx = -2; dx <= 2; dx++) {
    if (dx == 0 && dy == 0) continue;
    int nx = x + dx, ny = y + dy;
    if (nx >= 0 && nx < W && ny >= 0 && ny < H) nearc[ny * W + nx] += delta;
  }
}

void init(void) {
  if (!built) build_windows();
  for (int p = 0; p < 2; p++) for (int w = 0; w < nwin; w++) cnt[p][w] = 0;
  for (int c = 0; c < N; c++) nearc[c] = 0;
  score[0] = score[1] = 0;
  for (int c = 0; c < N; c++) if (board[c]) {
    int pi = board[c] - 1;
    for (int k = 0; k < cellwn[c]; k++) cnt[pi][cellw[c][k]]++;
    bump_near(c, 1);
  }
  for (int w = 0; w < nwin; w++) {
    score[0] += wval(w, 0);
    score[1] += wval(w, 1);
  }
}

unsigned char *board_ptr(void) { return board; }

/* Giá trị cửa sổ 5 theo luật Caro: 5 bị chặn 2 đầu hoặc quá 5 không được điểm thắng */
static int wval_n(int w, int pi, int n) {
  if (cnt[1 - pi][w]) return 0;
  if (n == 5) {
    int b = wprev[w], a = wnext[w];
    int bv = b >= 0 ? board[b] : 0, av = a >= 0 ? board[a] : 0;
    if ((b >= 0 && bv == pi + 1) || (a >= 0 && av == pi + 1)) return 0;
    if ((b >= 0 && bv != 0) && (a >= 0 && av != 0)) return 0;
  }
  return WTABLE[n];
}
static int wval(int w, int pi) { return wval_n(w, pi, cnt[pi][w]); }

static int gain_at(int c, int p) {
  int pi = p - 1, g = 0;
  for (int k = 0; k < cellwn[c]; k++) {
    int w = cellw[c][k];
    if (!cnt[1 - pi][w]) {
      int o = cnt[pi][w];
      g += wval_n(w, pi, o + 1) - wval_n(w, pi, o);
    }
  }
  return g;
}

static void place(int c, int p) {
  int pi = p - 1;
  for (int k = 0; k < endwn[c]; k++) {
    int w = endw[c][k];
    score[0] -= wval(w, 0); score[1] -= wval(w, 1);
  }
  for (int k = 0; k < cellwn[c]; k++) score[pi] -= wval(cellw[c][k], pi);
  board[c] = (unsigned char)p;
  for (int k = 0; k < cellwn[c]; k++) cnt[pi][cellw[c][k]]++;
  bump_near(c, 1);
  for (int k = 0; k < cellwn[c]; k++) score[pi] += wval(cellw[c][k], pi);
  for (int k = 0; k < endwn[c]; k++) {
    int w = endw[c][k];
    score[0] += wval(w, 0); score[1] += wval(w, 1);
  }
}

static void unplace(int c, int p) {
  int pi = p - 1;
  for (int k = 0; k < endwn[c]; k++) {
    int w = endw[c][k];
    score[0] -= wval(w, 0); score[1] -= wval(w, 1);
  }
  for (int k = 0; k < cellwn[c]; k++) score[pi] -= wval(cellw[c][k], pi);
  for (int k = 0; k < cellwn[c]; k++) cnt[pi][cellw[c][k]]--;
  board[c] = 0;
  bump_near(c, -1);
  for (int k = 0; k < cellwn[c]; k++) score[pi] += wval(cellw[c][k], pi);
  for (int k = 0; k < endwn[c]; k++) {
    int w = endw[c][k];
    score[0] += wval(w, 0); score[1] += wval(w, 1);
  }
}

/* Luật Caro: thắng khi đúng 5 quân liên tiếp và không bị chặn cả 2 đầu.
 * OXXXXO không thắng, XXXXXX (quá 5) không thắng, mép bàn không tính là chặn. */
static int win_at(int c, int p) {
  int x = c % W, y = c / W;
  for (int d = 0; d < 4; d++) {
    int sx = x, sy = y, ex = x, ey = y;
    while (sx - DX[d] >= 0 && sx - DX[d] < W && sy - DY[d] >= 0 && sy - DY[d] < H &&
           board[(sy - DY[d]) * W + (sx - DX[d])] == p) { sx -= DX[d]; sy -= DY[d]; }
    while (ex + DX[d] >= 0 && ex + DX[d] < W && ey + DY[d] >= 0 && ey + DY[d] < H &&
           board[(ey + DY[d]) * W + (ex + DX[d])] == p) { ex += DX[d]; ey += DY[d]; }

    int len = 0;
    for (int cx = sx, cy = sy; ; cx += DX[d], cy += DY[d]) {
      len++;
      if (cx == ex && cy == ey) break;
    }
    if (len != 5) continue;

    int bx = sx - DX[d], by = sy - DY[d];
    int ax = ex + DX[d], ay = ey + DY[d];
    int blockedB = bx >= 0 && bx < W && by >= 0 && by < H && board[by * W + bx] != 0;
    int blockedA = ax >= 0 && ax < W && ay >= 0 && ay < H && board[ay * W + ax] != 0;
    if (!blockedB || !blockedA) return 1;
  }
  return 0;
}

int is_win(int c, int p) { return win_at(c, p); }

static int evaluate(int p) {
  int pi = p - 1, oi = 1 - pi;
  return score[pi] - (score[oi] * 11) / 10;
}

static int genmoves(int p, int *moves, int *gains, int limit) {
  int n = 0;
  for (int c = 0; c < N; c++) {
    if (board[c] || !nearc[c]) continue;
    int g = gain_at(c, p) + (gain_at(c, 3 - p) * 9) / 10;
    int i = n < limit ? n : limit - 1;
    while (i > 0 && g > gains[i - 1]) {
      gains[i] = gains[i - 1]; moves[i] = moves[i - 1]; i--;
    }
    gains[i] = g; moves[i] = c;
    if (n < limit) n++;
  }
  return n;
}

static int search(int depth, int alpha, int beta, int p, int ply) {
  if (--nodes_left <= 0) { aborted = 1; return 0; }
  if (depth <= 0) return evaluate(p);
  int moves[12], gains[12];
  int n = genmoves(p, moves, gains, 12);
  if (!n) return evaluate(p);
  int best = -WINSCORE;
  for (int i = 0; i < n; i++) {
    int c = moves[i];
    place(c, p);
    int sc;
    if (win_at(c, p)) sc = WINSCORE - ply;
    else sc = -search(depth - 1, -beta, -alpha, 3 - p, ply + 1);
    unplace(c, p);
    if (aborted) return 0;
    if (sc > best) best = sc;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

int best(int my, int max_depth, int max_nodes) {
  int center = 9 * W + 7;
  int any = 0;
  for (int c = 0; c < N; c++) if (board[c]) { any = 1; break; }
  if (!any) return center;

  int result = -1, result_score = -WINSCORE * 2;
  for (int depth = 2; depth <= max_depth; depth += 2) {
    nodes_left = max_nodes;
    aborted = 0;
    int moves[16], gains[16], n = genmoves(my, moves, gains, 16);
    if (!n) break;
    if (result >= 0) for (int i = 0; i < n; i++) if (moves[i] == result) {
      int mc = moves[i], mg = gains[i];
      for (int j = i; j > 0; j--) { moves[j] = moves[j - 1]; gains[j] = gains[j - 1]; }
      moves[0] = mc; gains[0] = mg;
      break;
    }
    int alpha = -WINSCORE * 2, local = -1, local_score = -WINSCORE * 2;
    for (int i = 0; i < n; i++) {
      int c = moves[i];
      place(c, my);
      int sc = win_at(c, my) ? WINSCORE - 1
             : -search(depth - 1, -WINSCORE * 2, -alpha, 3 - my, 1);
      unplace(c, my);
      if (aborted) break;
      if (sc > local_score) { local_score = sc; local = c; }
      if (sc > alpha) alpha = sc;
    }
    if (!aborted && local >= 0) { result = local; result_score = local_score; }
    if (result_score >= WINSCORE - 20 || nodes_left <= 0) break;
  }
  return result;
}
