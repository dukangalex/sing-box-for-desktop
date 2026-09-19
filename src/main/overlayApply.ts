import type { PortableChainBinding, PortableSettings } from "./portableCloud";

const CN_DOMAIN_SUFFIXES = [
  "cn",
  "qq.com", "weixin.com", "wechat.com", "qpic.cn", "gtimg.cn", "idqqimg.com",
  "tencent.com", "tencent-cloud.net", "qcloud.com", "myqcloud.com",
  "baidu.com", "bdstatic.com", "bdimg.com",
  "alibaba.com", "alicdn.com", "aliyun.com", "alipay.com", "aliyuncs.com",
  "taobao.com", "tmall.com", "1688.com",
  "163.com", "126.com", "127.net", "netease.com",
  "jd.com", "360buyimg.com",
  "bilibili.com", "hdslb.com", "biliapi.net",
  "iqiyi.com", "iqiyipic.com",
  "youku.com", "ykimg.com",
  "douyin.com", "amemv.com", "toutiao.com", "bytedance.com", "pstatp.com", "snssdk.com",
  "weibo.com", "sina.com.cn", "sinaimg.cn",
  "zhihu.com", "zhimg.com",
  "meituan.com", "dianping.com", "sankuai.com",
  "pinduoduo.com", "yangkeduo.com",
  "xiaomi.com", "mi.com", "miui.com",
  "huawei.com", "honor.com", "hicloud.com", "vmall.com",
  "oppo.com", "heytap.com", "realme.com", "oneplus.com", "vivo.com",
  "ctrip.com", "qunar.com",
  "suning.com", "smzdm.com",
  "kugou.com", "kuwo.cn",
  "migu.cn", "10086.cn", "10010.com", "189.cn",
  "gov.cn", "edu.cn", "ac.cn", "org.cn", "com.cn", "net.cn",
  "douban.com", "csdn.net", "gitee.com",
  "ele.me", "dingtalk.com", "feishu.cn",
  "wps.cn", "unionpay.com", "unionpaysecure.com", "chinapay.com", "yeepay.com",
  "jdpay.com", "tenpay.com", "icbc.com.cn", "ccb.com", "boc.cn", "bankofchina.com",
  "abchina.com", "cmbchina.com", "bankcomm.com", "psbc.com", "spdb.com.cn",
  "cib.com.cn", "cmbc.com.cn", "citicbank.com", "cebbank.com", "cgbchina.com.cn",
  "pingan.com",
  "alidns.com", "dnspod.cn", "360.cn",
  "sogou.com", "so.com", "uc.cn",
  "cctv.com", "people.com.cn", "xinhuanet.com",
  "coolapk.com", "thepaper.cn",
];

const LAN_DOMAIN_SUFFIXES = [
  "local", "lan", "localhost", "home.arpa", "localdomain",
  "internal", "intranet", "private", "local.lan",
];

const CHINA_DNS_IPS = [
  "114.114.114.114/32", "114.114.115.115/32",
  "223.5.5.5/32", "223.6.6.6/32",
  "180.76.76.76/32",
  "119.29.29.29/32", "119.28.28.28/32",
  "1.2.4.8/32", "210.2.4.8/32",
  "117.50.10.10/32", "117.50.11.11/32", "117.50.22.22/32",
  "1.12.12.12/32", "120.53.53.53/32",
  "101.226.4.6/32", "123.125.81.6/32",
  "202.96.134.133/32", "202.96.128.86/32",
];

const CHINA_DNS_DOMAINS = [
  "dns.alidns.com", "doh.pub", "dns.pub", "dot.pub",
  "d.alidns.com", "dns.qq.com", "pdns.aliyun.com",
];

const ADS_RULESET_TAG = "geosite-category-ads-all";
const ADS_RULESET_URL =
  "https://testingcf.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-category-ads-all.srs";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function outboundsOf(root: JsonRecord): JsonRecord[] {
  if (!Array.isArray(root.outbounds)) {
    root.outbounds = [];
  }
  return (root.outbounds as unknown[]).filter(
    (item): item is JsonRecord => typeof item === "object" && item !== null,
  );
}

