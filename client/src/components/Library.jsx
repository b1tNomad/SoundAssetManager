import { useEffect, useMemo, useRef, useState } from 'react';
import { player, usePlayingOwner } from '../audio.js';
import { fmtTime, media, ORIGIN, DND_SOUNDS } from '../util.js';
import { Icon } from './Icon.jsx';

const FILTERS = [
  ['all', 'Усі'],
  ['import', 'Імпортовані'],
  ['made', 'Створені'],
  ['fav', 'Обрані'],
];

export default function Library({ sounds, newIds, importing, downloading, onImport, onAdd, onRename, onDelete, onFav, onReveal, onDownload }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [sel, setSel] = useState(() => new Set());
  const [anchor, setAnchor] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [menu, setMenu] = useState(null);
  const [fileOver, setFileOver] = useState(false);
  const owner = usePlayingOwner();
  const fileInput = useRef(null);

  const list = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return sounds
      .filter((s) => {
        if (filter === 'import' && s.origin !== 'import') return false;
        if (filter === 'made' && s.origin === 'import') return false;
        if (filter === 'fav' && !s.favorite) return false;
        const n = s.name.toLowerCase();
        return words.every((w) => n.includes(w));
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [sounds, q, filter]);

  // Drop selection entries that no longer exist.
  useEffect(() => {
    const ids = new Set(sounds.map((s) => s.id));
    setSel((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [sounds]);

  useEffect(() => {
    if (!menu) return;
    const close = (e) => !e.target.closest('.menu') && setMenu(null);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);

  const click = (e, s) => {
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(sel);
      next.has(s.id) ? next.delete(s.id) : next.add(s.id);
      setSel(next);
      setAnchor(s.id);
    } else if (e.shiftKey && anchor) {
      const a = list.findIndex((x) => x.id === anchor);
      const b = list.findIndex((x) => x.id === s.id);
      if (a < 0 || b < 0) return;
      const [i, j] = a < b ? [a, b] : [b, a];
      setSel(new Set(list.slice(i, j + 1).map((x) => x.id)));
    } else {
      setSel(new Set([s.id]));
      setAnchor(s.id);
    }
  };

  const playRow = (e, s) => {
    e.stopPropagation();
    const o = 'lib:' + s.id;
    if (owner === o) player.stop();
    else player.playUrl(o, media(s));
  };

  const dragStart = (e, s) => {
    const ids = sel.has(s.id) ? list.filter((x) => sel.has(x.id)).map((x) => x.id) : [s.id];
    e.dataTransfer.setData(DND_SOUNDS, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const hasFiles = (e) => [...e.dataTransfer.types].includes('Files');
  const selected = list.filter((x) => sel.has(x.id)).map((x) => x.id);

  return (
    <aside
      className={'library' + (fileOver ? ' file-over' : '')}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setFileOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFileOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setFileOver(false);
        onImport([...e.dataTransfer.files]);
      }}
    >
      <div className="lib-head">
        <h1>
          Бібліотека <span className="count">{sounds.length}</span>
        </h1>
        <button className="btn primary" onClick={() => fileInput.current.click()} disabled={importing}>
          <Icon name="import" /> {importing ? 'Імпорт…' : 'Додати файли'}
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff,.m4a,.opus"
          hidden
          onChange={(e) => {
            onImport([...e.target.files]);
            e.target.value = '';
          }}
        />
      </div>
      <label className="search">
        <Icon name="search" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Пошук за назвою" />
      </label>
      <div className="chips">
        {FILTERS.map(([k, label]) => (
          <button key={k} className={'chip' + (filter === k ? ' on' : '')} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
        {list.length > 1 && (
          <button className="chip-link" onClick={() => setSel(new Set(list.map((x) => x.id)))} title="Вибрати всі звуки, що зараз у списку (з урахуванням пошуку й фільтра)">
            Вибрати всі
          </button>
        )}
      </div>

      <div className="lib-list">
        {!sounds.length && (
          <div className="empty">
            <p>Тут будуть твої звуки.</p>
            <p>Перетягни файли з Finder сюди або натисни «Додати файли». Підходять wav, mp3, ogg, flac, aiff, m4a.</p>
          </div>
        )}
        {!!sounds.length && !list.length && <div className="empty">Нічого не знайдено</div>}
        {list.map((s) => {
          const playing = owner === 'lib:' + s.id;
          return (
            <div
              key={s.id}
              className={'lib-row' + (sel.has(s.id) ? ' sel' : '') + (newIds.has(s.id) ? ' new' : '')}
              draggable={renaming !== s.id}
              onDragStart={(e) => dragStart(e, s)}
              onClick={(e) => click(e, s)}
              onDoubleClick={() => renaming !== s.id && onAdd([s.id])}
              title="Подвійний клік — на стіл. Тягни на стіл або вкладку."
            >
              <button className={'btn-icon play' + (playing ? ' on' : '')} onClick={(e) => playRow(e, s)} title="Прослухати">
                <Icon name={playing ? 'stop' : 'play'} />
              </button>
              <div className="lib-main">
                {renaming === s.id ? (
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
                      if (v && v !== s.name) onRename(s.id, v);
                      setRenaming(null);
                    }}
                  />
                ) : (
                  <div className="lib-name">{s.name}</div>
                )}
                <div className="lib-meta">
                  <span>{fmtTime(s.duration)}</span>
                  <span className="ext">{s.ext}</span>
                  {s.origin !== 'import' && <span className="origin">{ORIGIN[s.origin] || s.origin}</span>}
                </div>
              </div>
              <button
                className={'btn-icon fav' + (s.favorite ? ' on' : '')}
                onClick={(e) => {
                  e.stopPropagation();
                  onFav(s.id, !s.favorite);
                }}
                title={s.favorite ? 'Прибрати з обраних' : 'В обрані'}
              >
                <Icon name={s.favorite ? 'starOn' : 'star'} />
              </button>
              <button
                className="btn-icon quiet"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenu(menu === s.id ? null : s.id);
                }}
                title="Ще"
              >
                <Icon name="more" />
              </button>
              {menu === s.id && (
                <div className="menu" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => (setMenu(null), onAdd([s.id]))}>Додати на стіл</button>
                  <button onClick={() => (setMenu(null), setRenaming(s.id))}>Перейменувати</button>
                  <button onClick={() => (setMenu(null), onReveal(s.id))}>Показати у Finder</button>
                  <button className="danger" onClick={() => (setMenu(null), onDelete([s.id]))}>
                    Видалити з бібліотеки
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {selected.length > 0 && (
        <div className="lib-sel">
          <div className="lib-sel-row">
            <span>Вибрано: {selected.length}</span>
            <button className="btn danger-ghost small" onClick={() => onDelete(selected)}>
              Видалити
            </button>
            <button className="btn-icon quiet" onClick={() => setSel(new Set())} title="Зняти виділення">
              <Icon name="x" />
            </button>
          </div>
          <div className="lib-sel-row">
            <button className="btn" onClick={() => onAdd(selected)}>
              На стіл
            </button>
            <button
              className="btn"
              disabled={downloading}
              onClick={() => onDownload(selected)}
              title={selected.length > 1 ? 'Скачати всі вибрані одним архівом, як є (формат можна змінити в режимі «Експорт»)' : 'Скачати файл'}
            >
              <Icon name="import" /> {downloading ? 'Пакую…' : selected.length > 1 ? 'Скачати .zip' : 'Скачати'}
            </button>
          </div>
        </div>
      )}
      {fileOver && <div className="drop-overlay">Відпусти, щоб додати в бібліотеку</div>}
    </aside>
  );
}
