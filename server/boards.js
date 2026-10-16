// Boards (tabs) with frames and cards. Also turns the old desks into boards on first start.
import { uid } from './db.js';
import { CARD_W, GAP, PAD, grid, fitFrame, rightOf } from '../shared/board.js';

export const freshBoard = (name) => ({ id: uid('bd_'), name, frames: [], cards: [], view: { x: 80, y: 80, z: 0.8 } });
export const freshCard = (soundId, extra = {}) => ({ uid: uid('c_'), soundId, trim: null, split: [], zoom: 1, w: CARD_W, x: 0, y: 0, frameId: null, ...extra });

/**
 * Old desks → boards. Each desk becomes a board whose cards sit in a frame named like the desk;
 * sounds that weren't on any desk go into a «Бібліотека» frame on the first board, grouped by
 * the track they were cut from. Returns true when something changed.
 */
export function migrateDesks(db) {
  if (Array.isArray(db.boards) && db.boards.length) {
    delete db.desks;
    delete db.activeDesk;
    return false;
  }
  const ids = new Set(db.sounds.map((s) => s.id));
  const placed = new Set();
  const boards = [];
  let active = null;
  for (const d of db.desks || []) {
    const b = freshBoard(d.name);
    if (d.id === db.activeDesk) active = b.id;
    const items = (d.items || []).filter((i) => ids.has(i.soundId));
    if (items.length) {
      const frame = { id: uid('f_'), name: d.name, type: 'split', x: 0, y: 0, w: CARD_W + 2 * PAD, h: 2 * PAD };
      const pos = grid(items.length, PAD, PAD, 1);
      const cards = items.map((it, i) => {
        const { checked, activeUid, ...rest } = it;
        return { ...rest, uid: it.uid || uid('c_'), ...pos[i], w: CARD_W, frameId: frame.id };
      });
      b.cards.push(...cards);
      b.frames.push(fitFrame(frame, cards));
      items.forEach((i) => placed.add(i.soundId));
    }
    boards.push(b);
  }
  if (!boards.length) boards.push(freshBoard('Дошка 1'));
  const rest = db.sounds.filter((s) => !placed.has(s.id));
  if (rest.length) {
    const b = boards[0];
    const at = rightOf(b);
    const groups = new Map();
    for (const s of [...rest].sort((a, b2) => a.createdAt - b2.createdAt)) {
      const key = s.parents?.[0] || s.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    const frame = { id: uid('f_'), name: 'Бібліотека', type: 'free', x: at.x, y: at.y, w: 2 * PAD, h: 2 * PAD };
    const cols = 4;
    let y = at.y + PAD;
    const cards = [];
    for (const list of groups.values()) {
      const pos = grid(list.length, at.x + PAD, y, cols);
      list.forEach((s, i) => cards.push(freshCard(s.id, { ...pos[i], frameId: frame.id })));
      y = pos[pos.length - 1].y + 156 + GAP;
    }
    b.cards.push(...cards);
    b.frames.push(fitFrame(frame, cards));
  }
  db.boards = boards;
  db.activeBoard = active || boards[0].id;
  delete db.desks;
  delete db.activeDesk;
  return true;
}