function routeOf(root: JsonRecord): JsonRecord {
  const existing = asRecord(root.route);
  if (existing !== null) {
    return existing;
  }
  const created: JsonRecord = {};
  root.route = created;
  return created;
}

function prependRules(route: JsonRecord, extra: JsonRecord[]): void {
  const current = Array.isArray(route.rules) ? (route.rules as unknown[]) : [];
  route.rules = [...extra, ...current];
}

function findDirectTag(outs: JsonRecord[]): string {
  const preferred = ["direct", "DIRECT", "直连", "🚀 直连", "🎯 全球直连"];
  for (const tag of preferred) {
    const match = outs.find(
      (item) => item.tag === tag && typeof item.type === "string" && item.type.toLowerCase() === "direct",
    );
    if (match !== undefined) {
      return tag;
    }
  }
  for (const item of outs) {
    if (typeof item.type !== "string" || item.type.toLowerCase() !== "direct") {
      continue;
    }
    if (typeof item.tag !== "string" || item.tag.trim() === "") {
      continue;
    }
    const lower = item.tag.toLowerCase();
    if (lower === "dns" || lower === "block" || lower === "reject") {
      continue;
    }
    return item.tag;
  }
  const tag = outs.some((item) => item.tag === "direct") ? "angelabox-direct" : "direct";
  if (!outs.some((item) => item.tag === tag)) {
    outs.push({ type: "direct", tag });
  }
  return tag;
}

function existingRuleSetTags(route: JsonRecord): string[] {
  if (!Array.isArray(route.rule_set)) {
    return [];
  }
  return route.rule_set.flatMap((item) => {
    const record = asRecord(item);
    if (record === null || typeof record.tag !== "string") {
      return [];
    }
    return record.tag.trim() === "" ? [] : [record.tag.trim()];
  });
}

function applyChinaDirect(root: JsonRecord): void {
  const outs = outboundsOf(root);
  const direct = findDirectTag(outs);
  root.outbounds = outs;
  const route = routeOf(root);
  const sets = existingRuleSetTags(route);
  const geoip = sets.filter((tag) => {
    const token = tag.trim().toLowerCase().split("/").pop() ?? "";
    return token === "geoip-cn" || token === "geoip_cn";
  });
  const geosite = sets.filter((tag) => {
    const token = tag.trim().toLowerCase().split("/").pop() ?? "";
    return token === "geosite-cn" || token === "geosite_cn" || token === "geosite-geolocation-cn" || token === "cn";
  });
  const rules: JsonRecord[] = [
    { ip_is_private: true, outbound: direct },
    { domain_suffix: LAN_DOMAIN_SUFFIXES, domain: ["localhost"], outbound: direct },
    { ip_cidr: CHINA_DNS_IPS, outbound: direct },
    { domain: CHINA_DNS_DOMAINS, domain_suffix: ["alidns.com", "dnspod.com", "dnspod.cn", "doh.pub", "dns.pub"], outbound: direct },
  ];
  if (geoip.length > 0) {
    rules.push({ rule_set: geoip, outbound: direct });
  }
  if (geosite.length > 0) {
    rules.push({ rule_set: geosite, outbound: direct });
  }
  rules.push({ domain_suffix: CN_DOMAIN_SUFFIXES, outbound: direct });
  prependRules(route, rules);
}

function applyAds(root: JsonRecord): void {
  const route = routeOf(root);
  if (!Array.isArray(route.rule_set)) {
    route.rule_set = [];
  }
  const sets = route.rule_set as JsonRecord[];
  const existing = sets.find((item) => {
    const tag = typeof item.tag === "string" ? item.tag : "";
    const url = typeof item.url === "string" ? item.url : "";
    return tag.toLowerCase() === ADS_RULESET_TAG || url.includes("geosite-category-ads");
  });
  const tag = typeof existing?.tag === "string" && existing.tag.trim() !== "" ? existing.tag : ADS_RULESET_TAG;
  if (existing === undefined) {
    sets.push({
      tag: ADS_RULESET_TAG,
      type: "remote",
      format: "binary",
      url: ADS_RULESET_URL,
    });
  }
  prependRules(route, [{ rule_set: tag, action: "reject" }]);
}

