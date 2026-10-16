import { useEffect, useMemo, useRef, useState } from 'react';
import { player, usePlayingOwner } from '../audio.js';
import { fmtTime, media, ORIGIN, DND_SOUNDS, loadLocal, saveLocal } from '../util.js';
import { FRAME_LABEL, readingOrder } from '../../../shared/board.js';
import { cardControls } from './TrackCard.jsx';
import { effSoundOf } from '../fxClient.js';
import { Icon } from './Icon.jsx';

const FILTERS = [
  ['all', 'Усі'],
  ['import', 'Імпортовані'],
  ['made', 'Створені'],
  ['fav', 'Обрані'],
];

function Thumb({ bars }) {
  if (!bars?.length) return <span className="lay-thumb" />;
  const step = Math.max(1, Math.floor(bars.length / 30));
  const pts = [];
  for (let i = 0; i < bars.length; i += step) pts.push(Math.max(...bars.slice(i, i + step)));
  return (
    <svg className="lay-thumb" viewBox={`0 0 ${pts.length} 100`} preserveAspectRatio="none">
      {pts.map((v, i) => (
        <rect key={i} x={i + 0.15} width="0.7" y={50 - v / 2} height={Math.max(2, v)} />
      ))}
    </svg>
  );
}

/**
 * The library, organised like Figma layers: frames of the current board with their cards, cards
 * outside frames, and sounds that aren't on any board. Search looks through every board.
 */
