// Easy Sound Manager — local server (no dependencies, just Node + ffmpeg).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { detect, caps, probe, ffmpeg, FfmpegError } from './ffmpeg.js';
import { db, save, flush, uid, getSound, soundPath, folderPath, safeName, uniquePath, ROOT, LIB, TMP, EXPORTS } from './db.js';
import { migrateDesks } from './boards.js';
import { build, finalize, OpError, EXT } from './ops.js';
import { writeZip } from './zip.js';
import { PREVIEW, rmrf, workDir, withWork, moveFile, wipeTmp, startSweeper, removeLater } from './tmp.js';
import { fxResolver } from './fxrender.js';

const PORT = Number(process.env.PORT) || 3737;
const HOST = process.env.HOST || '127.0.0.1';
const CLIENT = path.join(ROOT, 'client');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm',
};

// Files the browser can decode directly; everything else is converted to WAV on import.
const PLAYABLE_EXT = new Set(['wav', 'mp3', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'webm']);
const PLAYABLE_CODEC = new Set(['pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8', 'mp3', 'vorbis', 'opus', 'flac', 'aac']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- helpers ----------
function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readJson(req, limit = 5 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Запит завеликий');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Некоректний JSON');
  }
}

function sendFile(req, res, file, { immutable = false, download = null } = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    if (download) {
      const ascii = download.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      headers['Content-Disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(download)}`;
    }
    const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      let start = range[1] ? Number(range[1]) : 0;
      let end = range[2] ? Number(range[2]) : st.size - 1;
      if (!range[1] && range[2]) {
        start = Math.max(0, st.size - Number(range[2]));
        end = st.size - 1;
      }
      end = Math.min(end, st.size - 1);
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

function reveal(target, select = false) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  const args = process.platform === 'darwin' && select ? ['-R', target] : [select ? path.dirname(target) : target];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {}
}

function publicState() {
  const ids = new Set(db.sounds.map((s) => s.id));
  const batches = db.batches
    .map((b) => ({ ...b, sounds: b.sounds.filter((id) => ids.has(id)) }))
    .filter((b) => b.sounds.length)
    .slice(-40);
  return {
    sounds: db.sounds,
    batches,
    boards: db.boards,
    activeBoard: db.activeBoard,
    settings: db.settings,
    caps: { found: caps.found, ogg: caps.ogg, mp3: caps.mp3 },
    paths: { library: LIB, exports: EXPORTS },
  };
}

const withPath = (s) => (s ? { ...s, path: soundPath(s) } : null);

const relFile = (abs) => path.relative(LIB, abs).split(path.sep).join('/');

function registerSound({ id, dest: file }, info, { name, origin, parents = [], ext }) {
  const st = fs.statSync(file);
  const sound = {
    id,
    name,
    file: relFile(file),
    thumb: info.thumb,
    ext,
    duration: info.duration,
    sampleRate: info.sampleRate,
    channels: info.channels,
    size: st.size,
    createdAt: Date.now(),
    origin,
    parents,
    favorite: false,
  };
  db.sounds.push(sound);
  return sound;
}

/** A new library file; `folder` is the frame's folder (created on first use). */
function newLibFile(name, ext, folder = '') {
  const key = uid();
  const dir = folderPath(folder);
  fs.mkdirSync(dir, { recursive: true });
  return { id: 's_' + key, dest: path.join(dir, `${safeName(name)}-${key}.${ext}`) };
}

/** Audio-looking files in the library and its frame folders (one level deep). */
function libraryFiles() {
  const out = [];
  for (const f of fs.readdirSync(LIB)) {
    if (f.startsWith('.') || f.endsWith('.part')) continue;
    const p = path.join(LIB, f);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isFile()) out.push(f);
    else if (st.isDirectory())
      for (const g of fs.readdirSync(p)) if (!g.startsWith('.') && !g.endsWith('.part')) out.push(f + '/' + g);
  }
  return out;
}

/**
 * Library ↔ db.json consistency, checked on start:
 * entries whose file is gone are dropped; audio files nobody references are added back as sounds.
 */
