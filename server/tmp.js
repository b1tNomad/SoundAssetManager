// Temporary files. Every action works in its own folder inside data/tmp and removes it when it
// finishes — successfully or not. Whatever survives a crash is wiped on the next start, and a
// periodic sweep removes anything older than an hour while the app is running.
import fs from 'node:fs';
import path from 'node:path';
import { TMP, uid } from './db.js';

export const PREVIEW = path.join(TMP, 'preview'); // results of «Прослухати», replaced on each new preview

export const rmrf = (p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
};

export function workDir(kind = 'op') {
  const d = path.join(TMP, `${kind}-${uid()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Runs fn(dir) with a fresh work folder that is always deleted afterwards. */
export async function withWork(kind, fn) {
  const dir = workDir(kind);
  try {
    return await fn(dir);
  } finally {
    rmrf(dir);
  }
}

/** Moves a finished file into place. The destination only ever appears complete. */
export function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    // Different disk (e.g. export to an external drive): copy next to the target, then rename.
    const part = dest + '.part';
    try {
      fs.copyFileSync(src, part);
      fs.renameSync(part, dest);
    } catch (err) {
      rmrf(part);
      throw err;
    }
    rmrf(src);
  }
}

export function wipeTmp() {
  for (const f of fs.readdirSync(TMP)) rmrf(path.join(TMP, f));
}

function sweep(maxAgeMs) {
  const now = Date.now();
  for (const f of fs.readdirSync(TMP)) {
    const p = path.join(TMP, f);
    try {
      if (now - fs.statSync(p).mtimeMs > maxAgeMs) rmrf(p);
    } catch {}
  }
}

export function startSweeper() {
  const t = setInterval(() => sweep(60 * 60 * 1000), 5 * 60 * 1000);
  t.unref();
}

/** Removes a folder later (used for downloads the browser still has to fetch). */
export function removeLater(p, ms) {
  setTimeout(() => rmrf(p), ms).unref();
}
