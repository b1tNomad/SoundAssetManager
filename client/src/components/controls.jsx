import { useEffect, useState } from 'react';

/** Number input that lets you type freely and commits parsed values. */
export function NumField({ label, value, onChange, step = 0.01, min = 0, max, suffix = 'с', width, disabled, title }) {
  const [text, setText] = useState(fmt(value));
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setText(fmt(value));
  }, [value, focus]);
  const commit = (s) => {
    const n = parseFloat(String(s).replace(',', '.'));
    if (!Number.isFinite(n)) return;
    let v = n;
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    onChange(v);
  };
  return (
    <label className={'num' + (disabled ? ' disabled' : '')} title={title}>
      {label && <span className="num-label">{label}</span>}
      <span className="num-box" style={width ? { width } : null}>
        <input
          type="text"
          inputMode="decimal"
          value={text}
          disabled={disabled}
          onFocus={() => setFocus(true)}
          onBlur={() => {
            setFocus(false);
            commit(text);
          }}
          onChange={(e) => {
            setText(e.target.value);
            commit(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const cur = parseFloat(String(text).replace(',', '.')) || 0;
              const mult = e.shiftKey ? 10 : 1;
              let v = +(cur + (e.key === 'ArrowUp' ? step : -step) * mult).toFixed(6);
              if (min != null) v = Math.max(min, v);
              if (max != null) v = Math.min(max, v);
              setText(fmt(v));
              onChange(v);
            }
          }}
        />
        {suffix && <span className="num-suffix">{suffix}</span>}
      </span>
    </label>
  );
}

function fmt(v) {
  if (v == null || !Number.isFinite(v)) return '';
  return String(+Number(v).toFixed(3));
}

export function Seg({ value, options, onChange, small }) {
  return (
    <div className={'seg' + (small ? ' small' : '')} role="radiogroup">
      {options.map(([k, label, title]) => (
        <button key={k} role="radio" aria-checked={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)} title={title}>
          {label}
        </button>
      ))}
    </div>
  );
}

export const CURVES = [
  ['tri', 'Лінійне'],
  ['qsin', 'Плавне'],
  ['log', 'Логарифмічне'],
  ['exp', 'Експоненційне'],
];

export function CurveSelect({ value, onChange, label = 'Крива' }) {
  return (
    <label className="selectbox">
      <span className="num-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {CURVES.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Toggle({ checked, onChange, children, title }) {
  return (
    <label className="toggle" title={title}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}
