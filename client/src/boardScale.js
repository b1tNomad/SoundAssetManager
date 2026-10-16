// Current board zoom, readable without re-rendering (pointer maths inside cards), plus a coarse
// "pixel scale" that canvases use to stay sharp when the board is zoomed in.
import { useSyncExternalStore } from 'react';

let z = 1;
let q = 1;
const subs = new Set();

export const boardScale = () => z;
export function setBoardScale(v) {
  z = v;
  const nq = v > 2.2 ? 3 : v > 1.1 ? 2 : 1;
  if (nq !== q) {
    q = nq;
    subs.forEach((f) => f());
  }
}
export const usePixelScale = () =>
  useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => q
  );
