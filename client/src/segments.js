// Editing the list of split segments: [{ id, start, end, name? }]
import { clamp, rid } from './util.js';

const EPS = 0.01;

/**
 * Cut at time t. With no segments yet, the whole track becomes two pieces.
 * Otherwise the segment under t is divided in two. Returns null if t isn't inside any segment.
 */
export function cutAt(list, t, duration) {
  if (t <= EPS || t >= duration - EPS) return null;
  if (!list.length) {
    const b = { id: rid('r'), start: t, end: duration };
    return { list: [{ id: rid('r'), start: 0, end: t }, b], sel: b.id };
  }
  const hit = list
    .filter((r) => r.start + EPS < t && t < r.end - EPS)
    .sort((a, b) => a.end - a.start - (b.end - b.start))[0]; // the shortest one if they overlap
  if (!hit) return null;
  const b = { id: rid('r'), start: t, end: hit.end };
  return { list: list.flatMap((r) => (r === hit ? [{ ...r, end: t }, b] : [r])), sel: b.id };
}

/** New segment starting at t; stops before the next segment if there's room. */
export function addAt(list, t, duration) {
  const len = clamp(duration * 0.1, 0.1, 2);
  let start = clamp(t, 0, duration);
  if (start > duration - 0.05) start = Math.max(0, duration - len);
  const next = list.filter((r) => r.start > start + 0.001).reduce((m, r) => Math.min(m, r.start), duration);
  let end = Math.min(start + len, next);
  if (end - start < 0.05) end = Math.min(duration, start + len);
  const r = { id: rid('r'), start, end };
  return { list: [...list, r], sel: r.id };
}
