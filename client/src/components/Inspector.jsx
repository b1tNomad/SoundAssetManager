import { useEffect, useMemo, useState } from 'react';
import { TrimPanel, SplitPanel, MergePanel, OGG_KBPS, MP3_KBPS } from './ToolPanel.jsx';
import FxPanel from './FxPanel.jsx';
import SeamPanel from './SeamPanel.jsx';
import { Seg, Toggle } from './controls.jsx';
import { Icon } from './Icon.jsx';
import { FRAME_TYPES, FRAME_LABEL, readingOrder } from '../../../shared/board.js';
import { effSoundOf, chainOf, tailOf, fxCount } from '../fxClient.js';
import { useCardAudio } from '../cardAudio.js';
import { frameTool, frameOf, folderOf, membersOf } from '../boardOps.js';
import { fmtTime } from '../util.js';

const TOOL_TAB = { split: 'Нарізка', trim: 'Обрізка', merge: 'Склейка', free: 'Картка' };

/**
 * Right panel: tools for whatever is selected on the board. Opens by itself when something is
 * selected; folded it's a narrow strip with shortcuts to its sections.
 */
export default function Inspector(props) {
  const { board, sel, open, onOpen, onClose } = props;
  const cards = sel.cards.filter((u) => board.cards.some((c) => c.uid === u));
  const frames = sel.frames.filter((f) => board.frames.some((x) => x.id === f));
  if (!open) return <InspectorRail {...props} cards={cards} frames={frames} />;
  let body;
  if (cards.length === 1 && !frames.length) body = <CardInspector {...props} uid={cards[0]} />;
  else if (frames.length === 1 && !cards.length) body = <FrameInspector {...props} fid={frames[0]} />;
  else if (cards.length + frames.length > 1) body = <MultiInspector {...props} cards={cards} frames={frames} />;
  else body = <BoardInspector {...props} />;
  return (
    <aside className="panel inspector">
      <button className="btn-icon side-toggle insp-close" onClick={onClose} title="Згорнути панель (вона сама відкриється, коли щось виділиш)">
        <Icon name="sideRight" />
      </button>
      <div className="insp-inner">{body}</div>
    </aside>
  );
}

const TOOL_ICON = { split: 'cut', trim: 'trim', merge: 'merge', free: 'card' };

function InspectorRail({ board, cards, frames, onOpen, setTab, onNewFrame }) {
  const go = (tab) => {
    if (tab) setTab(tab);
    onOpen();
  };
  let items;
  if (cards.length === 1 && !frames.length) {
    const card = board.cards.find((c) => c.uid === cards[0]);
    const type = frameOf(board, card)?.type || 'free';
    items = [
      ['tool', TOOL_ICON[type], TOOL_TAB[type]],
      ['fx', 'fx', 'Ефекти'],
    ];
    if (type === 'trim' || type === 'split') items.push(['seam', 'loop', 'Шов']);
  } else if (frames.length === 1 && !cards.length) items = [[null, 'frame', 'Фрейм: тип, папка, експорт']];
  else if (cards.length + frames.length > 1) items = [[null, 'layers', 'Вибране: вирівняти, фрейм, експорт']];
  else items = null;
  return (
    <aside className="rail right">
      <button className="rail-btn" onClick={() => go(null)} title="Розгорнути панель">
        <Icon name="sideRight" />
      </button>
      <div className="rail-sep" />
      {items
        ? items.map(([tab, icon, label]) => (
            <button key={label} className="rail-btn" onClick={() => go(tab)} title={label}>
              <Icon name={icon} />
            </button>
          ))
        : [
            ['split', 'cut', 'Новий фрейм «Нарізка»'],
            ['trim', 'trim', 'Новий фрейм «Обрізка»'],
            ['merge', 'merge', 'Новий фрейм «Склейка»'],
          ].map(([k, icon, label]) => (
            <button key={k} className={'rail-btn t-' + k} onClick={() => onNewFrame(k)} title={label}>
              <Icon name={icon} />
            </button>
          ))}
      {!items && (
        <button className="rail-btn" onClick={() => go(null)} title="Керування й гарячі клавіші">
          <Icon name="help" />
        </button>
      )}
    </aside>
  );
}

