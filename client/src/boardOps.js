// Pure helpers that change a board (frames + cards). Every function returns a new board.
import { CARD_W, CARD_H, GAP, PAD, frameAt, centerOf, placeInFrame, fitFrame, readingOrder, cardW, grid, inside } from '../../shared/board.js';
import { rid, loadLocal } from './util.js';

export const TOOL_DEFAULT = {
  trim: { action: 'keep', fadeIn: 0, fadeOut: 0, curve: 'tri', crossfade: 0.02 },
  split: { fadeInOn: true, fadeIn: 0.005, fadeOutOn: true, fadeOut: 0.05, curve: 'tri', parts: 4 },
  merge: { how: 'concat', gap: 0, xfade: 1, overlap: true, curve: 'qsin', baseUid: null, layers: {}, durationMode: 'longest', fadeIn: 0, fadeOut: 0 },
};

export const newCard = (soundId, extra = {}) => ({ uid: rid('c_'), soundId, trim: null, split: [], zoom: 1, w: CARD_W, x: 0, y: 0, frameId: null, ...extra });

// Settings from the old single tool panel (before frames) become the defaults for new frames.
const legacy = loadLocal('esm.tool', {});
export const frameTool = (frame, k) => ({ ...TOOL_DEFAULT[k], ...(legacy[k] || {}), ...(frame?.tool?.[k] || {}) });

/** Library folder of a frame: what it was first saved to, or its name. Same cleaning as the server. */
export function safeFolder(name) {
  return String(name || '')
    .replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
}
export const folderOf = (frame) => (frame ? frame.folder || safeFolder(frame.name) : '');

export const membersOf = (board, fid) => board.cards.filter((c) => c.frameId === fid);
export const frameOf = (board, card) => (card?.frameId ? board.frames.find((f) => f.id === card.frameId) || null : null);

/** Cards that a merge frame joins, in reading order (left → right, top → bottom). */
export const mergeTargets = (board, fid) => readingOrder(membersOf(board, fid).filter((c) => c.inMerge !== false));

const setCards = (board, fn) => ({ ...board, cards: board.cards.map(fn) });

/** Frame membership by where the card's centre is. */
export function settle(board, uids) {
  const want = new Set(uids);
  return setCards(board, (c) => {
    if (!want.has(c.uid)) return c;
    const f = frameAt(board.frames, centerOf(c));
    const frameId = f ? f.id : null;
    if (frameId === c.frameId) return c;
    const patch = { frameId };
    // Entering a merge frame: takes part in the merge by default.
    if (f?.type === 'merge' && c.inMerge === undefined) patch.inMerge = true;
    return { ...c, ...patch };
  });
}

export function moveCards(board, uids, dx, dy) {
  const want = new Set(uids);
  const moved = setCards(board, (c) => (want.has(c.uid) ? { ...c, x: Math.round(c.x + dx), y: Math.round(c.y + dy) } : c));
  return settle(moved, uids);
}

/** Moves frames together with their cards. */
export function moveFrames(board, fids, dx, dy) {
  const want = new Set(fids);
  return {
    ...board,
    frames: board.frames.map((f) => (want.has(f.id) ? { ...f, x: Math.round(f.x + dx), y: Math.round(f.y + dy) } : f)),
    cards: board.cards.map((c) => (want.has(c.frameId) ? { ...c, x: Math.round(c.x + dx), y: Math.round(c.y + dy) } : c)),
  };
}

/** New frame rectangle; cards that end up inside join, cards that end up outside leave. */
export function resizeFrame(board, fid, rect) {
  const frames = board.frames.map((f) => (f.id === fid ? { ...f, ...rect } : f));
  const b = { ...board, frames };
  const affected = board.cards.filter((c) => c.frameId === fid || (!c.frameId && inside(rect, centerOf(c)))).map((c) => c.uid);
  return settle(b, affected);
}

export function updateFrame(board, fid, patch) {
  return { ...board, frames: board.frames.map((f) => (f.id === fid ? { ...f, ...patch } : f)) };
}

export function addFrame(board, type, rect, name) {
  const n = board.frames.filter((f) => f.type === type).length + 1;
  const label = { split: 'Нарізка', trim: 'Обрізка', merge: 'Склейка', free: 'Фрейм' }[type] || 'Фрейм';
  const frame = { id: rid('f_'), name: name || `${label} ${n}`, type, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h), tool: {} };
  const b = { ...board, frames: [...board.frames, frame] };
  // Cards inside the drawn rectangle join the new frame.
  const inner = board.cards.filter((c) => inside(frame, centerOf(c))).map((c) => c.uid);
  return { board: settle(b, inner), frame };
}

