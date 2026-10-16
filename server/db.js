// Tiny JSON-file storage. Everything lives in ./data next to the app.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.ESM_DATA ? path.resolve(process.env.ESM_DATA) : path.join(ROOT, 'data');
export const LIB = path.join(DATA, 'library');
export const TMP = path.join(DATA, 'tmp');
export const EXPORTS = path.join(DATA, 'exports');
const DB_FILE = path.join(DATA, 'db.json');

for (const d of [DATA, LIB, TMP, EXPORTS]) fs.mkdirSync(d, { recursive: true });

export const uid = (prefix = '') => prefix + crypto.randomBytes(5).toString('hex');

function defaults() {
  return {
    version: 2,
    sounds: [],
    batches: [],
    boards: [], // filled on start (see boards.js)
    activeBoard: null,
    settings: {
      exportDir: '', // empty = data/exports inside the app folder
      exportFormat: 'ogg',
      oggQuality: 6,
      mp3Quality: 2,
      overwrite: false,
      saveFormat: 'wav',
      addToDesk: true,
    },
  };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const d = defaults();
    return { ...d, ...raw, settings: { ...d.settings, ...(raw.settings || {}) } };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // Keep a copy of a broken file instead of silently losing it.
      try {
        fs.copyFileSync(DB_FILE, DB_FILE + '.broken-' + Date.now());
      } catch {}
      console.warn('db.json не прочитався, створено новий. Копія збережена поруч.');
    }
    return defaults();
  }
}

export const db = load();

let timer = null;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 150);
}
export function flush() {
  clearTimeout(timer);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
}

export const getSound = (id) => db.sounds.find((s) => s.id === id);
export const soundPath = (s) => path.join(LIB, s.file); // `file` may include a frame folder: "ТВ/boom-1a2b.wav"

/** A frame's folder inside the library (one level, safe name). '' = the library itself. */
export function folderPath(folder) {
  const f = safeName(folder || '', '');
  return f ? path.join(LIB, f) : LIB;
}

/** Safe file name: keeps unicode (Cyrillic etc.), strips characters macOS/Windows dislike. */
export function safeName(name, fallback = 'sound') {
  const n = String(name || '')
    .replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return n || fallback;
}

export function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}.${ext}`);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i}).${ext}`);
  return p;
}
