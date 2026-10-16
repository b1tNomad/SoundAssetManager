import { useRef, useState } from 'react';
import { DND_SOUNDS, DND_CARD } from '../util.js';
import { Icon } from './Icon.jsx';

const accepts = (e) => {
  const t = [...e.dataTransfer.types];
  return t.includes(DND_SOUNDS) || t.includes(DND_CARD);
};

export default function DeskTabs({ desks, activeId, onSelect, onAdd, onRename, onClose, onDropTo }) {
  const [editing, setEditing] = useState(null);
  const [over, setOver] = useState(null);
  const timer = useRef(null);

  const leave = () => {
    clearTimeout(timer.current);
    timer.current = null;
    setOver(null);
  };

  return (
    <nav className="tabs">
      {desks.map((d) => (
        <div
          key={d.id}
          className={'tab' + (d.id === activeId ? ' on' : '') + (over === d.id ? ' over' : '')}
          onClick={() => onSelect(d.id)}
          onDoubleClick={() => setEditing(d.id)}
          title="Подвійний клік — перейменувати. Кинь сюди звук, щоб додати на цей стіл."
          onDragOver={(e) => {
            if (!accepts(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            if (over !== d.id) {
              setOver(d.id);
              clearTimeout(timer.current);
              // Hovering a tab for a moment opens it, so you can drop at an exact spot.
              if (d.id !== activeId) timer.current = setTimeout(() => onSelect(d.id), 700);
            }
          }}
          onDragLeave={leave}
          onDrop={(e) => {
            e.preventDefault();
            leave();
            onDropTo(d.id, e.dataTransfer);
          }}
        >
          {editing === d.id ? (
            <input
              className="tab-edit"
              autoFocus
              defaultValue={d.name}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  e.currentTarget.value = d.name;
                  e.currentTarget.blur();
                }
              }}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                if (v) onRename(d.id, v);
                setEditing(null);
              }}
            />
          ) : (
            <span className="tab-name">{d.name}</span>
          )}
          <span className="tab-count">{d.items.length}</span>
          {desks.length > 1 && (
            <button
              className="tab-x"
              title="Закрити стіл"
              onClick={(e) => {
                e.stopPropagation();
                onClose(d.id);
              }}
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      ))}
      <button className="tab-add" onClick={onAdd} title="Новий стіл">
        <Icon name="plus" />
      </button>
    </nav>
  );
}
