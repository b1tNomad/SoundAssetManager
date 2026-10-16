// Sound effects engine. The same code runs in the browser (what you hear on a card) and on the
// server (what gets saved), so a saved file sounds exactly like the preview.
// Everything is deterministic: "random" noise comes from fixed seeds.
//
// A track's effects are applied to the whole track first, in a fixed order (like a pedalboard);
// trimming, splitting, merging and export then work on the processed track.

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dbGain = (db) => Math.pow(10, db / 20);
const linMix = (m) => [1 - m, m];
const powMix = (m) => [Math.cos((m * Math.PI) / 2), Math.sin((m * Math.PI) / 2)];

// ---------- catalog ----------
const P = (k, label, def, min, max, o = {}) => ({ k, label, def, min, max, step: 0.01, ...o });
const S = (k, label, def, options, o = {}) => ({ k, label, def, kind: 'select', options, ...o });
const B = (k, label, def, o = {}) => ({ k, label, def, kind: 'bool', ...o });
const MIX = (def) => P('mix', 'Мікс', def, 0, 100, { unit: '%', step: 1, hint: 'Скільки обробленого звуку проти чистого' });
const HZ = { unit: 'Гц', log: true, step: 1 };
const MS = { unit: 'мс', step: 1 };

export const GROUPS = [
  ['pitch', 'Тон і швидкість'],
  ['dist', 'Спотворення й характер'],
  ['filter', 'Фільтри й тембр'],
  ['mod', 'Модуляція'],
  ['space', 'Простір'],
  ['dyn', 'Гучність і стерео'],
];