async function reconcileLibrary() {
  const missing = db.sounds.filter((s) => !fs.existsSync(soundPath(s)));
  if (missing.length) {
    const gone = new Set(missing.map((s) => s.id));
    db.sounds = db.sounds.filter((s) => !gone.has(s.id));
    for (const b of db.boards || []) b.cards = b.cards.filter((c) => !gone.has(c.soundId));
    for (const d of db.desks || []) d.items = d.items.filter((i) => !gone.has(i.soundId));
    for (const b of db.batches) b.sounds = b.sounds.filter((id) => !gone.has(id));
    db.batches = db.batches.filter((b) => b.sounds.length);
    console.log(`  Записів без файлів прибрано: ${missing.length}`);
  }
  if (!caps.found) return;
  const known = new Set(db.sounds.map((s) => s.file));
  const ids = new Set(db.sounds.map((s) => s.id));
  const recovered = [];
  for (const f of libraryFiles()) {
    if (known.has(f)) continue;
    const file = path.join(LIB, f);
    let info;
    try {
      if (!fs.statSync(file).isFile()) continue;
      info = await probe(file);
    } catch {
      continue; // not audio — leave it alone
    }
    const m = path.basename(f).match(/^(.*)-([0-9a-f]{10})\.(\w+)$/);
    const ext = path.extname(f).slice(1).toLowerCase();
    const id = m && !ids.has('s_' + m[2]) ? 's_' + m[2] : uid('s_');
    ids.add(id);
    recovered.push(registerSound({ id, dest: file }, info, { name: m ? m[1] : path.basename(f, path.extname(f)), origin: 'import', ext }));
    console.log(`  + ${f}`);
  }
  if (recovered.length) {
    db.batches.push({ id: uid('b_'), op: 'import', label: `Відновлено файлів: ${recovered.length}`, sources: [], sounds: recovered.map((s) => s.id), createdAt: Date.now() });
    console.log(`  Повернуто в бібліотеку файлів, яких не було в базі: ${recovered.length}`);
  }
  if (missing.length || recovered.length) flush();
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('GET', '/api/state', (req, res) => json(res, publicState()));

route('POST', '/api/import', async (req, res, { query }) => {
  const orig = query.get('name') || 'sound';
  const ext0 = (path.extname(orig).slice(1) || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  const name = safeName(path.basename(orig, path.extname(orig)));
  const sound = await withWork('import', async (dir) => {
    // Upload lands in the work folder; an aborted upload or a bad file is removed with it.
    let file = path.join(dir, `upload.${ext0}`);
    await pipeline(req, fs.createWriteStream(file));
    let info;
    try {
      info = await probe(file);
    } catch (e) {
      if (e instanceof FfmpegError && !caps.found) throw new HttpError(500, e.message);
      throw new HttpError(400, `«${orig}» не схоже на аудіофайл`);
    }
    let ext = ext0;
    if (!(PLAYABLE_EXT.has(ext0) && PLAYABLE_CODEC.has(info.codec))) {
      ext = 'wav';
      const conv = path.join(dir, 'converted.wav');
      await ffmpeg(['-i', file, '-map', '0:a:0', '-c:a', 'pcm_s16le', conv]);
      file = conv;
      info = await probe(conv);
    }
    if (!(info.duration > 0)) throw new HttpError(400, `«${orig}» порожній`);
    const target = newLibFile(name, ext, query.get('folder') || '');
    moveFile(file, target.dest);
    return registerSound(target, info, { name, origin: 'import', ext });
  });

  const batchId = query.get('batch');
  let batch = batchId && db.batches.find((b) => b.id === batchId);
  if (!batch) {
    batch = { id: batchId && /^b_[0-9a-z]{4,20}$/.test(batchId) ? batchId : uid('b_'), op: 'import', label: '', sources: [], sounds: [], createdAt: Date.now() };
    db.batches.push(batch);
  }
  batch.sounds.push(sound.id);
  batch.label = batch.sounds.length === 1 ? `Імпорт «${sound.name}»` : `Імпорт ${batch.sounds.length} файлів`;
  flush();
  json(res, { sound, batch });
});

route('PATCH', '/api/sounds/:id', async (req, res, { params }) => {
  const s = getSound(params.id);
  if (!s) throw new HttpError(404, 'Звук не знайдено');
  const body = await readJson(req);
  if (typeof body.name === 'string' && body.name.trim()) s.name = body.name.trim().slice(0, 120);
  if (typeof body.favorite === 'boolean') s.favorite = body.favorite;
  save();
  json(res, { sound: s });
});

route('DELETE', '/api/sounds/:id', (req, res, { params }) => {
  const s = getSound(params.id);
  if (!s) throw new HttpError(404, 'Звук не знайдено');
  fs.rmSync(soundPath(s), { force: true });
  db.sounds = db.sounds.filter((x) => x.id !== s.id);
  for (const b of db.boards) b.cards = b.cards.filter((c) => c.soundId !== s.id);
  for (const b of db.batches) b.sounds = b.sounds.filter((id) => id !== s.id);
  db.batches = db.batches.filter((b) => b.sounds.length);
  save();
  json(res, { ok: true });
});

route('PUT', '/api/boards', async (req, res) => {
  const body = await readJson(req, 20 * 1024 * 1024);
  if (!Array.isArray(body.boards) || !body.boards.length) throw new HttpError(400, 'boards');
  db.boards = body.boards;
  db.activeBoard = body.activeBoard || body.boards[0].id;
  save();
  json(res, { ok: true });
});

// Renaming a frame renames its folder. If the new name's folder already exists, files are moved into it.
route('POST', '/api/folders/rename', async (req, res) => {
  const body = await readJson(req);
  const from = safeName(body.from || '', '');
  const to = safeName(body.to || '', '');
  if (!from || !to || from === to) return json(res, { folder: to || from, sounds: [] });
  const src = path.join(LIB, from);
  if (!fs.existsSync(src)) return json(res, { folder: to, sounds: [] });
  const dst = path.join(LIB, to);
  const moved = new Map(); // old rel → new rel
  if (!fs.existsSync(dst)) {
    fs.renameSync(src, dst);
    for (const f of fs.readdirSync(dst)) moved.set(from + '/' + f, to + '/' + f);
  } else {
    for (const f of fs.readdirSync(src)) {
      const ext = path.extname(f);
      const target = uniquePath(dst, path.basename(f, ext), ext.slice(1));
      moveFile(path.join(src, f), target);
      moved.set(from + '/' + f, relFile(target));
    }
    rmrf(src);
  }
  const changed = [];
  for (const s of db.sounds) {
    if (moved.has(s.file)) {
      s.file = moved.get(s.file);
      changed.push(s);
    }
  }
  flush();
  json(res, { folder: to, sounds: changed });
});

route('PUT', '/api/settings', async (req, res) => {
  const body = await readJson(req);
  const allowed = ['exportDir', 'exportFormat', 'oggQuality', 'mp3Quality', 'overwrite', 'saveFormat', 'addToDesk'];
  for (const k of allowed) if (k in body) db.settings[k] = body[k];
  save();
  json(res, { settings: db.settings });
});

route('POST', '/api/process', async (req, res) => {
  const { op, params = {}, output = {}, preview = false } = await readJson(req);
  const fades = { fadeIn: output.fadeIn, fadeOut: output.fadeOut, curve: output.curve };
  // Everything intermediate lives in one work folder that disappears when this action ends.
  await withWork('op', async (dir) => {
    const built = await build(op, params, fxResolver((id) => withPath(getSound(id)), dir), dir);

    if (preview) {
      const files = [];
      for (const [i, r] of built.results.entries()) {
        const out = path.join(dir, `preview-${i}.wav`);
        await finalize(r.tmp, out, { ...fades, format: 'wav' });
        files.push({ out, name: r.name, info: await probe(out) });
      }
      // Only the latest preview is kept (until the next one, or at most an hour).
      rmrf(PREVIEW);
      fs.mkdirSync(PREVIEW, { recursive: true });
      const previews = files.map((x) => {
        const f = `${uid()}.wav`;
        moveFile(x.out, path.join(PREVIEW, f));
        return { url: '/tmp/preview/' + f, name: x.name, duration: x.info.duration };
      });
      return json(res, { previews });
    }

    const format = EXT[output.format] ? output.format : 'wav';
    const quality = format === 'ogg' ? db.settings.oggQuality : db.settings.mp3Quality;
    const custom = typeof output.name === 'string' ? safeName(output.name.trim(), '') : '';
    built.results.forEach((r, i) => {
      if (custom) r.name = built.results.length === 1 ? custom : r.explicit ? r.name : `${custom}_${String(i + 1).padStart(2, '0')}`;
    });

    // All results are rendered first; the library only changes once every one of them succeeded.
    const ready = [];
    for (const [i, r] of built.results.entries()) {
      const out = path.join(dir, `final-${i}.${format}`);
      await finalize(r.tmp, out, { ...fades, format, quality });
      const info = await probe(out);
      if (!(info.duration > 0)) throw new OpError('Порожній результат');
      ready.push({ r, out, info });
    }
    const batch = {
      id: uid('b_'),
      op,
      label: built.label,
      sources: [...new Set(built.results.flatMap((r) => r.parents))],
      sounds: [],
      createdAt: Date.now(),
    };
    const sounds = ready.map(({ r, out, info }) => {
      const target = newLibFile(r.name, format, output.folder || '');
      moveFile(out, target.dest);
      const snd = registerSound(target, info, { name: r.name, origin: op, parents: r.parents, ext: format });
      batch.sounds.push(snd.id);
      return snd;
    });
    db.batches.push(batch);
    if (db.batches.length > 200) db.batches = db.batches.slice(-200);
    flush();
    json(res, { sounds, batch });
  });
});

route('POST', '/api/export', async (req, res) => {
  const body = await readJson(req);
  const format = EXT[body.format] ? body.format : 'ogg';
  const dir = path.resolve(expandHome(String(body.dir || db.settings.exportDir || EXPORTS)));
  fs.mkdirSync(dir, { recursive: true });
  const quality = body.quality ?? (format === 'ogg' ? db.settings.oggQuality : db.settings.mp3Quality);
  const files = [];
  for (const [i, id] of (body.ids || []).entries()) {
    const s = getSound(id);
    if (!s) continue;
    const base = safeName(s.name);
    const dest = body.overwrite ? path.join(dir, `${base}.${format}`) : uniquePath(dir, base, format);
    // Rendered in a work folder first, so a failure never leaves a broken file in the export folder.
    await withWork('export', async (work) => {
      const src = await fxResolver((x) => withPath(getSound(x)), work)(id, body.fx?.[i]);
      const out = path.join(work, `out.${format}`);
      await finalize(src.path, out, { format, quality });
      moveFile(out, dest);
    });
    files.push(dest);
  }
  json(res, { dir, files });
});

// Several sounds → one .zip (or the single file itself). Optional conversion to wav/ogg/mp3.
route('POST', '/api/download', async (req, res) => {
  const body = await readJson(req);
  const format = EXT[body.format] ? body.format : null; // null = keep each file as it is
  const list = (body.ids || []).map((id, i) => ({ snd: getSound(id), fx: body.fx?.[i] || null })).filter((x) => x.snd);
  if (!list.length) throw new HttpError(400, 'Нічого не вибрано');
  const quality = body.quality ?? (format === 'ogg' ? db.settings.oggQuality : db.settings.mp3Quality);

  const work = workDir('dl');
  try {
    const used = new Set();
    const entries = [];
    const resolve = fxResolver((id) => withPath(getSound(id)), work);
    for (const { snd: s0, fx } of list) {
      // A card's effects are rendered into the file (then it always gets encoded).
      const snd = fx ? await resolve(s0.id, fx) : s0;
      const ext = format || (snd.fx ? 'wav' : snd.ext);
      const base = safeName(snd.name);
      let name = `${base}.${ext}`;
      for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} (${i}).${ext}`;
      used.add(name.toLowerCase());
      let src = snd.fx ? snd.path : soundPath(snd);
      if (snd.fx || (format && format !== snd.ext)) {
        const out = path.join(work, `${entries.length}.${ext}`);
        await finalize(src, out, { format: ext, quality });
        src = out;
      }
      entries.push({ path: src, name });
    }

    let file;
    let name;
    if (entries.length === 1) {
      name = entries[0].name;
      file = path.join(work, 'file.' + path.extname(name).slice(1));
      if (entries[0].path.startsWith(work)) fs.renameSync(entries[0].path, file);
      else fs.copyFileSync(entries[0].path, file);
      for (const f of fs.readdirSync(work)) if (path.join(work, f) !== file) rmrf(path.join(work, f));
    } else {
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
      name = (body.name ? safeName(body.name) : `sounds-${stamp}`) + '.zip';
      file = path.join(work, 'archive.zip');
      await writeZip(entries, file);
      // Converted copies (and processed tracks) are inside the archive now.
      for (const f of fs.readdirSync(work)) if (f !== 'archive.zip') rmrf(path.join(work, f));
    }
    // The browser fetches it right away; the folder is removed shortly after either way.
    removeLater(work, 10 * 60 * 1000);
    json(res, { url: `/tmp/${path.basename(work)}/${path.basename(file)}?dl=${encodeURIComponent(name)}`, name, count: entries.length });
  } catch (e) {
    rmrf(work);
    throw e;
  }
});

route('POST', '/api/reveal', async (req, res) => {
  const body = await readJson(req);
  if (body.id) {
    const s = getSound(body.id);
    if (!s) throw new HttpError(404, 'Звук не знайдено');
    reveal(soundPath(s), true);
  } else if (body.folder != null) {
    const p = folderPath(body.folder);
    if (!fs.existsSync(p)) throw new HttpError(404, 'Папки ще немає — вона з’явиться, коли збережеш щось у цьому фреймі');
    reveal(p);
  } else if (body.path) {
    const p = path.resolve(expandHome(String(body.path)));
    if (!fs.existsSync(p)) throw new HttpError(404, 'Папки ще немає — спершу експортуй щось');
    reveal(p, fs.statSync(p).isFile());
  }
  json(res, { ok: true });
});

route('POST', '/api/redetect', (req, res) => {
  detect();
  json(res, { caps: { found: caps.found, ogg: caps.ogg, mp3: caps.mp3 } });
});

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pathname.match(r.re);
        if (m) return await r.handler(req, res, { params: m.groups || {}, query: url.searchParams });
      }
      throw new HttpError(404, 'Немає такого API');
    }
    const dl = url.searchParams.get('dl');
    if (pathname.startsWith('/media/')) {
      const parts = pathname.slice(7).split('/').filter((x) => x && x !== '.' && x !== '..');
      if (!parts.length || parts.length > 2) throw new HttpError(404, 'Not found');
      return sendFile(req, res, path.join(LIB, ...parts), { immutable: !dl, download: dl });
    }
    if (pathname.startsWith('/tmp/')) {
      const parts = pathname.slice(5).split('/').filter((x) => x && x !== '.' && x !== '..');
      if (parts.length > 2) throw new HttpError(404, 'Not found');
      return sendFile(req, res, path.join(TMP, ...parts), { download: dl });
    }
    if (pathname.startsWith('/dist/')) return sendFile(req, res, path.join(CLIENT, 'dist', path.basename(pathname)));
    if (pathname === '/' || pathname === '/index.html') return sendFile(req, res, path.join(CLIENT, 'index.html'));
    res.writeHead(404);
    res.end();
  } catch (e) {
    const status = e.status || (e instanceof OpError || e instanceof FfmpegError ? 422 : 500);
    if (status >= 500) console.error(e);
    if (!res.headersSent) json(res, { error: e.message || 'Помилка', details: e.stderr || undefined }, status);
    else res.end();
  }
});

detect();
wipeTmp(); // leftovers of a previous run (e.g. the app was closed mid-action)
await reconcileLibrary();
if (migrateDesks(db)) {
  console.log('  Столи перенесено на дошки');
  flush();
}
startSweeper();

// Waveform thumbs for sounds added before thumbs existed (in the background, one by one).
async function fillThumbs() {
  let n = 0;
  for (const s of db.sounds) {
    if (Array.isArray(s.thumb) || !fs.existsSync(soundPath(s))) continue;
    try {
      s.thumb = (await probe(soundPath(s))).thumb;
      n++;
    } catch {}
  }
  if (n) save();
}

const url = `http://localhost:${PORT}`;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Порт ${PORT} вже зайнятий — схоже, застосунок уже запущено: ${url}`);
    if (process.platform === 'darwin' && !process.env.NO_OPEN) reveal(url);
    process.exit(0);
  }
  throw e;
});
server.listen(PORT, HOST, () => {
  console.log(`\n  Easy Sound Manager → ${url}\n`);
  if (!caps.found) console.log('  ⚠ ffmpeg не знайдено. Встанови: brew install ffmpeg\n');
  else {
    console.log(`  ffmpeg: ${caps.bin}`);
    if (caps.ogg !== 'libvorbis') console.log('  ⚠ немає libvorbis — ogg буде гіршої якості. Краще: brew install ffmpeg');
  }
  if (!fs.existsSync(path.join(CLIENT, 'dist', 'app.js'))) console.log('  ⚠ інтерфейс не зібрано: npm install && npm run build');
  if (process.platform === 'darwin' && !process.env.NO_OPEN) reveal(url);
  if (caps.found) fillThumbs();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      flush();
    } catch {}
    process.exit(0);
  });
}
