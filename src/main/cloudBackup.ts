import { BrowserWindow, dialog, ipcMain } from "electron";
import { readFile, writeFile } from "node:fs/promises";

import { ServiceStatus_Type } from "../shared/gen/daemon/started_service_pb";
import { CLOUD_BACKUP_CALL } from "../shared/ipc";
import type { CloudBackupAccount, OverlayFlags, ProfilesResult } from "../shared/ipc";
import { managedService } from "./daemon";
import {
  applyPortableSettings,
  loadOverlaySettings,
  loadWebDavAccount,
  saveWebDavAccount,
  snapshotPortableSettings,
} from "./overlaySettings";
import {
  encodeProfiles,
  encodeSettings,
  isPortableManifest,
  MANIFEST_NAME,
  manifest,
  parseProfiles,
  parseSettings,
  PROFILES_NAME,
  SETTINGS_NAME,
  type PortableProfile,
} from "./portableCloud";
import {
  importPortableProfiles,
  profilesState,
  readProfileContent,
} from "./profiles";
import { requireHttpsUrl } from "./remoteUrlGuard";
import { daemonState } from "./state";
import { webdavDownload, webdavProbe, webdavUpload } from "./webdavClient";
import { createZip, isZipBuffer, readZip, type ZipEntry } from "./zipArchive";

async function stopRunningService(): Promise<void> {
  const status = daemonState.status;
  if (
    managedService !== null &&
    (status === ServiceStatus_Type.STARTED || status === ServiceStatus_Type.STARTING)
  ) {
    await managedService.stopService({});
  }
}

async function buildArchive(): Promise<Buffer> {
  const live = profilesState();
  const portable: PortableProfile[] = [];
  const configs = new Map<string, Uint8Array>();
  for (const [index, profile] of live.profiles.entries()) {
    const content = await readProfileContent(profile.id);
    const rel = `configs/${profile.id}.json`;
    configs.set(rel, Buffer.from(content, "utf-8"));
    portable.push({
      id: profile.id,
      name: profile.name,
      type: profile.type,
      remoteUrl: profile.remoteUrl ?? "",
      autoUpdate: profile.autoUpdate,
      autoUpdateIntervalMinutes: profile.autoUpdateIntervalMinutes,
      lastUpdated: profile.lastUpdated ?? 0,
      icon: null,
      config: rel,
      order: index,
    });
  }
  const settings = snapshotPortableSettings();
  const time = Date.now();
  const entries: ZipEntry[] = [
    { name: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest("windows", time)), "utf-8") },
    {
      name: PROFILES_NAME,
      data: Buffer.from(encodeProfiles(live.selectedId, portable), "utf-8"),
    },
    { name: SETTINGS_NAME, data: Buffer.from(encodeSettings(settings), "utf-8") },
  ];
  for (const [name, data] of configs) {
    entries.push({ name, data });
  }
  return createZip(entries);
}

function overlayFlagsFromSettings(): OverlayFlags {
  const settings = loadOverlaySettings();
  return {
    chinaDirect: settings.chinaDirect,
    adsBlock: settings.adsBlock,
    strictRoute: settings.strictRoute,
    dnsProtect: settings.dnsProtect,
    disableIpv6: settings.disableIpv6,
    disableQuic: settings.disableQuic,
    excludeCnQuic: settings.excludeCnQuic,
    webrtcProtect: settings.webrtcProtect,
    onDemand: settings.onDemand,
    configNormalize: settings.configNormalize,
    autoRedirect: settings.autoRedirect,
  };
}