/** In processing order. */
export const EFFECTS = [
  { id: 'reverse', group: 'pitch', label: 'Задом наперед', hint: 'Програє звук з кінця на початок', params: [] },
  {
    id: 'speed',
    group: 'pitch',
    label: 'Швидкість (як плівка)',
    hint: 'Тон і довжина змінюються разом, як на прискореній чи сповільненій плівці',
    params: [P('rate', 'Швидкість', 100, 25, 400, { unit: '%', log: true, step: 1 })],
  },
  {
    id: 'tempo',
    group: 'pitch',
    label: 'Темп',
    hint: 'Швидше чи повільніше без зміни тону. Довжина звуку змінюється',
    params: [P('rate', 'Темп', 100, 25, 400, { unit: '%', log: true, step: 1 })],
  },
  {
    id: 'pitch',
    group: 'pitch',
    label: 'Тон вище / нижче',
    hint: 'Вище чи нижче без зміни довжини',
    params: [P('semi', 'Тон', 0, -24, 24, { unit: 'півт.', step: 0.5 }), P('cents', 'Точно', 0, -100, 100, { unit: 'цент', step: 1 })],
  },
  {
    id: 'voice',
    group: 'dist',
    label: 'Робот / шепіт',
    hint: 'Робот: звук стає монотонним і механічним. Шепіт: зникає тон, лишається шелест',
    params: [
      S('mode', 'Режим', 'robot', [
        ['robot', 'Робот'],
        ['whisper', 'Шепіт'],
      ]),
      P('freq', 'Висота робота', 120, 40, 400, { ...HZ, when: (p) => p.mode === 'robot' }),
      MIX(100),
    ],
  },
  {
    id: 'fshift',
    group: 'dist',
    label: 'Зсув частот',
    hint: 'Зсуває всі частоти на однакову кількість герц: металевий, «інопланетний» звук',
    params: [P('shift', 'Зсув', 120, -1000, 1000, { unit: 'Гц', step: 1 }), MIX(100)],
  },
  {
    id: 'ring',
    group: 'dist',
    label: 'Кільцева модуляція',
    hint: 'Множить звук на тон: дзвінкий металевий або «далек»-голос на низьких частотах',
    params: [P('freq', 'Частота', 50, 1, 2000, HZ), MIX(100)],
  },
  {
    id: 'drive',
    group: 'dist',
    label: 'Перегруз / дисторшн',
    hint: 'Спотворення, як у перевантаженому підсилювачі. Гучність вирівнюється автоматично',
    params: [
      S('kind', 'Тип', 'soft', [
        ['soft', 'М’який'],
        ['hard', 'Жорсткий'],
        ['fuzz', 'Фузз'],
        ['fold', 'Метал'],
      ]),
      P('amount', 'Сила', 18, 0, 48, { unit: 'dB', step: 0.5 }),
      P('tone', 'Тон', 9000, 500, 20000, HZ),
      MIX(100),
    ],
  },
  {
    id: 'crush',
    group: 'dist',
    label: 'Біткрашер / 8-біт',
    hint: 'Менше бітів і нижча частота дискретизації: звук старих консолей',
    params: [P('bits', 'Біти', 8, 1, 16, { step: 1 }), P('rate', 'Частота', 11025, 500, 48000, HZ), MIX(100)],
  },
  {
    id: 'noise',
    group: 'dist',
    label: 'Шум і тріск',
    hint: 'Шипіння плівки, тріск платівки, гул мережі',
    params: [
      P('hiss', 'Шипіння', -42, -80, -12, { unit: 'dB', step: 1, hint: '−80 — вимкнено' }),
      P('crackle', 'Тріск', 30, 0, 100, { unit: '%', step: 1 }),
      P('hum', 'Гул 50 Гц', 0, 0, 100, { unit: '%', step: 1 }),
    ],
  },
  {
    id: 'eq',
    group: 'filter',
    label: 'Еквалайзер',
    hint: 'Більше чи менше низів, середини, верхів',
    params: [
      P('low', 'Низи', 0, -18, 18, { unit: 'dB', step: 0.5 }),
      P('mid', 'Середина', 0, -18, 18, { unit: 'dB', step: 0.5 }),
      P('midFreq', 'Де середина', 1000, 150, 8000, HZ),
      P('high', 'Верхи', 0, -18, 18, { unit: 'dB', step: 0.5 }),
    ],
  },
  {
    id: 'lowpass',
    group: 'filter',
    label: 'Глухіше (фільтр НЧ)',
    hint: 'Прибирає верхи — як з-за стіни чи під водою',
    params: [P('freq', 'Зріз', 1200, 40, 20000, HZ), P('q', 'Резонанс', 0.7, 0.3, 18, { log: true }), B('steep', 'Крутіше', false)],
  },
  {
    id: 'highpass',
    group: 'filter',
    label: 'Тонше (фільтр ВЧ)',
    hint: 'Прибирає низи — тонкий, «маленький» звук',
    params: [P('freq', 'Зріз', 400, 20, 12000, HZ), P('q', 'Резонанс', 0.7, 0.3, 18, { log: true }), B('steep', 'Крутіше', false)],
  },
  {
    id: 'bandpass',
    group: 'filter',
    label: 'Смуговий (телефон, рація)',
    hint: 'Лишає тільки смугу частот навколо центру',
    params: [P('freq', 'Центр', 1500, 80, 12000, HZ), P('width', 'Ширина', 1.5, 0.2, 5, { unit: 'окт.', step: 0.1 })],
  },
  {
    id: 'autofilter',
    group: 'filter',
    label: 'Автофільтр (вау, вобл)',
    hint: 'Фільтр, що сам ходить вгору-вниз',
    params: [
      S('kind', 'Тип', 'lowpass', [
        ['lowpass', 'Глухий'],
        ['bandpass', 'Вау'],
      ]),
      P('freq', 'Від', 250, 40, 5000, HZ),
      P('range', 'Розмах', 3, 0, 6, { unit: 'окт.', step: 0.1 }),
      P('rate', 'Швидкість', 1.5, 0.05, 20, { unit: 'Гц', log: true }),
      P('q', 'Резонанс', 5, 0.5, 18, { log: true }),
      MIX(100),
    ],
  },
  {
    id: 'compressor',
    group: 'dyn',
    label: 'Компресор',
    hint: 'Стискає різницю між тихим і гучним: щільніше, рівніше',
    params: [
      P('threshold', 'Поріг', -20, -60, 0, { unit: 'dB', step: 0.5 }),
      P('ratio', 'Ступінь', 4, 1, 20, { unit: ':1', step: 0.1, log: true }),
      P('attack', 'Атака', 10, 0.1, 200, { unit: 'мс', log: true }),
      P('release', 'Відпускання', 150, 10, 2000, { ...MS, log: true }),
      B('auto', 'Авто-гучність', true),
      P('makeup', 'Підсилення', 0, 0, 24, { unit: 'dB', step: 0.5, when: (p) => !p.auto }),
    ],
  },
  {
    id: 'vibrato',
    group: 'mod',
    label: 'Вібрато',
    hint: 'Тон хитається вгору-вниз',
    params: [P('rate', 'Швидкість', 5, 0.1, 15, { unit: 'Гц', log: true }), P('depth', 'Глибина', 0.3, 0, 2, { unit: 'півт.' })],
  },
  {
    id: 'chorus',
    group: 'mod',
    label: 'Хорус',
    hint: 'Кілька трохи розстроєних копій: ширше, «хором»',
    params: [
      P('rate', 'Швидкість', 0.8, 0.05, 8, { unit: 'Гц', log: true }),
      P('depth', 'Глибина', 3, 0.1, 15, { unit: 'мс', step: 0.1 }),
      P('delay', 'Затримка', 18, 5, 40, { unit: 'мс', step: 0.5 }),
      P('voices', 'Голосів', 3, 1, 4, { step: 1 }),
      MIX(50),
    ],
  },
  {
    id: 'flanger',
    group: 'mod',
    label: 'Флейнджер',
    hint: '«Реактивний» звук, що пливе. Зі швидкістю 0 — металевий резонанс',
    params: [
      P('rate', 'Швидкість', 0.25, 0, 5, { unit: 'Гц' }),
      P('depth', 'Глибина', 2, 0, 10, { unit: 'мс', step: 0.1 }),
      P('delay', 'Затримка', 1.5, 0.1, 15, { unit: 'мс', step: 0.1 }),
      P('feedback', 'Резонанс', 60, -95, 95, { unit: '%', step: 1 }),
      MIX(50),
    ],
  },
  {
    id: 'phaser',
    group: 'mod',
    label: 'Фейзер',
    hint: 'М’яке «шшух», що ходить по частотах',
    params: [
      P('rate', 'Швидкість', 0.4, 0.02, 10, { unit: 'Гц', log: true }),
      P('stages', 'Ступенів', 6, 2, 12, { step: 2 }),
      P('freq', 'Від', 200, 50, 2000, HZ),
      P('range', 'Розмах', 3.5, 0.5, 6, { unit: 'окт.', step: 0.1 }),
      P('feedback', 'Резонанс', 50, 0, 90, { unit: '%', step: 1 }),
      MIX(50),
    ],
  },
  {
    id: 'tremolo',
    group: 'mod',
    label: 'Тремоло / автопан',
    hint: 'Гучність пульсує. Автопан — звук ходить між лівим і правим',
    params: [
      P('rate', 'Швидкість', 5, 0.1, 30, { unit: 'Гц', log: true }),
      P('depth', 'Глибина', 60, 0, 100, { unit: '%', step: 1 }),
      S('shape', 'Форма', 'sine', [
        ['sine', 'Плавно'],
        ['square', 'Різко'],
      ]),
      B('pan', 'Автопан', false),
    ],
  },
  {
    id: 'echo',
    group: 'space',
    label: 'Луна (ехо)',
    hint: 'Повтори звуку, що затихають',
    params: [
      P('time', 'Затримка', 350, 10, 2000, { ...MS, log: true }),
      P('feedback', 'Повтори', 40, 0, 95, { unit: '%', step: 1 }),
      P('tone', 'Тон повторів', 5000, 500, 20000, HZ),
      B('pingpong', 'Пінг-понг (ліво-право)', false),
      MIX(35),
    ],
  },
  {
    id: 'reverb',
    group: 'space',
    label: 'Реверберація',
    hint: 'Простір: кімната, зал, печера, космос',
    params: [
      P('decay', 'Довжина', 2.5, 0.1, 20, { unit: 'с', log: true }),
      P('predelay', 'Передзатримка', 20, 0, 300, MS),
      P('damping', 'Глухість', 50, 0, 100, { unit: '%', step: 1 }),
      P('width', 'Ширина', 100, 0, 100, { unit: '%', step: 1 }),
      MIX(30),
    ],
  },
  {
    id: 'stereo',
    group: 'dyn',
    label: 'Стерео',
    hint: 'Ширина стерео, панорама, псевдостерео для моно',
    params: [
      P('width', 'Ширина', 100, 0, 200, { unit: '%', step: 1, hint: '0 — моно' }),
      P('pan', 'Панорама', 0, -100, 100, { step: 1, hint: '−100 ліво, 100 право' }),
      P('haas', 'Псевдостерео', 0, 0, 30, { unit: 'мс', step: 0.5, hint: 'Затримка правого каналу — робить моно ширшим' }),
    ],
  },
  {
    id: 'gain',
    group: 'dyn',
    label: 'Гучність',
    hint: 'Тихіше чи гучніше, або вирівняти пік',
    params: [
      P('db', 'Гучність', 0, -30, 30, { unit: 'dB', step: 0.5, when: (p) => !p.norm }),
      B('norm', 'Нормалізувати пік', false),
      P('peak', 'Пік', -1, -24, 0, { unit: 'dB', step: 0.5, when: (p) => p.norm }),
    ],
  },
];

export const BY_ID = Object.fromEntries(EFFECTS.map((e) => [e.id, e]));

export function defaults(id) {
  const o = {};
  for (const p of BY_ID[id]?.params || []) o[p.k] = p.def;
  return o;
}

function cleanParams(def, raw = {}) {
  const o = {};
  for (const p of def.params) {
    const v = raw[p.k];
    if (p.kind === 'bool') o[p.k] = v == null ? p.def : !!v;
    else if (p.kind === 'select') o[p.k] = p.options.some(([k]) => k === v) ? v : p.def;
    else {
      const n = Number(v);
      o[p.k] = Number.isFinite(n) ? clamp(n, p.min, p.max) : p.def;
    }
  }
  return o;
}

