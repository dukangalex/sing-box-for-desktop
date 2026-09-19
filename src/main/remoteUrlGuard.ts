import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "instance-data",
]);

function isBlockedIpv4(bytes: Uint8Array): boolean {
  if (bytes.length !== 4) {
    return true;
  }
  const [a, b] = bytes;
  if (a === 127 || a === 0 || a === 10) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  if (a >= 224) {
    return true;
  }
  return false;
}

function isBlockedIpv6(bytes: Uint8Array): boolean {
  if (bytes.length !== 16) {
    return true;
  }
  const loopback = bytes.every((value, index) => (index === 15 ? value === 1 : value === 0));
  if (loopback) {
    return true;
  }
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) {
    return true;
  }
  if ((bytes[0] & 0xfe) === 0xfc) {
    return true;
  }
  if (bytes[0] === 0xff) {
    return true;
  }
  const v4mapped =
    bytes[0] === 0 &&
    bytes[1] === 0 &&
    bytes[2] === 0 &&
    bytes[3] === 0 &&
    bytes[4] === 0 &&
    bytes[5] === 0 &&
    bytes[6] === 0 &&
    bytes[7] === 0 &&
    bytes[8] === 0 &&
    bytes[9] === 0 &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (v4mapped) {
    return isBlockedIpv4(bytes.subarray(12));
  }
  return false;
}

function parseLiteral(host: string): Uint8Array | null {
  const family = isIP(host);
  if (family === 0) {
    return null;
  }
  if (family === 4) {
    return Uint8Array.from(host.split(".").map((part) => Number(part)));
  }
  const cleaned = host.replace(/^\[/, "").replace(/\]$/, "");
  const expanded = cleaned.includes("::")
    ? (() => {
        const [head, tail] = cleaned.split("::");
        const headParts = head === "" ? [] : head.split(":");
        const tailParts = tail === "" ? [] : tail.split(":");
        const missing = 8 - headParts.length - tailParts.length;
        return [...headParts, ...Array.from({ length: missing }, () => "0"), ...tailParts];
      })()
    : cleaned.split(":");
  if (expanded.length !== 8) {
    return null;
  }
  const bytes = new Uint8Array(16);
  expanded.forEach((part, index) => {
    const value = Number.parseInt(part || "0", 16);
    bytes[index * 2] = (value >> 8) & 0xff;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
}

function hostAllowed(host: string): void {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  if (normalized === "" || BLOCKED_HOSTS.has(normalized)) {
    throw new Error("禁止访问本地或元数据地址");
  }
  const literal = parseLiteral(normalized.replace(/^\[/, "").replace(/\]$/, ""));
  if (literal !== null) {
    const blocked = literal.length === 4 ? isBlockedIpv4(literal) : isBlockedIpv6(literal);
    if (blocked) {
      throw new Error("禁止访问本地、链路本地或云元数据地址");
    }
  }
}

export function requireHttpsUrl(raw: string): URL {
  const value = raw.trim();
  if (value === "" || /[\s]/.test(value)) {
    throw new Error("URL 含非法空白");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("无法解析 URL");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("URL 不能包含用户名密码");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("仅允许 HTTPS");
  }
  hostAllowed(parsed.hostname);
  return parsed;
}

export async function requirePublicHttps(raw: string): Promise<URL> {
  const parsed = requireHttpsUrl(raw);
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (isIP(host) !== 0) {
    return parsed;
  }
  const results = await lookup(host, { all: true, verbatim: true });
  if (results.length === 0) {
    throw new Error("无法解析主机，已拒绝");
  }
  for (const result of results) {
    const bytes = parseLiteral(result.address);
    if (bytes === null) {
      throw new Error("主机解析到禁止地址，已拒绝");
    }
    const blocked = bytes.length === 4 ? isBlockedIpv4(bytes) : isBlockedIpv6(bytes);
    if (blocked) {
      throw new Error("主机解析到禁止地址，已拒绝");
    }
  }
  return parsed;
}
