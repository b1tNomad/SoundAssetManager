import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { NumField, Seg, CurveSelect, Toggle } from './controls.jsx';
import { Icon } from './Icon.jsx';
import { player, playerVersion, usePlayingOwner } from '../audio.js';
import { fmtTime, media, rid, clamp } from '../util.js';
import { cardControls } from './TrackCard.jsx';
import { mergeLayout, usePreviewMap, usePreviewSelect } from '../previewMap.js';
import { BY_ID } from '../../../shared/fx.js';


export const OGG_KBPS = { '-1': 45, 0: 64, 1: 80, 2: 96, 3: 112, 4: 128, 5: 160, 6: 192, 7: 224, 8: 256, 9: 320, 10: 500 };
export const MP3_KBPS = { 0: 245, 1: 225, 2: 190, 3: 175, 4: 165, 5: 130, 6: 115, 7: 100, 8: 85, 9: 65 };


export function NoTrack({ text = 'Клікни на трек на столі, щоб працювати з ним.' }) {
  return <p className="hint-block">{text}</p>;
}

/** Marks a track whose card has effects on — the result will be made from the processed sound. */
export function FxBadge({ sound, text }) {
  if (!sound.fx) return null;
  return (
    <span className="fx-badge" title={'З ефектами: ' + sound.fx.chain.map((e) => BY_ID[e.type]?.label).join(', ')}>
      <Icon name="fx" size={12} />
      {text && ' з ефектами'}
    </span>
  );
}

function Target({ sound }) {
  return (
    <div className="target">
      <span className="target-name">{sound.name}</span>
      <FxBadge sound={sound} text />
      <span className="target-dur">{fmtTime(sound.duration)}</span>
    </div>
  );
}