// Settings that change nothing are skipped, so e.g. "Тон 0" doesn't run the pitch shifter at all.
function isNeutral(id, p) {
  if ('mix' in p && p.mix <= 0) return true;
  switch (id) {
    case 'speed':
    case 'tempo':
      return Math.abs(p.rate - 100) < 0.05;
    case 'pitch':
      return Math.abs(p.semi * 100 + p.cents) < 0.5;
    case 'noise':
      return p.hiss <= -79.5 && p.crackle <= 0 && p.hum <= 0;
    case 'eq':
      return !p.low && !p.mid && !p.high;
    case 'lowpass':
      return p.freq >= 19999 && p.q <= 0.71;
    case 'vibrato':
      return p.depth <= 0;
    case 'tremolo':
      return p.depth <= 0;
    case 'stereo':
      return p.width === 100 && !p.pan && !p.haas;
    case 'gain':
      return !p.norm && !p.db;
    case 'compressor':
      return p.ratio <= 1 && (p.auto || !p.makeup);
    default:
      return false;
  }
}

/**
 * Card fx state → the list of effects to run.
 * fx: { on, tail: 'ring'|'cut', e: { [id]: { on, ...params } } }  (also accepts an already built chain)
 */
export function buildChain(fx) {
  if (Array.isArray(fx)) return normalizeChain(fx);
  if (!fx || !fx.on || !fx.e) return [];
  const list = [];
  for (const def of EFFECTS) {
    const s = fx.e[def.id];
    if (s && s.on) list.push({ type: def.id, ...s });
  }
  return normalizeChain(list);
}

/** Validates a chain (from the client or a request): known effects, in order, params clamped. */
export function normalizeChain(chain) {
  if (!Array.isArray(chain)) return [];
  const byType = new Map();
  for (const e of chain) if (e && BY_ID[e.type] && !byType.has(e.type)) byType.set(e.type, e);
  const out = [];
  for (const def of EFFECTS) {
    const raw = byType.get(def.id);
    if (!raw) continue;
    const p = cleanParams(def, raw);
    if (!isNeutral(def.id, p)) out.push({ type: def.id, ...p });
  }
  return out;
}

export const chainKey = (chain, tail) => (chain.length ? JSON.stringify(chain) + '|' + (tail === 'cut' ? 'cut' : 'ring') : '');

// ---------- lengths & channels (must match what render() produces) ----------
const MAX_TAIL = 30;
function echoTail(p, sr) {
  const D = Math.max(1, Math.round((p.time / 1000) * sr));
  const fb = p.feedback / 100;
  const repeats = fb < 0.001 ? 1 : Math.min(400, Math.ceil(Math.log(0.001) / Math.log(fb)));
  return Math.min(Math.round(MAX_TAIL * sr), D * (repeats + 1));
}
const reverbTail = (p, sr) => Math.round((p.predelay / 1000) * sr) + Math.round(p.decay * sr);
const rateLen = (n, rate) => Math.max(1, Math.round((n * 100) / rate));

export function outLength(n, sr, chain, tail = 'ring') {
  for (const e of chain) {
    if (e.type === 'speed' || e.type === 'tempo') n = rateLen(n, e.rate);
    else if (tail !== 'cut' && e.type === 'echo') n += echoTail(e, sr);
    else if (tail !== 'cut' && e.type === 'reverb') n += reverbTail(e, sr);
  }
  return n;
}

const makesStereo = (e) =>
  e.type === 'chorus' ||
  e.type === 'flanger' ||
  e.type === 'phaser' ||
  (e.type === 'tremolo' && e.pan) ||
  (e.type === 'echo' && e.pingpong) ||
  (e.type === 'reverb' && e.width > 0) ||
  (e.type === 'stereo' && (e.pan !== 0 || e.haas > 0));

export function outChannels(ch, chain) {
  ch = Math.min(2, Math.max(1, ch || 1));
  return ch === 1 && chain.some(makesStereo) ? 2 : ch;
}

// ---------- helpers ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const stereo = (chs) => (chs.length === 1 ? [chs[0], new Float32Array(chs[0])] : chs);

function rms(chs) {
  let s = 0;
  let n = 0;
  for (const c of chs) {
    for (let i = 0; i < c.length; i++) s += c[i] * c[i];
    n += c.length;
  }
  return n ? Math.sqrt(s / n) : 0;
}

/** Biquad coefficients (RBJ cookbook) → [b0, b1, b2, a1, a2]. */
function biquad(type, f, q, gainDb, sr, out = new Float64Array(5)) {
  const w = (TAU * clamp(f, 5, sr * 0.49)) / sr;
  const cs = Math.cos(w);
  const sn = Math.sin(w);
  const A = Math.pow(10, gainDb / 40);
  const alpha = sn / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') {
    b0 = (1 - cs) / 2;
    b1 = 1 - cs;
    b2 = b0;
    a0 = 1 + alpha;
    a1 = -2 * cs;
    a2 = 1 - alpha;
  } else if (type === 'hp') {
    b0 = (1 + cs) / 2;
    b1 = -(1 + cs);
    b2 = b0;
    a0 = 1 + alpha;
    a1 = -2 * cs;
    a2 = 1 - alpha;
  } else if (type === 'bp') {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
    a0 = 1 + alpha;
    a1 = -2 * cs;
    a2 = 1 - alpha;
  } else if (type === 'peak') {
    b0 = 1 + alpha * A;
    b1 = -2 * cs;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cs;
    a2 = 1 - alpha / A;
  } else {
    const sa = 2 * Math.sqrt(A) * (sn / 2) * Math.SQRT2; // shelf slope 1
    if (type === 'lowshelf') {
      b0 = A * (A + 1 - (A - 1) * cs + sa);
      b1 = 2 * A * (A - 1 - (A + 1) * cs);
      b2 = A * (A + 1 - (A - 1) * cs - sa);
      a0 = A + 1 + (A - 1) * cs + sa;
      a1 = -2 * (A - 1 + (A + 1) * cs);
      a2 = A + 1 + (A - 1) * cs - sa;
    } else {
      b0 = A * (A + 1 + (A - 1) * cs + sa);
      b1 = -2 * A * (A - 1 + (A + 1) * cs);
      b2 = A * (A + 1 + (A - 1) * cs - sa);
      a0 = A + 1 - (A - 1) * cs + sa;
      a1 = 2 * (A - 1 - (A + 1) * cs);
      a2 = A + 1 - (A - 1) * cs - sa;
    }
  }
  out[0] = b0 / a0;
  out[1] = b1 / a0;
  out[2] = b2 / a0;
  out[3] = a1 / a0;
  out[4] = a2 / a0;
  return out;
}

/** Runs a biquad over x in place. */
function runBiquad(x, c) {
  const b0 = c[0],
    b1 = c[1],
    b2 = c[2],
    a1 = c[3],
    a2 = c[4];
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = b0 * v + z1;
    z1 = b1 * v - a1 * y + z2;
    z2 = b2 * v - a2 * y;
    x[i] = y;
    if ((i & 1023) === 0 && Math.abs(z1) < 1e-30 && Math.abs(z2) < 1e-30) z1 = z2 = 0; // no denormals in silence
  }
}

/** Value of x at fractional position, zero outside the signal (cubic Hermite). */
function atZ(x, pos) {
  const i = Math.floor(pos);
  const t = pos - i;
  const n = x.length;
  const xm = i - 1 >= 0 && i - 1 < n ? x[i - 1] : 0;
  const x0 = i >= 0 && i < n ? x[i] : 0;
  const x1 = i + 1 >= 0 && i + 1 < n ? x[i + 1] : 0;
  const x2 = i + 2 >= 0 && i + 2 < n ? x[i + 2] : 0;
  const c1 = 0.5 * (x1 - xm);
  const c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
  return ((c3 * t + c2) * t + c1) * t + x0;
}

