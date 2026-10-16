import { useEffect, useState } from 'react';
import TrackCard from './TrackCard.jsx';
import { Icon } from './Icon.jsx';
import { DND_SOUNDS, DND_CARD, timeAgo } from '../util.js';
import { effSound } from '../fxClient.js';

const kinds = (e) => [...e.dataTransfer.types];

export default function Desk({
  desk,
  soundsById,
  mode,
  batches,
  visual,
  onUpdateItem,
  onRemoveItem,
  onActivate,
  onDropData,
  onCheckAll,
  onClear,
  onPullBatch,
  focusUid,
  onClearFades,
  onSaveFx,
  busy,
  canSave,
}) {
  const [dropAt, setDropAt] = useState(null); // { uid, where } | { end: true }
  const [histOpen, setHistOpen] = useState(false);

  useEffect(() => {
    if (!histOpen) return;
    const close = (e) => !e.target.closest('.hist') && setHistOpen(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [histOpen]);

  const accepts = (e) => {
    const t = kinds(e);
    return t.includes(DND_SOUNDS) || t.includes(DND_CARD) || t.includes('Files');
  };

  const onDropOnCard = (e, item, isDrop) => {
    if (!item) return; // dragleave — the list handler resets the hint
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const where = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
    if (!isDrop) {
      e.dataTransfer.dropEffect = kinds(e).includes(DND_CARD) ? 'move' : 'copy';
      if (!dropAt || dropAt.uid !== item.uid || dropAt.where !== where) setDropAt({ uid: item.uid, where });
      return;
    }
    setDropAt(null);
    const idx = desk.items.findIndex((i) => i.uid === item.uid);
    onDropData(e.dataTransfer, where === 'before' ? idx : idx + 1);
  };

  const items = desk.items.filter((i) => soundsById[i.soundId]);
  const recent = [...batches].reverse().slice(0, 15);
  const latest = recent[0];
  const allChecked = items.length > 0 && items.every((i) => i.checked);

  return (
    <section
      className="desk"
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        if (!dropAt || !dropAt.end) setDropAt({ end: true });
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setDropAt(null);
      }}
      onDrop={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        setDropAt(null);
        onDropData(e.dataTransfer, desk.items.length);
      }}
    >
      <div className="desk-bar">
        <div className="pull">
          <button
            className="btn"
            disabled={!latest}
            onClick={() => latest && onPullBatch(latest)}
            title={latest ? 'Додати на стіл результат останньої дії' : 'Ще нічого не створено'}
          >
            <Icon name="pull" /> Додати останні
            {latest && <span className="pull-what">{latest.label}</span>}
          </button>
          <div className="hist">
            <button className="btn btn-caret" disabled={!recent.length} onClick={() => setHistOpen(!histOpen)} title="Історія дій">
              <Icon name="chevron" />
            </button>
            {histOpen && (
              <div className="menu hist-menu">
                <div className="menu-title">Що додати на стіл</div>
                {recent.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => {
                      setHistOpen(false);
                      onPullBatch(b);
                    }}
                  >
                    <span className="hist-label">{b.label}</span>
                    <span className="hist-meta">
                      {b.sounds.length} шт., {timeAgo(b.createdAt)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="desk-bar-right">
          {items.length > 0 && (
            <>
              <label className="check-all">
                <input type="checkbox" checked={allChecked} onChange={(e) => onCheckAll(e.target.checked)} />
                Відмітити всі
              </label>
              <button className="btn ghost" onClick={onClear}>
                Очистити стіл
              </button>
            </>
          )}
        </div>
      </div>

      <div className="tracks">
        {!items.length && (
          <div className={'desk-empty' + (dropAt?.end ? ' over' : '')}>
            <p className="big">Стіл порожній</p>
            <p>Перетягни сюди звуки з бібліотеки або файли з Finder.</p>
            <p>«Додати останні» підтягне те, що ти щойно нарізав чи склеїв.</p>
          </div>
        )}
        {items.map((item) => (
          <TrackCard
            key={item.uid}
            item={item}
            sound={effSound(soundsById[item.soundId], item)}
            deskId={desk.id}
            mode={mode}
            active={desk.activeUid === item.uid}
            fades={visual.fades}
            trackFades={visual.trackFades}
            tone={visual.tone}
            onActivate={() => onActivate(item.uid)}
            onChange={(patch) => onUpdateItem(item.uid, patch)}
            onRemove={() => onRemoveItem(item.uid)}
            onDropOnCard={onDropOnCard}
            dropHint={dropAt && dropAt.uid === item.uid ? dropAt.where : null}
            focus={item.uid === focusUid}
            onClearFades={onClearFades}
            onSaveFx={() => onSaveFx(item)}
            busy={busy}
            canSave={canSave}
          />
        ))}
        {items.length > 0 && <div className={'drop-end' + (dropAt?.end ? ' over' : '')} />}
      </div>
    </section>
  );
}
