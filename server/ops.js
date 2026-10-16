// Audio operations. Every operation first renders a lossless float WAV into data/tmp,
// then `finalize` applies the output fades and encodes to wav/ogg/mp3.
import path from 'node:path';
import { ffmpeg, caps, probe } from './ffmpeg.js';
import { uid } from './db.js';

export class OpError extends Error {}

const f = (n) => Number(n).toFixed(6);
const num = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const CURVES = new Set(['tri', 'qsin', 'hsin', 'esin', 'log', 'ipar', 'qua', 'cub', 'squ', 'cbr', 'par', 'exp', 'iqsin', 'ihsin']);
const curveOf = (c) => (CURVES.has(c) ? c : 'tri');
const tmpWav = (dir) => path.join(dir, `work-${uid()}.wav`);
const WORK = ['-c:a', 'pcm_f32le', '-f', 'wav'];
const pad = (i) => String(i).padStart(2, '0');

function range(s, start, end) {
  const d = s.duration;
  let a = Math.max(0, Math.min(num(start), d));
  let b = Math.max(0, Math.min(num(end, d), d));
  if (b < a) [a, b] = [b, a];
  if (b - a < 0.005) throw new OpError('Виділення занадто коротке');
  return [a, b];
}

async function trimTo(dir, s, a, b) {
  const out = tmpWav(dir);
  await ffmpeg([
    '-i', s.path, '-map', '0:a:0',
    '-af', `asetpts=PTS-STARTPTS,atrim=start=${f(a)}:end=${f(b)},asetpts=PTS-STARTPTS`,
    ...WORK, out,
  ]);
  return out;
}

async function decodeTo(dir, s) {
  const out = tmpWav(dir);
  await ffmpeg(['-i', s.path, '-map', '0:a:0', ...WORK, out]);
  return out;
}

async function cutOut(dir, s, a, b, xfade, curve) {
  const d = s.duration;
  const eps = 0.0005;
  if (a <= eps && b >= d - eps) throw new OpError('Не можна видалити весь трек');
  if (a <= eps) return trimTo(dir, s, b, d);
  if (b >= d - eps) return trimTo(dir, s, 0, a);
  const x = Math.min(Math.max(0, num(xfade)), a - 0.001, d - b - 0.001);
  const join = x >= 0.005
    ? `[p][q]acrossfade=d=${f(x)}:c1=${curve}:c2=${curve}[out]`
    : `[p][q]concat=n=2:v=0:a=1[out]`;
  const graph =
    `[0:a:0]asetpts=PTS-STARTPTS,asplit=2[x][y];` +
    `[x]atrim=end=${f(a)},asetpts=PTS-STARTPTS[p];` +
    `[y]atrim=start=${f(b)},asetpts=PTS-STARTPTS[q];` +
    join;
  const out = tmpWav(dir);
  await ffmpeg(['-i', s.path, '-filter_complex', graph, '-map', '[out]', ...WORK, out]);
  return out;
}

/** Common format for multi-track operations: highest sample rate, stereo if any track is stereo. */
function target(list) {
  const sr = Math.max(...list.map((s) => s.sampleRate || 44100));
  const layout = list.some((s) => (s.channels || 2) > 1) ? 'stereo' : 'mono';
  return { sr, layout, ch: layout === 'stereo' ? 2 : 1 };
}
const norm = (i, t) =>
  `[${i}:a:0]asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=${t.sr}:channel_layouts=${t.layout}`;
const inputs = (list) => list.flatMap((s) => ['-i', s.path]);

async function concat(dir, list, gap) {
  const t = target(list);
  const parts = [];
  const labels = [];
  gap = Math.max(0, num(gap));
  list.forEach((s, i) => {
    parts.push(`${norm(i, t)}[a${i}]`);
    labels.push(`[a${i}]`);
    if (gap >= 0.001 && i < list.length - 1) {
      parts.push(`anullsrc=r=${t.sr}:cl=${t.layout},atrim=duration=${f(gap)},aformat=sample_fmts=fltp[g${i}]`);
      labels.push(`[g${i}]`);
    }
  });
  const graph = parts.join(';') + ';' + labels.join('') + `concat=n=${labels.length}:v=0:a=1[out]`;
  const out = tmpWav(dir);
  await ffmpeg([...inputs(list), '-filter_complex', graph, '-map', '[out]', ...WORK, out]);
  return out;
}