/** Same, clamped to the edge samples outside the signal. */
function atC(x, pos) {
  const n = x.length;
  const i = Math.floor(pos);
  const t = pos - i;
  const g = (k) => x[k < 0 ? 0 : k >= n ? n - 1 : k];
  const xm = g(i - 1);
  const x0 = g(i);
  const x1 = g(i + 1);
  const x2 = g(i + 2);
  const c1 = 0.5 * (x1 - xm);
  const c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
  return ((c3 * t + c2) * t + c1) * t + x0;
}

/** Reads x at step `ratio` per output sample → `len` samples (anti-aliased when speeding up). */
function resample(x, ratio, len, sr) {
  let src = x;
  if (ratio > 1.001) {
    src = new Float32Array(x);
    for (const q of [0.5412, 1.3066]) runBiquad(src, biquad('lp', (0.45 * sr) / ratio, q, 0, sr));
  }
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = atC(src, i * ratio);
  return out;
}

// ---------- FFT ----------
const tables = new Map();
function fftTables(N) {
  let t = tables.get(N);
  if (t) return t;
  const bits = Math.round(Math.log2(N));
  const rev = new Uint32Array(N);
  for (let i = 1; i < N; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
  const cos = new Float64Array(N / 2);
  const sin = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    cos[i] = Math.cos((TAU * i) / N);
    sin[i] = Math.sin((TAU * i) / N);
  }
  t = { rev, cos, sin };
  if (tables.size > 6) tables.delete(tables.keys().next().value);
  tables.set(N, t);
  return t;
}

function fft(re, im, inverse) {
  const N = re.length;
  const { rev, cos, sin } = fftTables(N);
  for (let i = 0; i < N; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  const sg = inverse ? 1 : -1;
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let i = 0; i < N; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cos[k];
        const wi = sg * sin[k];
        const a = i + j;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < N; i++) {
      re[i] /= N;
      im[i] /= N;
    }
  }
}

const pow2 = (n) => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};

/**
 * Spectra of one or two real impulse responses at FFT size F. Two are packed into one complex FFT
 * (left in the real part, right in the imaginary part) and separated afterwards.
 */
function spectra(hs, F) {
  const re = new Float64Array(F);
  const im = new Float64Array(F);
  re.set(hs[0]);
  if (hs.length > 1) im.set(hs[1]);
  fft(re, im, false);
  if (hs.length === 1) return [[re, im]];
  const Lr = new Float64Array(F);
  const Li = new Float64Array(F);
  const Rr = new Float64Array(F);
  const Ri = new Float64Array(F);
  for (let k = 0; k < F; k++) {
    const j = (F - k) & (F - 1);
    const br = re[j];
    const bi = -im[j]; // conj(Z[F-k])
    Lr[k] = (re[k] + br) / 2;
    Li[k] = (im[k] + bi) / 2;
    Rr[k] = (im[k] - bi) / 2;
    Ri[k] = -(re[k] - br) / 2;
  }
  return [
    [Lr, Li],
    [Rr, Ri],
  ];
}

let irCache = { key: '', H: null };

/**
 * (x[c] * h[c])[0 .. outLen) for one or two channels, by FFT overlap-add.
 * Stereo runs both channels through a single complex FFT per block.
 */
function convolve(xs, hs, outLen, cacheKey) {
  const C = xs.length;
  const outs = xs.map(() => new Float32Array(outLen));
  const n = xs[0].length;
  const M = hs[0].length;
  if (!n || !M) return outs;
  let F, Bk;
  if (n + M - 1 <= 1 << 20) {
    F = pow2(n + M - 1);
    Bk = n;
  } else {
    F = pow2(2 * M);
    Bk = F - M + 1;
  }
  const key = cacheKey ? cacheKey + '|' + F : '';
  let H;
  if (key && irCache.key === key) H = irCache.H;
  else {
    H = spectra(hs, F);
    irCache = key ? { key, H } : { key: '', H: null };
  }
  const re = new Float64Array(F);
  const im = new Float64Array(F);
  for (let s = 0; s < n && s < outLen; s += Bk) {
    re.fill(0);
    im.fill(0);
    const e = Math.min(n, s + Bk);
    for (let i = s; i < e; i++) {
      re[i - s] = xs[0][i];
      if (C > 1) im[i - s] = xs[1][i];
    }
    fft(re, im, false);
    if (C === 1) {
      const [Hr, Hi] = H[0];
      for (let k = 0; k < F; k++) {
        const a = re[k];
        const b = im[k];
        re[k] = a * Hr[k] - b * Hi[k];
        im[k] = a * Hi[k] + b * Hr[k];
      }
    } else {
      const [Lr, Li] = H[0];
      const [Rr, Ri] = H[1];
      for (let k = 0; k <= F / 2; k++) {
        const j = (F - k) & (F - 1);
        // separate the two channels' spectra, multiply each by its IR, pack again: Y = XL·HL + i·XR·HR
        const zr = re[k], zi = im[k], wr = re[j], wi = -im[j];
        const xlr = (zr + wr) / 2, xli = (zi + wi) / 2;
        const xrr = (zi - wi) / 2, xri = -(zr - wr) / 2;
        const alr = xlr * Lr[k] - xli * Li[k], ali = xlr * Li[k] + xli * Lr[k];
        const arr = xrr * Rr[k] - xri * Ri[k], ari = xrr * Ri[k] + xri * Rr[k];
        // bin j holds the conjugate-symmetric partners
        const blr = xlr * Lr[j] + xli * Li[j], bli = xlr * Li[j] - xli * Lr[j];
        const brr = xrr * Rr[j] + xri * Ri[j], bri = xrr * Ri[j] - xri * Rr[j];
        re[k] = alr - ari;
        im[k] = ali + arr;
        if (j !== k) {
          re[j] = blr - bri;
          im[j] = bli + brr;
        }
      }
    }
    fft(re, im, true);
    const lim = Math.min(outLen - s, F);
    for (let i = 0; i < lim; i++) {
      outs[0][s + i] += re[i];
      if (C > 1) outs[1][s + i] += im[i];
    }
  }
  return outs;
}

const hann = (N) => {
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((TAU * i) / N);
  return w;
};

// ---------- time-stretch (WSOLA) ----------
/**
 * Plays the sound `tempo` times faster without changing its pitch → `outLen` samples.
 * Frames of 40 ms overlap by half; each next frame is taken from where it lines up best with
 * the natural continuation of the previous one (searched ±12 ms), so tones stay smooth.
 */
