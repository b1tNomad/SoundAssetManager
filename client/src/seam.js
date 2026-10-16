// Loop-seam analysis: how cleanly the end of a region joins back to its start.
//
// Two things make a loop audible at the seam:
//  - shape: the waveform right after the jump differs from what would naturally follow → a click;
//  - level: the loudness just before the end differs from just after the start → a "pump".

const cache = new WeakMap();

/** Mono mix + running sums (energy and first-difference energy) for fast windowed measures. */
export function analysis(buffer) {
  let a = cache.get(buffer);
  if (a) return a;
  const n = buffer.length;
  const ch = buffer.numberOfChannels;
  const mono = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / ch;
  }
  const cum = new Float64Array(n + 1); // Σ x²
  const cumD = new Float64Array(n + 1); // Σ (x[i] − x[i−1])²  (high-frequency energy)
  for (let i = 0; i < n; i++) {
    cum[i + 1] = cum[i] + mono[i] * mono[i];
    const dd = i ? mono[i] - mono[i - 1] : 0;
    cumD[i + 1] = cumD[i] + dd * dd;
  }
  a = { mono, cum, cumD, sr: buffer.sampleRate, n, buffer };
  cache.set(buffer, a);
  return a;
}

function sumRange(arr, n, i0, i1) {
  i0 = Math.max(0, Math.min(n, i0));
  i1 = Math.max(0, Math.min(n, i1));
  return i1 > i0 ? [arr[i1] - arr[i0], i1 - i0] : [0, 0];
}
const rmsOf = ([sum, cnt]) => (cnt ? Math.sqrt(sum / cnt) : 0);
const db = (a, b) => 20 * Math.log10((a + 1e-7) / (b + 1e-7));

// 3rd-difference "kink" at sample i of a signal given as accessor — natural movement measure.
const kink = (a, b, c, d) => Math.abs(3 * c - 3 * b + a - d) / 2; // samples i-2, i-1, i, i+1

/**
 * Seam when playback jumps from sample `e` (region end, exclusive) back to sample `s` (region start).
 *  click:  the kink across the seam compared with the biggest natural kink within ±3 ms around it
 *          (≤1: the seam moves no more sharply than the sound itself does — no click, even in noise),
 *          or, for smooth tonal sounds, the step compared with normal sample-to-sample movement.
 *          A tone joined at the wrong phase scores in the tens.
 *  level:  loudness right before the end vs right after the start, dB — the largest gap over
 *          50 / 150 / 300 ms windows (the "pump" lives in the 100–300 ms range).
 *  bright: high-frequency share, end vs start over 150 ms, dB (timbre jump).
 */
export function seamCost(A, e, s) {
  const x = A.mono;
  const n = A.n;
  if (e < 3 || e > n || s < 0 || s + 2 >= n) return { click: 9, level: 0, bright: 0 };
  const len = e - s;
  const j = kink(x[e - 2], x[e - 1], x[s], x[s + 1]);
  const w = Math.max(24, Math.round(A.sr * 0.003));
  let nat = 0;
  for (let i = Math.max(2, e - w); i < e - 1; i++) {
    const k = kink(x[i - 2], x[i - 1], x[i], x[i + 1]);
    if (k > nat) nat = k;
  }
  for (let i = s + 2; i < Math.min(n - 1, s + w); i++) {
    const k = kink(x[i - 2], x[i - 1], x[i], x[i + 1]);
    if (k > nat) nat = k;
  }
  const r1 = nat < 1e-9 ? (j < 1e-7 ? 0 : 99) : j / nat;
  // Smooth (tonal) sounds have tiny natural kinks, so also compare the step across the seam with the
  // ordinary sample-to-sample movement there; a sub-sample phase error is inaudible and stays small here.
  const [l1, c1] = sumRange(A.cumD, n, e - w + 1, e);
  const [rr, c2] = sumRange(A.cumD, n, s + 2, s + w);
  const dr = Math.sqrt((l1 + rr) / Math.max(1, c1 + c2));
  const dev = Math.abs(x[s] - x[e - 1] - (x[e - 1] - x[e - 2] + x[s + 1] - x[s]) / 2);
  const r2 = dr < 1e-9 ? (dev < 1e-7 ? 0 : 99) : dev / dr / 1.5;
  const click = Math.min(r1, r2);

  let level = 0;
  for (const T of [0.05, 0.15, 0.3]) {
    const L = Math.min(Math.round(A.sr * T), Math.floor(len / 2));
    if (L < 16) continue;
    const eR = rmsOf(sumRange(A.cum, n, e - L, e));
    const sR = rmsOf(sumRange(A.cum, n, s, s + L));
    if (eR < 1e-4 && sR < 1e-4) continue;
    const d = db(eR, sR);
    if (Math.abs(d) > Math.abs(level)) level = d;
  }
  const L = Math.min(Math.round(A.sr * 0.15), Math.floor(len / 2));
  const eR = rmsOf(sumRange(A.cum, n, e - L, e));
  const sR = rmsOf(sumRange(A.cum, n, s, s + L));
  const eD = rmsOf(sumRange(A.cumD, n, e - L + 1, e));
  const sD = rmsOf(sumRange(A.cumD, n, s + 1, s + L));
  const bright = eR < 1e-4 && sR < 1e-4 ? 0 : db(eD / (eR + 1e-7), sD / (sR + 1e-7));
  return { click, level, bright };
}

