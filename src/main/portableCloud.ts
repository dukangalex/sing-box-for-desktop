export const PORTABLE_FORMAT = "angelabox-cloud/1";
export const PORTABLE_APP = "angelabox";
export const PORTABLE_VERSION = 3;
export const MANIFEST_NAME = "manifest.json";
export const PROFILES_NAME = "profiles.json";
export const SETTINGS_NAME = "settings.json";

export interface PortableProfile {
  id: string;
  name: string;
  type: "local" | "remote";
  remoteUrl: string;
  autoUpdate: boolean;
  autoUpdateIntervalMinutes: number;
  lastUpdated: number;
  icon: string | null;
  config: string;
  order: number;
}

export interface PortableChainBinding {
  profileId: string;
  entryTag: string;
  landingProfileId: string;
  landingTag: string;
}

export interface PortableWebDav {
  url: string;
  user: string;
  remoteFile: string;
}

export interface PortableSettings {
  chinaDirect: boolean;
  adsBlock: boolean;
  strictRoute: boolean;
  dnsProtect: boolean;
  disableIpv6: boolean;
  disableQuic: boolean;
  excludeCnQuic: boolean;
  webrtcProtect: boolean;
  onDemand: boolean;
  configNormalize: boolean;
  autoRedirect: boolean;
  chainBindings: PortableChainBinding[];
  overlayScripts: unknown[];
  overlayScriptBindings: Record<string, string[]>;
  webdav: PortableWebDav;
}

export interface PortableArchive {
  writtenBy: string;
  time: number;
  selected: string | null;
  profiles: PortableProfile[];
  configs: Map<string, Buffer>;
  settings: PortableSettings;
}

export const DEFAULT_OVERLAY: Omit<PortableSettings, "chainBindings" | "overlayScripts" | "overlayScriptBindings" | "webdav"> = {
  chinaDirect: true,
  adsBlock: true,
  strictRoute: true,
  dnsProtect: true,
  disableIpv6: true,
  disableQuic: true,
  excludeCnQuic: true,
  webrtcProtect: true,
  onDemand: true,
  configNormalize: true,
  autoRedirect: false,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function manifest(writtenBy: string, time = Date.now()): Record<string, unknown> {
  return {
    version: PORTABLE_VERSION,
    format: PORTABLE_FORMAT,
    app: PORTABLE_APP,
    written_by: writtenBy,
    time,
    secrets: "omitted",
  };
}

export function isPortableManifest(raw: string): boolean {
  if (raw.trim() === "") {
    return false;
  }
  try {
    const obj = JSON.parse(raw) as unknown;
    const record = asRecord(obj);
    if (record === null) {
      return false;
    }
    const format = asString(record.format);
    const version = asNumber(record.version, 0);
    const app = asString(record.app);
    return format === PORTABLE_FORMAT || (version >= PORTABLE_VERSION && (app === PORTABLE_APP || app === "chainbox"));
  } catch {
    return false;
  }
}

export function encodeProfiles(selected: string | null, profiles: PortableProfile[]): string {
  return JSON.stringify({
    selected,
    profiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      type: profile.type,
      remote_url: profile.remoteUrl,
      auto_update: profile.autoUpdate,
      auto_update_interval_minutes: profile.autoUpdateIntervalMinutes,
      last_updated: profile.lastUpdated,
      icon: profile.icon,
      config: profile.config,
      order: profile.order,
    })),
  });
}

export function parseProfiles(raw: string): { selected: string | null; profiles: PortableProfile[] } {
  const root = asRecord(JSON.parse(raw) as unknown);
  if (root === null) {
    throw new Error("profiles.json 无效");
  }
  const selectedRaw = asString(root.selected).trim();
  const selected = selectedRaw === "" ? null : selectedRaw;
  const array = Array.isArray(root.profiles) ? root.profiles : [];
  const profiles: PortableProfile[] = [];
  array.forEach((item, index) => {
    const obj = asRecord(item);
    if (obj === null) {
      return;
    }
    const id = asString(obj.id).trim();
    const name = asString(obj.name).trim();
    const config = asString(obj.config).trim();
    if (id === "" || name === "" || !config.startsWith("configs/") || config.includes("..")) {
      return;
    }
    const type = asString(obj.type).trim() === "remote" ? "remote" : "local";
    profiles.push({
      id,
      name,
      type,
      remoteUrl: asString(obj.remote_url).trim(),
      autoUpdate: asBoolean(obj.auto_update, false),
      autoUpdateIntervalMinutes: Math.max(15, Math.trunc(asNumber(obj.auto_update_interval_minutes, 60))),
      lastUpdated: Math.trunc(asNumber(obj.last_updated, 0)),
      icon: asString(obj.icon).trim() || null,
      config,
      order: Math.trunc(asNumber(obj.order, index)),
    });
  });
  profiles.sort((left, right) => left.order - right.order);
  return { selected, profiles };
}