function stretch(chs, sr, tempo, outLen) {
  const n = chs[0].length;
  const N = 2 * Math.max(64, Math.round(sr * 0.02));
  const H = N / 2;
  const tol = Math.round(sr * 0.012);
  const D = Math.max(1, Math.round(sr / 8000));
  const win = hann(N);
  const mono = new Float32Array(n);
  for (const c of chs) for (let i = 0; i < n; i++) mono[i] += c[i] / chs.length;
  const acc = chs.map(() => new Float64Array(outLen + N));
  const wsum = new Float64Array(outLen + N);
  const m = (i) => (i >= 0 && i < n ? mono[i] : 0);

  const align = (ref, nominal) => {
    let lo = Math.max(0, nominal - tol);
    let hi = Math.min(n - 1, nominal + tol);
    if (hi < lo) return clamp(nominal, 0, Math.max(0, n - 1));
    let eref = 0;
    for (let i = 0; i < H; i += D) eref += m(ref + i) * m(ref + i);
    if (eref < 1e-10) return clamp(nominal, 0, n - 1);
    const score = (p, step) => {
      let dot = 0;
      let en = 1e-9;
      for (let i = 0; i < H; i += step) {
        const v = m(p + i);
        dot += v * m(ref + i);
        en += v * v;
      }
      return dot / Math.sqrt(en);
    };
    let best = nominal;
    let bs = -Infinity;
    for (let p = lo; p <= hi; p += D) {
      const s = score(p, D);
      if (s > bs) {
        bs = s;
        best = p;
      }
    }
    if (D > 1) {
      const c = best;
      bs = -Infinity;
      for (let p = Math.max(lo, c - D); p <= Math.min(hi, c + D); p++) {
        const s = score(p, 1);
        if (s > bs) {
          bs = s;
          best = p;
        }
      }
    }
    return best;
  };

  let prev = 0;
  for (let k = 0; k * H < outLen; k++) {
    const o = k * H;
    const pos = k === 0 ? 0 : align(prev + H, Math.round(k * H * tempo));
    for (let i = 0; i < N; i++) {
      const w = k === 0 && i < H ? 1 : win[i];
      const idx = pos + i;
      for (let c = 0; c < chs.length; c++) acc[c][o + i] += (idx < n ? chs[c][idx] : 0) * w;
      wsum[o + i] += w;
    }
    prev = pos;
  }
  return acc.map((a) => {
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) out[i] = wsum[i] > 1e-6 ? a[i] / wsum[i] : 0;
    return out;
  });
}

// ---------- effects ----------
const FX = {};

FX.reverse = (chs) => chs.map((c) => new Float32Array(c).reverse());

FX.speed = (chs, sr, p) => {
  const r = p.rate / 100;
  const len = rateLen(chs[0].length, p.rate);
  return chs.map((c) => resample(c, r, len, sr));
};

FX.tempo = (chs, sr, p) => stretch(chs, sr, p.rate / 100, rateLen(chs[0].length, p.rate));

FX.pitch = (chs, sr, p) => {
  const n = chs[0].length;
  const k = Math.pow(2, (p.semi + p.cents / 100) / 12);
  const long = stretch(chs, sr, 1 / k, Math.max(1, Math.round(n * k)));
  return long.map((c) => resample(c, k, n, sr));
};

FX.voice = (chs, sr, p) => {
  const robot = p.mode === 'robot';
  const hop0 = robot ? Math.max(8, Math.round(sr / p.freq)) : 0;
  const N = robot ? pow2(Math.max(Math.round((1024 * sr) / 44100), 2 * hop0)) : pow2(Math.round((512 * sr) / 44100));
  const hop = robot ? hop0 : N / 4;
  const win = hann(N);
  const n = chs[0].length;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const dryRms = rms(chs);
  const wet = chs.map((x, ci) => {
    const rnd = rng(4242); // same phases in every channel keeps stereo/mono intact
    const acc = new Float64Array(n);
    const ws = new Float64Array(n);
    for (let pos = -N + hop; pos < n; pos += hop) {
      for (let i = 0; i < N; i++) {
        const j = pos + i;
        re[i] = j >= 0 && j < n ? x[j] * win[i] : 0;
        im[i] = 0;
      }
      fft(re, im, false);
      if (robot) {
        // zero phase, centred in the frame → one pulse per hop: a steady robotic pitch
        for (let k = 0; k < N; k++) {
          const mag = Math.hypot(re[k], im[k]);
          re[k] = k & 1 ? -mag : mag;
          im[k] = 0;
        }
      } else {
        for (let k = 0; k <= N / 2; k++) {
          const mag = Math.hypot(re[k], im[k]);
          if (k === 0 || k === N / 2) {
            re[k] = mag;
            im[k] = 0;
            continue;
          }
          const ph = rnd() * TAU;
          re[k] = mag * Math.cos(ph);
          im[k] = mag * Math.sin(ph);
          re[N - k] = re[k];
          im[N - k] = -im[k];
        }
      }
      fft(re, im, true);
      for (let i = 0; i < N; i++) {
        const j = pos + i;
        if (j < 0 || j >= n) continue;
        acc[j] += re[i] * win[i];
        ws[j] += win[i] * win[i];
      }
    }
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = ws[i] > 1e-3 ? acc[i] / ws[i] : 0;
    return out;
  });
  // Same loudness as the original, but robot pulses are spiky: keep their peak under −1 dB (or the original's peak).
  const g = Math.min(matchGain(dryRms, rms(wet)), matchGain(Math.max(peak(chs), 0.89), peak(wet)));
  const [gd, gw] = linMix(p.mix / 100);
  return chs.map((x, c) => mixInto(x, wet[c], gd, gw * g));
};

function peak(chs) {
  let p = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i]));
  return p;
}

function matchGain(dry, wet) {
  return wet > 1e-9 && dry > 1e-9 ? clamp(dry / wet, 0.05, 8) : 1;
}
function mixInto(dry, wet, gd, gw) {
  const out = new Float32Array(Math.max(dry.length, wet.length));
  for (let i = 0; i < out.length; i++) out[i] = (i < dry.length ? dry[i] * gd : 0) + (i < wet.length ? wet[i] * gw : 0);
  return out;
}

// Hilbert pair (Olli Niemitalo): two allpass chains whose outputs are 90° apart over almost the whole band.
const HIL_A = [0.6923878, 0.9360654322959, 0.988229522686, 0.9987488452737].map((a) => a * a);
const HIL_B = [0.4021921162426, 0.856171088242, 0.9722909545651, 0.9952884791278].map((a) => a * a);
function allpassChain(x, coefs) {
  const out = new Float64Array(x.length);
  const s = coefs.map(() => [0, 0, 0, 0]); // x1, x2, y1, y2
  for (let i = 0; i < x.length; i++) {
    let v = x[i];
    for (let k = 0; k < coefs.length; k++) {
      const st = s[k];
      const y = coefs[k] * (v + st[3]) - st[1];
      st[1] = st[0];
      st[0] = v;
      st[3] = st[2];
      st[2] = y;
      v = y;
    }
    out[i] = v;
  }
  return out;
}

FX.fshift = (chs, sr, p) => {
  const [gd, gw] = linMix(p.mix / 100);
  const w = (TAU * p.shift) / sr;
  return chs.map((x) => {
    const I = allpassChain(x, HIL_A);
    const Q = allpassChain(x, HIL_B);
    const out = new Float32Array(x.length);
    let i1 = 0;
    for (let i = 0; i < x.length; i++) {
      const re = i1; // path A one sample later → exactly 90° from path B
      i1 = I[i];
      const ph = w * i;
      out[i] = x[i] * gd + (re * Math.cos(ph) + Q[i] * Math.sin(ph)) * gw;
    }
    return out;
  });
};

FX.ring = (chs, sr, p) => {
  const [gd, gw] = linMix(p.mix / 100);
  const w = (TAU * p.freq) / sr;
  return chs.map((x) => {
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = x[i] * (gd + gw * Math.sin(w * i));
    return out;
  });
};

