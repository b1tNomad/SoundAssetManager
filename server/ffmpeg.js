// Locating ffmpeg, running it and probing audio files.
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const caps = {
  found: false,
  bin: null,
  ogg: null, // 'libvorbis' | 'vorbis' (native, lower quality) | null
  mp3: false,
};

function candidates() {
  const list = [];
  if (process.env.FFMPEG_PATH) list.push(process.env.FFMPEG_PATH);
  list.push('ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg');
  try {
    const p = require('ffmpeg-static');
    if (p) list.push(p);
  } catch {
    /* optional */
  }
  return [...new Set(list)];
}

function encodersOf(bin) {
  try {
    return execFileSync(bin, ['-hide_banner', '-encoders'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

export function detect() {
  let best = null;
  for (const bin of candidates()) {
    const enc = encodersOf(bin);
    if (!enc) continue;
    const has = (name) => new RegExp(`^\\s*A[.A-Z]{5}\\s+${name}\\s`, 'm').test(enc);
    const info = { bin, libvorbis: has('libvorbis'), vorbis: has('vorbis'), mp3: has('libmp3lame') };
    if (!best) best = info;
    if (info.libvorbis && info.mp3) {
      best = info;
      break;
    }
    if (info.libvorbis && !best.libvorbis) best = info;
  }
  if (!best) {
    Object.assign(caps, { found: false, bin: null, ogg: null, mp3: false });
    return caps;
  }
  Object.assign(caps, {
    found: true,
    bin: best.bin,
    ogg: best.libvorbis ? 'libvorbis' : best.vorbis ? 'vorbis' : null,
    mp3: best.mp3,
  });
  return caps;
}

export class FfmpegError extends Error {
  constructor(message, stderr) {
    super(message);
    this.stderr = stderr;
  }
}

/** Run ffmpeg with args; resolves on exit code 0, rejects with the stderr tail otherwise. */
export function ffmpeg(args, { onStdout } = {}) {
  if (!caps.found) return Promise.reject(new FfmpegError('ffmpeg не знайдено. Встанови: brew install ffmpeg'));
  return new Promise((resolve, reject) => {
    const proc = spawn(caps.bin, ['-hide_banner', '-nostdin', '-y', ...args], {
      stdio: ['ignore', onStdout ? 'pipe' : 'ignore', 'pipe'],
    });
    let err = '';
    proc.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 200000) err = err.slice(-100000);
    });
    if (onStdout) proc.stdout.on('data', onStdout);
    proc.on('error', (e) => reject(new FfmpegError(e.message, err)));
    proc.on('close', (code) => {
      if (code === 0) resolve(err);
      else {
        const tail = err.trim().split('\n').slice(-6).join('\n');
        reject(new FfmpegError('ffmpeg: ' + (tail.split('\n').pop() || 'помилка обробки'), tail));
      }
    });
  });
}

function channelsFromLayout(s) {
  s = s.trim();
  const named = { mono: 1, stereo: 2, '2.1': 3, '3.0': 3, quad: 4, '4.0': 4, '5.0': 5, '5.1': 6, '6.1': 7, '7.1': 8 };
  const base = s.replace(/\(.*\)$/, '');
  if (named[base]) return named[base];
  const m = s.match(/(\d+)\s*channels?/);
  return m ? Number(m[1]) : 2;
}

/**
 * Exact duration + format info by decoding the first audio stream to raw mono PCM
 * and counting samples.
 */
export async function probe(file) {
  let bytes = 0;
  // While counting, also keep the loudest sample of every 512 → a small waveform picture (thumb).
  const CH = 512;
  const maxes = [];
  let cur = 0;
  let curN = 0;
  let carry = null;
  const stderr = await ffmpeg(['-i', file, '-map', '0:a:0', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], {
    onStdout: (d) => {
      bytes += d.length;
      const buf = carry ? Buffer.concat([carry, d]) : d;
      carry = null;
      const n = buf.length >> 1;
      for (let i = 0; i < n; i++) {
        const v = buf.readInt16LE(i * 2);
        const a = v < 0 ? -v : v;
        if (a > cur) cur = a;
        if (++curN === CH) {
          maxes.push(cur);
          cur = 0;
          curN = 0;
        }
      }
      if (buf.length & 1) carry = buf.subarray(buf.length - 1);
    },
  });
  if (curN) maxes.push(cur);
  const input = stderr.split(/\nOutput #0/)[0];
  const m = input.match(/Stream #\d+:\d+[^:]*: Audio: ([^,\n]+), (\d+) Hz, ([^,\n]+)/);
  if (!m) throw new FfmpegError('У файлі немає аудіо');
  const sampleRate = Number(m[2]);
  const samples = bytes / 2;
  return {
    codec: m[1].trim().split(' ')[0],
    sampleRate,
    channels: channelsFromLayout(m[3]),
    duration: samples / sampleRate,
    thumb: thumbOf(maxes),
  };
}

/** 120 bars, 0..99, scaled to the sound's own peak (it's for the shape, not the level). */
function thumbOf(maxes, bars = 120) {
  const out = new Array(bars).fill(0);
  if (!maxes.length) return out;
  let peak = 0;
  for (const v of maxes) if (v > peak) peak = v;
  if (!peak) return out;
  for (let b = 0; b < bars; b++) {
    const i0 = Math.floor((b * maxes.length) / bars);
    const i1 = Math.max(i0 + 1, Math.floor(((b + 1) * maxes.length) / bars));
    let m = 0;
    for (let i = i0; i < i1 && i < maxes.length; i++) if (maxes[i] > m) m = maxes[i];
    out[b] = Math.round((m / peak) * 99);
  }
  return out;
}