/**
 * A frame around the given cards (Figma's "Frame selection"). When other cards or frames are in
 * the way, the cards are gathered into a neat grid in free space first, so the new frame holds
 * exactly them.
 */
export function wrapInFrame(board, uids, type) {
  let list = board.cards.filter((c) => uids.includes(c.uid));
  if (!list.length) return { board, frame: null };
  const box = (cs) => {
    const x = Math.min(...cs.map((c) => c.x)) - PAD;
    const y = Math.min(...cs.map((c) => c.y)) - PAD;
    const r = Math.max(...cs.map((c) => c.x + cardW(c))) + PAD;
    const btm = Math.max(...cs.map((c) => c.y + CARD_H)) + PAD;
    return { x, y, w: r - x, h: btm - y };
  };
  let rect = box(list);
  const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const blocked =
    board.cards.some((c) => !uids.includes(c.uid) && hit(rect, { x: c.x, y: c.y, w: cardW(c), h: CARD_H })) || board.frames.some((f) => hit(rect, f));
  let b = board;
  if (blocked) {
    const others = { ...board, cards: board.cards.filter((c) => !uids.includes(c.uid)) };
    const at = rightOfBoard(others);
    const w = Math.max(...list.map(cardW));
    const cols = Math.min(list.length, 3);
    const pos = new Map(readingOrder(list).map((c, i) => [c.uid, { x: at.x + PAD + (i % cols) * (w + GAP), y: at.y + PAD + Math.floor(i / cols) * (CARD_H + GAP) }]));
    b = setCards(board, (c) => (pos.has(c.uid) ? { ...c, ...pos.get(c.uid) } : c));
    list = b.cards.filter((c) => uids.includes(c.uid));
    rect = box(list);
  }
  const res = addFrame(b, type, rect);
  return { board: settle(res.board, uids), frame: res.frame };
}

function rightOfBoard(board) {
  let r = -Infinity;
  let top = Infinity;
  for (const f of board.frames) {
    r = Math.max(r, f.x + f.w);
    top = Math.min(top, f.y);
  }
  for (const c of board.cards) {
    r = Math.max(r, c.x + cardW(c));
    top = Math.min(top, c.y);
  }
  return Number.isFinite(r) ? { x: r + 80, y: top } : { x: 0, y: 0 };
}

export function removeFrames(board, fids, withCards = false) {
  const want = new Set(fids);
  return {
    ...board,
    frames: board.frames.filter((f) => !want.has(f.id)),
    cards: withCards ? board.cards.filter((c) => !want.has(c.frameId)) : board.cards.map((c) => (want.has(c.frameId) ? { ...c, frameId: null } : c)),
  };
}

export function removeCards(board, uids) {
  const want = new Set(uids);
  return { ...board, cards: board.cards.filter((c) => !want.has(c.uid)) };
}

const overlaps = (a, list) => list.some((c) => a.x < c.x + cardW(c) + 4 && a.x + a.w + 4 > c.x && a.y < c.y + CARD_H + 4 && a.y + CARD_H + 4 > c.y);

/** First free grid spot for `n` cards near (x, y), not covering other cards. */
function freeSpots(board, x, y, n, w = CARD_W, cols = 3) {
  for (let k = 0; k < 60; k++) {
    const pos = grid(n, x, y + k * (CARD_H + GAP), Math.min(cols, n), w);
    if (!pos.some((p) => overlaps({ ...p, w }, board.cards))) return pos;
  }
  return grid(n, x, y, Math.min(cols, n), w);
}

/**
 * New cards for sounds. Into a frame (laid out in its next free row, frame grows) or loose
 * around `at` (world point). Returns { board, uids }.
 */