function applyWebrtc(root: JsonRecord): void {
  prependRules(routeOf(root), [
    { network: "udp", port: [3478, 3479, 3480, 3481, 5349, 5350, 5351, 19302, 19303, 19304, 19305], action: "reject" },
    { network: "tcp", port: [3478, 3479, 3480, 3481, 5349, 5350], action: "reject" },
    { domain_keyword: ["stun.", "turn.", "stuns.", "turns."], action: "reject" },
  ]);
}

function applyDisableIpv6(root: JsonRecord): void {
  prependRules(routeOf(root), [{ ip_version: 6, action: "reject" }]);
}

function applyDisableQuic(root: JsonRecord, excludeCn: boolean): void {
  if (excludeCn) {
    return;
  }
  prependRules(routeOf(root), [{ network: "udp", port: 443, action: "reject" }]);
}

function applyDnsProtect(root: JsonRecord): void {
  const dns = asRecord(root.dns) ?? {};
  root.dns = dns;
  dns.independent_cache = true;
  const route = routeOf(root);
  const actions = Array.isArray(route.rules) ? (route.rules as JsonRecord[]) : [];
  if (!actions.some((rule) => rule.action === "hijack-dns" || rule.protocol === "dns")) {
    prependRules(route, [{ protocol: "dns", action: "hijack-dns" }]);
  }
}

function applyChainBindings(
  profileId: string,
  root: JsonRecord,
  bindings: PortableChainBinding[],
  configs: Map<string, string>,
): void {
  const match = bindings.find((binding) => binding.profileId === profileId);
  if (match === undefined) {
    return;
  }
  const landingRaw = configs.get(match.landingProfileId);
  if (landingRaw === undefined) {
    return;
  }
  let landing: JsonRecord;
  try {
    landing = JSON.parse(landingRaw) as JsonRecord;
  } catch {
    return;
  }
  const landingOuts = outboundsOf(landing);
  const landingOutbound = landingOuts.find((item) => item.tag === match.landingTag);
  if (landingOutbound === undefined) {
    return;
  }
  const outs = outboundsOf(root);
  if (!outs.some((item) => item.tag === match.landingTag)) {
    outs.push({ ...landingOutbound });
    if (typeof landingOutbound.detour === "string") {
      const hop = landingOuts.find((item) => item.tag === landingOutbound.detour);
      if (hop !== undefined && !outs.some((item) => item.tag === hop.tag)) {
        outs.push({ ...hop });
      }
    }
  }
  if (match.entryTag !== "") {
    const entry = outs.find((item) => item.tag === match.entryTag);
    if (entry !== undefined) {
      entry.detour = match.landingTag;
    }
  }
  root.outbounds = outs;
}

export function applyAngelaBoxOverlays(
  profileId: string,
  content: string,
  configs: Map<string, string>,
  settings: PortableSettings,
): string {
  let root: JsonRecord;
  try {
    root = JSON.parse(content) as JsonRecord;
  } catch {
    return content;
  }
  if (typeof root !== "object" || root === null) {
    return content;
  }
  applyChainBindings(profileId, root, settings.chainBindings, configs);
  if (settings.chinaDirect) {
    applyChinaDirect(root);
  }
  if (settings.disableQuic) {
    applyDisableQuic(root, settings.excludeCnQuic && settings.chinaDirect);
  }
  if (settings.dnsProtect) {
    applyDnsProtect(root);
  }
  if (settings.disableIpv6) {
    applyDisableIpv6(root);
  }
  if (settings.webrtcProtect) {
    applyWebrtc(root);
  }
  if (settings.adsBlock) {
    applyAds(root);
  }
  return JSON.stringify(root);
}
