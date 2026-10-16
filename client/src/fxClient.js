// Card effects in the browser: renders the processed track (in a worker), caches it, and tells the
// rest of the app how long the processed track is — the server renders exactly the same thing on save.
import { audioCtx, computePeaks } from './audio.js';
import { buildChain, chainKey, outLength, outChannels, render, EFFECTS, defaults } from '../../shared/fx.js';

export const emptyFx = () => ({ on: true, tail: 'ring', e: {} });

/** The effects that actually run for this card ([] when off or nothing chosen). */
export const chainOf = (item) => buildChain(item?.fx);
export const tailOf = (item) => (item?.fx?.tail === 'cut' ? 'cut' : 'ring');

/**
 * The card's sound as the rest of the app should see it: with effects on, duration and channels
 * of the processed track, plus `fx` ({ chain, tail }) to send with every request.
 */
export function effSound(sound, item) {
  if (!sound) return sound;
  const chain = chainOf(item);
  if (!chain.length) return sound;
  const tail = tailOf(item);
  const sr = sound.sampleRate || 44100;
  const n = Math.round(sound.duration * sr);
  return {
    ...sound,
    duration: outLength(n, sr, chain, tail) / sr,
    channels: outChannels(sound.channels, chain),
    fx: { chain, tail },
    rawDuration: sound.duration,
  };
}

// Same object back while the sound and the card's effects are unchanged (keeps cards from re-rendering).
const effMemo = new Map();
export function effSoundOf(sound, card) {
  if (!sound || !card) return sound;
  const m = effMemo.get(card.uid);
  if (m && m.sound === sound && m.fx === card.fx) return m.res;
  const res = effSound(sound, card);
  effMemo.set(card.uid, { sound, fx: card.fx, res });
  return res;
}

export const fxCount = (item) => (item?.fx?.on ? EFFECTS.filter((d) => item.fx.e?.[d.id]?.on).length : 0);

// ---------- rendering ----------
const cache = new Map(); // key → { buffer, peaks }
if (typeof window !== 'undefined') window.__esmFx = cache; // for diagnostics
let cachedSamples = 0;
const LIMIT = 80e6; // keep at most ~320 MB of processed audio

function remember(key, d) {
  if (cache.has(key)) return;
  cache.set(key, d);
  cachedSamples += d.buffer.length * d.buffer.numberOfChannels;
  while (cachedSamples > LIMIT && cache.size > 2) {
    const [k, v] = cache.entries().next().value;
    cache.delete(k);
    cachedSamples -= v.buffer.length * v.buffer.numberOfChannels;
  }
}
export function peekFx(key) {
  const d = cache.get(key);
  if (d) {
    cache.delete(key); // most recently used goes last
    cache.set(key, d);
  }
  return d || null;
}

let worker = null;
let workerBroken = false;
const queue = [];
let running = null;
let seq = 0;

function getWorker() {
  if (worker || workerBroken) return worker;
  try {
    worker = new Worker('/dist/fx-worker.js');
    worker.onmessage = (e) => finish(e.data);
    worker.onerror = (e) => {
      e.preventDefault?.();
      worker?.terminate();
      worker = null;
      if (running) finish({ id: running.id, error: 'Обробка зірвалась' });
    };
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

function toBuffer(channels, sr) {
  const b = audioCtx().createBuffer(channels.length, Math.max(1, channels[0].length), sr);
  channels.forEach((c, i) => b.copyToChannel(c, i));
  return b;
}

function finish(msg) {
  const job = running;
  running = null;
  if (job && msg.id === job.id) {
    if (msg.error) job.reject(new Error(msg.error));
    else {
      const buffer = toBuffer(msg.channels, msg.sr);
      const d = { buffer, peaks: computePeaks(buffer) };
      remember(job.key, d);
      job.resolve(d);
    }
  }
  pump();
}

function pump() {
  if (running || !queue.length) return;
  const job = queue.shift();
  const hit = peekFx(job.key);
  if (hit) {
    job.resolve(hit);
    return pump();
  }
  running = job;
  job.id = ++seq;
  const b = job.data.buffer;
  const channels = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c).slice());
  const w = getWorker();
  if (w) w.postMessage({ id: job.id, channels, sr: b.sampleRate, chain: job.chain, tail: job.tail }, channels.map((c) => c.buffer));
  else
    setTimeout(() => {
      // no worker (very old browser): same engine on the main thread
      try {
        finish({ id: job.id, channels: render(channels, b.sampleRate, job.chain, { tail: job.tail }), sr: b.sampleRate });
      } catch (e) {
        finish({ id: job.id, error: e.message });
      }
    }, 0);
}

/**
 * Processed version of `data` ({ buffer }) for this chain. `slot` is the card: a newer request
 * from the same card replaces its older one still waiting (resolves null), so dragging a slider
 * never piles up work.
 */
export function processFx(slot, data, chain, tail, key) {
  const hit = peekFx(key);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].slot === slot) {
        queue[i].resolve(null);
        queue.splice(i, 1);
      }
    }
    queue.push({ slot, data, chain, tail, key, resolve, reject });
    pump();
  });
}

export const fxKey = (url, chain, tail) => (chain.length ? url + '|' + chainKey(chain, tail) : '');

// ---------- editing helpers ----------
export function setEffect(fx, id, patch) {
  const cur = fx.e[id] || { ...defaults(id), on: false };
  return { ...fx, e: { ...fx.e, [id]: { ...cur, ...patch } } };
}
