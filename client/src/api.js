async function handle(r) {
  let data = null;
  try {
    data = await r.json();
  } catch {}
  if (!r.ok) {
    const e = new Error((data && data.error) || `Помилка ${r.status}`);
    e.details = data && data.details;
    throw e;
  }
  return data;
}

const send = (method, url, body) =>
  fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(handle, () => {
    throw new Error('Сервер не відповідає. Він запущений? (npm start)');
  });

export const api = {
  state: () => send('GET', '/api/state'),
  importFile: (file, batch, folder = '') =>
    fetch(`/api/import?name=${encodeURIComponent(file.name)}&batch=${encodeURIComponent(batch)}&folder=${encodeURIComponent(folder)}`, { method: 'POST', body: file }).then(handle, () => {
      throw new Error('Сервер не відповідає');
    }),
  patchSound: (id, patch) => send('PATCH', `/api/sounds/${id}`, patch),
  deleteSound: (id) => send('DELETE', `/api/sounds/${id}`),
  saveBoards: (boards, activeBoard) => send('PUT', '/api/boards', { boards, activeBoard }),
  renameFolder: (from, to) => send('POST', '/api/folders/rename', { from, to }),
  saveSettings: (s) => send('PUT', '/api/settings', s),
  process: (req) => send('POST', '/api/process', req),
  exportFiles: (req) => send('POST', '/api/export', req),
  reveal: (req) => send('POST', '/api/reveal', req),
  download: (req) => send('POST', '/api/download', req),
};
