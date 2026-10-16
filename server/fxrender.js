// Applies a card's effects to a library sound before any operation uses it.
// The processed track is a float WAV inside the action's work folder, so it disappears with it.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg } from './ffmpeg.js';
import { uid } from './db.js';
import { normalizeChain, render, chainKey } from '../shared/fx.js';

async function decodeFloat(file, ch, sr) {
  const chunks = [];
  await ffmpeg(['-i', file, '-map', '0:a:0', '-ac', String(ch), '-ar', String(sr), '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], {
    onStdout: (d) => chunks.push(d),
  });
  const buf = Buffer.concat(chunks);
  const n = Math.floor(buf.length / 4 / ch);
  const inter = new Float32Array(n * ch);
  new Uint8Array(inter.buffer).set(buf.subarray(0, n * ch * 4));
  const chs = Array.from({ length: ch }, () => new Float32Array(n));
  for (let i = 0, k = 0; i < n; i++) for (let c = 0; c < ch; c++) chs[c][i] = inter[k++];
  return chs;
}

function writeWavFloat(file, chs, sr) {
  const C = chs.length;
  const n = chs[0].length;
  const inter = new Float32Array(n * C);
  for (let i = 0, k = 0; i < n; i++) for (let c = 0; c < C; c++) inter[k++] = chs[c][i];
  const data = inter.byteLength;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(3, 20); // IEEE float
  h.writeUInt16LE(C, 22);
  h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * C * 4, 28);
  h.writeUInt16LE(C * 4, 32);
  h.writeUInt16LE(32, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data, 40);
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, h);
    fs.writeSync(fd, new Uint8Array(inter.buffer));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Returns a resolver `(id, fx) => sound` for one action. Without effects it's the library sound;
 * with effects it's the same sound pointing at its processed copy in `dir` (duration and channels
 * updated). The same sound + effects is processed only once per action.
 */
export function fxResolver(getSound, dir) {
  const done = new Map();
  return async (id, fx) => {
    const s = getSound(id);
    if (!s) return null;
    const chain = normalizeChain(fx?.chain);
    if (!chain.length) return s;
    const tail = fx.tail === 'cut' ? 'cut' : 'ring';
    const key = s.id + '|' + chainKey(chain, tail);
    if (!done.has(key)) {
      done.set(
        key,
        (async () => {
          const sr = s.sampleRate || 44100;
          const input = await decodeFloat(s.path, Math.min(2, Math.max(1, s.channels || 1)), sr);
          const out = render(input, sr, chain, { tail });
          const file = path.join(dir, `fx-${uid()}.wav`);
          writeWavFloat(file, out, sr);
          return { ...s, path: file, duration: out[0].length / sr, channels: out.length, sampleRate: sr, fx: true };
        })()
      );
    }
    return done.get(key);
  };
}
