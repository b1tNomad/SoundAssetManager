// Where each source track sits inside a merge result, so its preview can show what plays when.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { player, usePlayingOwner } from './audio.js';

/**
 * Same timing math as the server (ops.js), so the picture matches the audio.
 * Returns { duration, segments: [{ uid, name, start, end, lane, kind }] } in result time.
 */
export function mergeLayout(how, targets, m, layerOf, baseUid) {
  const segs = [];
  const n = targets.length;
  if (how === 'overlay') {
    const base = targets.find((x) => x.item.uid === baseUid) || targets[0];
    const lenB = base.sound.duration;
    segs.push({ uid: base.item.uid, name: base.sound.name, start: 0, end: lenB, lane: 0, kind: 'base' });
    let lane = 1;
    for (const x of targets) {
      if (x === base) continue;
      const off = Math.max(0, Number(layerOf(x.item.uid).offset) || 0);
      let end = off + x.sound.duration;
      if (m.durationMode === 'base') end = Math.min(end, lenB);
      segs.push({ uid: x.item.uid, name: x.sound.name, start: off, end: Math.max(off, end), lane: lane++, kind: 'layer' });
    }
    const duration = m.durationMode === 'base' ? lenB : Math.max(...segs.map((s) => s.end));
    return { how, duration, segments: segs };
  }
  if (how === 'crossfade' && m.overlap) {
    const D = Math.max(0, Number(m.xfade) || 0);
    let cur = 0;
    targets.forEach((x, i) => {
      const len = x.sound.duration;
      let start = 0;
      if (i > 0) {
        const d = Math.min(D, cur - 0.01, len - 0.01);
        start = d >= 0.005 ? cur - d : cur;
      }
      segs.push({ uid: x.item.uid, name: x.sound.name, start, end: start + len, lane: i % 2, kind: 'seq' });
      cur = start + len;
    });
    return { how, duration: cur, segments: segs };
  }
  // concat (with optional gap) and crossfade without overlap: one after another
  const gap = how === 'concat' ? Math.max(0, Number(m.gap) || 0) : 0;
  let x0 = 0;
  targets.forEach((x, i) => {
    const len = x.sound.duration;
    segs.push({ uid: x.item.uid, name: x.sound.name, start: x0, end: x0 + len, lane: i % 2, kind: 'seq' });
    x0 += len + (i < n - 1 && gap >= 0.001 ? gap : 0);
  });
  return { how, duration: x0, segments: segs };
}

// ---- the layout of the preview that is currently loaded ----
let map = null; // { owner, url, duration, segments }
const subs = new Set();
export function setPreviewMap(m) {
  map = m;
  subs.forEach((f) => f());
}
const subscribe = (f) => {
  subs.add(f);
  return () => subs.delete(f);
};
export const usePreviewMap = () => useSyncExternalStore(subscribe, () => map);

/**
 * While the mapped preview plays, runs select(t, map) every frame and re-renders
 * only when its result changes (so uninvolved components stay idle).
 */
export function usePreviewSelect(select) {
  const owner = usePlayingOwner();
  const m = usePreviewMap();
  const active = !!m && owner === m.owner;
  const [val, setVal] = useState(null);
  const sel = useRef(select);
  sel.current = select;
  useEffect(() => {
    if (!active) {
      setVal(null);
      return;
    }
    let raf;
    let last;
    const tick = () => {
      const t = player.position(m.owner);
      const v = t == null ? null : sel.current(t, m);
      if (v !== last) {
        last = v;
        setVal(v);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [active, m]);
  return active ? val : null;
}
