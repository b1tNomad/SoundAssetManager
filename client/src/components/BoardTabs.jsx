import { useRef, useState } from 'react';
import { DND_SOUNDS } from '../util.js';
import { Icon } from './Icon.jsx';

/** Boards as tabs. Drop sounds on a tab to put them on that board; drag cards onto a tab to copy them there. */
export default function BoardTabs({ boards, activeId, hoverId, onSelect, onAdd, onRename, onClose, onDropSounds }) {
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
      {boards.map((d) => (
        <div
          key={d.id}
          data-board-tab={d.id}
          className={'tab' + (d.id === activeId ? ' on' : '') + (over === d.id || hoverId === d.id ? ' over' : '')}
          onClick={() => onSelect(d.id)}
          onDoubleClick={() => setEditing(d.id)}
          title="Подвійний клік — перейменувати. Перетягни сюди картки чи звуки, щоб скопіювати на цю дошку."
          onDragOver={(e) => {
            if (![...e.dataTransfer.types].includes(DND_SOUNDS)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            if (over !== d.id) {
              setOver(d.id);
              clearTimeout(timer.current);
              if (d.id !== activeId) timer.current = setTimeout(() => onSelect(d.id), 700);
            }
          }}
          onDragLeave={leave}
          onDrop={(e) => {
            e.preventDefault();
            leave();
            onDropSounds(d.id, JSON.parse(e.dataTransfer.getData(DND_SOUNDS) || '[]'));
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
          <span className="tab-count">{d.cards.length}</span>
          {boards.length > 1 && (
            <button
              className="tab-x"
              title="Закрити дошку"
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
      <button className="tab-add" onClick={onAdd} title="Нова дошка">
        <Icon name="plus" />
      </button>
    </nav>
  );
}