export function addCards(board, soundIds, { at = null, frameId = null, after = null, extra = {} } = {}) {
  if (!soundIds.length) return { board, uids: [] };
  let frame = frameId ? board.frames.find((f) => f.id === frameId) : at ? frameAt(board.frames, at) : null;
  let positions;
  let frames = board.frames;
  if (frame) {
    const src = after ? board.cards.find((c) => c.uid === after) : null;
    const r = placeInFrame(frame, membersOf(board, frame.id), soundIds.length, { after: src });
    positions = r.positions;
    frames = frames.map((f) => (f.id === frame.id ? r.frame : f));
  } else {
    const src = after ? board.cards.find((c) => c.uid === after) : null;
    const p = src ? { x: src.x, y: src.y + CARD_H + GAP } : at || { x: 0, y: 0 };
    positions = freeSpots(board, Math.round(p.x), Math.round(p.y), soundIds.length);
  }
  const extraFor = frame?.type === 'merge' ? { inMerge: true, ...extra } : extra;
  const cards = soundIds.map((id, i) => newCard(id, { ...positions[i], frameId: frame ? frame.id : null, ...extraFor }));
  return { board: { ...board, frames, cards: [...board.cards, ...cards] }, uids: cards.map((c) => c.uid) };
}

const EDITS = ['trim', 'split', 'selRegion', 'zoom', 'loop', 'seam', 'seamFit', 'fx', 'w'];

/**
 * Copies of cards: with all their edits (segments, selection, effects, loop…) or clean (just the
 * sound). Same sound file — nothing is copied on disk. Placed next to the originals.
 */
export function duplicateCards(board, uids, { clean = false, dx = null, dy = 0 } = {}) {
  const list = board.cards.filter((c) => uids.includes(c.uid));
  if (!list.length) return { board, uids: [] };
  const minX = Math.min(...list.map((c) => c.x));
  const maxR = Math.max(...list.map((c) => c.x + cardW(c)));
  const shift = dx ?? maxR - minX + GAP;
  const copies = list.map((c) => {
    const base = { soundId: c.soundId, w: cardW(c), x: c.x + shift, y: c.y + dy };
    if (!clean) for (const k of EDITS) if (c[k] !== undefined) base[k] = JSON.parse(JSON.stringify(c[k]));
    if (c.split?.length && !clean) base.split = c.split.map((r) => ({ ...r, id: rid('r') })), (base.selRegion = null);
    return newCard(c.soundId, base);
  });
  const b = { ...board, cards: [...board.cards, ...copies] };
  return { board: settle(b, copies.map((c) => c.uid)), uids: copies.map((c) => c.uid) };
}

/** New order for cards (e.g. merge order): they swap places, the set of positions stays. */
export function reorderCards(board, order) {
  const list = order.map((u) => board.cards.find((c) => c.uid === u)).filter(Boolean);
  const slots = readingOrder(list).map((c) => ({ x: c.x, y: c.y }));
  const at = new Map(order.map((u, i) => [u, slots[i]]));
  return setCards(board, (c) => (at.has(c.uid) ? { ...c, ...at.get(c.uid) } : c));
}

/** Lines the cards up: in a row, a column or a grid, starting where the first one is. */
export function arrange(board, uids, how) {
  const list = readingOrder(board.cards.filter((c) => uids.includes(c.uid)));
  if (!list.length) return board;
  const x0 = Math.min(...list.map((c) => c.x));
  const y0 = Math.min(...list.map((c) => c.y));
  const w = Math.max(...list.map(cardW));
  const cols = how === 'row' ? list.length : how === 'col' ? 1 : Math.ceil(Math.sqrt(list.length));
  const pos = new Map(list.map((c, i) => [c.uid, { x: x0 + (i % cols) * (w + GAP), y: y0 + Math.floor(i / cols) * (CARD_H + GAP) }]));
  const moved = setCards(board, (c) => (pos.has(c.uid) ? { ...c, ...pos.get(c.uid) } : c));
  // frames that hold these cards grow to fit
  const frames = moved.frames.map((f) => {
    const m = moved.cards.filter((c) => c.frameId === f.id);
    return m.some((c) => pos.has(c.uid)) ? fitFrame(f, m) : f;
  });
  return { ...moved, frames };
}

/** Bounding box of cards and frames (world units). */
export function bounds(board, { cards = null, frames = null } = {}) {
  const cs = cards ? board.cards.filter((c) => cards.includes(c.uid)) : board.cards;
  const fs = frames ? board.frames.filter((f) => frames.includes(f.id)) : board.frames;
  const boxes = [...cs.map((c) => ({ x: c.x, y: c.y, w: cardW(c), h: CARD_H })), ...fs];
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const btm = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: btm - y };
}
