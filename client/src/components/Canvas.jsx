import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import TrackCard from './TrackCard.jsx';
import { CARD_H, CARD_MIN_W, CARD_MAX_W, FRAME_LABEL, FRAME_TYPES, cardW, inside, readingOrder } from '../../../shared/board.js';
import { effSoundOf } from '../fxClient.js';
import { setBoardScale } from '../boardScale.js';
import { DND_SOUNDS, fmtTime, clamp } from '../util.js';
import { Icon } from './Icon.jsx';
import { frameTool, bounds } from '../boardOps.js';

const ZMIN = 0.08;
const ZMAX = 4;
const LIVE_ZOOM = 0.32; // below this cards are drawn as light thumbnails

function visualOf(frame) {
  if (!frame) return null;
  if (frame.type === 'trim') {
    const t = frameTool(frame, 'trim');
    const f = { in: t.fadeIn, out: t.fadeOut, curve: t.curve };
    return t.action === 'fade' ? { trackFades: f } : t.action === 'keep' ? { fades: f, tone: 'keep' } : { tone: 'cut' };
  }
  if (frame.type === 'split') {
    const t = frameTool(frame, 'split');
    return { fades: { in: t.fadeInOn ? t.fadeIn : 0, out: t.fadeOutOn ? t.fadeOut : 0, curve: t.curve } };
  }
  return null;
}

/** Light stand-in for a card far away or zoomed out: name + the server-made waveform picture. */
const CardThumb = memo(function CardThumb({ card, sound, selected, orderNo }) {
  const bars = sound.thumb || [];
  return (
    <div className={'card thumb' + (selected ? ' selected' : '')} data-card={card.uid}>
      <div className="thumb-in" data-card-head={card.uid}>
        <div className="thumb-name">
          {orderNo != null && <span className="order-no">{orderNo}</span>}
          {sound.name}
        </div>
        <svg className="thumb-wave" viewBox={`0 0 ${bars.length || 1} 100`} preserveAspectRatio="none">
          {bars.map((v, i) => (
            <rect key={i} x={i + 0.15} width="0.7" y={50 - v / 2} height={Math.max(1, v)} />
          ))}
        </svg>
        <div className="thumb-meta">{fmtTime(sound.duration)}</div>
      </div>
    </div>
  );
});

const FrameView = memo(function FrameView({ frame, selected, count, dropping, z, onRename }) {
  const [edit, setEdit] = useState(false);
  return (
    <div className={`frame t-${frame.type}` + (selected ? ' selected' : '') + (dropping ? ' dropping' : '')} style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }} data-frame={frame.id}>
      <div className="frame-label" data-frame-label={frame.id} style={{ transform: `scale(${1 / z})` }} onDoubleClick={() => setEdit(true)} title="Тягни, щоб перемістити фрейм. Подвійний клік — перейменувати">
        {edit ? (
          <input
            autoFocus
            defaultValue={frame.name}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                e.currentTarget.value = frame.name;
                e.currentTarget.blur();
              }
            }}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              if (v && v !== frame.name) onRename(frame.id, v);
              setEdit(false);
            }}
          />
        ) : (
          <>
            <span className="frame-name">{frame.name}</span>
            <span className="frame-type">{FRAME_LABEL[frame.type]}</span>
            {count > 0 && <span className="frame-count">{count}</span>}
          </>
        )}
      </div>
      {count === 0 && (
        <div className="frame-empty" style={{ fontSize: Math.min(28, 13 / z) }}>
          Кинь сюди звуки
        </div>
      )}
      {selected &&
        ['nw', 'ne', 'sw', 'se', 'e', 's', 'w', 'n'].map((d) => <div key={d} className={'frame-h ' + d} data-frame-handle={d} style={{ '--hs': 1 / z }} />)}
    </div>
  );
});

/**
 * The board: an endless canvas with frames and cards (Figma-style).
 * Wheel / two fingers pan, pinch or ⌘ + wheel zoom, drag on empty space selects with a rectangle.
 */
