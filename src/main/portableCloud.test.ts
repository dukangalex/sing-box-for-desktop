import assert from "node:assert/strict";
import test from "node:test";

import { applyAngelaBoxOverlays } from "./overlayApply";
import {
  encodeProfiles,
  encodeSettings,
  isPortableManifest,
  manifest,
  parseProfiles,
  parseSettings,
  PORTABLE_APP,
  PORTABLE_FORMAT,
} from "./portableCloud";
import { createZip, isZipBuffer, readZip } from "./zipArchive";

test("manifest is portable and omits secrets", () => {
  const raw = JSON.stringify(manifest("windows", 1));
  assert.equal(isPortableManifest(raw), true);
  const obj = JSON.parse(raw) as { format: string; app: string; secrets: string };
  assert.equal(obj.format, PORTABLE_FORMAT);
  assert.equal(obj.app, PORTABLE_APP);
  assert.equal(obj.secrets, "omitted");
  assert.equal(raw.includes("password"), false);
});

test("rejects unrelated manifests", () => {
  assert.equal(isPortableManifest(JSON.stringify({ version: 1, app: "other" })), false);
  assert.equal(isPortableManifest("not-json"), false);
  assert.equal(isPortableManifest(""), false);
});

test("profiles round-trip and reject path traversal", () => {
  const profile = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "机场",
    type: "remote" as const,
    remoteUrl: "https://example.com/sub",
    autoUpdate: true,
    autoUpdateIntervalMinutes: 60,
    lastUpdated: 1710000000000,
    icon: null,
    config: "configs/550e8400-e29b-41d4-a716-446655440000.json",
    order: 0,
  };
  const encoded = encodeProfiles(profile.id, [profile]);
  const parsed = parseProfiles(encoded);
  assert.equal(parsed.selected, profile.id);
  assert.equal(parsed.profiles.length, 1);
  assert.equal(parsed.profiles[0].name, "机场");
  assert.equal(parsed.profiles[0].type, "remote");
  const bad = JSON.parse(encoded) as { profiles: Array<{ config: string }> };
  bad.profiles[0].config = "configs/../secret.json";
  const skipped = parseProfiles(JSON.stringify(bad));
  assert.equal(skipped.profiles.length, 0);
});

test("settings omit webdav password", () => {
  const encoded = encodeSettings({
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
    chainBindings: [
      {
        profileId: "aaaa",
        entryTag: "proxy",
        landingProfileId: "bbbb",
        landingTag: "landing",
      },
    ],
    overlayScripts: [],
    overlayScriptBindings: { aaaa: ["script-1"] },
    webdav: { url: "https://dav.example.com/", user: "me", remoteFile: "backup.zip" },
  });
  assert.equal(encoded.includes("password"), false);
  const parsed = parseSettings(encoded);
  assert.equal(parsed.chinaDirect, true);
  assert.equal(parsed.chainBindings[0].landingTag, "landing");
  assert.equal(parsed.overlayScriptBindings.aaaa[0], "script-1");
  assert.equal(parsed.webdav.remoteFile, "backup.zip");
});

test("zip round-trip and traversal guard", () => {
  const zip = createZip([
    { name: "manifest.json", data: Buffer.from("{\"format\":\"angelabox-cloud/1\"}", "utf-8") },
    { name: "configs/id.json", data: Buffer.from("{\"outbounds\":[]}", "utf-8") },
  ]);
  assert.equal(isZipBuffer(zip), true);
  const files = readZip(zip);
  assert.equal(files.get("manifest.json")?.toString("utf-8").includes("angelabox-cloud/1"), true);
  assert.throws(() => createZip([{ name: "configs/../x.json", data: Buffer.from("x") }]));
});

test("overlay injects china direct and ads without rewriting missing tags", () => {
  const base = JSON.stringify({
    outbounds: [{ type: "direct", tag: "direct" }, { type: "shadowsocks", tag: "proxy" }],
    route: { rules: [{ outbound: "proxy" }] },
  });
  const landing = JSON.stringify({
    outbounds: [{ type: "vless", tag: "landing" }],
  });
  const out = JSON.parse(
    applyAngelaBoxOverlays(
      "aaaa",
      base,
      new Map([
        ["aaaa", base],
        ["bbbb", landing],
      ]),
      {
        chinaDirect: true,
        adsBlock: true,
        strictRoute: true,
        dnsProtect: true,
        disableIpv6: false,
        disableQuic: false,
        excludeCnQuic: true,
        webrtcProtect: true,
        onDemand: true,
        configNormalize: true,
        autoRedirect: false,
        chainBindings: [
          {
            profileId: "aaaa",
            entryTag: "proxy",
            landingProfileId: "bbbb",
            landingTag: "landing",
          },
        ],
        overlayScripts: [],
        overlayScriptBindings: {},
        webdav: { url: "", user: "", remoteFile: "backup.zip" },
      },
    ),
  ) as {
    outbounds: Array<{ tag: string; detour?: string }>;
    route: { rules: Array<{ outbound?: string; action?: string }> };
  };
  assert.equal(out.outbounds.some((item) => item.tag === "landing"), true);
  assert.equal(out.outbounds.find((item) => item.tag === "proxy")?.detour, "landing");
  assert.equal(out.route.rules.some((rule) => rule.outbound === "direct"), true);
  assert.equal(out.route.rules.some((rule) => rule.action === "reject"), true);
});