export default function Layers({
  board,
  boards,
  sounds,
  soundsById,
  sel,
  importing,
  onImport,
  onPickCard,
  onPickFrame,
  onFocusCard,
  onFocusFrame,
  onOpenOnBoard,
  onAddOrphans,
  onRenameSound,
  onFav,
  onReveal,
  onDeleteSounds,
  open = true,
  onToggle,
}) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [closed, setClosed] = useState(() => loadLocal('esm.layers.closed', {}));
  const [menu, setMenu] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [fileOver, setFileOver] = useState(false);
  const owner = usePlayingOwner();
  const fileInput = useRef(null);
  const searchRef = useRef(null);
  const [focusSearch, setFocusSearch] = useState(false);
  const selCards = new Set(sel.cards);
  const selFrames = new Set(sel.frames);

  useEffect(() => saveLocal('esm.layers.closed', closed), [closed]);
  useEffect(() => {
    if (open && focusSearch) {
      searchRef.current?.focus();
      setFocusSearch(false);
    }
  }, [open, focusSearch]);
  useEffect(() => {
    if (!menu) return;
    const close = (e) => !e.target.closest('.menu') && setMenu(null);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const pass = (s) => {
    if (!s) return false;
    if (filter === 'import' && s.origin !== 'import') return false;
    if (filter === 'made' && s.origin === 'import') return false;
    if (filter === 'fav' && !s.favorite) return false;
    const n = s.name.toLowerCase();
    return words.every((w) => n.includes(w));
  };
  const filtering = words.length > 0 || filter !== 'all';

  const groups = useMemo(() => {
    const out = board.frames.map((f) => ({ frame: f, cards: readingOrder(board.cards.filter((c) => c.frameId === f.id)) }));
    out.push({ frame: null, cards: readingOrder(board.cards.filter((c) => !c.frameId)) });
    return out;
  }, [board]);

  const used = useMemo(() => new Set(boards.flatMap((b) => b.cards.map((c) => c.soundId))), [boards]);
  const orphans = sounds.filter((s) => !used.has(s.id) && pass(s)).sort((a, b) => b.createdAt - a.createdAt);
  // While searching: matches on the other boards too.
  const elsewhere = filtering
    ? boards
        .filter((b) => b.id !== board.id)
        .map((b) => ({ board: b, cards: b.cards.filter((c) => pass(soundsById[c.soundId])) }))
        .filter((x) => x.cards.length)
    : [];

  const play = (e, key, fn) => {
    e.stopPropagation();
    fn();
  };
  const playCard = (c, s) => {
    const ctl = cardControls.get(c.uid);
    if (ctl) return ctl.toggle();
    const o = 'lib:' + s.id;
    owner === o ? player.stop() : player.playUrl(o, media(s));
  };
  const playSound = (s) => {
    const o = 'lib:' + s.id;
    owner === o ? player.stop() : player.playUrl(o, media(s));
  };

  const soundMenu = (s, extra) => (
    <div className="menu" onClick={(e) => e.stopPropagation()}>
      {extra}
      <button onClick={() => (setMenu(null), setRenaming(s.id))}>Перейменувати</button>
      <button onClick={() => (setMenu(null), onFav(s.id, !s.favorite))}>{s.favorite ? 'Прибрати з обраних' : 'В обрані'}</button>
      <button onClick={() => (setMenu(null), onReveal(s.id))}>Показати у Finder</button>
    </div>
  );

  const name = (s) =>
    renaming === s.id ? (
      <input
        className="rename"
        autoFocus
        defaultValue={s.name}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            e.currentTarget.value = s.name;
            e.currentTarget.blur();
          }
        }}
        onBlur={(e) => {
          const v = e.currentTarget.value.trim();
          if (v && v !== s.name) onRenameSound(s.id, v);
          setRenaming(null);
        }}
      />
    ) : (
      <span className="lay-name">{s.name}</span>
    );

  const cardRow = (c, onClick, onDouble) => {
    const s = soundsById[c.soundId];
    if (!pass(s)) return null;
    const on = owner === 'card:' + c.uid || owner === 'lib:' + s.id;
    return (
      <div
        key={c.uid}
        className={'lay-row card-row' + (selCards.has(c.uid) ? ' sel' : '')}
        onClick={onClick}
        onDoubleClick={onDouble}
        draggable={renaming !== s.id}
        onDragStart={(e) => {
          e.dataTransfer.setData(DND_SOUNDS, JSON.stringify([s.id]));
          e.dataTransfer.effectAllowed = 'copy';
        }}
        title="Клік — показати на дошці. Подвійний клік — наблизити. Тягни на дошку — ще одна картка цього звуку"
      >
        <button className={'btn-icon play' + (on ? ' on' : '')} onClick={(e) => play(e, c.uid, () => playCard(c, s))} title="Прослухати">
          <Icon name={on ? 'stop' : 'play'} size={14} />
        </button>
        <Thumb bars={s.thumb} />
        {name(s)}
        {c.fx?.on && c.fx.e && Object.values(c.fx.e).some((x) => x.on) && (
          <span className="fx-badge" title="З ефектами">
            <Icon name="fx" size={11} />
          </span>
        )}
        {s.favorite && <Icon name="starOn" size={11} />}
        <span className="lay-dur">{fmtTime(effSoundOf(s, c).duration, 1)}</span>
        <button
          className="btn-icon quiet lay-more"
          onClick={(e) => {
            e.stopPropagation();
            setMenu(menu === c.uid ? null : c.uid);
          }}
        >
          <Icon name="more" size={14} />
        </button>
        {menu === c.uid && soundMenu(s)}
      </div>
    );
  };

  const hasFiles = (e) => [...e.dataTransfer.types].includes('Files');
  const totalCards = board.cards.length;
  const drops = {
    onDragOver: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setFileOver(true);
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setFileOver(false);
    },
    onDrop: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setFileOver(false);
      onImport([...e.dataTransfer.files], null);
    },
  };
  const fileField = (
    <input
      ref={fileInput}
      type="file"
      multiple
      accept="audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff,.m4a,.opus"
      hidden
      onChange={(e) => {
        onImport([...e.target.files], null);
        e.target.value = '';
      }}
    />
  );

  // Folded: a narrow strip with the essentials and the board's frames for quick jumps.
  if (!open)
    return (
      <aside className={'rail left' + (fileOver ? ' file-over' : '')} {...drops}>
        <button className="rail-btn" onClick={onToggle} title="Розгорнути шари (⌘\)">
          <Icon name="sideLeft" />
        </button>
        <button
          className="rail-btn"
          onClick={() => {
            setFocusSearch(true);
            onToggle();
          }}
          title="Пошук по всіх дошках"
        >
          <Icon name="search" />
        </button>
        <button className="rail-btn accent" onClick={() => fileInput.current.click()} disabled={importing} title="Додати файли">
          <Icon name="import" />
        </button>
        {fileField}
        {board.frames.length > 0 && <div className="rail-sep" />}
        <div className="rail-list">
          {board.frames.map((f) => (
            <button
              key={f.id}
              className={'rail-frame t-' + f.type + (selFrames.has(f.id) ? ' on' : '')}
              onClick={() => onPickFrame(f.id)}
              onDoubleClick={() => onFocusFrame(f.id)}
              title={`${f.name} · ${FRAME_LABEL[f.type]}`}
            >
              {f.name.trim().charAt(0).toUpperCase() || '·'}
            </button>
          ))}
        </div>
      </aside>
    );

  return (
    <aside className={'layers' + (fileOver ? ' file-over' : '')} {...drops}>
      <div className="lib-head">
        <button className="btn-icon side-toggle" onClick={onToggle} title="Згорнути шари (⌘\)">
          <Icon name="sideLeft" />
        </button>
        <h1>
          Шари <span className="count">{totalCards}</span>
        </h1>
        <button className="btn primary" onClick={() => fileInput.current.click()} disabled={importing}>
          <Icon name="import" /> {importing ? 'Імпорт…' : 'Додати файли'}
        </button>
        {fileField}
      </div>
      <label className="search">
        <Icon name="search" />
        <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Пошук по всіх дошках" />
        {q && (
          <button className="btn-icon quiet" onClick={() => setQ('')} title="Очистити">
            <Icon name="x" size={12} />
          </button>
        )}
      </label>
      <div className="chips">
        {FILTERS.map(([k, label]) => (
          <button key={k} className={'chip' + (filter === k ? ' on' : '')} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>

      <div className="lay-list">
        {groups.map(({ frame, cards }) => {
          const key = frame ? frame.id : '_loose';
          const shownCards = cards.filter((c) => pass(soundsById[c.soundId]));
          if (!frame && !cards.length) return null;
          if (filtering && !shownCards.length) return null;
          const open = filtering || !closed[key];
          return (
            <div key={key} className="lay-group">
              <div
                className={'lay-row group-row' + (frame && selFrames.has(frame.id) ? ' sel' : '')}
                onClick={() => (frame ? onPickFrame(frame.id) : setClosed({ ...closed, [key]: !closed[key] }))}
                onDoubleClick={() => frame && onFocusFrame(frame.id)}
                title={frame ? 'Клік — вибрати фрейм. Подвійний клік — показати його' : ''}
              >
                <button
                  className={'lay-caret' + (open ? ' open' : '')}
                  onClick={(e) => {
                    e.stopPropagation();
                    setClosed({ ...closed, [key]: !closed[key] });
                  }}
                >
                  <Icon name="chevron" size={12} />
                </button>
                {frame ? <span className={'lay-dot t-' + frame.type} /> : <span className="lay-dot" />}
                <span className="lay-name">{frame ? frame.name : 'Поза фреймами'}</span>
                {frame && <span className="lay-type">{FRAME_LABEL[frame.type]}</span>}
                <span className="lay-count">{shownCards.length}</span>
              </div>
              {open && shownCards.map((c) => cardRow(c, (e) => onPickCard(c.uid, e.shiftKey || e.metaKey), () => onFocusCard(c.uid)))}
            </div>
          );
        })}

        {orphans.length > 0 && (
          <div className="lay-group">
            <div className="lay-row group-row orphan-head" onClick={() => setClosed({ ...closed, _orphans: !closed._orphans })}>
              <button className={'lay-caret' + (filtering || !closed._orphans ? ' open' : '')}>
                <Icon name="chevron" size={12} />
              </button>
              <span className="lay-name">Без картки</span>
              <span className="lay-count">{orphans.length}</span>
              <button
                className="btn-link"
                onClick={(e) => {
                  e.stopPropagation();
                  onAddOrphans(orphans.map((s) => s.id));
                }}
                title="Покласти всі ці звуки на дошку"
              >
                усі на дошку
              </button>
            </div>
            {(filtering || !closed._orphans) &&
              orphans.map((s) => {
                const on = owner === 'lib:' + s.id;
                return (
                  <div
                    key={s.id}
                    className="lay-row card-row orphan"
                    draggable={renaming !== s.id}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DND_SOUNDS, JSON.stringify([s.id]));
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    onDoubleClick={() => onAddOrphans([s.id])}
                    title="Звук є в бібліотеці, але не лежить на жодній дошці. Подвійний клік або перетягни — на дошку"
                  >
                    <button className={'btn-icon play' + (on ? ' on' : '')} onClick={(e) => play(e, s.id, () => playSound(s))}>
                      <Icon name={on ? 'stop' : 'play'} size={14} />
                    </button>
                    <Thumb bars={s.thumb} />
                    {name(s)}
                    <span className="lay-dur">{fmtTime(s.duration, 1)}</span>
                    <button
                      className="btn-icon quiet lay-more"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenu(menu === s.id ? null : s.id);
                      }}
                    >
                      <Icon name="more" size={14} />
                    </button>
                    {menu === s.id &&
                      soundMenu(
                        s,
                        <>
                          <button onClick={() => (setMenu(null), onAddOrphans([s.id]))}>На дошку</button>
                          <button className="danger" onClick={() => (setMenu(null), onDeleteSounds([s.id]))}>
                            Видалити файл
                          </button>
                        </>
                      )}
                  </div>
                );
              })}
          </div>
        )}

        {elsewhere.map(({ board: b, cards }) => (
          <div key={b.id} className="lay-group">
            <div className="lay-row group-row elsewhere">
              <span className="lay-name">На дошці «{b.name}»</span>
              <span className="lay-count">{cards.length}</span>
            </div>
            {cards.map((c) => cardRow(c, () => onOpenOnBoard(b.id, c.uid), () => onOpenOnBoard(b.id, c.uid)))}
          </div>
        ))}

        {!sounds.length && (
          <div className="empty">
            <p>Тут будуть твої звуки.</p>
            <p>Перетягни файли з Finder на дошку або сюди. Підходять wav, mp3, ogg, flac, aiff, m4a.</p>
          </div>
        )}
        {!!sounds.length && filtering && !groups.some((g) => g.cards.some((c) => pass(soundsById[c.soundId]))) && !orphans.length && !elsewhere.length && (
          <div className="empty">Нічого не знайдено</div>
        )}
      </div>
      {fileOver && <div className="drop-overlay">Відпусти, щоб додати на дошку</div>}
    </aside>
  );
}