export default function Canvas({
  board,
  initialView,
  onViewChange,
  soundsById,
  sel,
  setSel,
  tool,
  setTool,
  frameKind,
  setFrameKind,
  newUids,
  api,
  onMove,
  onFrameResize,
  onCardChange,
  onCardAction,
  onImport,
  onAddSounds,
  onCopyToBoard,
  onTabHover,
  onFrameRename,
  onFrameCreated,
}) {
  const el = useRef(null);
  const [view, setViewState] = useState(initialView || { x: 80, y: 80, z: 0.8 });
  const viewRef = useRef(view);
  const [size, setSize] = useState({ w: 1000, h: 700 });
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const [drop, setDrop] = useState(null); // world point while dragging files / sounds over the board

  const setView = (v) => {
    const nv = { x: v.x, y: v.y, z: clamp(v.z, ZMIN, ZMAX) };
    viewRef.current = nv;
    setViewState(nv);
  };
  useEffect(() => {
    setBoardScale(view.z);
    const t = setTimeout(() => onViewChange(view), 400);
    return () => clearTimeout(t);
  }, [view]);

  // When a side panel opens or folds, the board changes size. Keep what you're looking at in place,
  // and keep the selection in view when the right panel takes space.
  const live = useRef({});
  live.current = { board, sel };
  useLayoutEffect(() => {
    let prev = el.current.getBoundingClientRect();
    const ro = new ResizeObserver(() => {
      const node = el.current;
      if (!node) return;
      const r = node.getBoundingClientRect();
      setSize({ w: node.clientWidth, h: node.clientHeight });
      const v = viewRef.current;
      let x = v.x + (prev.left - r.left);
      if (r.width < prev.width) {
        const { board: b, sel: s } = live.current;
        const box = s.cards.length || s.frames.length ? bounds(b, { cards: s.cards, frames: s.frames }) : null;
        if (box) {
          const left = box.x * v.z + x;
          const right = (box.x + box.w) * v.z + x;
          const over = right - (r.width - 24);
          if (over > 0) x -= Math.min(over, Math.max(0, left - 24));
        }
      }
      prev = r;
      if (x !== v.x) setView({ ...v, x });
    });
    ro.observe(el.current);
    setSize({ w: el.current.clientWidth, h: el.current.clientHeight });
    return () => ro.disconnect();
  }, []);

  const toWorld = (clientX, clientY) => {
    const r = el.current.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - r.left - v.x) / v.z, y: (clientY - r.top - v.y) / v.z };
  };

  // Imperative bits for the app: fit, fly to, where the middle is.
  useEffect(() => {
    api.current = {
      size: () => ({ w: el.current?.clientWidth || 1000, h: el.current?.clientHeight || 700 }),
      view: () => viewRef.current,
      center: () => {
        const v = viewRef.current;
        const s = api.current.size();
        return { x: (s.w / 2 - v.x) / v.z, y: (s.h / 2 - v.y) / v.z };
      },
      fit: (rect, pad = 70, maxZ = 1.25) => {
        if (!rect) return;
        const s = api.current.size();
        const z = clamp(Math.min((s.w - 2 * pad) / Math.max(1, rect.w), (s.h - 2 * pad) / Math.max(1, rect.h)), ZMIN, maxZ);
        setView({ z, x: s.w / 2 - (rect.x + rect.w / 2) * z, y: s.h / 2 - (rect.y + rect.h / 2) * z });
      },
      /** Brings a rectangle into view; zooms in if cards would be too small to work with. */
      reveal: (rect) => {
        const s = api.current.size();
        const v = viewRef.current;
        const z = v.z < 0.55 ? 0.9 : v.z;
        const sx = rect.x * z + v.x;
        const sy = rect.y * z + v.y;
        const visible = z === v.z && sx > 20 && sy > 20 && sx + rect.w * z < s.w - 20 && sy + rect.h * z < s.h - 20;
        if (visible) return;
        setView({ z, x: s.w / 2 - (rect.x + rect.w / 2) * z, y: s.h / 2 - (rect.y + rect.h / 2) * z });
      },
      zoomBy: (k) => {
        const s = api.current.size();
        const v = viewRef.current;
        const nz = clamp(v.z * k, ZMIN, ZMAX);
        setView({ z: nz, x: s.w / 2 - ((s.w / 2 - v.x) * nz) / v.z, y: s.h / 2 - ((s.h / 2 - v.y) * nz) / v.z });
      },
      zoomTo: (nz) => api.current.zoomBy(nz / viewRef.current.z),
    };
  });

  // Wheel: pan; pinch or ⌘/Ctrl + wheel: zoom around the pointer.
  useEffect(() => {
    const node = el.current;
    const onWheel = (e) => {
      if (e.defaultPrevented) return; // e.g. Alt + wheel zoomed a waveform
      const wf = e.target.closest?.('.wf');
      if (e.shiftKey && wf && wf.scrollWidth > wf.clientWidth + 1) return; // Shift + wheel scrolls a zoomed waveform
      if (e.target.closest?.('.menu')) return;
      e.preventDefault();
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        const r = node.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        const k = Math.abs(e.deltaY) > 40 ? 0.0025 : 0.012;
        const nz = clamp(v.z * Math.exp(-e.deltaY * k), ZMIN, ZMAX);
        setView({ z: nz, x: px - ((px - v.x) * nz) / v.z, y: py - ((py - v.y) * nz) / v.z });
      } else {
        let dx = e.deltaX;
        let dy = e.deltaY;
        if (e.deltaMode === 1) {
          dx *= 16;
          dy *= 16;
        }
        if (e.shiftKey && !dx) {
          dx = dy;
          dy = 0;
        }
        setView({ ...v, x: v.x - dx, y: v.y - dy });
      }
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  const selCards = useMemo(() => new Set(sel.cards), [sel.cards]);
  const selFrames = useMemo(() => new Set(sel.frames), [sel.frames]);
  const framesById = useMemo(() => Object.fromEntries(board.frames.map((f) => [f.id, f])), [board.frames]);
  const visuals = useMemo(() => Object.fromEntries(board.frames.map((f) => [f.id, visualOf(f)])), [board.frames]);
  const counts = useMemo(() => {
    const m = {};
    for (const c of board.cards) if (c.frameId) m[c.frameId] = (m[c.frameId] || 0) + 1;
    return m;
  }, [board.cards]);
  // Merge frames number their cards in the order they'll be joined.
  const orderNo = useMemo(() => {
    const m = {};
    for (const f of board.frames) {
      if (f.type !== 'merge') continue;
      readingOrder(board.cards.filter((c) => c.frameId === f.id && c.inMerge !== false)).forEach((c, i) => (m[c.uid] = i + 1));
    }
    return m;
  }, [board.cards, board.frames]);

  // ---------- pointer ----------
  const begin = (d, e) => {
    dragRef.current = d;
    setDrag(d);
    el.current.setPointerCapture(e.pointerId);
  };
  const update = (d) => {
    dragRef.current = d;
    setDrag(d);
  };

  const onPointerDown = (e) => {
    const t = e.target;
    if (t.closest('.toolbar, .zoom-badge')) return;
    const v = viewRef.current;
    if (e.button === 1 || (e.button === 0 && tool === 'hand')) {
      e.preventDefault();
      return begin({ kind: 'pan', sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y }, e);
    }
    if (e.button !== 0) return;
    const w = toWorld(e.clientX, e.clientY);
    const resize = t.closest('[data-card-resize]');
    if (resize) {
      const c = board.cards.find((x) => x.uid === resize.dataset.cardResize);
      if (c) return begin({ kind: 'card-w', uid: c.uid, sx: w.x, w0: cardW(c), w: cardW(c) }, e);
    }
    const cardEl = t.closest('[data-card]');
    if (cardEl) {
      const uid = cardEl.dataset.card;
      const add = e.shiftKey || e.metaKey || e.ctrlKey;
      const already = selCards.has(uid);
      if (add) setSel({ cards: already ? sel.cards.filter((u) => u !== uid) : [...sel.cards, uid], frames: sel.frames });
      else if (!already) setSel({ cards: [uid], frames: [] });
      const head = t.closest('[data-card-head]');
      const interactive = t.closest('button, input, select, textarea, .menu, a, label');
      if (head && !interactive && !add) {
        const uids = already ? sel.cards : [uid];
        return begin({ kind: 'move', uids, fids: already ? sel.frames : [], start: w, dx: 0, dy: 0, alt: e.altKey, clicked: uid, moved: false }, e);
      }
      return; // waveform, buttons: the card handles them
    }
    const handle = t.closest('[data-frame-handle]');
    if (handle) {
      const fid = handle.parentElement.dataset.frame;
      const f = framesById[fid];
      return begin({ kind: 'frame-size', fid, dir: handle.dataset.frameHandle, start: w, orig: { x: f.x, y: f.y, w: f.w, h: f.h }, rect: { x: f.x, y: f.y, w: f.w, h: f.h } }, e);
    }
    const label = t.closest('[data-frame-label]');
    if (label) {
      if (t.closest('input')) return;
      const fid = label.dataset.frameLabel;
      const add = e.shiftKey || e.metaKey;
      const fids = add ? [...new Set([...sel.frames, fid])] : selFrames.has(fid) ? sel.frames : [fid];
      setSel({ cards: add ? sel.cards : [], frames: fids });
      return begin({ kind: 'move', uids: add ? sel.cards : [], fids, start: w, dx: 0, dy: 0, moved: false }, e);
    }
    if (tool === 'frame') return begin({ kind: 'draw', a: w, b: w }, e);
    const frameEl = t.closest('[data-frame]');
    begin({ kind: 'marquee', a: w, b: w, add: e.shiftKey || e.metaKey, frameId: frameEl?.dataset.frame || null, base: sel }, e);
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'pan') return setView({ ...viewRef.current, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy });
    const w = toWorld(e.clientX, e.clientY);
    if (d.kind === 'move') {
      const dx = w.x - d.start.x;
      const dy = w.y - d.start.y;
      const moved = d.moved || Math.hypot(dx, dy) * viewRef.current.z > 3;
      const tab = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-board-tab]')?.dataset.boardTab || null;
      const overTab = tab && tab !== board.id ? tab : null;
      if (overTab !== d.overTab) onTabHover(overTab);
      return update({ ...d, dx, dy, moved, overTab });
    }
    if (d.kind === 'card-w') return update({ ...d, w: Math.round(clamp(d.w0 + w.x - d.sx, CARD_MIN_W, CARD_MAX_W)) });
    if (d.kind === 'frame-size') {
      const o = d.orig;
      const dx = w.x - d.start.x;
      const dy = w.y - d.start.y;
      let { x, y, w: fw, h } = o;
      if (d.dir.includes('e')) fw = Math.max(160, o.w + dx);
      if (d.dir.includes('s')) h = Math.max(100, o.h + dy);
      if (d.dir.includes('w')) {
        fw = Math.max(160, o.w - dx);
        x = o.x + o.w - fw;
      }
      if (d.dir.includes('n')) {
        h = Math.max(100, o.h - dy);
        y = o.y + o.h - h;
      }
      return update({ ...d, rect: { x: Math.round(x), y: Math.round(y), w: Math.round(fw), h: Math.round(h) } });
    }
    if (d.kind === 'marquee' || d.kind === 'draw') return update({ ...d, b: w });
  };

  const rectOf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

  const onPointerUp = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    if (d.kind === 'move') {
      if (d.overTab) onTabHover(null);
      if (!d.moved) {
        // A plain click on one card of a multi-selection selects just that card.
        if (d.clicked && d.uids.length > 1 && !(e.shiftKey || e.metaKey)) setSel({ cards: [d.clicked], frames: [] });
        return;
      }
      if (d.overTab) return onCopyToBoard(d.overTab, d.uids, d.fids);
      onMove({ uids: d.uids, fids: d.fids, dx: d.dx, dy: d.dy, alt: d.alt });
      return;
    }
    if (d.kind === 'card-w') {
      if (d.w !== d.w0) onCardChange(d.uid, { w: d.w });
      return;
    }
    if (d.kind === 'frame-size') return onFrameResize(d.fid, d.rect);
    if (d.kind === 'draw') {
      const r = rectOf(d.a, d.b);
      const rect = r.w * viewRef.current.z < 12 || r.h * viewRef.current.z < 12 ? { x: d.a.x, y: d.a.y, w: 1000, h: 560 } : r;
      setTool('select');
      return onFrameCreated(rect);
    }
    if (d.kind === 'marquee') {
      const r = rectOf(d.a, d.b);
      if (r.w * viewRef.current.z < 4 && r.h * viewRef.current.z < 4) {
        if (d.frameId) setSel({ cards: [], frames: [d.frameId] });
        else if (!d.add) setSel({ cards: [], frames: [] });
        return;
      }
      const hit = board.cards.filter((c) => c.x < r.x + r.w && c.x + cardW(c) > r.x && c.y < r.y + r.h && c.y + CARD_H > r.y).map((c) => c.uid);
      const fr = board.frames.filter((f) => f.x >= r.x && f.y >= r.y && f.x + f.w <= r.x + r.w && f.y + f.h <= r.y + r.h).map((f) => f.id);
      setSel(d.add ? { cards: [...new Set([...d.base.cards, ...hit])], frames: [...new Set([...d.base.frames, ...fr])] } : { cards: hit, frames: fr });
    }
  };

  // ---------- drops from Finder and the layers panel ----------
  const accepts = (e) => {
    const t = [...e.dataTransfer.types];
    return t.includes('Files') || t.includes(DND_SOUNDS);
  };

  // ---------- what's visible ----------
  const v = view;
  const margin = 240 / v.z;
  const vis = { x: -v.x / v.z - margin, y: -v.y / v.z - margin, w: size.w / v.z + 2 * margin, h: size.h / v.z + 2 * margin };
  const isVisible = (x, y, w, h) => x < vis.x + vis.w && x + w > vis.x && y < vis.y + vis.h && y + h > vis.y;

  const mv = drag?.kind === 'move' && drag.moved && !drag.overTab ? drag : null;
  const movedCard = mv ? new Set(mv.uids) : null;
  const movedFrame = mv ? new Set(mv.fids) : null;
  const offsetOf = (c) => (mv && (movedCard.has(c.uid) || movedFrame.has(c.frameId)) ? [mv.dx, mv.dy] : [0, 0]);
  const dropFrame = drop ? [...board.frames].reverse().find((f) => inside(f, drop)) : null;
  const marquee = drag?.kind === 'marquee' || drag?.kind === 'draw' ? rectOf(drag.a, drag.b) : null;
  const empty = !board.cards.length && !board.frames.length;

  return (
    <div
      className={'board' + (tool === 'hand' || drag?.kind === 'pan' ? ' panning' : '') + (tool === 'frame' ? ' drawing' : '')}
      ref={el}
      style={{ backgroundSize: `${24 * v.z}px ${24 * v.z}px`, backgroundPosition: `${v.x}px ${v.y}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        dragRef.current = null;
        setDrag(null);
      }}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        const w = toWorld(e.clientX, e.clientY);
        if (!drop || Math.abs(drop.x - w.x) + Math.abs(drop.y - w.y) > 4 / v.z) setDrop(w);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setDrop(null);
      }}
      onDrop={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        setDrop(null);
        const at = toWorld(e.clientX, e.clientY);
        const types = [...e.dataTransfer.types];
        if (types.includes(DND_SOUNDS)) onAddSounds(JSON.parse(e.dataTransfer.getData(DND_SOUNDS) || '[]'), at);
        else if (e.dataTransfer.files?.length) onImport([...e.dataTransfer.files], at);
      }}
    >
      <div className="world" style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.z})`, "--z": v.z }}>
        {board.frames.map((f) => {
          const r = drag?.kind === 'frame-size' && drag.fid === f.id ? { ...f, ...drag.rect } : mv && movedFrame.has(f.id) ? { ...f, x: f.x + mv.dx, y: f.y + mv.dy } : f;
          if (!isVisible(r.x, r.y - 40 / v.z, r.w, r.h + 40 / v.z)) return null;
          return <FrameView key={f.id} frame={r} selected={selFrames.has(f.id)} count={counts[f.id] || 0} dropping={dropFrame?.id === f.id} z={v.z} onRename={onFrameRename} />;
        })}
        {board.cards.map((c) => {
          const [ox, oy] = offsetOf(c);
          const w = drag?.kind === 'card-w' && drag.uid === c.uid ? drag.w : cardW(c);
          const x = c.x + ox;
          const y = c.y + oy;
          const selected = selCards.has(c.uid);
          if (!selected && !isVisible(x, y, w, CARD_H)) return null;
          const sound = effSoundOf(soundsById[c.soundId], c);
          if (!sound) return null;
          const frame = c.frameId ? framesById[c.frameId] : null;
          const live = v.z >= LIVE_ZOOM || (selected && sel.cards.length === 1);
          return (
            <div key={c.uid} className={'card-slot' + (mv && movedCard.has(c.uid) ? ' moving' : '') + (selected ? ' sel' : '')} style={{ left: x, top: y, width: w, height: CARD_H }}>
              {live ? (
                <TrackCard
                  card={c}
                  sound={sound}
                  frameType={frame?.type || null}
                  visual={frame ? visuals[frame.id] : null}
                  selected={selected}
                  orderNo={orderNo[c.uid] ?? null}
                  isNew={newUids.has(c.uid)}
                  onChange={onCardChange}
                  onAction={onCardAction}
                />
              ) : (
                <CardThumb card={c} sound={sound} selected={selected} orderNo={orderNo[c.uid] ?? null} />
              )}
              {selected && sel.cards.length === 1 && <div className="card-resize" data-card-resize={c.uid} title="Тягни, щоб змінити ширину картки" />}
            </div>
          );
        })}
        {marquee && <div className={drag.kind === 'draw' ? 'draw-rect t-' + frameKind : 'marquee'} style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
      </div>

      {empty && (
        <div className="board-empty">
          <p className="big">Порожня дошка</p>
          <p>Перетягни сюди звуки з Finder або натисни «Додати файли» ліворуч.</p>
          <p>
            Фрейм (<kbd>F</kbd>) — область під нарізку, обрізку чи склейку. Усе, що збережеш усередині, ляже в його папку.
          </p>
        </div>
      )}

      <div className="toolbar" onPointerDown={(e) => e.stopPropagation()}>
        <button className={'tool' + (tool === 'select' ? ' on' : '')} onClick={() => setTool('select')} title="Вибір і переміщення (V)">
          <Icon name="cursor" />
        </button>
        <button className={'tool' + (tool === 'hand' ? ' on' : '')} onClick={() => setTool('hand')} title="Рука: рухати дошку (H). Або два пальці / колесо">
          <Icon name="hand" />
        </button>
        <button className={'tool' + (tool === 'frame' ? ' on' : '')} onClick={() => setTool(tool === 'frame' ? 'select' : 'frame')} title="Фрейм: протягни на дошці (F)">
          <Icon name="frame" />
        </button>
        {tool === 'frame' && (
          <span className="tool-kinds">
            {FRAME_TYPES.map(([k, l]) => (
              <button key={k} className={'kind t-' + k + (frameKind === k ? ' on' : '')} onClick={() => setFrameKind(k)}>
                {l}
              </button>
            ))}
          </span>
        )}
        <span className="tool-sep" />
        <button className="tool" onClick={() => api.current.zoomBy(1 / 1.25)} title="Віддалити (⌘ −)">
          <Icon name="minus" />
        </button>
        <button className="tool zoom-val" onClick={() => api.current.zoomTo(1)} title="100%">
          {Math.round(v.z * 100)}%
        </button>
        <button className="tool" onClick={() => api.current.zoomBy(1.25)} title="Наблизити (⌘ +)">
          <Icon name="plus" />
        </button>
        <button className="tool" onClick={() => onCardAction(null, 'fit')} title="Показати все (Shift+1)">
          <Icon name="fit" />
        </button>
      </div>
      {tool === 'frame' && <div className="board-tip">Протягни на дошці, щоб намалювати фрейм «{FRAME_LABEL[frameKind]}». Картки, що опиняться всередині, увійдуть у нього.</div>}
    </div>
  );
}
