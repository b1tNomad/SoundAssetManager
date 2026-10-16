// Minimal ZIP writer (no compression — audio barely compresses anyway). No dependencies.
import fs from 'node:fs';
import zlib from 'node:zlib';

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// zlib.crc32 exists in Node 20.15+/22.2+; fall back to a table for older versions.
const crcChunk =
  typeof zlib.crc32 === 'function'
    ? (crc, buf) => zlib.crc32(buf, crc)
    : (crc, buf) => {
        let c = (crc ^ 0xffffffff) >>> 0;
        for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
      };

async function crcFile(file) {
  let crc = 0;
  for await (const chunk of fs.createReadStream(file)) crc = crcChunk(crc, chunk);
  return crc >>> 0;
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** entries: [{ path, name }] — `name` is the file name inside the archive (UTF-8). */
export async function writeZip(entries, dest) {
  if (entries.length > 65000) throw new Error('Забагато файлів для одного архіву');
  const out = fs.createWriteStream(dest);
  let offset = 0;
  let failed = null;
  out.on('error', (e) => (failed = e));
  const write = (buf) => {
    if (failed) throw failed;
    offset += buf.length;
    return out.write(buf) ? null : new Promise((resolve) => out.once('drain', resolve));
  };
  const central = [];
  const { time, date } = dosTime(new Date());

  for (const e of entries) {
    const size = fs.statSync(e.path).size;
    if (offset + size > 0xfffffff0) throw new Error('Архів вийшов би більшим за 4 ГБ — вибери менше файлів');
    const crc = await crcFile(e.path);
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const headerAt = offset;
    await write(local);
    await write(name);
    for await (const chunk of fs.createReadStream(e.path)) await write(chunk);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4); // made by
    c.writeUInt16LE(20, 6); // needed
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(size, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(headerAt, 42);
    central.push(c, name);
  }

  const cdStart = offset;
  for (const b of central) await write(b);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - cdStart, 12);
  end.writeUInt32LE(cdStart, 16);
  await write(end);
  await new Promise((resolve, reject) => {
    out.once('error', reject);
    out.end(resolve);
  });
  if (failed) throw failed;
  return offset;
}
