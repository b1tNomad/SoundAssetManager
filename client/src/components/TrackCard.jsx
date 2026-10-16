import { memo, useEffect, useMemo, useRef, useState } from 'react';
import Waveform from './Waveform.jsx';
import { player, playFaded, useIsPlaying } from '../audio.js';
import { fmtTime, ORIGIN } from '../util.js';
import { Icon } from './Icon.jsx';
import { cutAt, addAt } from '../segments.js';
import { usePreviewSelect } from '../previewMap.js';
import { chainOf, tailOf, fxCount, emptyFx } from '../fxClient.js';
import { useCardAudio } from '../cardAudio.js';

const peakDb = (p) => (p > 0 ? (20 * Math.log10(p)).toFixed(1).replace('-', '−') + ' dB' : '−∞');

// Controls of mounted cards, so keyboard shortcuts and the inspector can reach them.
export const cardControls = new Map();

/**
 * A sound on the board. What the waveform lets you mark depends on the frame it sits in:
 * a single selection in «Обрізка», any number of segments in «Нарізка», nothing elsewhere.
 */
function TrackCard({ card, sound, frameType, visual, selected, orderNo, isNew, onChange, onAction }) {
  const item = card;
  const uid = card.uid;
  const mode = frameType === 'trim' ? 'trim' : frameType === 'split' ? 'split' : 'none';
  const [cursor, setCursor] = useState(0);
  const [pos, setPos] = useState(null);
  const [menu, setMenu] = useState(false);
  const owner = 'card:' + uid;
  const playing = useIsPlaying(owner);
  const zoom = item.zoom || 1;
  const loop = !!item.loop;
  const change = (patch, opts) => onChange(uid, patch, opts);
  const fades = selected ? visual?.fades : null;
  const trackFades = selected ? visual?.trackFades : null;
  const tone = selected ? visual?.tone : null;

  const fxChain = useMemo(() => chainOf(item), [item.fx]);
  const audio = useCardAudio(uid, sound, fxChain, tailOf(item));
  const { view, processed } = audio;

  // When a merge preview plays and this track is sounding in it: the matching time inside this track.
  const ghost = usePreviewSelect((t, m) => {
    const sg = m.segments.find((x) => x.uid === uid && t >= x.start && t < x.end);
    return sg ? Math.round((t - sg.start) * 1000) / 1000 : null;
  });
  const lastPlay = useRef(null);

  useEffect(() => {
    if (!playing) {
      setPos(null);
      return;
    }
    let raf;
    const tick = () => {
      setPos(player.position(owner));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [playing, owner]);

  useEffect(() => () => player.owner() === owner && player.stop(), [owner]);

  useEffect(() => {
    if (!menu) return;
    const close = (e) => !e.target.closest('.card-menu') && setMenu(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);

  const regions = useMemo(
    () => (mode === 'trim' ? (item.trim ? [{ id: 'sel', ...item.trim }] : []) : mode === 'split' ? item.split || [] : []),
    [mode, item.trim, item.split]
  );
  const regionMode = mode === 'trim' ? 'single' : mode === 'split' ? 'multi' : 'none';
  const selectedReg =
    mode === 'trim' ? item.trim && { start: item.trim.start, end: item.trim.end } : mode === 'split' ? (item.split || []).find((r) => r.id === item.selRegion) : null;

  const startTrack = (from, lp = loop) => {
    if (!view) return;
    lastPlay.current = { kind: 'track' };
    if (trackFades) playFaded(owner, view.buffer, 0, sound.duration, trackFades, { from, loop: lp });
    else player.play(owner, view.buffer, from, null, lp, 0, 0);
  };
  // A selection / segment plays the way it will be saved: with its fades. With loop on — round and round.
  const startRegion = (a, b, id, { from = a, lp = loop } = {}) => {
    if (!view) return;
    lastPlay.current = { kind: 'region', a, b, id, loop: lp };
    playFaded(owner, view.buffer, a, b, visual?.fades, { from, loop: lp });
  };

  // A new processed version while playing: carry on from the same spot, now with the new sound.
  const shownRef = useRef(view);
  useEffect(() => {
    if (shownRef.current === view) return;
    shownRef.current = view;
    if (!view || player.owner() !== owner) return;
    const p = player.position(owner);
    const lp = lastPlay.current;
    if (lp?.kind === 'region') startRegion(lp.a, lp.b, lp.id, { from: Math.min(Math.max(p ?? lp.a, lp.a), lp.b - 0.001), lp: lp.loop });
    else startTrack(Math.min(p ?? 0, Math.max(0, view.buffer.duration - 0.01)));
  }, [view]);

  const toggle = () => {
    if (playing) {
      const p = player.position(owner);
      player.stop();
      if (p != null) setCursor(p);
      return;
    }
    startTrack(cursor >= sound.duration - 0.02 ? 0 : cursor);
  };

  const selectedId = mode === 'trim' ? 'sel' : item.selRegion;
  const playSel = () => {
    if (!selectedReg) return toggle();
    if (playing) return player.stop();
    startRegion(selectedReg.start, selectedReg.end, selectedId);
  };

  // Switching loop takes effect immediately, from the current position.
  const setLoop = (v) => {
    change({ loop: v });
    if (!playing) return;
    const p = player.position(owner);
    const lp = lastPlay.current;
    if (lp?.kind === 'region') startRegion(lp.a, lp.b, lp.id, { from: p ?? lp.a, lp: v });
    else startTrack(p ?? 0, v);
  };

  useEffect(() => {
    cardControls.set(uid, {
      toggle,
      playSel,
      toggleLoop: () => setLoop(!loop),
      setLoop,
      playRange: (a, b, id, lp) => startRegion(a, b, id, { lp: lp ?? loop }),
      current: () => (player.owner() === owner ? lastPlay.current : null),
      hasRegion: () => (mode === 'split' ? !!item.selRegion : mode === 'trim' ? !!item.trim : false),
      deleteSelectedRegion: () => {
        if (mode === 'split' && item.selRegion) change({ split: (item.split || []).filter((r) => r.id !== item.selRegion), selRegion: null });
        if (mode === 'trim' && item.trim) change({ trim: null });
      },
      // Split mode: cut the segment under the cursor (or the playhead while playing). false = nothing to cut there.
      cutHere: () => {
        const r = cutAt(item.split || [], player.position(owner) ?? cursor, sound.duration);
        if (!r) return false;
        change({ split: r.list, selRegion: r.sel });
        return true;
      },
      addHere: () => {
        const r = addAt(item.split || [], player.position(owner) ?? cursor, sound.duration);
        change({ split: r.list, selRegion: r.sel });
        return true;
      },
    });
    return () => cardControls.delete(uid);
  });

  const onRegionsChange = (list) => {
    if (mode === 'trim') change({ trim: list[0] ? { start: list[0].start, end: list[0].end } : null });
    else if (mode === 'split') change({ split: list });
    onAction(uid, 'region');
  };

  const onSeek = (t) => {
    setCursor(t);
    if (!playing) return;
    const lp = lastPlay.current;
    // Clicking inside the region that's playing keeps playing (and looping) that region.
    if (lp?.kind === 'region' && t >= lp.a && t < lp.b) startRegion(lp.a, lp.b, lp.id, { from: t, lp: lp.loop });
    else startTrack(t);
  };

  const playingRegionId = playing && lastPlay.current?.kind === 'region' ? lastPlay.current.id : null;
  const seamOn = !!item.seam && (mode === 'trim' || mode === 'split');
  const seamRegion = mode === 'trim' ? item.trim : mode === 'split' ? (item.split || []).find((r) => r.id === item.selRegion) : null;
  const nFx = fxCount(item);
  const ch = sound.channels === 1 ? 'моно' : sound.channels === 2 ? 'стерео' : `${sound.channels} кан.`;

  return (
    <div className={'card' + (selected ? ' selected' : '') + (ghost != null ? ' previewing' : '') + (isNew ? ' new' : '')} data-card={uid}>
      <div className="card-head" data-card-head={uid}>
        {frameType === 'merge' && (
          <input
            type="checkbox"
            className="check"
            checked={item.inMerge !== false}
            onChange={(e) => change({ inMerge: e.target.checked })}
            title="Бере участь у склейці цього фрейму"
          />
        )}
        {orderNo != null && <span className="order-no">{orderNo}</span>}
        <button className={'btn-icon play' + (playing ? ' on' : '')} onClick={toggle} title="Грати / стоп (пробіл)">
          <Icon name={playing ? 'stop' : 'play'} />
        </button>
        <div className="card-title">
          <span className="name" title={sound.name}>
            {sound.name}
          </span>
          <span className="meta">
            <span>{fmtTime(sound.duration)}</span>
            <span>{ch}</span>
            {view && <span title={processed ? 'Пікова гучність з ефектами' : 'Пікова гучність'}>пік {peakDb(view.peaks.peak)}</span>}
            {sound.origin !== 'import' && <span className="origin">{ORIGIN[sound.origin] || sound.origin}</span>}
          </span>
        </div>
        <div className="card-tools">
          <button
            className={'chip-toggle fx-toggle' + (item.fx?.on ? ' on' : '')}
            onClick={() => {
              const on = !item.fx?.on;
              change({ fx: item.fx ? { ...item.fx, on } : emptyFx() });
              if (on) onAction(uid, 'tab:fx');
            }}
            title="Ефекти: спотворення, тон, луна, реверберація, космос… Що чуєш на картці — те й збережеться"
          >
            <Icon name="fx" size={14} />
            <span className="chip-label">Ефекти</span>
            {nFx > 0 && <span className="fx-count">{nFx}</span>}
          </button>
          {(mode === 'trim' || mode === 'split') && (
            <button
              className={'chip-toggle' + (seamOn ? ' on' : '')}
              onClick={() => {
                change({ seam: !seamOn });
                if (!seamOn) {
                  if (!loop) setLoop(true); // checking a seam means listening to it loop
                  onAction(uid, 'tab:seam');
                }
              }}
              title="Допомога з лупами: показує, де кінець зійдеться з початком без клацання й «пум»"
            >
              Шов
            </button>
          )}
          <button className={'chip-toggle' + (loop ? ' on' : '')} onClick={() => setLoop(!loop)} title="Грати по колу (клавіша L)">
            <Icon name="loop" size={14} />
            <span className="chip-label">Луп</span>
          </button>
          <span className="zoom">
            <button className="btn-icon" onClick={() => change({ zoom: Math.max(1, zoom / 1.6) }, { quiet: true })} title="Віддалити хвилю (або Alt + колесо)">
              <Icon name="minus" />
            </button>
            <button className="btn-icon" onClick={() => change({ zoom: zoom * 1.6 }, { quiet: true })} title="Наблизити хвилю (або Alt + колесо)">
              <Icon name="plus" />
            </button>
          </span>
          <span className="card-menu">
            <button className="btn-icon quiet" onClick={() => setMenu(!menu)} title="Ще">
              <Icon name="more" />
            </button>
            {menu && (
              <div className="menu" onClick={() => setMenu(false)}>
                <button onClick={() => onAction(uid, 'dup')}>
                  Дубль з усіма змінами <kbd>⌘D</kbd>
                </button>
                <button onClick={() => onAction(uid, 'dup-clean')}>Чистий дубль</button>
                <button onClick={() => onAction(uid, 'reveal')}>Показати у Finder</button>
                <button onClick={() => onAction(uid, 'download')}>Скачати</button>
                <button className="danger" onClick={() => onAction(uid, 'remove')}>
                  Прибрати з дошки
                </button>
              </div>
            )}
          </span>
        </div>
      </div>
      {audio.error ? (
        <div className="wf-error">Не вдалося відкрити файл: {audio.error}</div>
      ) : (
        <Waveform
          data={view}
          processed={processed}
          height={84}
          duration={sound.duration}
          zoom={zoom}
          onZoom={(z) => change({ zoom: z }, { quiet: true })}
          regions={regions}
          regionMode={regionMode}
          selectedId={selectedId}
          onSelect={(id) => {
            if (mode === 'split') change({ selRegion: id }, { quiet: true });
            if (id) onAction(uid, 'region');
          }}
          onRegionsChange={onRegionsChange}
          onSeek={onSeek}
          onRegionPlay={(r) => startRegion(r.start, r.end, r.id)}
          playingId={playingRegionId}
          seam={seamOn && selected && seamRegion ? { fit: item.seamFit || 'end', start: seamRegion.start, end: seamRegion.end } : null}
          cursor={cursor}
          playhead={pos ?? ghost}
          fades={fades}
          trackFades={trackFades}
          tone={tone}
          dimOutside={mode === 'trim' && !!item.trim && selected && tone === 'keep'}
        />
      )}
      <div className="card-foot" data-card-head={uid}>
        <span className="pos">{fmtTime(pos ?? cursor)}</span>
        {mode === 'trim' && item.trim && (
          <span>
            виділено <b>{(item.trim.end - item.trim.start).toFixed(2)} с</b>
          </span>
        )}
        {mode === 'split' && (item.split || []).length > 0 && <span>відрізків: {(item.split || []).length}</span>}
        {selected && mode === 'trim' && !item.trim && <span className="hint">Протягни по хвилі, щоб виділити</span>}
        {selected && mode === 'split' && !(item.split || []).length && <span className="hint">Протягуй по хвилі або S — розрізати в курсорі</span>}
        {audio.pending && <span className="fx-busy">ефекти…</span>}
      </div>
    </div>
  );
}

export default memo(TrackCard);