FX.drive = (chs, sr, p) => {
  const g = dbGain(p.amount);
  const shape =
    p.kind === 'hard'
      ? (v) => clamp(v, -1, 1)
      : p.kind === 'fuzz'
        ? (v) => clamp(Math.tanh(v + 0.35) - 0.3364, -0.85, 0.85) // tanh(0.35) ≈ 0.3364: asymmetric, keeps 0 at 0
        : p.kind === 'fold'
          ? (v) => Math.sin(v * 1.5707963)
          : (v) => Math.tanh(v);
  const wet = chs.map((x) => {
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = shape(x[i] * g);
    if (p.kind === 'fuzz') {
      // DC blocker
      const R = 1 - (TAU * 10) / sr;
      let x1 = 0;
      let y1 = 0;
      for (let i = 0; i < y.length; i++) {
        const v = y[i];
        y1 = v - x1 + R * y1;
        x1 = v;
        y[i] = y1;
      }
    }
    if (p.tone < 19500) runBiquad(y, biquad('lp', p.tone, 0.7071, 0, sr));
    return y;
  });
  const k = matchGain(rms(chs), rms(wet));
  const [gd, gw] = linMix(p.mix / 100);
  return chs.map((x, c) => mixInto(x, wet[c], gd, gw * k));
};

FX.crush = (chs, sr, p) => {
  const levels = Math.pow(2, Math.round(p.bits) - 1);
  const step = Math.max(1, sr / p.rate);
  const [gd, gw] = linMix(p.mix / 100);
  return chs.map((x) => {
    const out = new Float32Array(x.length);
    let acc = step;
    let held = 0;
    for (let i = 0; i < x.length; i++) {
      if (acc >= step) {
        acc -= step;
        held = clamp(Math.round(x[i] * levels) / levels, -1, 1);
      }
      acc += 1;
      out[i] = x[i] * gd + held * gw;
    }
    return out;
  });
};

FX.noise = (chs, sr, p) => {
  const n = chs[0].length;
  const hissRms = p.hiss <= -79.5 ? 0 : dbGain(p.hiss);
  // crackle: the same clicks in every channel (like a record), random strength
  const clicks = new Float32Array(n);
  if (p.crackle > 0) {
    const r = rng(1999);
    const prob = ((p.crackle / 100) * 40) / sr;
    const tau = Math.max(1, sr * 0.00025);
    for (let i = 0; i < n; i++) {
      if (r() >= prob) continue;
      const a = (r() < 0.5 ? -1 : 1) * (0.02 + 0.3 * Math.pow(r(), 3));
      for (let j = 0; j < tau * 6 && i + j < n; j++) clicks[i + j] += a * Math.exp(-j / tau);
    }
    runBiquad(clicks, biquad('hp', 900, 0.7071, 0, sr));
  }
  const hum = (p.hum / 100) * 0.03;
  const w = (TAU * 50) / sr;
  return chs.map((x, c) => {
    const out = new Float32Array(x);
    if (hissRms > 0) {
      const r = rng(7001 + c * 31);
      const h = new Float32Array(n);
      for (let i = 0; i < n; i++) h[i] = (r() * 2 - 1) * 1.732 * hissRms;
      runBiquad(h, biquad('lp', 9000, 0.7071, 0, sr));
      for (let i = 0; i < n; i++) out[i] += h[i];
    }
    if (p.crackle > 0) for (let i = 0; i < n; i++) out[i] += clicks[i];
    if (hum > 0) for (let i = 0; i < n; i++) out[i] += hum * (Math.sin(w * i) + 0.5 * Math.sin(2 * w * i) + 0.25 * Math.sin(3 * w * i));
    return out;
  });
};

FX.eq = (chs, sr, p) =>
  chs.map((x) => {
    const y = new Float32Array(x);
    if (p.low) runBiquad(y, biquad('lowshelf', 150, 0.7071, p.low, sr));
    if (p.mid) runBiquad(y, biquad('peak', p.midFreq, 0.8, p.mid, sr));
    if (p.high) runBiquad(y, biquad('highshelf', 5000, 0.7071, p.high, sr));
    return y;
  });

const passFilter = (type) => (chs, sr, p) =>
  chs.map((x) => {
    const y = new Float32Array(x);
    const c = biquad(type, p.freq, p.q, 0, sr);
    runBiquad(y, c);
    if (p.steep) runBiquad(y, c);
    return y;
  });
FX.lowpass = passFilter('lp');
FX.highpass = passFilter('hp');

FX.bandpass = (chs, sr, p) =>
  chs.map((x) => {
    const y = new Float32Array(x);
    // Q from bandwidth in octaves; two stages for steeper sides (telephone-like)
    const q = Math.sqrt(Math.pow(2, p.width)) / (Math.pow(2, p.width) - 1);
    const c = biquad('bp', p.freq, q, 0, sr);
    runBiquad(y, c);
    runBiquad(y, c);
    return y;
  });

FX.autofilter = (chs, sr, p) => {
  const [gd, gw] = linMix(p.mix / 100);
  const type = p.kind === 'bandpass' ? 'bp' : 'lp';
  const w = (TAU * p.rate) / sr;
  return chs.map((x) => {
    const out = new Float32Array(x.length);
    const c = new Float64Array(5);
    let z1 = 0;
    let z2 = 0;
    for (let i = 0; i < x.length; i++) {
      if ((i & 31) === 0) {
        const lfo = 0.5 - 0.5 * Math.cos(w * i);
        biquad(type, p.freq * Math.pow(2, p.range * lfo), p.q, 0, sr, c);
      }
      const v = x[i];
      const y = c[0] * v + z1;
      z1 = c[1] * v - c[3] * y + z2;
      z2 = c[2] * v - c[4] * y;
      out[i] = v * gd + y * gw;
    }
    return out;
  });
};

FX.compressor = (chs, sr, p) => {
  const n = chs[0].length;
  const knee = 6;
  const slope = 1 / p.ratio - 1;
  const aA = Math.exp(-1 / ((p.attack / 1000) * sr));
  const aR = Math.exp(-1 / ((p.release / 1000) * sr));
  const makeup = dbGain(p.auto ? (-p.threshold * -slope) / 2 : p.makeup);
  const outs = chs.map((x) => new Float32Array(x.length));
  let gr = 0; // gain reduction, dB (≤ 0)
  for (let i = 0; i < n; i++) {
    let lvl = 0;
    for (const x of chs) {
      const a = Math.abs(x[i]);
      if (a > lvl) lvl = a;
    }
    const db = 20 * Math.log10(lvl + 1e-12);
    const over = db - p.threshold;
    let target = 0;
    if (2 * over >= knee) target = slope * over;
    else if (2 * over > -knee) target = (slope * (over + knee / 2) ** 2) / (2 * knee);
    gr = target < gr ? aA * gr + (1 - aA) * target : aR * gr + (1 - aR) * target;
    const g = dbGain(gr) * makeup;
    for (let c = 0; c < chs.length; c++) outs[c][i] = chs[c][i] * g;
  }
  return outs;
};

FX.vibrato = (chs, sr, p) => {
  const w = (TAU * p.rate) / sr;
  const A = ((Math.pow(2, p.depth / 12) - 1) / (TAU * p.rate)) * sr; // samples of delay swing for that pitch swing
  return chs.map((x) => {
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = atC(x, i - A * Math.sin(w * i));
    return out;
  });
};