async function crossfade(dir, list, dur, overlap, curve) {
  const t = target(list);
  const D = Math.max(0, num(dur, 1));
  const parts = [];
  let last;
  if (overlap) {
    list.forEach((s, i) => parts.push(`${norm(i, t)}[a${i}]`));
    let cur = 'a0';
    let curLen = list[0].duration;
    for (let i = 1; i < list.length; i++) {
      const len = list[i].duration;
      const d = Math.min(D, curLen - 0.01, len - 0.01);
      const next = `x${i}`;
      if (d >= 0.005) {
        parts.push(`[${cur}][a${i}]acrossfade=d=${f(d)}:c1=${curve}:c2=${curve}[${next}]`);
        curLen += len - d;
      } else {
        parts.push(`[${cur}][a${i}]concat=n=2:v=0:a=1[${next}]`);
        curLen += len;
      }
      cur = next;
    }
    last = cur;
  } else {
    // No overlap: the first track fades out completely, then the next one fades in.
    const labels = [];
    list.forEach((s, i) => {
      const len = s.duration;
      const fx = [];
      const dIn = i > 0 ? Math.min(D, len / 2) : 0;
      const dOut = i < list.length - 1 ? Math.min(D, len / 2) : 0;
      if (dIn >= 0.001) fx.push(`afade=t=in:st=0:d=${f(dIn)}:curve=${curve}`);
      if (dOut >= 0.001) fx.push(`afade=t=out:st=${f(len - dOut)}:d=${f(dOut)}:curve=${curve}`);
      parts.push(`${norm(i, t)}${fx.length ? ',' + fx.join(',') : ''}[a${i}]`);
      labels.push(`[a${i}]`);
    });
    parts.push(labels.join('') + `concat=n=${list.length}:v=0:a=1[out]`);
    last = 'out';
  }
  const out = tmpWav(dir);
  await ffmpeg([...inputs(list), '-filter_complex', parts.join(';'), '-map', `[${last}]`, ...WORK, out]);
  return out;
}

async function overlay(dir, base, baseVolume, layers, mode) {
  const list = [base, ...layers.map((l) => l.sound)];
  const t = target(list);
  const parts = [`${norm(0, t)},volume=${f(Math.max(0, num(baseVolume, 1)))}[b]`];
  const labels = ['[b]'];
  layers.forEach((l, i) => {
    const idx = i + 1;
    const samples = Math.round(Math.max(0, num(l.offset)) * t.sr);
    const delay = Array(t.ch).fill(`${samples}S`).join('|');
    parts.push(`${norm(idx, t)},volume=${f(Math.max(0, num(l.volume, 1)))},adelay=delays=${delay}[l${idx}]`);
    labels.push(`[l${idx}]`);
  });
  const duration = mode === 'base' ? 'first' : 'longest';
  parts.push(labels.join('') + `amix=inputs=${labels.length}:duration=${duration}:dropout_transition=0:normalize=0[out]`);
  const out = tmpWav(dir);
  await ffmpeg([...inputs(list), '-filter_complex', parts.join(';'), '-map', '[out]', ...WORK, out]);
  return out;
}

function shortJoin(names) {
  if (names.length <= 2) return names.join('+');
  return `${names[0]}+${names.length - 1}`;
}

/**
 * Builds the operation. Returns { label, results: [{ tmp, name, parents }] }.
 * `get(id, fx)` resolves to a sound with an absolute `path` — with the card's effects already
 * applied when `fx` is given. Intermediate files go into `dir`.
 */