function useFrameTools(frame, onUpdateFrame) {
  const tools = { trim: frameTool(frame, 'trim'), split: frameTool(frame, 'split'), merge: frameTool(frame, 'merge') };
  const setTool = (k, patch) => frame && onUpdateFrame(frame.id, { tool: { ...(frame.tool || {}), [k]: { ...tools[k], ...patch } } }, { key: 'tool:' + frame.id });
  return [tools, setTool];
}

const saveNote = (frame) => (frame ? `Збережеться в папку «${folderOf(frame)}» і з’явиться картками в цьому фреймі.` : 'Збережеться в бібліотеку й з’явиться карткою під цією.');

// ---------- one card ----------
function CardInspector({ board, uid, soundsById, settings, setSettings, caps, busy, previews, toast, tab, setTab, onUpdateCard, onUpdateFrame, onRun, onPreview, onReorder, onSaveFx, onCardAction, onRenameSound, setSel, onClearFades, onWrap }) {
  const card = board.cards.find((c) => c.uid === uid);
  const sound = effSoundOf(soundsById[card.soundId], card);
  const frame = frameOf(board, card);
  const type = frame?.type || 'free';
  const [tools, setTool] = useFrameTools(frame, onUpdateFrame);
  const chain = useMemo(() => chainOf(card), [card.fx]);
  const audio = useCardAudio(uid, sound, chain, tailOf(card));
  const tabs = [['tool', TOOL_TAB[type]], ['fx', 'Ефекти' + (fxCount(card) ? ` · ${fxCount(card)}` : '')]];
  if (type === 'trim' || type === 'split') tabs.push(['seam', 'Шов']);
  const cur = tabs.some(([k]) => k === tab) ? tab : 'tool';
  const ctx = { frameId: frame?.id || null, sourceUid: uid };
  const withFolder = (req) => ({ ...req, output: { ...req.output, folder: folderOf(frame) } });
  const common = {
    settings,
    setSettings,
    caps,
    busy,
    previews,
    toast,
    tool: tools,
    setTool,
    onUpdateItem: onUpdateCard,
    onRun: (req) => onRun(withFolder(req), ctx),
    onPreview: (req) => onPreview(withFolder(req), ctx),
    note: saveNote(frame),
  };
  if (!sound) return null;

  const fades =
    type === 'trim'
      ? tools.trim.action === 'keep'
        ? { in: tools.trim.fadeIn, out: tools.trim.fadeOut, curve: tools.trim.curve }
        : null
      : type === 'split'
        ? { in: tools.split.fadeInOn ? tools.split.fadeIn : 0, out: tools.split.fadeOutOn ? tools.split.fadeOut : 0, curve: tools.split.curve }
        : null;
  const seamRegion = type === 'trim' ? card.trim : type === 'split' ? (card.split || []).find((r) => r.id === card.selRegion) : null;
  const applySeam = (a, b) => {
    if (type === 'trim') onUpdateCard(uid, { trim: { start: a, end: b } });
    else if (seamRegion) onUpdateCard(uid, { split: (card.split || []).map((r) => (r.id === seamRegion.id ? { ...r, start: a, end: b } : r)) });
  };

  return (
    <>
      <div className="insp-head">
        <EditableName value={soundsById[card.soundId].name} onChange={(v) => onRenameSound(card.soundId, v)} />
        <div className="insp-meta">
          <span>{fmtTime(sound.duration)}</span>
          {sound.fx && <span className="fx-badge">✦ з ефектами</span>}
          {frame ? (
            <button className={'frame-chip t-' + frame.type} onClick={() => setSel({ cards: [], frames: [frame.id] })} title="Вибрати фрейм">
              {frame.name} · {FRAME_LABEL[frame.type]}
            </button>
          ) : (
            <span className="frame-chip t-free">поза фреймом</span>
          )}
        </div>
      </div>
      <div className="insp-tabs">
        <Seg value={cur} onChange={setTab} options={tabs} />
      </div>
      <div className="panel-body">
        {cur === 'tool' && type === 'split' && <SplitPanel {...common} active={{ item: card, sound }} />}
        {cur === 'tool' && type === 'trim' && <TrimPanel {...common} active={{ item: card, sound }} />}
        {cur === 'tool' && type === 'merge' && (
          <MergePanel
            {...common}
            onRun={(req) => onRun(withFolder(req), { frameId: frame.id })}
            onPreview={(req) => onPreview(withFolder(req), { frameId: frame.id })}
            targets={readingOrder(membersOf(board, frame.id).filter((c) => c.inMerge !== false)).map((c) => ({ item: c, sound: effSoundOf(soundsById[c.soundId], c) }))}
            onReorderTargets={onReorder}
          />
        )}
        {cur === 'tool' && type === 'free' && (
          <div className="free-card">
            <p className="hint-block">
              Тут можна слухати, лупити, накладати ефекти й робити дублі. Щоб різати, обрізати чи склеювати — переклади картку у фрейм потрібного типу або створи його:
            </p>
            <div className="free-actions">
              {FRAME_TYPES.filter(([k]) => k !== 'free').map(([k, l]) => (
                <button key={k} className={'btn kind-btn t-' + k} onClick={() => onWrap([uid], k)}>
                  Фрейм «{l}» з нею
                </button>
              ))}
            </div>
          </div>
        )}
        {cur === 'fx' && (
          <FxPanel
            narrow
            fx={card.fx || { on: true, tail: 'ring', e: {} }}
            onFx={(fx) => onUpdateCard(uid, { fx: { ...fx, on: true } }, { key: 'fx:' + uid })}
            sound={sound}
            data={audio.processed ? audio.view : null}
            pending={audio.pending}
            error={audio.fxError}
            onSave={() => onSaveFx(uid)}
            busy={busy}
            canSave={caps.found}
            off={!card.fx?.on}
            onToggle={(on) => onUpdateCard(uid, { fx: { ...(card.fx || { tail: 'ring', e: {} }), on } })}
          />
        )}
        {cur === 'seam' &&
          (!card.seam ? (
            <div className="seam-off">
              <p className="hint-block">«Шов» допомагає зробити безшовний луп: показує, де кінець зійдеться з початком.</p>
              <button className="btn" onClick={() => onUpdateCard(uid, { seam: true, loop: true })}>
                Увімкнути шов
              </button>
            </div>
          ) : seamRegion && audio.view ? (
            <SeamPanel data={audio.view} region={seamRegion} fit={card.seamFit || 'end'} setFit={(f) => onUpdateCard(uid, { seamFit: f })} onApply={applySeam} fades={fades} onClearFades={() => onClearFades(frame)} />
          ) : (
            <p className="hint-block">{type === 'trim' ? 'Виділи шматок на хвилі — тут з’явиться його шов.' : 'Клікни відрізок на хвилі, щоб перевірити його шов.'}</p>
          ))}
      </div>
      <div className="insp-foot">
        <button className="btn ghost" onClick={() => onCardAction(uid, 'dup')} title="Копія з відрізками, виділенням, ефектами (⌘D)">
          Дубль
        </button>
        <button className="btn ghost" onClick={() => onCardAction(uid, 'dup-clean')} title="Той самий звук без змін">
          Чистий дубль
        </button>
        <button className="btn ghost" onClick={() => onCardAction(uid, 'reveal')} title="Показати файл у Finder">
          <Icon name="folder" />
        </button>
        <button className="btn ghost" onClick={() => onCardAction(uid, 'download')} title="Скачати (з ефектами, якщо увімкнені)">
          <Icon name="import" />
        </button>
        <button className="btn ghost danger-text" onClick={() => onCardAction(uid, 'remove')} title="Прибрати з дошки (Delete). Файл лишиться в бібліотеці">
          <Icon name="x" />
        </button>
      </div>
    </>
  );
}

