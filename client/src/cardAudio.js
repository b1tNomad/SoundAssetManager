// Decoded audio of each card and its processed (effects) version, shared by the card on the board
// and the inspector, so both always show and play exactly the same thing.
import { useEffect, useSyncExternalStore } from 'react';
import { loadAudio } from './audio.js';
import { media } from './util.js';
import { fxKey, peekFx, processFx } from './fxClient.js';

const entries = new Map(); // uid → entry

function entry(uid) {
  let e = entries.get(uid);
  if (!e) {
    e = { uid, url: null, data: null, error: null, key: '', fx: null, fxErr: null, timer: null, listeners: new Set(), snap: null, drop: null };
    e.snap = snapshot(e);
    entries.set(uid, e);
  }
  return e;
}

function snapshot(e) {
  const key = e.data ? e.key : '';
  const ready = !!key && e.fx?.key === key;
  return {
    data: e.data, // the original sound
    view: key ? (e.fx?.data ?? e.data) : e.data, // what plays and is drawn (while a new version renders, the previous one stays)
    processed: !!key && !!e.fx,
    pending: !!key && !ready && !e.fxErr,
    error: e.error,
    fxError: e.fxErr,
  };
}

function changed(e) {
  e.snap = snapshot(e);
  e.listeners.forEach((f) => f());
}

function runFx(e) {
  const { chain, tail } = e;
  clearTimeout(e.timer);
  if (!e.key || !e.data) return changed(e);
  const hit = peekFx(e.key);
  if (hit) {
    e.fx = { key: e.key, data: hit };
    e.fxErr = null;
    return changed(e);
  }
  changed(e);
  const key = e.key;
  e.timer = setTimeout(() => {
    processFx(e.uid, e.data, chain, tail, key).then(
      (d) => {
        if (d && e.key === key) {
          e.fx = { key, data: d };
          e.fxErr = null;
          changed(e);
        }
      },
      (err) => {
        if (e.key === key) {
          e.fxErr = err.message || 'помилка';
          changed(e);
        }
      }
    );
  }, 80);
}

/** Starts loading / processing when needed; repeated calls with the same inputs do nothing. */
function ensure(e, sound, chain, tail) {
  const url = media(sound);
  const key = fxKey(url, chain, tail);
  e.chain = chain;
  e.tail = tail;
  if (e.url !== url) {
    e.url = url;
    e.data = null;
    e.error = null;
    e.key = key;
    e.fxErr = null;
    changed(e);
    loadAudio(url, sound.sampleRate).then(
      (d) => {
        if (e.url !== url) return;
        e.data = d;
        runFx(e);
      },
      (err) => {
        if (e.url !== url) return;
        e.error = err.message || 'Не вдалося декодувати';
        changed(e);
      }
    );
    return;
  }
  if (e.key !== key) {
    e.key = key;
    e.fxErr = null;
    runFx(e);
  }
}

/**
 * { data, view, processed, pending, error, fxError } for a card. `chain`/`tail` are its effects
 * (from fxClient.chainOf / tailOf).
 */
export function useCardAudio(uid, sound, chain, tail) {
  const e = entry(uid);
  const snap = useSyncExternalStore(
    (cb) => {
      e.listeners.add(cb);
      clearTimeout(e.drop);
      return () => {
        e.listeners.delete(cb);
        // Nobody shows this card any more: forget it a bit later (decoded audio stays cached).
        if (!e.listeners.size) e.drop = setTimeout(() => !e.listeners.size && entries.delete(uid), 30000);
      };
    },
    () => e.snap
  );
  const key = sound ? fxKey(media(sound), chain, tail) : '';
  useEffect(() => {
    if (sound) ensure(e, sound, chain, tail);
  }, [uid, sound?.file, key]);
  return snap;
}