export async function build(op, p, get, dir) {
  const one = async () => {
    const s = await get(p.id, p.fx);
    if (!s) throw new OpError('Трек не знайдено в бібліотеці');
    return s;
  };
  const many = async (ids, fxs, min = 2) => {
    const list = [];
    for (const [i, id] of (ids || []).entries()) {
      const s = await get(id, Array.isArray(fxs) ? fxs[i] : null);
      if (s) list.push(s);
    }
    if (list.length < min) throw new OpError(`Потрібно щонайменше ${min} треки`);
    return list;
  };
  const curve = curveOf(p.curve);

  switch (op) {
    case 'trim': {
      const s = await one();
      const [a, b] = range(s, p.start, p.end);
      return { label: `Обрізка «${s.name}»`, results: [{ tmp: await trimTo(dir, s, a, b), name: `${s.name}_trim`, parents: [s.id] }] };
    }
    case 'cut': {
      const s = await one();
      const [a, b] = range(s, p.start, p.end);
      return {
        label: `Виріз з «${s.name}»`,
        results: [{ tmp: await cutOut(dir, s, a, b, p.crossfade, curve), name: `${s.name}_cut`, parents: [s.id] }],
      };
    }
    case 'fade': {
      const s = await one();
      return { label: `Фейди «${s.name}»`, results: [{ tmp: await decodeTo(dir, s), name: `${s.name}_fade`, parents: [s.id] }] };
    }
    case 'render': {
      // The whole track with its effects, as a new sound.
      const s = await one();
      if (!s.fx) throw new OpError('Увімкни хоча б один ефект');
      return { label: `Ефекти «${s.name}»`, results: [{ tmp: await decodeTo(dir, s), name: `${s.name}_fx`, parents: [s.id] }] };
    }
    case 'split': {
      const s = await one();
      const segs = (p.segments || [])
        .map((g) => ({ ...g, r: range(s, g.start, g.end) }))
        .sort((x, y) => x.r[0] - y.r[0]);
      if (!segs.length) throw new OpError('Додай хоча б один відрізок');
      const results = [];
      for (let i = 0; i < segs.length; i++) {
        const g = segs[i];
        results.push({
          tmp: await trimTo(dir, s, g.r[0], g.r[1]),
          name: g.name && String(g.name).trim() ? String(g.name).trim() : null,
          index: i + 1,
          parents: [s.id],
        });
      }
      results.forEach((r) => {
        if (!r.name) r.name = `${s.name}_${pad(r.index)}`;
        else r.explicit = true;
      });
      return { label: `Нарізка «${s.name}» → ${segs.length}`, results };
    }
    case 'concat': {
      const list = await many(p.ids, p.fx);
      return {
        label: `Склейка ${list.length} треків`,
        results: [{ tmp: await concat(dir, list, p.gap), name: shortJoin(list.map((s) => s.name)), parents: list.map((s) => s.id) }],
      };
    }
    case 'crossfade': {
      const list = await many(p.ids, p.fx);
      return {
        label: `Кросфейд ${list.length} треків`,
        results: [{
          tmp: await crossfade(dir, list, p.duration, p.overlap !== false, curve),
          name: shortJoin(list.map((s) => s.name)),
          parents: list.map((s) => s.id),
        }],
      };
    }
    case 'overlay': {
      const base = await get(p.baseId, p.baseFx);
      if (!base) throw new OpError('Обери основний трек');
      const layers = [];
      for (const l of p.layers || []) {
        const sound = await get(l.id, l.fx);
        if (sound) layers.push({ ...l, sound });
      }
      if (!layers.length) throw new OpError('Додай хоча б один трек для накладення');
      return {
        label: `Накладення на «${base.name}»`,
        results: [{
          tmp: await overlay(dir, base, p.baseVolume, layers, p.durationMode),
          name: `${base.name}&${layers.length > 1 ? layers.length : layers[0].sound.name}`,
          parents: [base.id, ...layers.map((l) => l.sound.id)],
        }],
      };
    }
    default:
      throw new OpError('Невідома операція: ' + op);
  }
}

export const EXT = { wav: 'wav', ogg: 'ogg', mp3: 'mp3' };

function codecArgs(format, quality, info) {
  if (format === 'ogg') {
    if (caps.ogg === 'libvorbis') return ['-c:a', 'libvorbis', '-q:a', String(Math.min(10, Math.max(-1, num(quality, 6))))];
    if (caps.ogg === 'vorbis') return ['-c:a', 'vorbis', '-strict', '-2', '-ac', '2'];
    throw new OpError('Цей ffmpeg не вміє ogg. Встанови повний: brew install ffmpeg');
  }
  if (format === 'mp3') {
    if (!caps.mp3) throw new OpError('Цей ffmpeg не вміє mp3 (немає libmp3lame). Встанови: brew install ffmpeg');
    const a = ['-c:a', 'libmp3lame', '-q:a', String(Math.min(9, Math.max(0, num(quality, 2))))];
    if (info.sampleRate > 48000) a.push('-ar', '48000');
    return a;
  }
  return ['-c:a', 'pcm_s16le', '-f', 'wav'];
}

/** Applies output fades and encodes `src` into `dest`. */
export async function finalize(src, dest, { fadeIn = 0, fadeOut = 0, curve = 'tri', format = 'wav', quality } = {}) {
  const info = await probe(src);
  const d = info.duration;
  const c = curveOf(curve);
  const fi = Math.min(Math.max(0, num(fadeIn)), d);
  const fo = Math.min(Math.max(0, num(fadeOut)), d);
  const af = [];
  if (fi >= 0.001) af.push(`afade=t=in:st=0:d=${f(fi)}:curve=${c}`);
  if (fo >= 0.001) af.push(`afade=t=out:st=${f(Math.max(0, d - fo))}:d=${f(fo)}:curve=${c}`);
  await ffmpeg([
    '-i', src, '-map', '0:a:0', '-map_metadata', '-1',
    ...(af.length ? ['-af', af.join(',')] : []),
    ...codecArgs(format, quality, info),
    dest,
  ]);
}