// ---------- shared output block ----------
export function Output({ settings, setSettings, caps, nameHint, name, setName, busy, canRun, runLabel, onPreview, onRun, previews, children, note }) {
  const owner = usePlayingOwner();
  return (
    <div className="output">
      {children}
      <label className="field">
        <span className="num-label">Назва результату</span>
        <input type="text" value={name} placeholder={nameHint} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="row">
        <span className="num-label">Формат</span>
        <Seg
          small
          value={settings.saveFormat}
          onChange={(v) => setSettings({ saveFormat: v })}
          options={[
            ['wav', 'wav', 'Без втрат — найкраще для подальшої обробки'],
            ['ogg', 'ogg', caps.ogg === 'vorbis' ? 'Вбудований енкодер ffmpeg, якість нижча' : 'Ogg Vorbis'],
            ['mp3', 'mp3'],
          ]}
        />
      </div>
      {note && <p className="hint save-note">{note}</p>}
      <div className="actions">
        <button className="btn" disabled={!canRun || busy} onClick={onPreview} title="Зробити тимчасово і прослухати, нічого не зберігаючи">
          <Icon name="play" /> Прослухати
        </button>
        <button className="btn primary" disabled={!canRun || busy} onClick={onRun}>
          {busy ? 'Обробка…' : runLabel}
        </button>
      </div>
      {previews?.length > 0 && (
        <div className="previews">
          <div className="num-label">Прослуховування (ще не збережено)</div>
          {previews.map((p, i) => {
            const o = 'prev:' + p.url;
            const on = owner === o;
            return (
              <div className="prev-row" key={p.url}>
                <button className={'btn-icon play' + (on ? ' on' : '')} onClick={() => (on ? player.stop() : player.playUrl(o, p.url))}>
                  <Icon name={on ? 'stop' : 'play'} />
                </button>
                <span className="prev-name">{p.name}</span>
                <span className="prev-dur">{fmtTime(p.duration)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function useName(key) {
  const [name, setName] = useState('');
  useEffect(() => setName(''), [key]);
  return [name, setName];
}

// ---------- trim ----------
export function TrimPanel({ active, tool, setTool, onUpdateItem, settings, setSettings, caps, busy, previews, onPreview, onRun, note }) {
  const t = tool.trim;
  const set = (p) => setTool('trim', p);
  const [name, setName] = useName(active?.item.uid);
  if (!active) return <NoTrack />;
  const { item, sound } = active;
  const sel = item.trim;
  const d = sound.duration;
  const setSel = (p) => {
    const next = { start: 0, end: d, ...(sel || {}), ...p };
    next.start = clamp(next.start, 0, d);
    next.end = clamp(next.end, 0, d);
    if (next.end - next.start < 0.005) return;
    onUpdateItem(item.uid, { trim: next });
  };
  const fadesOk = t.fadeIn > 0 || t.fadeOut > 0;
  const canRun = t.action === 'fade' ? fadesOk : !!sel;

  const req = () => {
    const output = { fadeIn: t.fadeIn, fadeOut: t.fadeOut, curve: t.curve, name, format: settings.saveFormat };
    const fx = sound.fx || null;
    if (t.action === 'fade') return { op: 'fade', params: { id: sound.id, fx }, output, sourceUid: item.uid };
    if (t.action === 'cut')
      return { op: 'cut', params: { id: sound.id, fx, start: sel.start, end: sel.end, crossfade: t.crossfade, curve: 'qsin' }, output, sourceUid: item.uid };
    return { op: 'trim', params: { id: sound.id, fx, start: sel.start, end: sel.end }, output, sourceUid: item.uid };
  };
  const suffix = { keep: '_trim', cut: '_cut', fade: '_fade' }[t.action];

  return (
    <>
      <Seg
        value={t.action}
        onChange={(v) => set({ action: v })}
        options={[
          ['keep', 'Залишити виділене', 'Обрізати трек до виділеного шматка'],
          ['cut', 'Видалити виділене', 'Вирізати шматок, а решту склеїти'],
          ['fade', 'Лише фейди', 'Додати затухання до всього треку'],
        ]}
      />
      {t.action !== 'fade' && (
        <div className="group">
          <div className="group-title">Виділення</div>
          {sel ? (
            <>
              <div className="row">
                <NumField label="Початок" value={sel.start} onChange={(v) => setSel({ start: v })} max={d} />
                <NumField label="Кінець" value={sel.end} onChange={(v) => setSel({ end: v })} max={d} />
                <span className="len">{(sel.end - sel.start).toFixed(2)} с</span>
              </div>
            </>
          ) : (
            <p className="hint">Протягни мишкою по хвилі треку.</p>
          )}
          <div className="row">
            <button className="btn ghost" onClick={() => onUpdateItem(item.uid, { trim: { start: 0, end: d } })}>
              Виділити все
            </button>
            {sel && (
              <button className="btn ghost" onClick={() => onUpdateItem(item.uid, { trim: null })}>
                Скинути
              </button>
            )}
          </div>
          {t.action === 'cut' && (
            <NumField
              label="Кросфейд на стику"
              value={t.crossfade}
              onChange={(v) => set({ crossfade: v })}
              title="Щоб стик не клацав. 0 — склеїти впритул."
            />
          )}
        </div>
      )}
      <div className="group">
        <div className="group-title">Затухання результату</div>
        <div className="row">
          <NumField label="На початку" value={t.fadeIn} onChange={(v) => set({ fadeIn: v })} />
          <NumField label="В кінці" value={t.fadeOut} onChange={(v) => set({ fadeOut: v })} />
        </div>
        <CurveSelect value={t.curve} onChange={(v) => set({ curve: v })} />
      </div>
      <Output
        settings={settings}
        setSettings={setSettings}
        caps={caps}
        nameHint={sound.name + suffix}
        name={name}
        setName={setName}
        busy={busy}
        canRun={canRun && caps.found}
        runLabel="Зберегти"
        note={note}
        previews={previews}
        onPreview={() => onPreview(req())}
        onRun={() => onRun(req())}
      />
    </>
  );
}

// ---------- split ----------
export function SplitPanel({ active, tool, setTool, onUpdateItem, settings, setSettings, caps, busy, previews, onPreview, onRun, toast, note }) {
  const t = tool.split;
  const set = (p) => setTool('split', p);
  const [name, setName] = useName(active?.item.uid);
  const owner = usePlayingOwner();
  useSyncExternalStore(player.subscribe, playerVersion); // re-render on every play/stop to show which segment plays
  if (!active) return <NoTrack />;
  const { item, sound } = active;
  const d = sound.duration;
  const ctl = cardControls.get(item.uid);
  const now = owner === 'card:' + item.uid ? ctl?.current() : null;
  const regs = [...(item.split || [])].sort((a, b) => a.start - b.start);
  const update = (id, p) => {
    onUpdateItem(item.uid, {
      split: (item.split || []).map((r) => {
        if (r.id !== id) return r;
        const n = { ...r, ...p };
        n.start = clamp(n.start, 0, d);
        n.end = clamp(n.end, 0, d);
        return n.end - n.start >= 0.005 ? n : r;
      }),
    });
  };
  const equal = () => {
    const n = Math.max(1, Math.min(200, Math.round(t.parts) || 1));
    const len = d / n;
    onUpdateItem(item.uid, { split: Array.from({ length: n }, (_, i) => ({ id: rid('r'), start: i * len, end: (i + 1) * len })) });
  };
  const cutHere = () => {
    if (cardControls.get(item.uid)?.cutHere() === false) toast('Постав курсор усередині відрізка, щоб розрізати його', 'error');
  };
  const addHere = () => cardControls.get(item.uid)?.addHere();
  const req = () => ({
    op: 'split',
    params: { id: sound.id, fx: sound.fx || null, segments: regs.map((r) => ({ start: r.start, end: r.end, name: r.name || '' })) },
    output: {
      fadeIn: t.fadeInOn ? t.fadeIn : 0,
      fadeOut: t.fadeOutOn ? t.fadeOut : 0,
      curve: t.curve,
      name,
      format: settings.saveFormat,
    },
    sourceUid: item.uid,
  });

  return (
    <>
      <div className="group">
        <div className="group-title">
          Відрізки <span className="count">{regs.length}</span>
        </div>
        {!regs.length && (
          <p className="hint">
            Відрізків може бути скільки завгодно, і кожен стане окремим файлом. Протягни мишкою по хвилі, натисни «Відрізок» або клікни по хвилі й «Розрізати тут».
          </p>
        )}
        {regs.length > 0 && (
          <div className="seg-list">
            {regs.map((r, i) => {
              const isPlaying = now?.kind === 'region' && now.id === r.id;
              const isLooping = isPlaying && now.loop;
              return (
                <div key={r.id} className={'seg-row' + (item.selRegion === r.id ? ' sel' : '') + (isPlaying ? ' playing' : '')} onClick={() => onUpdateItem(item.uid, { selRegion: r.id })}>
                  <span className="seg-n">{i + 1}</span>
                  <input
                    className="seg-name"
                    placeholder={`${name || sound.name}_${String(i + 1).padStart(2, '0')}`}
                    value={r.name || ''}
                    onChange={(e) => update(r.id, { name: e.target.value })}
                  />
                  <NumField value={r.start} onChange={(v) => update(r.id, { start: v })} max={d} width={58} suffix="" />
                  <NumField value={r.end} onChange={(v) => update(r.id, { end: v })} max={d} width={58} suffix="" />
                  <button
                    className={'btn-icon' + (isPlaying && !isLooping ? ' on' : '')}
                    title="Прослухати (із затуханням)"
                    onClick={(e) => {
                      e.stopPropagation();
                      isPlaying && !isLooping ? player.stop() : ctl?.playRange(r.start, r.end, r.id, false);
                    }}
                  >
                    <Icon name={isPlaying && !isLooping ? 'stop' : 'play'} />
                  </button>
                  <button
                    className={'btn-icon' + (isLooping ? ' on' : '')}
                    title="Слухати по колу. Ще раз — стоп"
                    onClick={(e) => {
                      e.stopPropagation();
                      isLooping ? player.stop() : ctl?.playRange(r.start, r.end, r.id, true);
                    }}
                  >
                    <Icon name="loop" size={14} />
                  </button>
                  <button
                    className="btn-icon quiet"
                    title="Прибрати відрізок"
                    onClick={(e) => {
                      e.stopPropagation();
                      onUpdateItem(item.uid, { split: (item.split || []).filter((x) => x.id !== r.id) });
                    }}
                  >
                    <Icon name="x" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div className="row">
          <button className="btn" onClick={addHere} title="Новий відрізок від курсора — потім підтягни краї мишкою або впиши час">
            <Icon name="plus" /> Відрізок
          </button>
          <button className="btn" onClick={cutHere} title="Розрізати в місці курсора. Працює й під час відтворення — клавіша S">
            <Icon name="cut" /> Розрізати тут <kbd>S</kbd>
          </button>
        </div>
        {regs.length > 0 && <p className="hint">Alt + протягування створює новий відрізок поверх інших. Delete прибирає виділений.</p>}
        <div className="row split-more">
          <NumField label="Рівних частин" value={t.parts} onChange={(v) => set({ parts: v })} step={1} min={1} max={200} suffix="" width={48} />
          <button className="btn ghost" onClick={equal}>
            Розбити порівну
          </button>
          {regs.length > 0 && (
            <button className="btn ghost" onClick={() => onUpdateItem(item.uid, { split: [], selRegion: null })}>
              Очистити
            </button>
          )}
        </div>
      </div>
      <div className="group">
        <div className="group-title">Затухання кожного шматка</div>
        <div className="row">
          <Toggle checked={t.fadeInOn} onChange={(v) => set({ fadeInOn: v })}>
            На початку
          </Toggle>
          <NumField value={t.fadeIn} onChange={(v) => set({ fadeIn: v })} disabled={!t.fadeInOn} width={72} />
        </div>
        <div className="row">
          <Toggle checked={t.fadeOutOn} onChange={(v) => set({ fadeOutOn: v })}>
            В кінці
          </Toggle>
          <NumField value={t.fadeOut} onChange={(v) => set({ fadeOut: v })} disabled={!t.fadeOutOn} width={72} />
        </div>
        <CurveSelect value={t.curve} onChange={(v) => set({ curve: v })} />
      </div>
      <Output
        settings={settings}
        setSettings={setSettings}
        caps={caps}
        nameHint={`${sound.name}_01, _02…`}
        name={name}
        setName={setName}
        busy={busy}
        canRun={regs.length > 0 && caps.found}
        runLabel={regs.length > 1 ? `Нарізати на ${regs.length} файли` : 'Вирізати шматок'}
        note={note}
        previews={previews}
        onPreview={() => onPreview(req())}
        onRun={() => onRun(req())}
      />
    </>
  );
}

// ---------- merge ----------
export function MergePanel({ targets, tool, setTool, onReorderTargets, settings, setSettings, caps, busy, previews, onPreview, onRun, note, onUpdateItem }) {
  const t = tool.merge;
  const set = (p) => setTool('merge', p);
  const [name, setName] = useName(targets.map((x) => x.item.uid).join());
  const pm = usePreviewMap();
  const playT = usePreviewSelect((tt) => Math.round(tt * 100) / 100);
  if (targets.length < 2)
    return <NoTrack text="Поклади у цей фрейм два чи більше звуки. Склеюються ті, що з галочкою, у порядку зліва направо й зверху вниз." />;

  const baseUid = targets.some((x) => x.item.uid === t.baseUid) ? t.baseUid : targets[0].item.uid;
  const layer = (uid) => ({ offset: 0, volume: 100, ...(t.layers[uid] || {}) });
  const setLayer = (uid, p) => set({ layers: { ...t.layers, [uid]: { ...layer(uid), ...p } } });
  const base = targets.find((x) => x.item.uid === baseUid);
  const others = targets.filter((x) => x.item.uid !== baseUid);

  const req = () => {
    const ids = targets.map((x) => x.sound.id);
    const fx = targets.map((x) => x.sound.fx || null);
    const output = { fadeIn: t.fadeIn, fadeOut: t.fadeOut, curve: 'tri', name, format: settings.saveFormat };
    if (t.how === 'concat') return { op: 'concat', params: { ids, fx, gap: t.gap }, output };
    if (t.how === 'crossfade') return { op: 'crossfade', params: { ids, fx, duration: t.xfade, overlap: t.overlap, curve: t.curve }, output };
    return {
      op: 'overlay',
      params: {
        baseId: base.sound.id,
        baseFx: base.sound.fx || null,
        baseVolume: layer(baseUid).volume / 100,
        layers: others.map((x) => ({ id: x.sound.id, fx: x.sound.fx || null, offset: layer(x.item.uid).offset, volume: layer(x.item.uid).volume / 100 })),
        durationMode: t.durationMode,
      },
      output,
    };
  };

  const layout = mergeLayout(t.how, targets, t, layer, baseUid);
  const total = layout.duration;
  // While the preview plays, show the layout it was rendered with and what sounds at this moment.
  const playing = playT != null && pm;
  const shown = playing ? pm : layout;
  const nowSegs = playing ? pm.segments.filter((sg) => playT >= sg.start && playT < sg.end) : [];
  const activeSet = new Set(nowSegs.map((sg) => sg.uid));
  const canSeek = !!(pm && previews?.[0] && pm.url === previews[0].url);
  const seek = (tt) => player.playUrl(pm.owner, pm.url, tt);

  return (
    <>
      <div className="group">
        <div className="group-title">
          Треки фрейму <span className="count">{targets.length}</span>
        </div>
        <SortableRows
          items={targets}
          keyOf={(x) => x.item.uid}
          onReorder={onReorderTargets}
          rowClass={(x) => (activeSet.has(x.item.uid) ? 'playing' : '')}
          render={(x, i) => (
            <>
              {t.how === 'overlay' ? (
                <input
                  type="radio"
                  name="base"
                  checked={x.item.uid === baseUid}
                  onChange={() => set({ baseUid: x.item.uid })}
                  title="Основа — на неї накладаються інші"
                />
              ) : (
                <span className="seg-n">{i + 1}</span>
              )}
              <span className="order-name" title={x.sound.name}>
                {x.sound.name}
              </span>
              <FxBadge sound={x.sound} />
              <span className="order-dur">{fmtTime(x.sound.duration)}</span>
            </>
          )}
        />
        {t.how !== 'overlay' && targets.length > 1 && <p className="hint">Тягни за ⋮⋮ або переставляй картки на дошці, щоб змінити порядок.</p>}
      </div>

      <Seg
        value={t.how}
        onChange={(v) => set({ how: v })}
        options={[
          ['concat', 'Підряд', 'Один за одним'],
          ['crossfade', 'Кросфейд', 'Із затуханням на стиках'],
          ['overlay', 'Накладення', 'Один поверх іншого'],
        ]}
      />

      <div className="mt-wrap">
        <MergeTimeline
          layout={shown}
          playT={playing ? playT : null}
          active={activeSet}
          draggable={t.how === 'overlay' && !playing}
          onDragOffset={(uid, off) => setLayer(uid, { offset: off })}
          onSeek={canSeek ? seek : null}
        />
        <div className="mt-info">
          {playing ? (
            <>
              <span className="mt-time">
                {fmtTime(playT)} / {fmtTime(pm.duration)}
              </span>
              <span className="mt-now">{nowSegs.length ? nowSegs.map((sg) => sg.name).join(' + ') : 'пауза'}</span>
            </>
          ) : (
            <span className="hint">
              {canSeek ? 'Клікни по таймлайну, щоб слухати з того місця.' : 'Натисни «Прослухати» — тут буде видно, що звучить у кожен момент.'}
              {t.how === 'overlay' ? ' Блакитні смужки можна тягати.' : ''}
            </span>
          )}
        </div>
      </div>

      <div className="group">
        {t.how === 'concat' && <NumField label="Пауза між треками" value={t.gap} onChange={(v) => set({ gap: v })} />}
        {t.how === 'crossfade' && (
          <>
            <NumField label="Довжина затухання" value={t.xfade} onChange={(v) => set({ xfade: v })} />
            <Toggle checked={t.overlap} onChange={(v) => set({ overlap: v })}>
              З перекриттям: один стихає, поки інший наростає
            </Toggle>
            {!t.overlap && <p className="hint">Без перекриття: перший трек затихає повністю, потім наростає наступний.</p>}
            <CurveSelect value={t.curve} onChange={(v) => set({ curve: v })} />
          </>
        )}
        {t.how === 'overlay' && (
          <>
            <div className="layer-row base">
              <span className="layer-name">Основа: {base.sound.name}</span>
              <NumField value={layer(baseUid).volume} onChange={(v) => setLayer(baseUid, { volume: v })} step={5} max={400} suffix="%" width={64} title="Гучність" />
            </div>
            {others.map((x) => (
              <div className="layer-row" key={x.item.uid}>
                <span className="layer-name" title={x.sound.name}>
                  {x.sound.name}
                </span>
                <NumField value={layer(x.item.uid).offset} onChange={(v) => setLayer(x.item.uid, { offset: v })} width={76} title="Зсув від початку основи" />
                <NumField value={layer(x.item.uid).volume} onChange={(v) => setLayer(x.item.uid, { volume: v })} step={5} max={400} suffix="%" width={64} title="Гучність" />
              </div>
            ))}
            <div className="row">
              <span className="num-label">Довжина</span>
              <Seg
                small
                value={t.durationMode}
                onChange={(v) => set({ durationMode: v })}
                options={[
                  ['longest', 'по найдовшому'],
                  ['base', 'по основі'],
                ]}
              />
            </div>
          </>
        )}
      </div>

      <div className="group">
        <div className="group-title">Затухання результату</div>
        <div className="row">
          <NumField label="На початку" value={t.fadeIn} onChange={(v) => set({ fadeIn: v })} />
          <NumField label="В кінці" value={t.fadeOut} onChange={(v) => set({ fadeOut: v })} />
        </div>
      </div>

      <Output
        settings={settings}
        setSettings={setSettings}
        caps={caps}
        nameHint={targets.length > 2 ? `${targets[0].sound.name}+${targets.length - 1}` : targets.map((x) => x.sound.name).join(t.how === 'overlay' ? '&' : '+')}
        name={name}
        setName={setName}
        busy={busy}
        canRun={caps.found}
        runLabel={`Склеїти (${fmtTime(Math.max(0, total))})`}
        note={note}
        previews={previews}
        onPreview={() => onPreview({ ...req(), layout })}
        onRun={() => onRun(req())}
      />
    </>
  );
}

/** Vertical list reordered by dragging the ⋮⋮ handle. Calls onReorder(keys in the new order). */
function SortableRows({ items, keyOf, onReorder, render, rowClass }) {
  const listRef = useRef(null);
  const [drag, setDrag] = useState(null); // { key, from, over, dy, pitch }

  const down = (e, i) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rows = [...listRef.current.children].filter((el) => el.classList.contains('order-row'));
    const r0 = rows[0].getBoundingClientRect();
    const pitch = rows[1] ? rows[1].getBoundingClientRect().top - r0.top : r0.height;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ key: keyOf(items[i]), from: i, over: i, y0: e.clientY, dy: 0, pitch });
  };
  const move = (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y0;
    const over = Math.max(0, Math.min(items.length - 1, drag.from + Math.round(dy / drag.pitch)));
    setDrag({ ...drag, dy, over });
  };
  const up = () => {
    if (!drag) return;
    const { from, over } = drag;
    setDrag(null);
    if (from === over) return;
    const keys = items.map(keyOf);
    const [k] = keys.splice(from, 1);
    keys.splice(over, 0, k);
    onReorder(keys);
  };

  const shiftOf = (i) => {
    if (!drag || i === drag.from) return 0;
    if (drag.over > drag.from && i > drag.from && i <= drag.over) return -drag.pitch;
    if (drag.over < drag.from && i >= drag.over && i < drag.from) return drag.pitch;
    return 0;
  };

  return (
    <div className={'order-list' + (drag ? ' sorting' : '')} ref={listRef}>
      {items.map((x, i) => {
        const dragging = drag && i === drag.from;
        return (
          <div
            key={keyOf(x)}
            className={'order-row ' + (rowClass?.(x) || '') + (dragging ? ' dragging' : '')}
            style={{ transform: `translateY(${dragging ? drag.dy : shiftOf(i)}px)` }}
          >
            <span className="row-grip" onPointerDown={(e) => down(e, i)} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrag(null)} title="Тягни, щоб змінити порядок">
              <Icon name="grip" size={14} />
            </span>
            {render(x, i)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Where every track sits in the merged result. Shows the playhead and lights up what sounds right now.
 * Overlay layers can be dragged sideways to change their offset; a click seeks the preview.
 */
function MergeTimeline({ layout, playT, active, draggable, onDragOffset, onSeek }) {
  const ref = useRef(null);
  const drag = useRef(null);
  const [frozen, setFrozen] = useState(null);
  const natural = Math.max(layout.duration, ...layout.segments.map((sg) => sg.end)) || 1;
  const span = frozen ?? (draggable ? natural * 1.15 : natural);
  const pct = (tt) => (tt / span) * 100 + '%';
  const lanes = Math.max(1, ...layout.segments.map((sg) => sg.lane + 1));

  const down = (e, sg) => {
    if (!draggable || sg.kind !== 'layer') return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { uid: sg.uid, x0: e.clientX, off0: sg.start, w: ref.current.clientWidth, scale: span, moved: false };
    setFrozen(span);
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x0) > 2) d.moved = true;
    onDragOffset(d.uid, Math.max(0, +(d.off0 + ((e.clientX - d.x0) / d.w) * d.scale).toFixed(3)));
  };
  const up = () => {
    setTimeout(() => (drag.current = null), 0);
    setFrozen(null);
  };
  const click = (e) => {
    if (!onSeek || drag.current?.moved) return;
    const r = ref.current.getBoundingClientRect();
    onSeek(Math.min(layout.duration - 0.01, Math.max(0, ((e.clientX - r.left) / r.width) * span)));
  };

  return (
    <div className={'mt' + (onSeek ? ' seekable' : '')} ref={ref} style={{ height: lanes * 24 + 8 }} onClick={click}>
      {layout.segments.map((sg) => (
        <div
          key={sg.uid}
          className={'mt-bar ' + sg.kind + (active.has(sg.uid) ? ' on' : '') + (draggable && sg.kind === 'layer' ? ' drag' : '')}
          style={{ left: pct(sg.start), width: pct(Math.max(0, sg.end - sg.start)), top: 4 + sg.lane * 24 }}
          onPointerDown={(e) => down(e, sg)}
          onPointerMove={move}
          onPointerUp={up}
          title={draggable && sg.kind === 'layer' ? 'Тягни, щоб змінити момент накладення' : sg.name}
        >
          {sg.name}
        </div>
      ))}
      {playT != null && <div className="mt-head" style={{ left: pct(playT) }} />}
    </div>
  );
}
