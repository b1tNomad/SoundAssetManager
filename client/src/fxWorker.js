// Renders card effects off the main thread, so sliders stay smooth even on long sounds.
import { render } from '../../shared/fx.js';

self.onmessage = (e) => {
  const { id, channels, sr, chain, tail } = e.data;
  try {
    const out = render(channels, sr, chain, { tail });
    self.postMessage({ id, channels: out, sr }, out.map((c) => c.buffer));
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