async function restoreFromZip(
  data: Uint8Array,
  compat: boolean,
): Promise<{ imported: number; skipped: number }> {
  const files = readZip(data);
  const manifestRaw = files.get(MANIFEST_NAME)?.toString("utf-8") ?? "";
  const profilesRaw = files.get(PROFILES_NAME)?.toString("utf-8") ?? "";
  if (profilesRaw === "") {
    throw new Error(
      "这是旧版 Android SQLite 备份，Windows 读不了。请在当前手机 AngelaBox 里重新云备份一次。",
    );
  }
  if (manifestRaw !== "" && !isPortableManifest(manifestRaw)) {
    throw new Error("备份格式不是 angelabox-cloud/1");
  }
  const parsed = parseProfiles(profilesRaw);
  const imported = [];
  for (const profile of parsed.profiles) {
    const fileName = profile.config.replace(/^configs\//, "");
    const content = files.get(profile.config) ?? files.get(`configs/${fileName}`);
    if (content === undefined) {
      continue;
    }
    if (profile.remoteUrl !== "") {
      try {
        requireHttpsUrl(profile.remoteUrl);
      } catch {
        continue;
      }
    }
    imported.push({
      id: profile.id,
      name: profile.name,
      type: profile.type,
      remoteUrl: profile.remoteUrl === "" ? undefined : profile.remoteUrl,
      autoUpdate: profile.autoUpdate,
      autoUpdateIntervalMinutes: profile.autoUpdateIntervalMinutes,
      lastUpdated: profile.lastUpdated === 0 ? undefined : profile.lastUpdated,
      content: content.toString("utf-8"),
    });
  }
  if (imported.length === 0) {
    throw new Error("备份里没有可用的配置，或远程地址未通过 HTTPS 校验");
  }
  if (!compat) {
    await stopRunningService();
  }
  const result = await importPortableProfiles({
    mode: compat ? "compat" : "overwrite",
    selected: parsed.selected,
    profiles: imported,
  });
  if (!compat) {
    const keepPassword = loadWebDavAccount().password;
    const settingsRaw = files.get(SETTINGS_NAME)?.toString("utf-8") ?? "{}";
    applyPortableSettings(parseSettings(settingsRaw), keepPassword);
  }
  return result;
}

const handlers: Record<string, (...args: never[]) => Promise<unknown>> = {
  async get(): Promise<{ account: CloudBackupAccount; overlay: OverlayFlags }> {
    const account = loadWebDavAccount();
    return {
      account: {
        url: account.url,
        user: account.user,
        password: account.password,
        remoteFile: account.remoteFile,
      },
      overlay: overlayFlagsFromSettings(),
    };
  },

  async saveAccount(account: CloudBackupAccount): Promise<void> {
    saveWebDavAccount({
      url: account.url,
      user: account.user,
      password: account.password,
      remoteFile: account.remoteFile.trim() || "backup.zip",
    });
  },

  async saveOverlay(flags: OverlayFlags): Promise<void> {
    const current = loadOverlaySettings();
    applyPortableSettings(
      {
        ...current,
        chinaDirect: flags.chinaDirect,
        adsBlock: flags.adsBlock,
        strictRoute: flags.strictRoute,
        dnsProtect: flags.dnsProtect,
        disableIpv6: flags.disableIpv6,
        disableQuic: flags.disableQuic,
        excludeCnQuic: flags.excludeCnQuic,
        webrtcProtect: flags.webrtcProtect,
        onDemand: flags.onDemand,
        configNormalize: flags.configNormalize,
        autoRedirect: flags.autoRedirect,
      },
      loadWebDavAccount().password,
    );
  },

  async probe(): Promise<boolean> {
    const account = loadWebDavAccount();
    return await webdavProbe(account.url, account.user, account.password, account.remoteFile);
  },

  async upload(): Promise<void> {
    const account = loadWebDavAccount();
    const zip = await buildArchive();
    await webdavUpload(account.url, account.user, account.password, account.remoteFile, zip);
  },

  async download(compat: boolean): Promise<{ imported: number; skipped: number }> {
    const account = loadWebDavAccount();
    const data = await webdavDownload(
      account.url,
      account.user,
      account.password,
      account.remoteFile,
    );
    if (!isZipBuffer(data)) {
      throw new Error(
        "下载内容不是 ZIP 备份。请确认远程文件名正确，并且手机已用当前版本重新备份。",
      );
    }
    return await restoreFromZip(data, compat === true);
  },

  async exportFile(): Promise<boolean> {
    const window = BrowserWindow.getFocusedWindow();
    const zip = await buildArchive();
    const options = {
      defaultPath: "backup.zip",
      filters: [{ name: "AngelaBox backup", extensions: ["zip"] }],
    };
    const result =
      window === null
        ? await dialog.showSaveDialog(options)
        : await dialog.showSaveDialog(window, options);
    if (result.canceled || result.filePath === undefined) {
      return false;
    }
    await writeFile(result.filePath, zip);
    return true;
  },

  async importFile(compat: boolean): Promise<{ imported: number; skipped: number } | null> {
    const window = BrowserWindow.getFocusedWindow();
    const options = {
      filters: [{ name: "AngelaBox backup", extensions: ["zip"] }],
      properties: ["openFile" as const],
    };
    const result =
      window === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const data = await readFile(result.filePaths[0]);
    return await restoreFromZip(data, compat === true);
  },
};

export function registerCloudBackup(): void {
  ipcMain.handle(
    CLOUD_BACKUP_CALL,
    async (_event, method: string, ...callArguments: unknown[]): Promise<ProfilesResult> => {
      const handler = handlers[method];
      if (handler === undefined) {
        return { ok: false, error: `unknown cloudBackup method: ${method}` };
      }
      try {
        const value = await handler(...(callArguments as never[]));
        return { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}
