/**
 * BE-132 — minimal store-only ZIP writer (PKWARE APPNOTE 4.4.x subset).
 *
 * Deliberately dependency-free: the export bundle is a handful of small JSON
 * files for ONE user, so "stored" (method 0, no compression) is fine and
 * keeps the archive byte-deterministic for a given input. Readable by every
 * unzip tool (only local headers + central directory + EOCD, no ZIP64).
 */

export interface ZipEntry {
  /** Forward-slash relative path inside the archive. */
  name: string;
  data: Buffer;
}

// ── CRC-32 (IEEE 802.3, reflected) ───────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── DOS date/time (ZIP's native timestamp format) ────────────────────────────

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time:
      (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

// ── archive builder ──────────────────────────────────────────────────────────

/** Build a complete .zip buffer from entries (store-only, UTF-8 names). */
export function buildZip(entries: ZipEntry[], timestamp: Date = new Date(0)): Buffer {
  const { time, date } = dosDateTime(timestamp);
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // general purpose: UTF-8 names
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed size (== raw for stored)
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    parts.push(local, name, entry.data);

    const cdir = Buffer.alloc(46);
    cdir.writeUInt32LE(0x02014b50, 0); // central directory signature
    cdir.writeUInt16LE(20, 4); // version made by
    cdir.writeUInt16LE(20, 6); // version needed
    cdir.writeUInt16LE(0x0800, 8);
    cdir.writeUInt16LE(0, 10); // method: stored
    cdir.writeUInt16LE(time, 12);
    cdir.writeUInt16LE(date, 14);
    cdir.writeUInt32LE(crc, 16);
    cdir.writeUInt32LE(size, 20);
    cdir.writeUInt32LE(size, 24);
    cdir.writeUInt16LE(name.length, 28);
    // extra/comment/disk/attrs all zero (offsets 30…41)
    cdir.writeUInt32LE(offset, 42); // local header offset
    central.push(cdir, name);

    offset += 30 + name.length + size;
  }

  const centralSize = central.reduce((sum, b) => sum + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16); // central directory offset
  return Buffer.concat([...parts, ...central, eocd]);
}