export function parseSettings(raw: string): PortableSettings {
  const root = raw.trim() === "" ? {} : asRecord(JSON.parse(raw) as unknown);
  const obj = root ?? {};
  const chainRaw = Array.isArray(obj.chain_bindings) ? obj.chain_bindings : [];
  const chainBindings: PortableChainBinding[] = [];
  for (const item of chainRaw) {
    const binding = asRecord(item);
    if (binding === null) {
      continue;
    }
    const profileId = asString(binding.profile_id).trim();
    const landingProfileId = asString(binding.landing_profile_id).trim();
    const landingTag = asString(binding.landing_tag).trim();
    if (profileId === "" || landingProfileId === "" || landingTag === "") {
      continue;
    }
    chainBindings.push({
      profileId,
      entryTag: asString(binding.entry_tag).trim(),
      landingProfileId,
      landingTag,
    });
  }
  const scriptBindingsRaw = asRecord(obj.overlay_script_bindings) ?? {};
  const overlayScriptBindings: Record<string, string[]> = {};
  for (const [uuid, value] of Object.entries(scriptBindingsRaw)) {
    if (!Array.isArray(value)) {
      continue;
    }
    overlayScriptBindings[uuid] = value.map((id) => asString(id).trim()).filter((id) => id !== "");
  }
  const webdav = asRecord(obj.webdav) ?? {};
  const scripts = Array.isArray(obj.overlay_scripts) ? obj.overlay_scripts : [];
  return {
    chinaDirect: asBoolean(obj.china_direct, DEFAULT_OVERLAY.chinaDirect),
    adsBlock: asBoolean(obj.ads_block, DEFAULT_OVERLAY.adsBlock),
    strictRoute: asBoolean(obj.strict_route, DEFAULT_OVERLAY.strictRoute),
    dnsProtect: asBoolean(obj.dns_protect, DEFAULT_OVERLAY.dnsProtect),
    disableIpv6: asBoolean(obj.disable_ipv6, DEFAULT_OVERLAY.disableIpv6),
    disableQuic: asBoolean(obj.disable_quic, DEFAULT_OVERLAY.disableQuic),
    excludeCnQuic: asBoolean(obj.exclude_cn_quic, DEFAULT_OVERLAY.excludeCnQuic),
    webrtcProtect: asBoolean(obj.webrtc_protect, DEFAULT_OVERLAY.webrtcProtect),
    onDemand: asBoolean(obj.on_demand, DEFAULT_OVERLAY.onDemand),
    configNormalize: asBoolean(obj.config_normalize, DEFAULT_OVERLAY.configNormalize),
    autoRedirect: asBoolean(obj.auto_redirect, DEFAULT_OVERLAY.autoRedirect),
    chainBindings,
    overlayScripts: scripts,
    overlayScriptBindings,
    webdav: {
      url: asString(webdav.url).trim(),
      user: asString(webdav.user).trim(),
      remoteFile: asString(webdav.remote_file).trim() || "backup.zip",
    },
  };
}

export function encodeSettings(settings: PortableSettings): string {
  return JSON.stringify({
    china_direct: settings.chinaDirect,
    ads_block: settings.adsBlock,
    strict_route: settings.strictRoute,
    dns_protect: settings.dnsProtect,
    disable_ipv6: settings.disableIpv6,
    disable_quic: settings.disableQuic,
    exclude_cn_quic: settings.excludeCnQuic,
    webrtc_protect: settings.webrtcProtect,
    on_demand: settings.onDemand,
    config_normalize: settings.configNormalize,
    auto_redirect: settings.autoRedirect,
    chain_bindings: settings.chainBindings.map((binding) => ({
      profile_id: binding.profileId,
      entry_tag: binding.entryTag,
      landing_profile_id: binding.landingProfileId,
      landing_tag: binding.landingTag,
    })),
    overlay_scripts: settings.overlayScripts,
    overlay_script_bindings: settings.overlayScriptBindings,
    webdav: {
      url: settings.webdav.url,
      user: settings.webdav.user,
      remote_file: settings.webdav.remoteFile,
    },
  });
}
