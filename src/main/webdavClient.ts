import { requirePublicHttps } from "./remoteUrlGuard";

const USER_AGENT = "AngelaBox-WebDAV";
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;

function joinUrl(base: string, name: string): string {
  return `${base.replace(/\/+$/, "")}/${name.replace(/^\/+/, "")}`;
}

function authHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf-8").toString("base64")}`;
}

async function webdavFetch(
  url: string,
  username: string,
  password: string,
  init: RequestInit,
): Promise<Response> {
  await requirePublicHttps(url);
  return await fetch(url, {
    ...init,
    redirect: "manual",
    headers: {
      ...(init.headers ?? {}),
      Authorization: authHeader(username, password),
      "User-Agent": USER_AGENT,
      Connection: "close",
    },
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
}

function authFailedMessage(baseUrl: string, code: number, body: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = baseUrl;
  }
  const extra = host.toLowerCase().includes("koofr")
    ? " Koofr 请使用账号邮箱 + 在 Koofr 设置里生成的应用密码，不是登录密码。"
    : " 请核对用户名/密码；部分网盘需要单独的应用密码。";
  const snippet = body.trim().slice(0, 80);
  return `认证失败 HTTP ${code}。${extra}${snippet === "" ? "" : ` 服务器：${snippet}`}`;
}

async function readError(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "";
  }
}

export async function webdavUpload(
  baseUrl: string,
  username: string,
  password: string,
  remoteName: string,
  body: Uint8Array,
): Promise<void> {
  if (username.trim() === "" || password === "") {
    throw new Error("请填写 WebDAV 用户名和密码");
  }
  const url = joinUrl((await requirePublicHttps(baseUrl)).toString(), remoteName);
  const response = await webdavFetch(url, username, password, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      Overwrite: "T",
    },
    body: Buffer.from(body),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(authFailedMessage(baseUrl, response.status, await readError(response)));
  }
  if (response.status < 200 || response.status > 299) {
    throw new Error(`WebDAV 上传失败 HTTP ${response.status}${await readError(response)}`);
  }
}

export async function webdavDownload(
  baseUrl: string,
  username: string,
  password: string,
  remoteName: string,
): Promise<Buffer> {
  if (username.trim() === "" || password === "") {
    throw new Error("请填写 WebDAV 用户名和密码");
  }
  const url = joinUrl((await requirePublicHttps(baseUrl)).toString(), remoteName);
  const response = await webdavFetch(url, username, password, { method: "GET" });
  if (response.status === 401 || response.status === 403) {
    throw new Error(authFailedMessage(baseUrl, response.status, await readError(response)));
  }
  if (response.status < 200 || response.status > 299) {
    throw new Error(`WebDAV 下载失败 HTTP ${response.status}`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  if (response.body === null) {
    throw new Error("WebDAV 下载为空");
  }
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_DOWNLOAD_BYTES) {
      throw new Error("WebDAV 下载过大");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export async function webdavProbe(
  baseUrl: string,
  username: string,
  password: string,
  remoteName = "",
): Promise<boolean> {
  if (username.trim() === "" || password === "") {
    throw new Error("请填写 WebDAV 用户名和密码");
  }
  const base = (await requirePublicHttps(baseUrl)).toString();
  const fileUrl = remoteName.trim() === "" ? base : joinUrl(base, remoteName);
  const attempts: Array<{ url: string; method: string }> = [
    { url: fileUrl, method: "HEAD" },
    { url: base, method: "OPTIONS" },
    { url: base, method: "HEAD" },
    { url: base, method: "GET" },
  ];
  let lastDetail = "no response";
  let sawAuth = false;
  for (const attempt of attempts) {
    try {
      const response = await webdavFetch(attempt.url, username, password, {
        method: attempt.method,
      });
      const code = response.status;
      lastDetail = `${attempt.method} HTTP ${code}`;
      if (code === 401 || code === 403) {
        sawAuth = true;
        lastDetail = authFailedMessage(baseUrl, code, await readError(response));
        continue;
      }
      if (code >= 300 && code < 400) {
        throw new Error("连通性失败：重定向到不安全主机");
      }
      if (code === 405) {
        continue;
      }
      if ((code >= 200 && code < 300) || code === 404 || code === 410) {
        return true;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("重定向")) {
        throw error;
      }
      lastDetail = error instanceof Error ? error.message : String(error);
    }
  }
  if (sawAuth) {
    throw new Error(lastDetail);
  }
  throw new Error(`连通性失败：${lastDetail}`);
}
