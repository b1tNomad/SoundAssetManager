import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BIN } from '../audio.js';
import { analysis, heatColumns, peakIn } from '../seam.js';
import { clamp, rid } from '../util.js';
import { boardScale, usePixelScale } from '../boardScale.js';

const RULER = 18;
const TICKS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const MAX_PPS = 8000;
const HEAT = { good: '#7fd47a', ok: '#e2c35a', bad: 'rgba(226, 100, 79, 0.85)' };
export const COLORS = {
  wave: '#EDB04A',
  waveDim: 'rgba(237,176,74,0.38)',
  fxWave: '#B79CF2', // the processed sound (card effects on)
  fxWaveDim: 'rgba(183,156,242,0.38)',
  mid: 'rgba(232,227,216,0.08)',
  ruler: '#1F242B',
  tick: 'rgba(232,227,216,0.28)',
  label: '#8C95A0',
};

function tickLabel(t, step) {
  if (t >= 60 || step >= 60) {
    const m = Math.floor(t / 60);
    const s = Math.round(t - m * 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  const dec = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return t.toFixed(dec);
}

/**
 * Canvas waveform with a time ruler, click-to-seek and draggable regions.
 * regionMode: 'single' (one selection), 'multi' (many segments) or 'none'.
 */
export default function Waveform({
  data,
  duration,
  zoom = 1,
  onZoom,
  regions = [],
  regionMode = 'none',
  selectedId,
  onRegionsChange,
  onSelect,
  onSeek,
  onRegionPlay,
  cursor,
  playhead,
  fades,
  trackFades,
  dimOutside = false,
  tone,
  playingId,
  seam,
  processed = false,
  height = 96,
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const anchorRef = useRef(null);
  const prevPps = useRef(null);
  const [width, setWidth] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [draft, setDraft] = useState(null);
  const heatRef = useRef({ key: '', cols: [] });
  const pxs = usePixelScale(); // sharper drawing when the board is zoomed in

  useLayoutEffect(() => {
    const el = wrapRef.current;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const fit = width > 0 && duration > 0 ? width / duration : 100;
  const maxZoom = Math.max(1, MAX_PPS / fit);
  const z = clamp(zoom, 1, maxZoom);
  const pps = fit * z;
  const total = Math.max(width, Math.ceil(duration * pps));

  // Keep the point under the mouse (or the centre) in place when zooming.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    const before = prevPps.current;
    prevPps.current = pps;
    if (!el || !before || before === pps) return;
    const a = anchorRef.current || { t: (el.scrollLeft + el.clientWidth / 2) / before, x: el.clientWidth / 2 };
    anchorRef.current = null;
    el.scrollLeft = Math.max(0, a.t * pps - a.x);
    setScroll(el.scrollLeft);
  }, [pps]);

  // Follow the playhead when zoomed in.
  useEffect(() => {
    const el = wrapRef.current;
    if (playhead == null || !el || z <= 1.01) return;
    const x = playhead * pps;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 8) {
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.1);
    }
  }, [playhead, pps, z]);

  // Alt + wheel zooms the waveform (plain wheel and pinch belong to the board).
  useEffect(() => {
    const el = wrapRef.current;
    const onWheel = (e) => {
      if (!e.altKey || !onZoom) return;
      e.preventDefault();
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / boardScale();
      anchorRef.current = { t: (x + el.scrollLeft) / pps, x };
      onZoom(clamp(z * Math.exp(-e.deltaY * 0.01), 1, maxZoom));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [pps, z, maxZoom, onZoom]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !width) return;
    const dpr = Math.min((window.devicePixelRatio || 1) * pxs, 8192 / Math.max(1, width));
    cv.width = Math.round(width * dpr);
    cv.height = Math.round(height * dpr);
    cv.style.width = width + 'px';
    cv.style.height = height + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    const t0 = scroll / pps;
    const t1 = t0 + width / pps;

    // ruler
    g.fillStyle = COLORS.ruler;
    g.fillRect(0, 0, width, RULER);
    const step = TICKS.find((s) => s * pps >= 70) ?? 600;
    const first = Math.floor(t0 / step);
    g.font = '10px -apple-system, system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (let i = first; i * step <= t1 + step; i++) {
      const t = i * step;
      const x = Math.round((t - t0) * pps) + 0.5;
      g.fillStyle = COLORS.tick;
      g.fillRect(x - 0.5, RULER - 6, 1, 6);
      const xm = Math.round((t + step / 2 - t0) * pps);
      g.fillRect(xm, RULER - 3, 1, 3);
      if (t <= duration + 1e-6) {
        g.fillStyle = COLORS.label;
        g.fillText(tickLabel(t, step), x + 3, 8);
      }
    }

    const top = RULER;
    const h = height - RULER;
    const mid = top + h / 2;
    const amp = h / 2 - 3;
    g.fillStyle = COLORS.mid;
    g.fillRect(0, Math.round(mid), width, 1);
    if (!data) return;

    const { buffer, peaks } = data;
    const sr = buffer.sampleRate;
    const spp = sr / pps;
    const chans = spp < BIN ? Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)) : null;
    const nb = peaks.min.length;
    // Quiet files are drawn taller (up to +18 dB) so their shape is readable; the card shows the real peak level.
    const gain = peaks.peak > 0 ? clamp(0.95 / peaks.peak, 1, 8) : 1;
    const dimRegions = dimOutside && regions.length ? regions : null;
    for (let x = 0; x < width; x++) {
      const ta = t0 + x / pps;
      const s0 = Math.floor(ta * sr);
      if (s0 >= buffer.length) break;
      const s1 = Math.max(s0 + 1, Math.floor((ta + 1 / pps) * sr));
      let lo = 1;
      let hi = -1;
      if (chans) {
        for (const d of chans) {
          for (let i = s0; i < s1 && i < d.length; i++) {
            const v = d[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      } else {
        const b1 = Math.min(nb, Math.max(Math.floor(s0 / BIN) + 1, Math.ceil(s1 / BIN)));
        for (let b = Math.floor(s0 / BIN); b < b1; b++) {
          if (peaks.min[b] < lo) lo = peaks.min[b];
          if (peaks.max[b] > hi) hi = peaks.max[b];
        }
      }
      if (hi < lo) continue;
      const inside = !dimRegions || dimRegions.some((r) => ta >= r.start && ta <= r.end);
      g.fillStyle = processed ? (inside ? COLORS.fxWave : COLORS.fxWaveDim) : inside ? COLORS.wave : COLORS.waveDim;
      const y1 = mid - Math.min(1, hi * gain) * amp;
      const y2 = mid - Math.max(-1, lo * gain) * amp;
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }

    // Loop seam helpers: where the fitted edge would join cleanly + level guide lines from the fixed edge.
    if (seam) {
      const A = analysis(buffer);
      const fixed = seam.fit === 'end' ? seam.start : seam.end;
      const key = [seam.fit, fixed, t0, pps, width, buffer.length].join('|');
      if (heatRef.current.key !== key) heatRef.current = { key, cols: heatColumns(A, { fit: seam.fit, fixed, t0, pps, width }) };
      const cols = heatRef.current.cols;
      const yb = height - 6;
      for (let x = 0; x < width; x++) {
        const c = cols[x];
        if (!c) continue;
        g.fillStyle = HEAT[c];
        g.fillRect(x, yb, 1, 5);
      }
      const win = 0.03;
      const p = seam.fit === 'end' ? peakIn(buffer, seam.start, seam.start + win) : peakIn(buffer, seam.end - win, seam.end);
      const dy = Math.min(1, p * gain) * amp;
      const xa = (seam.start - t0) * pps;
      const xb = (seam.end - t0) * pps;
      // The guide is the level of the edge that stays put; it runs towards the edge being fitted.
      const fitEnd = seam.fit === 'end';
      const edgeColor = fitEnd ? '#5bc6d3' : '#f2c46d'; // start = blue, end = amber (as in the seam close-up)
      g.save();
      g.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      g.lineWidth = 1;
      g.setLineDash([5, 4]);
      g.beginPath();
      for (const y of [Math.round(mid - dy) + 0.5, Math.round(mid + dy) + 0.5]) {
        g.moveTo(fitEnd ? xa : xa - 24, y);
        g.lineTo(fitEnd ? xb + 24 : xb, y);
      }
      g.stroke();
      // Solid ticks over the 30 ms the guide was measured on.
      g.setLineDash([]);
      g.lineWidth = 2;
      const m0 = fitEnd ? xa : xb - win * pps;
      const m1 = fitEnd ? xa + win * pps : xb;
      g.strokeStyle = edgeColor;
      g.beginPath();
      for (const y of [Math.round(mid - dy), Math.round(mid + dy)]) {
        g.moveTo(m0, y);
        g.lineTo(Math.max(m0 + 4, m1), y);
      }
      g.stroke();
      // Says whose level it is, right where it's measured.
      const label = fitEnd ? 'рівень початку →' : '← рівень кінця';
      g.font = '600 10px -apple-system, system-ui, sans-serif';
      g.textBaseline = 'bottom';
      const tw = g.measureText(label).width;
      const lx = fitEnd ? xa + 3 : xb - 3 - tw;
      const ly = Math.max(top + 12, Math.round(mid - dy) - 3);
      g.fillStyle = 'rgba(21, 24, 29, 0.78)';
      g.fillRect(lx - 3, ly - 12, tw + 6, 13);
      g.fillStyle = edgeColor;
      g.fillText(label, lx, ly);
      g.restore();
    }
  }, [data, width, scroll, pps, height, duration, dimOutside, regions, seam?.fit, seam?.start, seam?.end, processed, pxs]);

  const timeAt = (clientX) => {
    const el = wrapRef.current;
    const r = el.getBoundingClientRect();
    return clamp(((clientX - r.left) / boardScale() + el.scrollLeft) / pps, 0, duration);
  };

  const onPointerDown = (e) => {
    // The bare scroll container is only exposed under the content — that's the scrollbar strip.
    if (e.button !== 0 || e.target === wrapRef.current) return;
    const el = e.target.closest('[data-rid]');
    const t = timeAt(e.clientX);
    // Alt + drag always starts a new segment, even on top of existing ones.
    if (el && regionMode !== 'none' && !(e.altKey && regionMode === 'multi')) {
      const r = regions.find((x) => x.id === el.dataset.rid);
      if (!r) return;
      const h = e.target.dataset.handle;
      dragRef.current = { kind: h ? 'resize-' + h : 'move', id: r.id, orig: r, startT: t, startX: e.clientX, base: regions };
    } else {
      dragRef.current = { kind: 'new', startT: t, startX: e.clientX, base: regions };
    }
    wrapRef.current.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.startX) < 4) return;
    d.moved = true;
    const t = timeAt(e.clientX);
    let next;
    if (d.kind === 'new') {
      if (regionMode === 'none') return;
      if (!d.id) d.id = regionMode === 'single' ? 'sel' : rid('r');
      const reg = { id: d.id, start: Math.min(d.startT, t), end: Math.max(d.startT, t) };
      next = regionMode === 'single' ? [reg] : [...d.base.filter((r) => r.id !== d.id), reg];
    } else {
      const o = d.orig;
      let { start, end } = o;
      if (d.kind === 'move') {
        const len = o.end - o.start;
        start = clamp(o.start + (t - d.startT), 0, duration - len);
        end = start + len;
      } else if (d.kind === 'resize-l') start = clamp(t, 0, o.end - 0.005);
      else end = clamp(t, o.start + 0.005, duration);
      next = d.base.map((r) => (r.id === d.id ? { ...r, start, end } : r));
    }
    d.next = next;
    setDraft(next);
  };

  const onPointerUp = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.moved && d.next) {
      const reg = d.next.find((r) => r.id === d.id);
      if (reg && reg.end - reg.start >= 0.005) onRegionsChange?.(d.next);
      else onRegionsChange?.(d.base);
      onSelect?.(d.id);
    } else if (!d.moved) {
      onSelect?.(d.kind === 'new' ? null : d.id);
      onSeek?.(timeAt(e.clientX));
    }
    setDraft(null);
  };

  const shown = draft || regions;
  const ordered = [...shown].sort((a, b) => a.start - b.start);

  return (
    <div
      className="wf"
      ref={wrapRef}
      style={{ height: height + 10 }}
      onScroll={(e) => setScroll(e.currentTarget.scrollLeft)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        dragRef.current = null;
        setDraft(null);
      }}
      onDoubleClick={(e) => {
        // Pointer capture retargets the click to the container, so find the region by time.
        const t = timeAt(e.clientX);
        const r = shown.filter((x) => t >= x.start && t <= x.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
        if (r) onRegionPlay?.(r);
      }}
    >
      <div className="wf-inner" style={{ width: total, height }}>
        <canvas ref={canvasRef} className="wf-canvas" />
        {trackFades && duration > 0 && (
          <>
            {trackFades.in > 0 && <div className="wf-fade in" style={{ left: 0, top: RULER, width: Math.min(trackFades.in, duration) * pps }} />}
            {trackFades.out > 0 && (
              <div className="wf-fade out" style={{ left: Math.max(0, duration - trackFades.out) * pps, top: RULER, width: Math.min(trackFades.out, duration) * pps }} />
            )}
          </>
        )}
        {ordered.map((r, i) => {
          const len = r.end - r.start;
          const w = len * pps;
          return (
            <div
              key={r.id}
              data-rid={r.id}
              className={'wf-region' + (r.id === selectedId ? ' sel' : '') + (regionMode === 'multi' ? ' multi' : '') + (tone === 'cut' ? ' cut' : '') + (r.id === playingId ? ' playing' : '')}
              style={{ left: r.start * pps, width: Math.max(2, w), top: RULER }}
            >
              {fades && fades.in > 0 && <div className="wf-fade in" style={{ width: Math.min(fades.in, len) * pps }} />}
              {fades && fades.out > 0 && <div className="wf-fade out" style={{ right: 0, width: Math.min(fades.out, len) * pps }} />}
              {regionMode === 'multi' && w > 18 && <span className="wf-label">{r.name || i + 1}</span>}
              <div className="wf-h l" data-handle="l" />
              <div className="wf-h r" data-handle="r" />
            </div>
          );
        })}
        {cursor != null && playhead == null && <div className="wf-cursor" style={{ left: cursor * pps }} />}
        {playhead != null && <div className="wf-playhead" style={{ left: playhead * pps }} />}
      </div>
    </div>
  );
}
