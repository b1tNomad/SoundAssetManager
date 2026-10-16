// Board geometry shared by the browser and the server (migration): card sizes, placing cards
// inside frames, frame membership and the order cards are merged in.

export const CARD_W = 420; // default card width (cards can be made wider or narrower)
export const CARD_MIN_W = 240;
export const CARD_MAX_W = 1600;
export const CARD_H = 156; // fixed card height on the board
export const GAP = 16;
export const PAD = 24; // inner padding of a frame

export const FRAME_TYPES = [
  ['split', 'Нарізка'],
  ['trim', 'Обрізка'],
  ['merge', 'Склейка'],
  ['free', 'Вільний'],
];
export const FRAME_LABEL = Object.fromEntries(FRAME_TYPES);

export const cardW = (c) => c.w || CARD_W;
export const centerOf = (c) => ({ x: c.x + cardW(c) / 2, y: c.y + CARD_H / 2 });
export const inside = (f, p) => p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h;

/** Frame under a point (the last drawn wins, like layers). */
export function frameAt(frames, p) {
  for (let i = frames.length - 1; i >= 0; i--) if (inside(frames[i], p)) return frames[i];
  return null;
}

/** Cards in reading order: rows top to bottom (cards whose tops are close share a row), then left to right. */
export function readingOrder(cards) {
  const sorted = [...cards].sort((a, b) => a.y - b.y);
  const rows = [];
  for (const c of sorted) {
    const row = rows.find((r) => Math.abs(r.y - c.y) < CARD_H / 2);
    if (row) row.list.push(c);
    else rows.push({ y: c.y, list: [c] });
  }
  return rows.flatMap((r) => r.list.sort((a, b) => a.x - b.x));
}

/** Positions for `n` cards laid out in a grid of `cols` columns starting at (x0, y0). */
export function grid(n, x0, y0, cols, w = CARD_W) {
  return Array.from({ length: n }, (_, i) => ({ x: x0 + (i % cols) * (w + GAP), y: y0 + Math.floor(i / cols) * (CARD_H + GAP) }));
}

/** Frame grown (never shrunk) so every card fits inside with padding. */
export function fitFrame(frame, cards) {
  let { x, y, w, h } = frame;
  let r = x + w;
  let b = y + h;
  for (const c of cards) {
    x = Math.min(x, c.x - PAD);
    y = Math.min(y, c.y - PAD);
    r = Math.max(r, c.x + cardW(c) + PAD);
    b = Math.max(b, c.y + CARD_H + PAD);
  }
  return { ...frame, x, y, w: r - x, h: b - y };
}

/**
 * Where `n` new cards go inside a frame: a new row (or rows) under everything already in it —
 * or right under `after` (the source card) when there is room. Returns { positions, frame }
 * with the frame grown to fit.
 */
export function placeInFrame(frame, members, n, { w = CARD_W, after = null } = {}) {
  const x0 = frame.x + PAD;
  const usable = Math.max(w, frame.w - 2 * PAD);
  const cols = Math.max(1, Math.floor((usable + GAP) / (w + GAP)));
  const bottom = members.reduce((m, c) => Math.max(m, c.y + CARD_H), frame.y + PAD - GAP);
  let y0 = bottom + GAP;
  // Right under the source if nothing is in the way there.
  if (after) {
    const yy = after.y + CARD_H + GAP;
    const rows = Math.ceil(n / cols);
    const area = { x: x0, y: yy, w: cols * (w + GAP), h: rows * (CARD_H + GAP) };
    const blocked = members.some((c) => c.uid !== after.uid && c.x < area.x + area.w && c.x + cardW(c) > area.x && c.y < area.y + area.h && c.y + CARD_H > area.y);
    if (!blocked) y0 = yy;
  }
  const positions = grid(n, x0, y0, cols, w);
  const placed = positions.map((p) => ({ ...p, w }));
  return { positions, frame: fitFrame(frame, [...members, ...placed]) };
}

/** Free spot to the right of everything on the board (for new frames / loose cards). */
export function rightOf(board, margin = 80) {
  let r = 0;
  let top = Infinity;
  for (const f of board.frames) {
    r = Math.max(r, f.x + f.w);
    top = Math.min(top, f.y);
  }
  for (const c of board.cards) {
    r = Math.max(r, c.x + cardW(c));
    top = Math.min(top, c.y);
  }
  return { x: board.frames.length || board.cards.length ? r + margin : 0, y: Number.isFinite(top) ? top : 0 };
}
