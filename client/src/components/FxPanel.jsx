import { useEffect, useState } from 'react';
import { EFFECTS, GROUPS, PRESETS, defaults, presetEffects } from '../../../shared/fx.js';
import { setEffect } from '../fxClient.js';
import { Seg, Toggle } from './controls.jsx';
import { Icon } from './Icon.jsx';
import { fmtTime, clamp } from '../util.js';

const minus = (s) => s.replace('-', '−');
const trim = (s) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);

function shown(def, v) {
  if (def.unit === 'Гц' && Math.abs(v) >= 1000) return [minus(trim((v / 1000).toFixed(Math.abs(v) >= 10000 ? 1 : 2))), 'кГц'];
  const dec = def.step >= 1 ? 0 : def.step >= 0.1 ? 1 : 2;
  return [minus(trim(v.toFixed(dec))), def.unit || ''];
}

const toPos = (d, v) => (d.log ? Math.log(v / d.min) / Math.log(d.max / d.min) : (v - d.min) / (d.max - d.min));
function fromPos(d, t) {
  let v = d.log ? d.min * Math.pow(d.max / d.min, t) : d.min + t * (d.max - d.min);
  v = Math.round(v / d.step) * d.step;
  return clamp(+v.toFixed(4), d.min, d.max);
}

/** Number shown nicely (2.5 кГц); click to type an exact value in base units. */
function ValueBox({ def, value, onChange }) {
  const [edit, setEdit] = useState(null);
  const [txt, unit] = shown(def, value);
  if (edit != null)
    return (
      <span className="fx-val editing">
        <input
          autoFocus
          value={edit}
          onChange={(e) => setEdit(e.target.value)}
          onBlur={() => {
            const n = parseFloat(String(edit).replace(',', '.').replace('−', '-'));
            if (Number.isFinite(n)) onChange(clamp(n, def.min, def.max));
            setEdit(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setEdit(null);
          }}
        />
        <span className="fx-unit">{def.unit}</span>
      </span>
    );
  return (
    <button type="button" className="fx-val" onClick={() => setEdit(String(+value.toFixed(4)))} title="Клікни, щоб вписати точне значення">
      {txt}
      {unit && <span className="fx-unit">{unit}</span>}
    </button>
  );
}

function Param({ def, value, onChange }) {
  if (def.kind === 'select')
    return (
      <div className="fx-param">
        <span className="fx-label">{def.label}</span>
        <Seg small value={value} onChange={onChange} options={def.options} />
      </div>
    );
  if (def.kind === 'bool')
    return (
      <div className="fx-param bool">
        <Toggle checked={value} onChange={onChange}>
          {def.label}
        </Toggle>
      </div>
    );
  return (
    <div className="fx-param" title={def.hint}>
      <span className="fx-label">{def.label}</span>
      <input
        type="range"
        min="0"
        max="1000"
        step="1"
        value={Math.round(clamp(toPos(def, value), 0, 1) * 1000)}
        onChange={(e) => onChange(fromPos(def, e.target.value / 1000))}
        onDoubleClick={() => onChange(def.def)}
        aria-label={def.label}
      />
      <ValueBox def={def} value={value} onChange={onChange} />
    </div>
  );
}

function Editor({ def, p, onSet, onReset, onOff }) {
  const params = def.params.filter((q) => !q.when || q.when(p));
  return (
    <div className="fx-card">
      <div className="fx-card-head" title={def.hint}>
        <span className="fx-name">{def.label}</span>
        {def.params.length > 0 && (
          <button className="btn-icon quiet" onClick={onReset} title="Повернути стандартні налаштування">
            <Icon name="reset" size={14} />
          </button>
        )}
        <button className="btn-icon quiet" onClick={onOff} title="Вимкнути цей ефект">
          <Icon name="x" size={14} />
        </button>
      </div>
      {!params.length && <div className="fx-hint">{def.hint}</div>}
      {params.map((q) => (
        <Param key={q.k} def={q} value={p[q.k]} onChange={(v) => onSet({ [q.k]: v })} />
      ))}
    </div>
  );
}

const peakText = (p) => (p > 0 ? minus((20 * Math.log10(p)).toFixed(1)) + ' dB' : '−∞');

/**
 * Effects of one card. Everything switched on here is heard right away on the card — and the same
 * processed sound is what trim, split, merge, export and "Зберегти з ефектами" use.
 */
export default function FxPanel({ fx, onFx, sound, data, pending, error, onSave, busy, canSave, narrow = false, off = false, onToggle = null }) {
  const active = EFFECTS.filter((d) => fx.e[d.id]?.on);
  const [flash, setFlash] = useState(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(t);
  }, [flash]);

  const toggle = (id) => onFx(setEffect(fx, id, { on: !fx.e[id]?.on }));
  const set = (id, patch) => onFx(setEffect(fx, id, patch));
  const reset = (id) => onFx({ ...fx, e: { ...fx.e, [id]: { ...defaults(id), on: true } } });
  const preset = (pr) => {
    onFx({ ...fx, e: presetEffects(pr.id, fx.e) });
    setFlash(pr.id);
  };
  const allOff = () => onFx({ ...fx, e: Object.fromEntries(Object.entries(fx.e).map(([k, v]) => [k, { ...v, on: false }])) });

  const peak = data?.peaks?.peak ?? 0;
  const over = !pending && active.length > 0 && peak > 1.0001;
  const hasTail = active.some((d) => d.id === 'echo' || d.id === 'reverb');
  const lenChanged = sound.rawDuration != null && Math.abs(sound.duration - sound.rawDuration) > 0.0005;

  if (fx.min && !narrow)
    return (
      <div className="fx fx-min">
        <span className="fx-title">
          <Icon name="fx" size={14} /> Ефекти
        </span>
        <span className="fx-summary">{active.length ? active.map((d) => d.label).join(' · ') : 'нічого не увімкнено'}</span>
        {pending && <span className="fx-busy">Обробка…</span>}
        <button className="btn-link" onClick={() => onFx({ ...fx, min: false })}>
          Розгорнути
        </button>
      </div>
    );

  return (
    <div className={'fx' + (narrow ? ' narrow' : '') + (off ? ' off' : '')}>
      <div className="fx-top">
        <span className="fx-title">
          <Icon name="fx" size={14} /> Ефекти
        </span>
        <span className="fx-note">
          {active.length
            ? 'Чути одразу. Обрізка, відрізки, склейка й експорт цієї картки теж підуть з ними.'
            : 'Обери пресет або ефекти нижче — звук на картці зміниться одразу.'}
        </span>
        {pending && <span className="fx-busy">Обробка…</span>}
        {error && <span className="fx-error">Не вдалося: {error}</span>}
        {onToggle ? (
          <Toggle checked={!off} onChange={onToggle} title="Вимкни, щоб почути оригінал. Налаштування лишаються">
            {off ? 'вимкнено' : 'увімкнено'}
          </Toggle>
        ) : (
          <button className="btn-link fx-collapse" onClick={() => onFx({ ...fx, min: true })}>
            Згорнути
          </button>
        )}
      </div>

      <div className="fx-group">
        <span className="fx-group-title">Пресети</span>
        <div className="fx-chips">
          {PRESETS.map((pr) => (
            <button key={pr.id} className={'fx-chip preset' + (flash === pr.id ? ' flash' : '')} onClick={() => preset(pr)} title="Замінює увімкнені ефекти набором цього пресету">
              {pr.label}
            </button>
          ))}
        </div>
      </div>

      <div className="fx-catalog">
        {GROUPS.map(([g, label]) => (
          <div className="fx-group" key={g}>
            <span className="fx-group-title">{label}</span>
            <div className="fx-chips">
              {EFFECTS.filter((d) => d.group === g).map((d) => (
                <button key={d.id} className={'fx-chip' + (fx.e[d.id]?.on ? ' on' : '')} aria-pressed={!!fx.e[d.id]?.on} title={d.hint} onClick={() => toggle(d.id)}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {active.length > 0 && (
        <div className="fx-editors">
          {active.map((d) => (
            <Editor key={d.id} def={d} p={{ ...defaults(d.id), ...fx.e[d.id] }} onSet={(patch) => set(d.id, patch)} onReset={() => reset(d.id)} onOff={() => toggle(d.id)} />
          ))}
        </div>
      )}

      <div className="fx-foot">
        {hasTail && (
          <div className="fx-tail">
            <span className="num-label">Хвіст луни й реверберації</span>
            <Seg
              small
              value={fx.tail === 'cut' ? 'cut' : 'ring'}
              onChange={(v) => onFx({ ...fx, tail: v })}
              options={[
                ['ring', 'дозвучує', 'Трек стає довшим, щоб відлуння затихло природно'],
                ['cut', 'обрізати', 'Довжина як в оригіналу'],
              ]}
            />
          </div>
        )}
        <div className="fx-facts">
          {lenChanged && (
            <span>
              Довжина {fmtTime(sound.rawDuration)} → <b>{fmtTime(sound.duration)}</b>
            </span>
          )}
          {active.length > 0 && data && !pending && <span className={over ? 'fx-over' : ''}>Пік {peakText(peak)}{over ? ' — буде перевантаження' : ''}</span>}
          {over && (
            <button className="btn-link" onClick={() => set('gain', { on: true, norm: true, peak: -1 })}>
              Вирівняти пік до −1 dB
            </button>
          )}
        </div>
        <div className="fx-actions">
          <button className="btn ghost" disabled={!active.length} onClick={allOff}>
            Вимкнути всі
          </button>
          <button className="btn" disabled={!active.length || busy || !canSave} onClick={onSave} title="Зберегти весь трек з ефектами як новий звук у бібліотеці">
            <Icon name="fx" size={14} /> Зберегти з ефектами
          </button>
        </div>
      </div>
    </div>
  );
}