FX.chorus = (chs, sr, p) => {
  const st = stereo(chs);
  const V = Math.round(p.voices);
  const w = (TAU * p.rate) / sr;
  const base = (p.delay / 1000) * sr;
  const depth = (p.depth / 1000) * sr;
  const [gd, gw] = linMix(p.mix / 100);
  return st.map((x, c) => {
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      let s = 0;
      for (let v = 0; v < V; v++) {
        const ph = (TAU * v) / V + c * (Math.PI / 2);
        s += atZ(x, i - base - depth * 0.5 * (1 + Math.sin(w * i + ph)));
      }
      out[i] = x[i] * gd + (s / V) * gw;
    }
    return out;
  });
};

FX.flanger = (chs, sr, p) => {
  const st = stereo(chs);
  const w = (TAU * p.rate) / sr;
  const base = (p.delay / 1000) * sr;
  const depth = (p.depth / 1000) * sr;
  const fb = p.feedback / 100;
  const [gd, gw] = linMix(p.mix / 100);
  return st.map((x, c) => {
    const n = x.length;
    const line = new Float64Array(n);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const d = Math.max(2, base + depth * 0.5 * (1 + Math.sin(w * i + c * (Math.PI / 2))));
      const pos = i - d;
      const k = Math.floor(pos);
      const t = pos - k;
      const a = k >= 0 ? line[k] : 0;
      const b = k + 1 >= 0 ? line[k + 1] : 0;
      const v = a + (b - a) * t;
      line[i] = x[i] + fb * v;
      out[i] = x[i] * gd + v * gw;
    }
    return out;
  });
};

FX.phaser = (chs, sr, p) => {
  const st = stereo(chs);
  const S = Math.round(p.stages);
  const w = (TAU * p.rate) / sr;
  const fb = p.feedback / 100;
  const [gd, gw] = linMix(p.mix / 100);
  return st.map((x, c) => {
    const out = new Float32Array(x.length);
    const xs = new Float64Array(S);
    const ys = new Float64Array(S);
    let a = 0;
    let last = 0;
    for (let i = 0; i < x.length; i++) {
      if ((i & 15) === 0) {
        const lfo = 0.5 + 0.5 * Math.sin(w * i + c * (Math.PI / 2));
        const f = Math.min(sr * 0.45, p.freq * Math.pow(2, p.range * lfo));
        const t = Math.tan((Math.PI * f) / sr);
        a = (t - 1) / (t + 1);
      }
      let v = x[i] + fb * last;
      for (let k = 0; k < S; k++) {
        const y = a * v + xs[k] - a * ys[k];
        xs[k] = v;
        ys[k] = y;
        v = y;
      }
      last = v;
      out[i] = x[i] * gd + v * gw;
    }
    return out;
  });
};

FX.tremolo = (chs, sr, p) => {
  const st = p.pan ? stereo(chs) : chs;
  const w = (TAU * p.rate) / sr;
  const d = p.depth / 100;
  const lfo = p.shape === 'square' ? (ph) => 0.5 + 0.5 * Math.tanh(5 * Math.sin(ph)) : (ph) => 0.5 + 0.5 * Math.sin(ph);
  return st.map((x, c) => {
    const out = new Float32Array(x.length);
    const off = p.pan && c === 1 ? Math.PI : 0;
    for (let i = 0; i < x.length; i++) out[i] = x[i] * (1 - d * (1 - lfo(w * i + off)));
    return out;
  });
};

FX.echo = (chs, sr, p, ctx) => {
  const n = chs[0].length;
  const len = ctx.tail === 'cut' ? n : n + echoTail(p, sr);
  const D = Math.max(1, Math.round((p.time / 1000) * sr));
  const fb = p.feedback / 100;
  const cf = 1 - Math.exp((-TAU * p.tone) / sr);
  const [gd, gw] = powMix(p.mix / 100);
  const at = (x, i) => (i < x.length ? x[i] : 0);
  if (p.pingpong) {
    const st = stereo(chs);
    const lineL = new Float64Array(len);
    const lineR = new Float64Array(len);
    const outL = new Float32Array(len);
    const outR = new Float32Array(len);
    let lpL = 0;
    let lpR = 0;
    for (let i = 0; i < len; i++) {
      lpL += cf * ((i >= D ? lineL[i - D] : 0) - lpL);
      lpR += cf * ((i >= D ? lineR[i - D] : 0) - lpR);
      const m = (at(st[0], i) + at(st[1], i)) / 2;
      lineL[i] = m + fb * lpR;
      lineR[i] = fb * lpL;
      outL[i] = at(st[0], i) * gd + lpL * gw;
      outR[i] = at(st[1], i) * gd + lpR * gw;
    }
    return [outL, outR];
  }
  return chs.map((x) => {
    const line = new Float64Array(len);
    const out = new Float32Array(len);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      lp += cf * ((i >= D ? line[i - D] : 0) - lp);
      line[i] = at(x, i) + fb * lp;
      out[i] = at(x, i) * gd + lp * gw;
    }
    return out;
  });
};

/** Impulse response: decaying noise that gets darker as it fades (damping), one per channel. */
function reverbIR(sr, p, ch) {
  const pre = Math.round((p.predelay / 1000) * sr);
  const L = Math.max(1, Math.round(p.decay * sr));
  const att = Math.max(1, Math.round(sr * 0.004));
  const make = (seed) => {
    const r = rng(seed);
    const ir = new Float32Array(pre + L);
    let lp = 0;
    for (let i = 0; i < L; i++) {
      const t = i / sr;
      const env = Math.exp((-6.9078 * t) / p.decay) * Math.min(1, i / att);
      const cut = Math.max(150, 16000 * Math.exp((-(p.damping / 100) * 4 * t) / p.decay));
      lp += (1 - Math.exp((-TAU * Math.min(cut, sr * 0.45)) / sr)) * (r() * 2 - 1 - lp);
      ir[pre + i] = lp * env;
    }
    return ir;
  };
  const unit = (ir) => {
    let e = 0;
    for (let i = 0; i < ir.length; i++) e += ir[i] * ir[i];
    const g = e > 0 ? 1 / Math.sqrt(e) : 0;
    for (let i = 0; i < ir.length; i++) ir[i] *= g;
    return ir;
  };
  const a = make(31337);
  if (ch === 1) return [unit(a)];
  const b = make(27183);
  const w = p.width / 100;
  for (let i = 0; i < b.length; i++) b[i] = w * b[i] + (1 - w) * a[i];
  return [unit(a), unit(b)];
}

FX.reverb = (chs, sr, p, ctx) => {
  const src = p.width > 0 ? stereo(chs) : chs;
  const n = src[0].length;
  const len = ctx.tail === 'cut' ? n : n + reverbTail(p, sr);
  const key = ['rev', sr, p.decay, p.predelay, p.damping, p.width, src.length].join('|');
  const irs = reverbIR(sr, p, src.length); // cheap; its spectrum (the slow part) is cached by `key`
  const [gd, gw] = powMix(p.mix / 100);
  const wets = convolve(src, irs, len, key);
  return wets.map((wet, c) => {
    const x = src[c];
    for (let i = 0; i < len; i++) wet[i] = (i < n ? x[i] * gd : 0) + wet[i] * gw;
    return wet;
  });
};

