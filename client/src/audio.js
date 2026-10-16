// Decoding, waveform peaks and a single global player (only one thing plays at a time).
import { useSyncExternalStore } from 'react';

let ctx = null;
export const audioCtx = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());

export const BIN = 256; // samples per precomputed peak bin
const cache = new Map();

export function computePeaks(buffer) {
  const len = buffer.length;
  const n = Math.ceil(len / BIN);
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  let peak = 0;
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  for (let b = 0; b < n; b++) {
    let lo = 1;
    let hi = -1;
    const s0 = b * BIN;
    const s1 = Math.min(len, s0 + BIN);
    for (const d of chans) {
      for (let i = s0; i < s1; i++) {
        const v = d[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[b] = lo;
    max[b] = hi;
    peak = Math.max(peak, -lo, hi);
  }
  return { min, max, peak };
}

/**
 * Decodes at the file's own sample rate when it's known (so effects and fades are computed on
 * exactly the samples the server will use); playback resamples on the fly.
 */
function decodeAt(ab, sampleRate) {
  const Off = typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext);
  if (sampleRate && Off) {
    try {
      return new Off(1, 1, sampleRate).decodeAudioData(ab.slice(0)).catch(() => audioCtx().decodeAudioData(ab));
    } catch {
      /* unsupported rate → decode at the output rate */
    }
  }
  return audioCtx().decodeAudioData(ab);
}

// Decoded sounds are big (a minute of stereo ≈ 20 MB), so only the most recently used are kept.
const sizes = new Map();
const LIMIT = 90e6; // samples (~360 MB)
function trim(keep) {
  let total = 0;
  for (const v of sizes.values()) total += v;
  for (const [url] of cache) {
    if (total <= LIMIT) break;
    if (url === keep || !sizes.has(url)) continue;
    total -= sizes.get(url);
    sizes.delete(url);
    cache.delete(url);
  }
}

/** Fetch + decode once per URL. Resolves to { buffer, peaks }. */
export function loadAudio(url, sampleRate) {
  if (cache.has(url)) {
    const p = cache.get(url); // most recently used goes last
    cache.delete(url);
    cache.set(url, p);
    return p;
  }
  if (!cache.has(url)) {
    const p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error('Файл не знайдено');
        return r.arrayBuffer();
      })
      .then((ab) => decodeAt(ab, sampleRate))
      .then((buffer) => {
        sizes.set(url, buffer.length * buffer.numberOfChannels);
        trim(url);
        return { buffer, peaks: computePeaks(buffer) };
      });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return cache.get(url);
}
export const forgetAudio = (url) => (sizes.delete(url), cache.delete(url));

// ---------- fades ----------
/** Gain for x in 0..1 — the same formulas ffmpeg's afade uses, so what you hear is what gets saved. */
export function fadeGain(curve, x) {
  x = x <= 0 ? 0 : x >= 1 ? 1 : x;
  switch (curve) {
    case 'qsin':
      return Math.sin((x * Math.PI) / 2);
    case 'hsin':
      return (1 - Math.cos(x * Math.PI)) / 2;
    case 'esin':
      return 1 - Math.cos((Math.PI / 4) * (Math.pow(2 * x - 1, 3) + 1));
    case 'log':
      return x <= 0 ? 0 : Math.min(1, Math.max(0, 1 + 0.2 * Math.log10(x)));
    case 'exp':
      return Math.exp(-11.512925464970227 * (1 - x));
    case 'ipar':
      return 1 - (1 - x) * (1 - x);
    case 'par':
      return 1 - Math.sqrt(1 - x);
    case 'qua':
      return x * x;
    case 'cub':
      return x * x * x;
    case 'squ':
      return Math.sqrt(x);
    case 'cbr':
      return Math.cbrt(x);
    default:
      return x; // tri — linear
  }
}

/** Copy of [start, end] with fade-in/out applied, as a new AudioBuffer (nothing touches the disk). */
export function renderFaded(buffer, start, end, fadeIn, fadeOut, curve) {
  const sr = buffer.sampleRate;
  const s0 = Math.max(0, Math.round(start * sr));
  const s1 = Math.min(buffer.length, Math.max(s0 + 1, Math.round(end * sr)));
  const n = s1 - s0;
  const out = audioCtx().createBuffer(buffer.numberOfChannels, n, sr);
  const fi = Math.min(n, Math.round(Math.max(0, fadeIn) * sr));
  const fo = Math.min(n, Math.round(Math.max(0, fadeOut) * sr));
  const gi = new Float32Array(fi);
  for (let i = 0; i < fi; i++) gi[i] = fadeGain(curve, i / fi);
  const go = new Float32Array(fo);
  for (let j = 0; j < fo; j++) go[j] = fadeGain(curve, (j + 1) / fo);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const dst = out.getChannelData(c);
    dst.set(buffer.getChannelData(c).subarray(s0, s1));
    for (let i = 0; i < fi; i++) dst[i] *= gi[i];
    for (let j = 0; j < fo; j++) dst[n - 1 - j] *= go[j];
  }
  return out;
}

