import { deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const MAX_ENTRIES = 512;
const MAX_ENTRY_SIZE = 32 * 1024 * 1024;
const MAX_TOTAL_SIZE = 128 * 1024 * 1024;

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function writeU16(target: Buffer, offset: number, value: number): void {
  target.writeUInt16LE(value, offset);
}

function writeU32(target: Buffer, offset: number, value: number): void {
  target.writeUInt32LE(value, offset);
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function assertSafeName(name: string): string {
  const normalized = name.replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    normalized === "" ||
    normalized.includes("..") ||
    normalized.startsWith("/") ||
    normalized.includes("\0")
  ) {
    throw new Error(`非法备份路径：${name}`);
  }
  return normalized;
}

export function createZip(entries: ZipEntry[]): Buffer {
  if (entries.length > MAX_ENTRIES) {
    throw new Error("备份包含过多文件");
  }
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  let total = 0;
  for (const entry of entries) {
    const name = assertSafeName(entry.name);
    const data = entry.data;
    if (data.byteLength > MAX_ENTRY_SIZE) {
      throw new Error(`备份文件过大：${name}`);
    }
    total += data.byteLength;
    if (total > MAX_TOTAL_SIZE) {
      throw new Error("备份展开大小超过限制");
    }
    const nameBytes = Buffer.from(name, "utf-8");
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.byteLength + compressed.byteLength);
    writeU32(local, 0, LOCAL_SIGNATURE);
    writeU16(local, 4, 20);
    writeU16(local, 8, 8);
    writeU32(local, 14, crc);
    writeU32(local, 18, compressed.byteLength);
    writeU32(local, 22, data.byteLength);
    writeU16(local, 26, nameBytes.byteLength);
    nameBytes.copy(local, 30);
    compressed.copy(local, 30 + nameBytes.byteLength);
    const central = Buffer.alloc(46 + nameBytes.byteLength);
    writeU32(central, 0, CENTRAL_SIGNATURE);
    writeU16(central, 4, 20);
    writeU16(central, 6, 20);
    writeU16(central, 10, 8);
    writeU32(central, 16, crc);
    writeU32(central, 20, compressed.byteLength);
    writeU32(central, 24, data.byteLength);
    writeU16(central, 28, nameBytes.byteLength);
    writeU32(central, 42, offset);
    nameBytes.copy(central, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.byteLength;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  writeU32(eocd, 0, EOCD_SIGNATURE);
  writeU16(eocd, 8, entries.length);
  writeU16(eocd, 10, entries.length);
  writeU32(eocd, 12, centralDirectory.byteLength);
  writeU32(eocd, 16, offset);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

export function isZipBuffer(data: Uint8Array): boolean {
  return data.byteLength >= 4 && data[0] === 0x50 && data[1] === 0x4b;
}

export function readZip(data: Uint8Array): Map<string, Buffer> {
  if (!isZipBuffer(data)) {
    throw new Error("不是有效的 ZIP 备份（可能下到了网页错误页）。请重新备份后再恢复。");
  }
  if (data.byteLength > MAX_TOTAL_SIZE) {
    throw new Error("备份展开大小超过限制");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.byteLength - 22; i >= 0 && i >= data.byteLength - 22 - 65535; i -= 1) {
    if (u32(view, i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("不是有效的 ZIP 备份");
  }
  const count = u16(view, eocd + 8);
  if (count > MAX_ENTRIES) {
    throw new Error("备份包含过多文件");
  }
  let central = u32(view, eocd + 16);
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (central + 46 > data.byteLength || u32(view, central) !== CENTRAL_SIGNATURE) {
      throw new Error("ZIP 目录损坏");
    }
    const method = u16(view, central + 10);
    const compressedSize = u32(view, central + 20);
    const uncompressedSize = u32(view, central + 24);
    const nameLength = u16(view, central + 28);
    const extraLength = u16(view, central + 30);
    const commentLength = u16(view, central + 32);
    const localOffset = u32(view, central + 42);
    const name = Buffer.from(data.subarray(central + 46, central + 46 + nameLength)).toString("utf-8");
    const safe = assertSafeName(name);
    if (uncompressedSize > MAX_ENTRY_SIZE) {
      throw new Error(`备份文件过大：${safe}`);
    }
    if (u32(view, localOffset) !== LOCAL_SIGNATURE) {
      throw new Error("ZIP 条目损坏");
    }
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    const payloadOffset = localOffset + 30 + localNameLength + localExtraLength;
    const payload = data.subarray(payloadOffset, payloadOffset + compressedSize);
    let raw: Buffer;
    if (method === 0) {
      raw = Buffer.from(payload);
    } else if (method === 8) {
      raw = inflateRawSync(payload);
    } else {
      throw new Error(`不支持的 ZIP 压缩方式：${method}`);
    }
    if (raw.byteLength !== uncompressedSize) {
      throw new Error("ZIP 解压大小不匹配");
    }
    total += raw.byteLength;
    if (total > MAX_TOTAL_SIZE) {
      throw new Error("备份展开大小超过限制");
    }
    out.set(safe, raw);
    central += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}
