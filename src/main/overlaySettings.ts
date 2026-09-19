import { Preference, parseBooleanPreference } from "./database";
import {
  DEFAULT_OVERLAY,
  type PortableChainBinding,
  type PortableSettings,
  type PortableWebDav,
} from "./portableCloud";

function parseObject(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    throw new Error("invalid overlay preference");
  }
  return value;
}

function parseString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("invalid string preference");
  }
  return value;
}

const chinaDirectPreference = new Preference("overlay_china_direct", DEFAULT_OVERLAY.chinaDirect, parseBooleanPreference);
const adsBlockPreference = new Preference("overlay_ads_block", DEFAULT_OVERLAY.adsBlock, parseBooleanPreference);
const strictRoutePreference = new Preference("overlay_strict_route", DEFAULT_OVERLAY.strictRoute, parseBooleanPreference);
const dnsProtectPreference = new Preference("overlay_dns_protect", DEFAULT_OVERLAY.dnsProtect, parseBooleanPreference);
const disableIpv6Preference = new Preference("overlay_disable_ipv6", DEFAULT_OVERLAY.disableIpv6, parseBooleanPreference);
const disableQuicPreference = new Preference("overlay_disable_quic", DEFAULT_OVERLAY.disableQuic, parseBooleanPreference);
const excludeCnQuicPreference = new Preference("overlay_exclude_cn_quic", DEFAULT_OVERLAY.excludeCnQuic, parseBooleanPreference);
const webrtcProtectPreference = new Preference("overlay_webrtc_protect", DEFAULT_OVERLAY.webrtcProtect, parseBooleanPreference);
const onDemandPreference = new Preference("overlay_on_demand", DEFAULT_OVERLAY.onDemand, parseBooleanPreference);
const configNormalizePreference = new Preference("overlay_config_normalize", DEFAULT_OVERLAY.configNormalize, parseBooleanPreference);
const autoRedirectPreference = new Preference("overlay_auto_redirect", DEFAULT_OVERLAY.autoRedirect, parseBooleanPreference);
const chainBindingsPreference = new Preference<PortableChainBinding[]>(
  "overlay_chain_bindings",
  [],
  (value) => {
    if (!Array.isArray(value)) {
      throw new Error("invalid chain bindings");
    }
    return value.flatMap((item) => {
      if (typeof item !== "object" || item === null) {
        return [];
      }
      const record = item as Record<string, unknown>;
      const profileId = typeof record.profileId === "string" ? record.profileId.trim() : "";
      const landingProfileId =
        typeof record.landingProfileId === "string" ? record.landingProfileId.trim() : "";
      const landingTag = typeof record.landingTag === "string" ? record.landingTag.trim() : "";
      if (profileId === "" || landingProfileId === "" || landingTag === "") {
        return [];
      }
      return [
        {
          profileId,
          entryTag: typeof record.entryTag === "string" ? record.entryTag.trim() : "",
          landingProfileId,
          landingTag,
        },
      ];
    });
  },
);
const overlayScriptsPreference = new Preference<unknown[]>("overlay_scripts", [], (value) => {
  if (!Array.isArray(value)) {
    throw new Error("invalid overlay scripts");
  }
  return value;
});
const overlayScriptBindingsPreference = new Preference<Record<string, string[]>>(
  "overlay_script_bindings",
  {},
  (value) => {
    const record = parseObject(value) as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [key, ids] of Object.entries(record)) {
      if (!Array.isArray(ids)) {
        continue;
      }
      out[key] = ids.filter((id): id is string => typeof id === "string" && id.trim() !== "");
    }
    return out;
  },
);
const webdavUrlPreference = new Preference("webdav_url", "", parseString);
const webdavUserPreference = new Preference("webdav_user", "", parseString);
const webdavPasswordPreference = new Preference("webdav_password", "", parseString);
const webdavRemoteFilePreference = new Preference("webdav_remote_file", "backup.zip", parseString);

export function loadOverlaySettings(): PortableSettings {
  return {
    chinaDirect: chinaDirectPreference.get(),
    adsBlock: adsBlockPreference.get(),
    strictRoute: strictRoutePreference.get(),
    dnsProtect: dnsProtectPreference.get(),
    disableIpv6: disableIpv6Preference.get(),
    disableQuic: disableQuicPreference.get(),
    excludeCnQuic: excludeCnQuicPreference.get(),
    webrtcProtect: webrtcProtectPreference.get(),
    onDemand: onDemandPreference.get(),
    configNormalize: configNormalizePreference.get(),
    autoRedirect: autoRedirectPreference.get(),
    chainBindings: chainBindingsPreference.get(),
    overlayScripts: overlayScriptsPreference.get(),
    overlayScriptBindings: overlayScriptBindingsPreference.get(),
    webdav: loadWebDavAccount(),
  };
}

export function loadWebDavAccount(): PortableWebDav & { password: string } {
  const remote = webdavRemoteFilePreference.get().trim();
  return {
    url: webdavUrlPreference.get().trim(),
    user: webdavUserPreference.get().trim(),
    remoteFile: remote === "" ? "backup.zip" : remote,
    password: webdavPasswordPreference.get(),
  };
}

export function saveWebDavAccount(account: {
  url: string;
  user: string;
  password: string;
  remoteFile: string;
}): void {
  webdavUrlPreference.set(account.url.trim());
  webdavUserPreference.set(account.user.trim());
  webdavPasswordPreference.set(account.password);
  webdavRemoteFilePreference.set(account.remoteFile.trim() || "backup.zip");
}

export function applyPortableSettings(settings: PortableSettings, keepPassword: string): void {
  chinaDirectPreference.set(settings.chinaDirect);
  adsBlockPreference.set(settings.adsBlock);
  strictRoutePreference.set(settings.strictRoute);
  dnsProtectPreference.set(settings.dnsProtect);
  disableIpv6Preference.set(settings.disableIpv6);
  disableQuicPreference.set(settings.disableQuic);
  excludeCnQuicPreference.set(settings.excludeCnQuic);
  webrtcProtectPreference.set(settings.webrtcProtect);
  onDemandPreference.set(settings.onDemand);
  configNormalizePreference.set(settings.configNormalize);
  autoRedirectPreference.set(settings.autoRedirect);
  chainBindingsPreference.set(settings.chainBindings);
  overlayScriptsPreference.set(settings.overlayScripts);
  overlayScriptBindingsPreference.set(settings.overlayScriptBindings);
  if (settings.webdav.url !== "") {
    webdavUrlPreference.set(settings.webdav.url);
  }
  if (settings.webdav.user !== "") {
    webdavUserPreference.set(settings.webdav.user);
  }
  if (settings.webdav.remoteFile !== "") {
    webdavRemoteFilePreference.set(settings.webdav.remoteFile);
  }
  if (keepPassword !== "") {
    webdavPasswordPreference.set(keepPassword);
  }
}

export function snapshotPortableSettings(): PortableSettings {
  const loaded = loadOverlaySettings();
  loaded.webdav = {
    url: loaded.webdav.url,
    user: loaded.webdav.user,
    remoteFile: loaded.webdav.remoteFile,
  };
  return loaded;
}