let lastFaded = { src: null, key: '', out: null };
/**
 * Plays [start, end] of `buffer` with fades applied live. `from` is a track time inside the range.
 * Without fades it simply plays the original.
 */
export function playFaded(owner, buffer, start, end, fades, { from = start, loop = false } = {}) {
  const fi = fades?.in || 0;
  const fo = fades?.out || 0;
  if (!(fi > 0 || fo > 0)) return player.play(owner, buffer, from, end, loop, 0, start);
  const key = [start, end, fi, fo, fades.curve].join('|');
  if (lastFaded.src !== buffer || lastFaded.key !== key) lastFaded = { src: buffer, key, out: renderFaded(buffer, start, end, fi, fo, fades.curve) };
  player.play(owner, lastFaded.out, Math.max(0, from - start), null, loop, start, 0);
}

// ---------- player ----------
const listeners = new Set();
let cur = null; // { owner, kind: 'buffer'|'html', src, t0, from, to, loop }
let version = 0;
const html = typeof Audio !== 'undefined' ? new Audio() : null;
const emit = () => {
  version++;
  listeners.forEach((fn) => fn());
};

function stopInternal() {
  if (!cur) return;
  if (cur.kind === 'buffer') {
    cur.src.onended = null;
    try {
      cur.src.stop();
    } catch {}
  } else if (html) {
    html.onended = null;
    html.pause();
  }
  cur = null;
}

export const player = {
  /**
   * `timeOffset`: track time of the buffer's first sample (for rendered excerpts), used by position().
   * `loopStart`: where a loop jumps back to (defaults to `from`), so playback can start mid-loop.
   */
  play(owner, buffer, from = 0, to = null, loop = false, timeOffset = 0, loopStart = null) {
    stopInternal();
    const c = audioCtx();
    c.resume();
    const end = Math.min(to ?? buffer.duration, buffer.duration);
    from = Math.max(0, Math.min(from, end - 0.001));
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(c.destination);
    const ls = loopStart == null ? from : Math.max(0, Math.min(loopStart, from));
    if (loop && end - ls > 0.01) {
      src.loop = true;
      src.loopStart = ls;
      src.loopEnd = end;
      src.start(0, from);
    } else {
      loop = false;
      src.start(0, from, Math.max(0.001, end - from));
    }
    cur = { owner, kind: 'buffer', src, t0: c.currentTime, from, to: end, loop, timeOffset, loopStart: ls };
    src.onended = () => {
      if (cur && cur.src === src) {
        cur = null;
        emit();
      }
    };
    emit();
  },
  /** Plays a file by URL (library rows, previews). `from` seeks in seconds. */
  playUrl(owner, url, from = 0) {
    stopInternal();
    if (!html) return;
    const abs = new URL(url, location.href).href;
    const go = () => {
      try {
        html.currentTime = from;
      } catch {}
      html.play().catch(() => {});
    };
    if (html.src !== abs) {
      html.src = abs;
      if (from > 0) html.addEventListener('loadedmetadata', go, { once: true });
      else go();
    } else go();
    cur = { owner, kind: 'html' };
    html.onended = () => {
      if (cur && cur.owner === owner) {
        cur = null;
        emit();
      }
    };
    emit();
  },
  stop() {
    stopInternal();
    emit();
  },
  owner: () => cur?.owner ?? null,
  /** Current playback time for this owner (buffer playback only), or null. */
  position(owner) {
    if (!cur || cur.owner !== owner) return null;
    if (cur.kind === 'html') return html ? html.currentTime : null;
    const el = audioCtx().currentTime - cur.t0;
    const first = cur.to - cur.from; // first pass runs from `from`, later passes from `loopStart`
    const t = !cur.loop
      ? Math.min(cur.to, cur.from + el)
      : el < first
        ? cur.from + el
        : cur.loopStart + ((el - first) % (cur.to - cur.loopStart));
    return cur.timeOffset + t;
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function usePlayingOwner() {
  return useSyncExternalStore(player.subscribe, () => cur?.owner ?? null);
}
export function useIsPlaying(owner) {
  return usePlayingOwner() === owner;
}
export const playerVersion = () => version;