FX.stereo = (chs, sr, p) => {
  let st = p.pan || p.haas ? stereo(chs) : chs;
  if (st.length < 2) return st;
  const n = st[0].length;
  let L = new Float32Array(st[0]);
  let R = new Float32Array(st[1]);
  if (p.haas > 0) {
    const d = Math.round((p.haas / 1000) * sr);
    const r2 = new Float32Array(n);
    r2.set(R.subarray(0, Math.max(0, n - d)), d);
    R = r2;
  }
  if (p.width !== 100) {
    const k = p.width / 100;
    for (let i = 0; i < n; i++) {
      const m = (L[i] + R[i]) / 2;
      const s = ((L[i] - R[i]) / 2) * k;
      L[i] = m + s;
      R[i] = m - s;
    }
  }
  if (p.pan) {
    const b = p.pan / 100;
    const gl = b > 0 ? 1 - b : 1;
    const gr = b < 0 ? 1 + b : 1;
    for (let i = 0; i < n; i++) {
      L[i] *= gl;
      R[i] *= gr;
    }
  }
  return [L, R];
};

FX.gain = (chs, sr, p) => {
  let g = dbGain(p.db);
  if (p.norm) {
    let pk = 0;
    for (const x of chs) for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i]));
    g = pk > 1e-9 ? dbGain(p.peak) / pk : 1;
  }
  return chs.map((x) => {
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = x[i] * g;
    return y;
  });
};

/**
 * Runs the chain over the channels (Float32Arrays, not modified) at sample rate `sr`.
 * tail: 'ring' lets echo/reverb ring out past the end, 'cut' keeps the length.
 */
export function render(channels, sr, chain, { tail = 'ring' } = {}) {
  let chs = channels.map((c) => new Float32Array(c));
  if (chs.length > 2) {
    // more than stereo: fold down to stereo first
    const n = chs[0].length;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    chs.forEach((c, i) => {
      const t = i % 2 === 0 ? L : R;
      for (let j = 0; j < n; j++) t[j] += c[j] / Math.ceil(chs.length / 2);
    });
    chs = [L, R];
  }
  if (!chs.length || !chs[0].length) return chs;
  const ctx = { tail: tail === 'cut' ? 'cut' : 'ring' };
  for (const e of normalizeChain(chain)) chs = FX[e.type](chs, sr, e, ctx);
  return chs;
}

// ---------- presets ----------
export const PRESETS = [
  { id: 'space', label: 'Космос', fx: { chorus: { rate: 0.3, depth: 6, delay: 20, voices: 3, mix: 40 }, echo: { time: 420, feedback: 45, tone: 3500, pingpong: true, mix: 30 }, reverb: { decay: 9, predelay: 60, damping: 35, width: 100, mix: 55 }, stereo: { width: 150 } } },
  { id: 'robot', label: 'Робот', fx: { voice: { mode: 'robot', freq: 110, mix: 100 }, ring: { freq: 55, mix: 25 }, reverb: { decay: 0.5, predelay: 5, damping: 40, mix: 15 } } },
  { id: 'alien', label: 'Прибулець', fx: { fshift: { shift: 180, mix: 100 }, vibrato: { rate: 6.5, depth: 0.35 }, phaser: { rate: 0.6, mix: 40 }, reverb: { decay: 1.6, mix: 22 } } },
  { id: 'radio', label: 'Рація', fx: { bandpass: { freq: 1700, width: 1.6 }, drive: { kind: 'soft', amount: 16, tone: 4500, mix: 70 }, compressor: { threshold: -26, ratio: 6 }, noise: { hiss: -40, crackle: 12, hum: 0 } } },
  { id: 'phone', label: 'Телефон', fx: { bandpass: { freq: 1400, width: 1.8 }, crush: { bits: 8, rate: 8000, mix: 100 }, drive: { kind: 'soft', amount: 6, mix: 40 } } },
  { id: 'megaphone', label: 'Мегафон', fx: { highpass: { freq: 550 }, lowpass: { freq: 4000 }, drive: { kind: 'hard', amount: 20, tone: 5000, mix: 80 }, reverb: { decay: 0.7, mix: 15 } } },
  { id: 'underwater', label: 'Під водою', fx: { lowpass: { freq: 420, q: 1.6 }, vibrato: { rate: 1.1, depth: 0.35 }, chorus: { rate: 0.4, depth: 5, mix: 40 }, reverb: { decay: 2, damping: 85, mix: 30 } } },
  { id: 'cave', label: 'Печера', fx: { echo: { time: 280, feedback: 25, tone: 3000, mix: 22 }, reverb: { decay: 4.5, predelay: 70, damping: 60, mix: 45 } } },
  { id: 'hall', label: 'Собор', fx: { reverb: { decay: 7, predelay: 45, damping: 30, mix: 45 } } },
  { id: 'room', label: 'Кімната', fx: { reverb: { decay: 0.45, predelay: 4, damping: 55, mix: 25 } } },
  { id: 'monster', label: 'Монстр', fx: { pitch: { semi: -8 }, drive: { kind: 'soft', amount: 10, mix: 35 }, eq: { low: 5 }, reverb: { decay: 1.2, mix: 18 } } },
  { id: 'giant', label: 'Велетень', fx: { pitch: { semi: -12 }, eq: { low: 4, high: -3 }, reverb: { decay: 2.5, predelay: 30, mix: 25 } } },
  { id: 'chipmunk', label: 'Бурундук', fx: { pitch: { semi: 9 } } },
  { id: 'ghost', label: 'Привид', fx: { highpass: { freq: 300 }, vibrato: { rate: 0.6, depth: 0.25 }, echo: { time: 520, feedback: 40, mix: 25 }, reverb: { decay: 6, predelay: 30, damping: 40, mix: 60 } } },
  { id: '8bit', label: '8-біт', fx: { crush: { bits: 5, rate: 11025, mix: 100 } } },
  { id: 'vinyl', label: 'Платівка', fx: { bandpass: { freq: 1600, width: 3.2 }, vibrato: { rate: 0.55, depth: 0.06 }, noise: { hiss: -44, crackle: 55, hum: 0 } } },
  { id: 'lofi', label: 'Лоу-фай', fx: { crush: { bits: 10, rate: 16000 }, lowpass: { freq: 5200 }, vibrato: { rate: 0.8, depth: 0.1 }, noise: { hiss: -46, crackle: 8, hum: 0 } } },
  { id: 'fuzz', label: 'Дисторшн', fx: { drive: { kind: 'fuzz', amount: 30, tone: 6000 }, compressor: { threshold: -18, ratio: 4 } } },
  { id: 'wobble', label: 'Вобл', fx: { autofilter: { kind: 'lowpass', freq: 150, range: 4, rate: 3, q: 6 } } },
  { id: 'slowmo', label: 'Сповільнення', fx: { speed: { rate: 65 }, reverb: { decay: 1.5, mix: 15 } } },
  { id: 'reverse', label: 'Реверс', fx: { reverse: {}, reverb: { decay: 2.5, mix: 35 } } },
];

/** fx.e built from a preset: its effects on (with their settings), everything else off. */
export function presetEffects(id, prev = {}) {
  const pr = PRESETS.find((x) => x.id === id);
  if (!pr) return prev;
  const e = {};
  for (const def of EFFECTS) {
    const keep = prev[def.id];
    if (pr.fx[def.id]) e[def.id] = { ...defaults(def.id), ...pr.fx[def.id], on: true };
    else if (keep) e[def.id] = { ...keep, on: false };
  }
  return e;
}

// for tests
export const _internals = { convolve, reverbIR, stretch, fft };
