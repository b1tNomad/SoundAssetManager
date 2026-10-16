import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { player, forgetAudio } from './audio.js';
import { rid, media, downloadUrl } from './util.js';
import Layers from './components/Layers.jsx';
import BoardTabs from './components/BoardTabs.jsx';
import Canvas from './components/Canvas.jsx';
import Inspector from './components/Inspector.jsx';
import { cardControls } from './components/TrackCard.jsx';
import { setPreviewMap } from './previewMap.js';
import { effSoundOf } from './fxClient.js';
import * as B from './boardOps.js';
import { CARD_H, cardW, frameAt, rightOf } from '../../shared/board.js';

const AUDIO_RE = /\.(wav|mp3|ogg|oga|flac|aif|aiff|aifc|m4a|aac|opus|webm|wma|caf|mp4)$/i;
const EMPTY_SEL = { cards: [], frames: [] };
const newBoard = (name) => ({ id: rid('bd_'), name, frames: [], cards: [], view: { x: 80, y: 80, z: 0.8 } });
const dirOf = (file) => (file && file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');

export default function App() {
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [sounds, setSounds] = useState([]);
  const [boards, setBoardsState] = useState([]);
  const boardsRef = useRef([]);
  const [activeBoard, setActiveBoardState] = useState(null);
  const activeRef = useRef(null);
  const views = useRef({}); // board id → { x, y, z }; kept out of undo history
  const [settings, setSettingsState] = useState({});
  const [caps, setCaps] = useState({ found: true });
  const [paths, setPaths] = useState({});
  const [sel, setSelState] = useState(EMPTY_SEL);
  const [tool, setTool] = useState('select');
  const [frameKind, setFrameKind] = useState('split');
  const [tab, setTab] = useState('tool');
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [previews, setPreviews] = useState([]);
  const [lastExport, setLastExport] = useState(null);
  const [newUids, setNewUids] = useState(() => new Set());
  const [tabHover, setTabHover] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [dialog, setDialog] = useState(null);
  const canvasApi = useRef(null);
  const hist = useRef({ past: [], future: [], key: null, at: 0 });
  const regionFocus = useRef(null);
  const flashTimer = useRef(null);
  const [savedTick, setSavedTick] = useState(0);
  // Side panels: the left one only folds when you fold it; the right one opens by itself for a selection.
  const [leftOpen, setLeftOpen] = useState(() => {
    try {
      return localStorage.getItem('esm.left') !== '0';
    } catch {
      return true;
    }
  });
  const [rightManual, setRightManual] = useState(null); // null = automatic, true/false = what you chose for this selection
  const toggleLeft = () =>
    setLeftOpen((v) => {
      try {
        localStorage.setItem('esm.left', v ? '0' : '1');
      } catch {}
      return !v;
    });

  const setActiveBoard = (id) => {
    activeRef.current = id;
    setActiveBoardState(id);
  };

  // ---------- load & persist ----------
  useEffect(() => {
    api
      .state()
      .then((s) => {
        setSounds(s.sounds);
        const bs = s.boards?.length ? s.boards : [newBoard('Дошка 1')];
        for (const b of bs) views.current[b.id] = b.view || { x: 80, y: 80, z: 0.8 };
        boardsRef.current = bs;
        setBoardsState(bs);
        setActiveBoard(bs.some((b) => b.id === s.activeBoard) ? s.activeBoard : bs[0].id);
        setSettingsState(s.settings);
        setCaps(s.caps);
        setPaths(s.paths);
        setReady(true);
      })
      .catch((e) => setLoadError(e.message));
  }, []);

  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => {
      const out = boardsRef.current.map((b) => ({ ...b, view: views.current[b.id] || b.view }));
      api.saveBoards(out, activeRef.current).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [boards, activeBoard, ready, savedTick]);

  const settingsDirty = useRef(false);
  useEffect(() => {
    if (!ready || !settingsDirty.current) return;
    const t = setTimeout(() => api.saveSettings(settings).catch(() => {}), 400);
    return () => clearTimeout(t);
  }, [settings, ready]);
  const setSettings = useCallback((patch) => {
    settingsDirty.current = true;
    setSettingsState((s) => ({ ...s, ...patch }));
  }, []);

  // ---------- history ----------
  /** Every change of the boards goes through here; `key` merges quick repeats (sliders, typing) into one undo step. */
  const setBoards = (next, { history = true, key = null } = {}) => {
    const prev = boardsRef.current;
    if (next === prev) return;
    if (history) {
      const h = hist.current;
      const now = Date.now();
      if (!(key && h.key === key && now - h.at < 1500)) {
        h.past.push(prev);
        if (h.past.length > 200) h.past.shift();
      }
      h.future = [];
      h.key = key;
      h.at = now;
    }
    boardsRef.current = next;
    setBoardsState(next);
  };
  const editBoard = (fn, opts) => {
    const id = activeRef.current;
    setBoards(
      boardsRef.current.map((b) => (b.id === id ? fn(b) : b)),
      opts
    );
  };
  const curBoard = () => boardsRef.current.find((b) => b.id === activeRef.current);

  const undo = () => {
    const h = hist.current;
    if (!h.past.length) return toast('Більше нічого скасовувати');
    h.future.push(boardsRef.current);
    const prev = h.past.pop();
    h.key = null;
    boardsRef.current = prev;
    setBoardsState(prev);
    if (!prev.some((b) => b.id === activeRef.current)) setActiveBoard(prev[0].id);
  };
  const redo = () => {
    const h = hist.current;
    if (!h.future.length) return;
    h.past.push(boardsRef.current);
    const next = h.future.pop();
    h.key = null;
    boardsRef.current = next;
    setBoardsState(next);
    if (!next.some((b) => b.id === activeRef.current)) setActiveBoard(next[0].id);
  };

  // ---------- feedback ----------
  const toast = useCallback((text, kind = 'ok') => {
    const id = rid();
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  const confirm = (text, ok = 'Видалити') => new Promise((res) => setDialog({ text, ok, res }));
  const flash = (uids) => {
    setNewUids(new Set(uids));
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setNewUids(new Set()), 5000);
  };
  const setSel = useCallback((s) => setSelState(s), []);

  // ---------- derived ----------
  const soundsById = useMemo(() => Object.fromEntries(sounds.map((s) => [s.id, s])), [sounds]);
  const selKey = sel.cards.join(',') + '|' + sel.frames.join(',');
  useEffect(() => setRightManual(null), [selKey, activeBoard]);
  const rightOpen = rightManual ?? (sel.cards.length > 0 || sel.frames.length > 0);
  const board = boards.find((b) => b.id === activeBoard) || boards[0];
  const effOf = (c) => effSoundOf(soundsById[c.soundId], c);

  // ---------- cards & frames ----------
  const reveal = (rect) => setTimeout(() => canvasApi.current?.reveal(rect), 30);
  const cardRect = (c) => ({ x: c.x, y: c.y, w: cardW(c), h: CARD_H });

  const updateCard = (uid, patch, opts = {}) =>
    editBoard((b) => ({ ...b, cards: b.cards.map((c) => (c.uid === uid ? { ...c, ...patch } : c)) }), opts.quiet ? { history: false } : { key: opts.key || 'card:' + uid + ':' + Object.keys(patch).join(',') });

  const duplicate = (uids, clean = false) => {
    let copies = [];
    editBoard((b) => {
      const r = B.duplicateCards(b, uids, { clean });
      copies = r.uids;
      return r.board;
    });
    setSel({ cards: copies, frames: [] });
    flash(copies);
    const c = curBoard().cards.find((x) => x.uid === copies[0]);
    if (c) reveal(cardRect(c));
  };

  const removeCards = (uids) => {
    if (!uids.length) return;
    if (uids.some((u) => player.owner() === 'card:' + u)) player.stop();
    editBoard((b) => B.removeCards(b, uids));
    setSel(EMPTY_SEL);
    toast(uids.length === 1 ? 'Картку прибрано з дошки (файл лишився). ⌘Z — повернути' : `Прибрано карток: ${uids.length}. ⌘Z — повернути`);
  };

  const deleteFrames = (fids, withCards) => {
    editBoard((b) => B.removeFrames(b, fids, withCards));
    setSel(EMPTY_SEL);
  };

  const onMove = ({ uids, fids, dx, dy, alt }) => {
    if (alt && uids.length) {
      let copies = [];
      editBoard((b) => {
        const r = B.duplicateCards(b, uids, { dx, dy });
        copies = r.uids;
        return r.board;
      });
      setSel({ cards: copies, frames: [] });
      return;
    }
    editBoard((b) => {
      let nb = b;
      if (fids.length) nb = B.moveFrames(nb, fids, dx, dy);
      const loose = uids.filter((u) => !fids.includes(b.cards.find((c) => c.uid === u)?.frameId));
      if (loose.length) nb = B.moveCards(nb, loose, dx, dy);
      return nb;
    });
  };

  const createFrame = (type, rect) => {
    let f = null;
    editBoard((b) => {
      const r = B.addFrame(b, type, rect);
      f = r.frame;
      return r.board;
    });
    setSel({ cards: [], frames: [f.id] });
    return f;
  };
  const newFrameHere = (type) => {
    const c = canvasApi.current?.center() || { x: 0, y: 0 };
    createFrame(type, { x: c.x - 500, y: c.y - 280, w: 1000, h: 560 });
  };

  const wrap = (uids, type) => {
    let f = null;
    editBoard((b) => {
      const r = B.wrapInFrame(b, uids, type);
      f = r.frame;
      return r.board;
    });
    if (f) {
      setSel({ cards: uids.length === 1 ? uids : [], frames: uids.length === 1 ? [] : [f.id] });
      setTab('tool');
      const nf = curBoard().frames.find((x) => x.id === f.id);
      if (nf) reveal(nf);
    }
  };

  const renameFrame = async (fid, name) => {
    const f = curBoard().frames.find((x) => x.id === fid);
    if (!f) return;
    editBoard((b) => B.updateFrame(b, fid, { name }), { key: 'name:' + fid });
    // Its folder follows the name (when something was already saved there).
    if (f.folder && f.folder !== B.safeFolder(name)) {
      try {
        const r = await api.renameFolder(f.folder, name);
        if (r.sounds?.length) {
          const byId = Object.fromEntries(r.sounds.map((s) => [s.id, s]));
          setSounds((list) => list.map((s) => byId[s.id] || s));
        }
        setBoards(
          boardsRef.current.map((b) => ({ ...b, frames: b.frames.map((x) => (x.folder === f.folder ? { ...x, folder: r.folder } : x)) })),
          { history: false }
        );
      } catch (e) {
        toast(e.message, 'error');
      }
    }
  };

  const copyToBoard = (boardId, uids, fids = []) => {
    const src = curBoard();
    const target = boardsRef.current.find((b) => b.id === boardId);
    if (!target) return;
    const cards = src.cards.filter((c) => uids.includes(c.uid) || fids.includes(c.frameId));
    const frames = src.frames.filter((f) => fids.includes(f.id));
    const box = B.bounds(src, { cards: cards.map((c) => c.uid), frames: frames.map((f) => f.id) });
    if (!box) return;
    const at = rightOf(target);
    const dx = at.x - box.x;
    const dy = at.y - box.y;
    const fmap = Object.fromEntries(frames.map((f) => [f.id, rid('f_')]));
    const nf = frames.map((f) => ({ ...JSON.parse(JSON.stringify(f)), id: fmap[f.id], x: f.x + dx, y: f.y + dy }));
    const nc = cards.map((c) => ({ ...JSON.parse(JSON.stringify(c)), uid: rid('c_'), x: c.x + dx, y: c.y + dy, frameId: fmap[c.frameId] || null }));
    setBoards(boardsRef.current.map((b) => (b.id === boardId ? { ...b, frames: [...b.frames, ...nf], cards: [...b.cards, ...nc] } : b)));
    toast(`Скопійовано на «${target.name}»: ${nc.length}`);
  };

  // ---------- import ----------
  const importFiles = async (files, at) => {
    const audio = files.filter((f) => f.type.startsWith('audio/') || AUDIO_RE.test(f.name));
    if (!audio.length) return toast('Це не схоже на аудіофайли', 'error');
    const b = curBoard();
    // «Додати файли»: into the selected frame, or the frame of the selected card, or wherever the view is centred.
    const selCard = !at && sel.cards.length === 1 ? b.cards.find((c) => c.uid === sel.cards[0]) : null;
    const selFrame = at ? null : sel.frames.length === 1 ? b.frames.find((f) => f.id === sel.frames[0]) : selCard?.frameId ? b.frames.find((f) => f.id === selCard.frameId) : null;
    const point = at || canvasApi.current?.center() || { x: 0, y: 0 };
    const frame = selFrame || frameAt(b.frames, point);
    const folder = B.folderOf(frame);
    setImporting(true);
    const batch = rid('b_');
    const created = [];
    for (const f of audio) {
      try {
        const r = await api.importFile(f, batch, folder);
        created.push(r.sound);
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    setImporting(false);
    if (!created.length) return;
    setSounds((s) => [...s, ...created]);
    let uids = [];
    editBoard((bb) => {
      const r = B.addCards(bb, created.map((s) => s.id), { at: frame ? null : point, frameId: frame?.id });
      uids = r.uids;
      let nb = r.board;
      if (frame && !frame.folder && folder) nb = B.updateFrame(nb, frame.id, { folder: dirOf(created[0].file) || folder });
      return nb;
    });
    flash(uids);
    setSel({ cards: uids, frames: [] });
    const nb = curBoard();
    const box = B.bounds(nb, { cards: uids, frames: [] });
    if (box) setTimeout(() => canvasApi.current?.reveal(box), 30);
    toast(created.length === 1 ? `Додано: ${created[0].name}` : `Додано файлів: ${created.length}`);
  };

  const addSounds = (ids, at) => {
    if (!ids.length) return;
    let uids = [];
    editBoard((b) => {
      const r = B.addCards(b, ids, { at: at || canvasApi.current?.center() });
      uids = r.uids;
      return r.board;
    });
    setSel({ cards: uids, frames: [] });
    flash(uids);
    if (!at) {
      const box = B.bounds(curBoard(), { cards: uids, frames: [] });
      if (box) setTimeout(() => canvasApi.current?.reveal(box), 30);
    }
  };

  const dropSoundsOnBoard = (boardId, ids) => {
    const target = boardsRef.current.find((b) => b.id === boardId);
    if (!target || !ids.length) return;
    const r = B.addCards(target, ids, { at: rightOf(target) });
    setBoards(boardsRef.current.map((b) => (b.id === boardId ? r.board : b)));
    if (boardId !== activeRef.current) toast(`Додано на «${target.name}»: ${ids.length}`);
  };

  // ---------- operations ----------
  const runPreview = async ({ layout, ...req }) => {
    setBusy(true);
    try {
      const r = await api.process({ ...req, preview: true });
      setPreviews(r.previews);
      const p0 = r.previews[0];
      setPreviewMap(layout && p0 ? { owner: 'prev:' + p0.url, url: p0.url, duration: p0.duration, segments: layout.segments } : null);
      if (p0) player.playUrl('prev:' + p0.url, p0.url);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  /** Saves the result into the frame's folder and puts the new sounds as cards into the same frame. */
  const runOp = async (req, { frameId = null, sourceUid = null } = {}) => {
    setBusy(true);
    try {
      const r = await api.process(req);
      setSounds((s) => [...s, ...r.sounds]);
      setPreviews([]);
      setPreviewMap(null);
      let uids = [];
      editBoard((b) => {
        const frame = frameId ? b.frames.find((f) => f.id === frameId) : null;
        const res = B.addCards(b, r.sounds.map((s) => s.id), { frameId, after: sourceUid, extra: frame?.type === 'merge' ? { inMerge: false } : {} });
        uids = res.uids;
        let nb = res.board;
        if (frame && !frame.folder) nb = B.updateFrame(nb, frame.id, { folder: dirOf(r.sounds[0]?.file) || B.folderOf(frame) });
        return nb;
      });
      flash(uids);
      const box = B.bounds(curBoard(), { cards: uids, frames: [] });
      if (box) setTimeout(() => canvasApi.current?.reveal(box), 30);
      toast(r.sounds.length === 1 ? `Збережено: ${r.sounds[0].name}` : `Збережено ${r.sounds.length} файлів`);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveFx = (uid) => {
    const c = curBoard().cards.find((x) => x.uid === uid);
    const s = c && effOf(c);
    if (!s?.fx) return;
    const frame = B.frameOf(curBoard(), c);
    runOp({ op: 'render', params: { id: s.id, fx: s.fx }, output: { format: settings.saveFormat, folder: B.folderOf(frame) } }, { frameId: frame?.id || null, sourceUid: uid });
  };

  const exportTargets = async (targets, dir) => {
    setBusy(true);
    try {
      const fmt = settings.exportFormat;
      const r = await api.exportFiles({
        ids: targets.map((s) => s.id),
        fx: targets.map((s) => s.fx || null),
        format: fmt,
        quality: fmt === 'ogg' ? settings.oggQuality : settings.mp3Quality,
        dir,
        overwrite: settings.overwrite,
      });
      setLastExport(r);
      toast(`Експортовано: ${r.files.length} → ${r.dir}`);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  // One file → straight download; several → a .zip. Effects are rendered in.
  const download = async (targets, format = null) => {
    if (!targets.length) return;
    const t0 = targets[0];
    if (targets.length === 1 && !t0.fx && (!format || t0.ext === format)) {
      const n = `${t0.name}.${t0.ext}`;
      downloadUrl(`${media(t0)}?dl=${encodeURIComponent(n)}`, n);
      return;
    }
    setDownloading(true);
    try {
      const quality = format === 'ogg' ? settings.oggQuality : format === 'mp3' ? settings.mp3Quality : undefined;
      const r = await api.download({ ids: targets.map((s) => s.id), format, quality, fx: targets.map((s) => s.fx || null) });
      downloadUrl(r.url, r.name);
      toast(r.count > 1 ? `Архів готовий: ${r.count} файлів → Завантаження` : `Завантажується: ${r.name}`);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setDownloading(false);
    }
  };

  const revealPath = (p) => api.reveal(p).catch((e) => toast(e.message, 'error'));

  // ---------- library ----------
  const renameSound = async (id, name) => {
    try {
      const r = await api.patchSound(id, { name });
      setSounds((s) => s.map((x) => (x.id === id ? r.sound : x)));
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const favSound = (id, favorite) => {
    setSounds((s) => s.map((x) => (x.id === id ? { ...x, favorite } : x)));
    api.patchSound(id, { favorite }).catch((e) => toast(e.message, 'error'));
  };
  const deleteSounds = async (ids) => {
    const text = ids.length === 1 ? `Видалити файл «${soundsById[ids[0]]?.name}» з диска?` : `Видалити ${ids.length} файлів з диска?`;
    if (!(await confirm(text))) return;
    player.stop();
    for (const id of ids) {
      try {
        await api.deleteSound(id);
        if (soundsById[id]) forgetAudio(media(soundsById[id]));
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    const gone = new Set(ids);
    setSounds((s) => s.filter((x) => !gone.has(x.id)));
    setBoards(
      boardsRef.current.map((b) => ({ ...b, cards: b.cards.filter((c) => !gone.has(c.soundId)) })),
      { history: false }
    );
  };

  // ---------- boards ----------
  const addBoard = () => {
    const b = newBoard(`Дошка ${boardsRef.current.length + 1}`);
    views.current[b.id] = b.view;
    setBoards([...boardsRef.current, b]);
    switchBoard(b.id);
  };
  const switchBoard = (id) => {
    setActiveBoard(id);
    setSel(EMPTY_SEL);
    setTool('select');
  };
  const closeBoard = async (id) => {
    const d = boardsRef.current.find((x) => x.id === id);
    if (d.cards.length && !(await confirm(`Закрити «${d.name}»? Картки зникнуть з дошки, файли лишаться в бібліотеці.`, 'Закрити'))) return;
    const rest = boardsRef.current.filter((x) => x.id !== id);
    setBoards(rest);
    if (activeRef.current === id) switchBoard(rest[Math.max(0, boardsRef.current.findIndex((x) => x.id === id) - 1)]?.id || rest[0].id);
  };

  // ---------- focus / fit ----------
  const fitAll = () => canvasApi.current?.fit(B.bounds(curBoard()));
  const fitSel = () => {
    const box = B.bounds(curBoard(), { cards: sel.cards, frames: sel.frames });
    if (box) canvasApi.current?.fit(box, 80, 1.6);
  };
  const focusCard = (uid) => {
    const c = curBoard().cards.find((x) => x.uid === uid);
    if (!c) return;
    setSel({ cards: [uid], frames: [] });
    canvasApi.current?.reveal(cardRect(c));
  };
  const pickCard = (uid, add) => {
    const c = curBoard().cards.find((x) => x.uid === uid);
    if (!c) return;
    if (add) setSel({ cards: sel.cards.includes(uid) ? sel.cards.filter((u) => u !== uid) : [...sel.cards, uid], frames: sel.frames });
    else setSel({ cards: [uid], frames: [] });
    canvasApi.current?.reveal(cardRect(c));
  };
  const pickFrame = (fid) => {
    setSel({ cards: [], frames: [fid] });
    const f = curBoard().frames.find((x) => x.id === fid);
    if (f) canvasApi.current?.reveal(f);
  };
  const focusFrame = (fid) => {
    const f = curBoard().frames.find((x) => x.id === fid);
    if (f) canvasApi.current?.fit(f);
    setSel({ cards: [], frames: [fid] });
  };
  const openOnBoard = (boardId, uid) => {
    switchBoard(boardId);
    setTimeout(() => {
      const c = boardsRef.current.find((b) => b.id === boardId)?.cards.find((x) => x.uid === uid);
      if (c) {
        setSel({ cards: [uid], frames: [] });
        canvasApi.current?.reveal(cardRect(c));
      }
    }, 60);
  };

  // ---------- card actions (from cards) ----------
  const cardAction = (uid, action) => {
    if (action === 'fit') return fitAll();
    if (action === 'region') {
      regionFocus.current = uid;
      return;
    }
    if (action.startsWith('tab:')) {
      setSel({ cards: [uid], frames: [] });
      setTab(action.slice(4));
      setRightManual(true);
      return;
    }
    const c = curBoard().cards.find((x) => x.uid === uid);
    if (!c) return;
    if (action === 'dup') duplicate([uid]);
    else if (action === 'dup-clean') duplicate([uid], true);
    else if (action === 'reveal') revealPath({ id: c.soundId });
    else if (action === 'download') download([effOf(c)]);
    else if (action === 'remove') removeCards([uid]);
  };

  // Stable callbacks for memoised cards: always call the latest version.
  const latest = useRef({});
  latest.current = { updateCard, cardAction };
  const onCardChange = useCallback((...a) => latest.current.updateCard(...a), []);
  const onCardAction = useCallback((...a) => latest.current.cardAction(...a), []);

  // ---------- keyboard ----------
  const keyRef = useRef(null);
  keyRef.current = (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
    if (dialog) {
      if (e.key === 'Escape') (dialog.res(false), setDialog(null));
      return;
    }
    if (tag === 'BUTTON' && e.key === 'Enter') return;
    // Space always means play / stop here, even right after clicking a button (which would re-press it).
    if (tag === 'BUTTON' && e.code === 'Space') e.target.blur();
    const mod = e.metaKey || e.ctrlKey;
    const one = sel.cards.length === 1 ? sel.cards[0] : null;
    const c = one && cardControls.get(one);
    const b = curBoard();
    if (mod && e.code === 'Backslash') {
      e.preventDefault();
      return toggleLeft();
    }
    if (mod && e.code === 'KeyZ') {
      e.preventDefault();
      return e.shiftKey ? redo() : undo();
    }
    if (mod && e.code === 'KeyY') {
      e.preventDefault();
      return redo();
    }
    if (mod && e.code === 'KeyD') {
      e.preventDefault();
      if (sel.cards.length) duplicate(sel.cards, e.shiftKey);
      return;
    }
    if (mod && e.code === 'KeyA') {
      e.preventDefault();
      return setSel({ cards: b.cards.map((x) => x.uid), frames: [] });
    }
    if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      return canvasApi.current?.zoomBy(1.25);
    }
    if (mod && e.key === '-') {
      e.preventDefault();
      return canvasApi.current?.zoomBy(0.8);
    }
    if (mod && e.key === '0') {
      e.preventDefault();
      return canvasApi.current?.zoomTo(1);
    }
    if (e.shiftKey && e.code === 'Digit1') return fitAll();
    if (e.shiftKey && e.code === 'Digit2') return fitSel();
    if (mod || e.altKey) return;
    if (e.code === 'Space') {
      e.preventDefault();
      return c?.toggle();
    }
    if (e.key === 'Escape') {
      player.stop();
      if (tool !== 'select') setTool('select');
      else setSel(EMPTY_SEL);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (c && regionFocus.current === one && c.hasRegion()) return c.deleteSelectedRegion();
      if (sel.cards.length) return removeCards(sel.cards);
      if (sel.frames.length) return deleteFrames(sel.frames, false);
      return;
    }
    if (e.key === 'Enter') return c?.playSel();
    if (e.code === 'KeyL') return c?.toggleLoop();
    if (e.code === 'KeyS') {
      const card = one && b.cards.find((x) => x.uid === one);
      if (!card || B.frameOf(b, card)?.type !== 'split') return;
      e.preventDefault();
      if (c?.cutHere() === false) toast('Постав курсор усередині відрізка, щоб розрізати його', 'error');
      return;
    }
    if (e.code === 'KeyF') return setTool(tool === 'frame' ? 'select' : 'frame');
    if (e.code === 'KeyV') return setTool('select');
    if (e.code === 'KeyH') return setTool('hand');
    if (e.key.startsWith('Arrow') && sel.cards.length) {
      e.preventDefault();
      const s = e.shiftKey ? 40 : 8;
      const dx = e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0;
      const dy = e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0;
      editBoard((bb) => B.moveCards(bb, sel.cards, dx, dy), { key: 'nudge' });
    }
  };
  useEffect(() => {
    const onKey = (e) => keyRef.current(e);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Files dropped outside the drop zones shouldn't make the browser open them.
  useEffect(() => {
    const stop = (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);

  if (loadError)
    return (
      <div className="boot">
        <p>Не вдалося підключитися до сервера.</p>
        <p className="muted">{loadError}</p>
      </div>
    );
  if (!ready || !board) return <div className="boot muted">Завантаження…</div>;

  return (
    <div className={'app' + (leftOpen ? '' : ' l-closed') + (rightOpen ? '' : ' r-closed')}>
      <Layers
        open={leftOpen}
        onToggle={toggleLeft}
        board={board}
        boards={boards}
        sounds={sounds}
        soundsById={soundsById}
        sel={sel}
        importing={importing}
        onImport={importFiles}
        onPickCard={pickCard}
        onPickFrame={pickFrame}
        onFocusCard={focusCard}
        onFocusFrame={focusFrame}
        onOpenOnBoard={openOnBoard}
        onAddOrphans={(ids) => addSounds(ids, null)}
        onRenameSound={renameSound}
        onFav={favSound}
        onReveal={(id) => revealPath({ id })}
        onDeleteSounds={deleteSounds}
      />
      <main className="main">
        <BoardTabs
          boards={boards}
          activeId={board.id}
          hoverId={tabHover}
          onSelect={switchBoard}
          onAdd={addBoard}
          onRename={(id, name) => setBoards(boardsRef.current.map((b) => (b.id === id ? { ...b, name } : b)))}
          onClose={closeBoard}
          onDropSounds={dropSoundsOnBoard}
        />
        <Canvas
          key={board.id}
          board={board}
          initialView={views.current[board.id]}
          onViewChange={(v) => {
            views.current[board.id] = v;
            setSavedTick((t) => t + 1);
          }}
          soundsById={soundsById}
          sel={sel}
          setSel={setSel}
          tool={tool}
          setTool={setTool}
          frameKind={frameKind}
          setFrameKind={setFrameKind}
          newUids={newUids}
          api={canvasApi}
          onMove={onMove}
          onFrameResize={(fid, rect) => editBoard((b) => B.resizeFrame(b, fid, rect))}
          onCardChange={onCardChange}
          onCardAction={onCardAction}
          onImport={importFiles}
          onAddSounds={addSounds}
          onCopyToBoard={copyToBoard}
          onTabHover={setTabHover}
          onFrameRename={renameFrame}
          onFrameCreated={(rect) => createFrame(frameKind, rect)}
        />
      </main>
      <Inspector
        open={rightOpen}
        onOpen={() => setRightManual(true)}
        onClose={() => setRightManual(false)}
        board={board}
        sel={sel}
        setSel={setSel}
        soundsById={soundsById}
        settings={settings}
        setSettings={setSettings}
        caps={caps}
        paths={paths}
        busy={busy}
        downloading={downloading}
        previews={previews}
        lastExport={lastExport}
        toast={toast}
        tab={tab}
        setTab={setTab}
        onUpdateCard={updateCard}
        onUpdateFrame={(fid, patch, opts = {}) => editBoard((b) => B.updateFrame(b, fid, patch), { key: opts.key || null })}
        onRenameFrame={renameFrame}
        onRenameSound={renameSound}
        onRun={runOp}
        onPreview={runPreview}
        onReorder={(order) => editBoard((b) => B.reorderCards(b, order))}
        onSaveFx={saveFx}
        onCardAction={cardAction}
        onArrange={(uids, how) => editBoard((b) => B.arrange(b, uids, how))}
        onWrap={wrap}
        onDeleteFrames={deleteFrames}
        onRemoveCards={removeCards}
        onDuplicate={duplicate}
        onExport={exportTargets}
        onDownload={(targets) => download(targets, settings.exportFormat)}
        onReveal={revealPath}
        onNewFrame={(k) => {
          newFrameHere(k);
          setRightManual(null);
        }}
        onClearFades={(frame) => {
          if (!frame) return;
          const k = frame.type === 'trim' ? 'trim' : 'split';
          const patch = k === 'trim' ? { fadeIn: 0, fadeOut: 0 } : { fadeInOn: false, fadeOutOn: false };
          editBoard((b) => B.updateFrame(b, frame.id, { tool: { ...(frame.tool || {}), [k]: { ...B.frameTool(frame, k), ...patch } } }));
        }}
      />

      <div className="toasts">
        {toasts.map((x) => (
          <div key={x.id} className={'toast ' + x.kind}>
            {x.text}
          </div>
        ))}
      </div>
      {dialog && (
        <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && (dialog.res(false), setDialog(null))}>
          <div className="modal" role="dialog">
            <p>{dialog.text}</p>
            <div className="actions">
              <button className="btn" autoFocus onClick={() => (dialog.res(false), setDialog(null))}>
                Скасувати
              </button>
              <button className="btn danger" onClick={() => (dialog.res(true), setDialog(null))}>
                {dialog.ok}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
