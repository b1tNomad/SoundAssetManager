import { useEffect, useMemo, useRef, useState } from 'react';
import { analysis, seamCost, verdict, findBest } from '../seam.js';
import { fadeGain } from '../audio.js';
import { Seg } from './controls.jsx';

const W = 300;
const H = 76;
const SPANS = [
  [0.01, '10 мс'],
  [0.04, '40 мс'],
  [0.15, '150 мс'],
];

function clickWord(c) {
  if (c < 1.2) return ['плавний', 'good'];
  if (c < 2) return ['помітний', 'ok'];
  return ['клацне', 'bad'];
}
const dbWord = (v, lim1, lim2) => (Math.abs(v) < lim1 ? 'good' : Math.abs(v) < lim2 ? 'ok' : 'bad');
const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);

/**
 * The loop seam up close: the end of the region (amber) followed by its start (cyan), exactly as
 * it plays when looping. The faint line after the seam is what would naturally have followed the end.
 */
export default function SeamPanel({ data, region, fit, setFit, onApply, fades, onClearFades }) {
  const A = useMemo(() => analysis(data.buffer), [data]);
  const [span, setSpan] = useState(0.04);
  const [note, setNote] = useState(null);
  const applied = useRef(null); // region we set ourselves, so its note isn't cleared right away
  const ref = useRef(null);
  const sr = A.sr;
  const s = Math.round(region.start * sr);
  const e = Math.round(region.end * sr);
  const r = seamCost(A, e, s);
  const v = verdict(r);
  const fi = fades?.in || 0;
  const fo = fades?.out || 0;
  const fadesOn = fi > 0 || fo > 0;



  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr;
    cv.height = H * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const N = Math.max(8, Math.round(span * sr));
    const len = region.end - region.start;
    // What actually plays, including fades if they're on (that's what makes a loop "pump").
    const gainEnd = (k) => (fo > 0 ? fadeGain(fades.curve, Math.min(1, (k + 1) / (fo * sr))) : 1); // k samples before the end
    const gainStart = (k) => (fi > 0 ? fadeGain(fades.curve, Math.min(1, k / (fi * sr))) : 1);
    const left = new Float32Array(N);
    const right = new Float32Array(N);
    const ghost = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const i = e - N + k;
      left[k] = i >= 0 && i < A.n && e - i <= len * sr ? A.mono[i] * gainEnd(N - 1 - k) : NaN;
      const j = s + k;
      right[k] = j < A.n && k <= len * sr ? A.mono[j] * gainStart(k) : NaN;
      const q = e + k;
      ghost[k] = q < A.n ? A.mono[q] : NaN;
    }
    let peak = 1e-6;
    for (const arr of [left, right, ghost]) for (const x of arr) if (x === x && Math.abs(x) > peak) peak = Math.abs(x);
    const mid = H / 2;
    const amp = (H / 2 - 4) / peak;
    const half = W / 2;

    g.fillStyle = '#15181d';
    g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(232,227,216,0.08)';
    g.fillRect(0, mid, W, 1);

    const plot = (arr, x0, color, dash) => {
      g.save();
      g.strokeStyle = color;
      g.lineWidth = 1.25;
      if (dash) g.setLineDash(dash);
      const perPx = N / half;
      g.beginPath();
      if (perPx <= 2) {
        let started = false;
        for (let k = 0; k < N; k++) {
          const x = arr[k];
          if (x !== x) {
            started = false;
            continue;
          }
          const px = x0 + (k / (N - 1)) * half;
          const py = mid - x * amp;
          if (!started) g.moveTo(px, py);
          else g.lineTo(px, py);
          started = true;
        }
        g.stroke();
      } else {
        // dense: min/max per pixel column
        for (let px = 0; px < half; px++) {
          const k0 = Math.floor(px * perPx);
          const k1 = Math.min(N, Math.floor((px + 1) * perPx));
          let lo = Infinity;
          let hi = -Infinity;
          for (let k = k0; k < k1; k++) {
            const x = arr[k];
            if (x !== x) continue;
            if (x < lo) lo = x;
            if (x > hi) hi = x;
          }
          if (hi < lo) continue;
          g.moveTo(x0 + px + 0.5, mid - hi * amp);
          g.lineTo(x0 + px + 0.5, mid - lo * amp + 1);
        }
        g.stroke();
      }
      g.restore();
    };
    plot(ghost, half, 'rgba(232,227,216,0.28)', [3, 3]);
    plot(left, 0, '#edb04a');
    plot(right, half, '#5bc6d3');
    g.fillStyle = '#fff';
    g.fillRect(half - 0.5, 0, 1, H);
  }, [A, s, e, span, fi, fo, fades?.curve, region.start, region.end]);

  const fmtShift = (d) =>
    Math.abs(d) >= 1 ? `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(2)} с` : `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.round(Math.abs(d) * 1000)} мс`;

  const search = (which) => {
    const fixed = which === 'end' ? region.start : region.end;
    const around = which === 'end' ? region.end : region.start;
    const near = findBest(A, which, fixed, around, 0.3);
    const mid = near && verdict(near.r) === 'good' ? near : findBest(A, which, fixed, around, 1);
    const far = mid && verdict(mid.r) === 'good' ? mid : findBest(A, which, fixed, around, 3);
    return { around, near, mid, far };
  };
  const move = (which, pos) => {
    applied.current = which === 'end' ? { start: region.start, end: pos } : { start: pos, end: region.end };
    if (which === 'end') onApply(region.start, pos);
    else onApply(pos, region.end);
  };

  // Moving the region by hand makes an old note stale.
  useEffect(() => {
    const a = applied.current;
    if (a && Math.abs(a.start - region.start) < 1e-6 && Math.abs(a.end - region.end) < 1e-6) return;
    setNote(null);
  }, [region.start, region.end]);

  // Looks close first and widens the search; never jumps far on its own — offers it instead.
  const apply = (which) => {
    const { around, near, mid, far } = search(which);
    if (!mid) return setNote({ text: 'Відрізок закороткий для підбору' });
    const pick = verdict(near?.r || mid.r) === 'good' ? near : mid;
    move(which, pick.pos);
    setFit(which);
    const who = which === 'end' ? 'Кінець' : 'Початок';
    const d = pick.pos - around;
    const actions = [];
    let text;
    if (Math.abs(d) < 0.0005) text = verdict(pick.r) === 'good' ? 'Це вже найкраща точка — шов чистий' : 'Ближче кращої точки немає.';
    else text = `${who} зсунуто на ${fmtShift(d)}` + (verdict(pick.r) === 'good' ? ' — шов чистий' : ' — це найкраще в межах ±1 с, але ще не ідеально.');
    if (verdict(pick.r) !== 'good') {
      if (far && verdict(far.r) === 'good' && Math.abs(far.pos - pick.pos) > 0.0005)
        actions.push({ label: `Чиста точка є на ${fmtShift(far.pos - around)} — перейти`, run: () => (move(which, far.pos), setNote({ text: `${who} зсунуто на ${fmtShift(far.pos - around)} — шов чистий` })) });
      const other = which === 'end' ? 'start' : 'end';
      const o = search(other).mid;
      if (o && verdict(o.r) === 'good') {
        const oa = other === 'end' ? region.end : region.start;
        actions.push({
          label: `Або підібрати ${other === 'end' ? 'кінець' : 'початок'} (${fmtShift(o.pos - oa)}) — там чисто`,
          run: () => {
            move(other, o.pos);
            setFit(other);
            setNote({ text: `${other === 'end' ? 'Кінець' : 'Початок'} зсунуто на ${fmtShift(o.pos - oa)} — шов чистий` });
          },
        });
      }
    }
    setNote({ text, actions });
  };

  const [cw, cv] = clickWord(r.click);
  const title =
    v === 'good' ? 'Шов чистий' : v === 'ok' ? 'Майже — можна точніше' : cv === 'bad' ? 'На шві буде клацання' : 'На шві стрибок гучності чи тембру';

  return (
    <div className="seam">
      <div className="seam-view">
        <canvas ref={ref} style={{ width: W, height: H }} />
        <div className="seam-axis">
          <span>кінець</span>
          <span>початок</span>
        </div>
        <Seg small value={span} onChange={setSpan} options={SPANS.map(([k, l]) => [k, l])} />
      </div>
      <div className="seam-info">
        <div className={'seam-verdict ' + v}>{title}</div>
        <div className="seam-stats">
          <span className={cv} title="Чи плавно хвиля переходить з кінця на початок. Різкий злам — клацання.">
            Стик: {cw}
          </span>
          <span className={dbWord(r.level, 1, 1.5)} title="Гучність перед кінцем проти гучності після початку (найбільша різниця на 50, 150 і 300 мс). Різниця дає «пум» на кожному колі.">
            Гучність: {signed(r.level)} dB
          </span>
          <span className={dbWord(r.bright, 1.5, 3)} title="Скільки високих частот у кінці проти початку (150 мс). Різниця чутна як зміна тембру.">
            Тембр: {signed(r.bright)} dB
          </span>
        </div>
        <div className="row">
          <button className="btn" onClick={() => apply('end')} title="Знайти найкращу точку кінця в межах ±0.3 с">
            Підібрати кінець
          </button>
          <button className="btn" onClick={() => apply('start')} title="Знайти найкращу точку початку в межах ±0.3 с">
            Підібрати початок
          </button>
        </div>
        <div className="row seam-fit">
          <span className="num-label">Підганяю</span>
          <Seg
            small
            value={fit}
            onChange={setFit}
            options={[
              ['end', 'кінець', 'Початок стоїть, підганяєш кінець'],
              ['start', 'початок', 'Кінець стоїть, підганяєш початок'],
            ]}
          />
        </div>
        <p className="seam-how">
          {fit === 'end' ? (
            <>
              Пунктир на хвилі — рівень <b className="c-start">початку</b>. Став <b className="c-end">кінець</b> туди, де хвиля сягає пунктиру, а смужка під нею зелена.
            </>
          ) : (
            <>
              Пунктир на хвилі — рівень <b className="c-end">кінця</b>. Став <b className="c-start">початок</b> туди, де хвиля сягає пунктиру, а смужка під нею зелена.
            </>
          )}
        </p>
        <div className="seam-legend">
          <i className="good" /> зійдеться <i className="ok" /> майже <i className="bad" /> буде зрив
        </div>
        {note && (
          <div className="seam-note">
            {note.text}
            {note.actions?.map((a) => (
              <button key={a.label} className="btn-link" onClick={a.run}>
                {a.label}
              </button>
            ))}
          </div>
        )}
        {fadesOn && (
          <div className="seam-warn">
            Увімкнене затухання ({fi > 0 ? `${fi} с на початку` : ''}
            {fi > 0 && fo > 0 ? ', ' : ''}
            {fo > 0 ? `${fo} с в кінці` : ''}). У лупі воно дає провал гучності на кожному колі.{' '}
            <button className="btn-link" onClick={onClearFades}>
              Вимкнути затухання
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