export const costOf = (r) => Math.max(0, r.click - 1) * 0.6 + 0.5 * Math.abs(r.level) + 0.2 * Math.abs(r.bright);

export function verdict(r) {
  if (r.click < 1.2 && Math.abs(r.level) < 1 && Math.abs(r.bright) < 1.5) return 'good';
  if (r.click < 2 && Math.abs(r.level) < 1.5 && Math.abs(r.bright) < 3) return 'ok';
  return 'bad';
}

export const MIN_LEN = 0.05;

/**
 * Quality per visible pixel column for the side being fitted.
 * fit 'end': candidates are end positions, compared with the fixed start; 'start' the other way round.
 */
export function heatColumns(A, { fit, fixed, t0, pps, width }) {
  const out = new Array(width).fill(null);
  const fs = Math.round(fixed * A.sr);
  const minS = Math.round(MIN_LEN * A.sr);
  for (let x = 0; x < width; x++) {
    let lo = Math.floor((t0 + x / pps) * A.sr);
    let hi = Math.max(lo + 1, Math.floor((t0 + (x + 1) / pps) * A.sr));
    if (fit === 'end') {
      lo = Math.max(lo, fs + minS);
      hi = Math.min(hi, A.n);
    } else {
      lo = Math.max(lo, 0);
      hi = Math.min(hi, fs - minS);
    }
    if (hi <= lo) continue;
    const stride = Math.max(1, Math.floor((hi - lo) / 24));
    let best = null;
    let bestK = Infinity;
    for (let c = lo; c < hi; c += stride) {
      const r = fit === 'end' ? seamCost(A, c, fs) : seamCost(A, fs, c);
      const k = costOf(r);
      if (k < bestK) {
        bestK = k;
        best = r;
      }
    }
    out[x] = verdict(best);
  }
  return out;
}

/** Best position for the fitted side within ±range seconds of `around`. Returns { pos, r }. */
export function findBest(A, fit, fixed, around, range = 0.3) {
  const fs = Math.round(fixed * A.sr);
  const c = Math.round(around * A.sr);
  const R = Math.round(range * A.sr);
  const minS = Math.round(MIN_LEN * A.sr);
  let lo = c - R;
  let hi = c + R;
  if (fit === 'end') {
    lo = Math.max(lo, fs + minS);
    hi = Math.min(hi, A.n);
  } else {
    lo = Math.max(lo, 0);
    hi = Math.min(hi, fs - minS);
  }
  if (hi <= lo) return null;
  const evalAt = (p) => (fit === 'end' ? seamCost(A, p, fs) : seamCost(A, fs, p));
  // Small pull towards the current position, so equal matches don't jump far away.
  const score = (p) => costOf(evalAt(p)) + (0.05 * Math.abs(p - c)) / R;
  let best = lo;
  let bestK = Infinity;
  for (let p = lo; p < hi; p += 8) {
    const k = score(p);
    if (k < bestK) {
      bestK = k;
      best = p;
    }
  }
  for (let p = Math.max(lo, best - 16); p < Math.min(hi, best + 17); p++) {
    const k = score(p);
    if (k < bestK) {
      bestK = k;
      best = p;
    }
  }
  return { pos: best / A.sr, r: evalAt(best) };
}

/** Peak level (0..1, across channels) in [t0, t1] — for the reference lines. */
export function peakIn(buffer, t0, t1) {
  const sr = buffer.sampleRate;
  const i0 = Math.max(0, Math.floor(t0 * sr));
  const i1 = Math.min(buffer.length, Math.ceil(t1 * sr));
  let p = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = i0; i < i1; i++) {
      const v = d[i] < 0 ? -d[i] : d[i];
      if (v > p) p = v;
    }
  }
  return p;
}
