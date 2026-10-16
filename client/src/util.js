export const rid = (p = '') => p + Math.random().toString(36).slice(2, 10);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** 0:02.34 / 1:05.10 */
export function fmtTime(t, digits = 2) {
  if (!Number.isFinite(t)) return '–';
  t = Math.max(0, t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = s.toFixed(digits).padStart(digits ? digits + 3 : 2, '0');
  return `${m}:${ss}`;
}

export function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'щойно';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} хв тому`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} год тому`;
  return new Date(ts).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
}

export const ORIGIN = {
  import: 'імпорт',
  trim: 'обрізка',
  cut: 'виріз',
  fade: 'фейди',
  split: 'шматок',
  concat: 'склейка',
  crossfade: 'кросфейд',
  overlay: 'накладення',
  render: 'ефекти',
};

export const media = (s) => '/media/' + encodeURIComponent(s.file);

/** Ask the browser to save a URL as a file (goes to Downloads). */
export function downloadUrl(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name || '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export const DND_SOUNDS = 'application/x-esm-sounds';
export const DND_CARD = 'application/x-esm-card';

export function loadLocal(key, def) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v && typeof v === 'object' ? { ...def, ...v } : def;
  } catch {
    return def;
  }
}
export function saveLocal(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}