function EditableName({ value, onChange, placeholder }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className="insp-name"
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setV(value);
          setTimeout(() => e.target.blur());
        }
      }}
      onBlur={() => {
        const t = v.trim();
        if (t && t !== value) onChange(t);
        else setV(value);
      }}
      title="Клікни, щоб перейменувати"
    />
  );
}

// ---------- export block (frame / selection) ----------
function ExportBlock({ targets, title, dir, setDir, defaultDir, settings, setSettings, caps, busy, downloading, onExport, onDownload, onReveal, lastExport }) {
  const fmt = settings.exportFormat;
  const q = fmt === 'ogg' ? settings.oggQuality : settings.mp3Quality;
  const n = targets.length;
  return (
    <div className="group">
      <div className="group-title">{title}</div>
      <div className="row">
        <span className="num-label">Формат</span>
        <Seg
          small
          value={fmt}
          onChange={(v) => setSettings({ exportFormat: v })}
          options={[
            ['ogg', 'ogg'],
            ['mp3', 'mp3'],
            ['wav', 'wav'],
          ]}
        />
      </div>
      {fmt !== 'wav' && !(fmt === 'ogg' && caps.ogg === 'vorbis') && (
        <label className="range">
          <span className="num-label">
            Якість {fmt === 'ogg' ? q : `V${q}`} <span className="muted">≈ {(fmt === 'ogg' ? OGG_KBPS : MP3_KBPS)[q]} kbps</span>
          </span>
          <input
            type="range"
            min="0"
            max={fmt === 'ogg' ? 10 : 9}
            step="1"
            value={fmt === 'ogg' ? q : 9 - q}
            onChange={(e) => (fmt === 'ogg' ? setSettings({ oggQuality: +e.target.value }) : setSettings({ mp3Quality: 9 - +e.target.value }))}
          />
        </label>
      )}
      {setDir && (
        <label className="field">
          <span className="num-label">Папка (наприклад, звуки гри)</span>
          <input type="text" value={dir || ''} placeholder={defaultDir} onChange={(e) => setDir(e.target.value)} spellCheck={false} />
        </label>
      )}
      <Toggle checked={settings.overwrite} onChange={(v) => setSettings({ overwrite: v })}>
        Перезаписувати файли з такою ж назвою
      </Toggle>
      <div className="actions col">
        <button className="btn primary wide" disabled={!n || busy || !caps.found} onClick={() => onExport(targets, dir || defaultDir)}>
          {busy ? 'Експорт…' : `Експортувати ${n} в ${fmt}`}
        </button>
        <button className="btn wide" disabled={!n || downloading || !caps.found} onClick={() => onDownload(targets)} title="Браузер збереже у «Завантаження»">
          <Icon name="import" /> {downloading ? 'Пакую…' : n > 1 ? `Скачати ${n} архівом .zip` : `Скачати файл .${fmt}`}
        </button>
        <button className="btn ghost" onClick={() => onReveal({ path: dir || defaultDir })}>
          <Icon name="folder" /> Відкрити папку експорту
        </button>
      </div>
      {lastExport && <p className="hint">Останній експорт: {lastExport.files.length} файл(и) → {lastExport.dir}</p>}
    </div>
  );
}

// ---------- one frame ----------
function FrameInspector(props) {
  const { board, fid, soundsById, settings, onUpdateFrame, onRenameFrame, onRun, onPreview, onReorder, onReveal, onDeleteFrames, paths } = props;
  const frame = board.frames.find((f) => f.id === fid);
  const [tools, setTool] = useFrameTools(frame, onUpdateFrame);
  const members = readingOrder(membersOf(board, fid));
  const targets = members.map((c) => ({ item: c, sound: effSoundOf(soundsById[c.soundId], c) })).filter((x) => x.sound);
  const folder = folderOf(frame);
  const withFolder = (req) => ({ ...req, output: { ...req.output, folder } });
  const defaultDir = `${paths.exports || 'data/exports'}/${folder || 'export'}`;
  return (
    <>
      <div className="insp-head">
        <EditableName value={frame.name} onChange={(v) => onRenameFrame(fid, v)} />
        <div className="insp-meta">
          <span>{members.length} карт.</span>
          <span className={'frame-chip t-' + frame.type}>{FRAME_LABEL[frame.type]}</span>
        </div>
      </div>
      <div className="panel-body">
        <div className="group first">
          <div className="group-title">Тип фрейму — що можна робити з картками всередині</div>
          <Seg value={frame.type} onChange={(v) => onUpdateFrame(fid, { type: v })} options={FRAME_TYPES} />
          <div className="folder-row">
            <Icon name="folder" />
            <span className="folder-path" title="Сюди лягають файли, збережені в цьому фреймі">
              бібліотека / {folder || '—'}
            </span>
            <button className="btn-link" onClick={() => onReveal({ folder })}>
              Показати у Finder
            </button>
          </div>
        </div>
        {frame.type === 'merge' && (
          <MergePanel
            {...props}
            tool={tools}
            setTool={setTool}
            note={saveNote(frame)}
            onRun={(req) => onRun(withFolder(req), { frameId: fid })}
            onPreview={(req) => onPreview(withFolder(req), { frameId: fid })}
            targets={targets.filter((x) => x.item.inMerge !== false)}
            onReorderTargets={onReorder}
          />
        )}
        {(frame.type === 'split' || frame.type === 'trim') && (
          <p className="hint-block">Клікни картку в цьому фреймі, щоб {frame.type === 'split' ? 'нарізати її на відрізки' : 'обрізати її'}. Результати з’являться тут же, а файли — у папці фрейму.</p>
        )}
        <ExportBlock
          {...props}
          title={`Експорт фрейму (${targets.length})`}
          targets={targets.map((x) => x.sound)}
          dir={frame.exportDir}
          setDir={(v) => onUpdateFrame(fid, { exportDir: v }, { key: 'dir:' + fid })}
          defaultDir={defaultDir}
        />
        <div className="group">
          <div className="row">
            <button className="btn ghost" onClick={() => onDeleteFrames([fid], false)} title="Фрейм зникне, картки лишаться на дошці">
              Прибрати фрейм
            </button>
            <button className="btn ghost danger-text" onClick={() => onDeleteFrames([fid], true)} title="Разом з картками (файли лишаться в бібліотеці)">
              Разом з картками
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------- several things ----------
function MultiInspector(props) {
  const { board, cards, frames, soundsById, onArrange, onWrap, onDuplicate, onRemoveCards, onDeleteFrames, paths } = props;
  const [kind, setKind] = useState('split');
  const inFrames = board.cards.filter((c) => frames.includes(c.frameId)).map((c) => c.uid);
  const all = [...new Set([...cards, ...inFrames])];
  const targets = readingOrder(board.cards.filter((c) => all.includes(c.uid))).map((c) => effSoundOf(soundsById[c.soundId], c)).filter(Boolean);
  return (
    <>
      <div className="insp-head">
        <div className="insp-title">
          Вибрано: {cards.length ? `${cards.length} карт.` : ''} {frames.length ? `${frames.length} фрейм.` : ''}
        </div>
      </div>
      <div className="panel-body">
        {cards.length > 1 && (
          <div className="group first">
            <div className="group-title">Вирівняти</div>
            <div className="row">
              <button className="btn" onClick={() => onArrange(cards, 'row')}>
                Рядком
              </button>
              <button className="btn" onClick={() => onArrange(cards, 'col')}>
                Стовпцем
              </button>
              <button className="btn" onClick={() => onArrange(cards, 'grid')}>
                Сіткою
              </button>
            </div>
          </div>
        )}
        {cards.length > 0 && (
          <div className="group">
            <div className="group-title">Обгорнути у фрейм</div>
            <Seg small value={kind} onChange={setKind} options={FRAME_TYPES} />
            <button className="btn" onClick={() => onWrap(cards, kind)}>
              <Icon name="frame" /> Створити фрейм «{FRAME_LABEL[kind]}»
            </button>
          </div>
        )}
        <ExportBlock {...props} title={`Експорт вибраного (${targets.length})`} targets={targets} dir={null} setDir={null} defaultDir={paths.exports} />
        <div className="group">
          <div className="row">
            {cards.length > 0 && (
              <button className="btn ghost" onClick={() => onDuplicate(cards, false)}>
                Дубль
              </button>
            )}
            {cards.length > 0 && (
              <button className="btn ghost danger-text" onClick={() => onRemoveCards(cards)}>
                Прибрати з дошки
              </button>
            )}
            {frames.length > 0 && (
              <button className="btn ghost" onClick={() => onDeleteFrames(frames, false)}>
                Прибрати фрейми
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ---------- nothing selected ----------
function BoardInspector({ board, onNewFrame }) {
  return (
    <>
      <div className="insp-head">
        <div className="insp-title">{board.name}</div>
        <div className="insp-meta">
          <span>{board.cards.length} карт.</span>
          <span>{board.frames.length} фрейм.</span>
        </div>
      </div>
      <div className="panel-body">
        <div className="group first">
          <div className="group-title">Новий фрейм</div>
          <p className="hint">Фрейм — це папка і набір інструментів: у «Нарізці» ріжеш на відрізки, в «Обрізці» обрізаєш, у «Склейці» склеюєш. Збережене всередині лягає в його папку.</p>
          <div className="free-actions">
            {FRAME_TYPES.map(([k, l]) => (
              <button key={k} className={'btn kind-btn t-' + k} onClick={() => onNewFrame(k)}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="group">
          <div className="group-title">Керування</div>
          <dl className="keys">
            <dt>Два пальці / колесо</dt>
            <dd>рухати дошку</dd>
            <dt>Щипок, ⌘ + колесо</dt>
            <dd>масштаб</dd>
            <dt>Alt + колесо на хвилі</dt>
            <dd>масштаб хвилі</dd>
            <dt>Тягнути шапку картки</dt>
            <dd>перемістити (з Alt — дубль)</dd>
            <dt>Протягнути по порожньому</dt>
            <dd>виділити рамкою</dd>
            <dt>
              <kbd>F</kbd> <kbd>V</kbd> <kbd>H</kbd>
            </dt>
            <dd>фрейм, вибір, рука</dd>
            <dt>
              <kbd>Пробіл</kbd>
            </dt>
            <dd>грати / стоп вибрану картку</dd>
            <dt>
              <kbd>⌘D</kbd>
            </dt>
            <dd>дубль з усіма змінами</dd>
            <dt>
              <kbd>⌘Z</kbd> <kbd>⇧⌘Z</kbd>
            </dt>
            <dd>скасувати / повторити</dd>
            <dt>
              <kbd>⇧1</kbd> <kbd>⇧2</kbd>
            </dt>
            <dd>показати все / вибране</dd>
            <dt>
              <kbd>Delete</kbd>
            </dt>
            <dd>прибрати з дошки (файл лишається)</dd>
            <dt>
              <kbd>L</kbd> <kbd>S</kbd> <kbd>Enter</kbd>
            </dt>
            <dd>луп, розрізати, грати виділене</dd>
          </dl>
        </div>
      </div>
    </>
  );
}
