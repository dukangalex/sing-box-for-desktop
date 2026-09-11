import { ipcMain } from "electron";

import {
  PROFILE_CHAINS_CALL,
  PROFILE_CHAINS_CHANGED,
} from "../shared/ipc";
import type {
  ProfileChain,
  ProfileChainCreate,
  ProfileChainPatch,
  ProfileChainableOutbound,
  ProfilesResult,
} from "../shared/ipc";
import { settingsDatabase } from "./database";
import { readProfileContent } from "./profiles";
import { BrowserWindow } from "electron";

// Outbound types that can never be a meaningful chain hop. Group types
// (selector/urltest) are intentionally NOT excluded here — chaining through
// a group's currently-selected member is valid sing-box behaviour — but the
// UI may choose to hide them to keep the picker simple.
const NON_CHAINABLE_TYPES = new Set(["direct", "block", "dns"]);

interface ProfileChainRow {
  id: string;
  profile_id: string;
  name: string;
  hops: string;
  item_order: number;
}

interface RawOutbound {
  tag?: unknown;
  type?: unknown;
  detour?: unknown;
  [key: string]: unknown;
}

interface RawConfig {
  outbounds?: unknown;
  [key: string]: unknown;
}

function rowToChain(row: ProfileChainRow): ProfileChain {
  let hops: string[];
  try {
    hops = JSON.parse(row.hops);
    if (!Array.isArray(hops) || !hops.every((hop) => typeof hop === "string")) {
      throw new Error("invalid hops");
    }
  } catch {
    hops = [];
  }
  return { id: row.id, profileId: row.profile_id, name: row.name, hops };
}

function listChainsForProfile(profileId: string): ProfileChain[] {
  const rows = settingsDatabase()
    .prepare(
      "SELECT * FROM profile_chains WHERE profile_id = ? ORDER BY item_order ASC",
    )
    .all(profileId) as unknown as ProfileChainRow[];
  return rows.map(rowToChain);
}

function notifyChanged(profileId: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(PROFILE_CHAINS_CHANGED, profileId);
    }
  }
}

function parseOutbounds(content: string): RawOutbound[] {
  let config: RawConfig;
  try {
    config = JSON.parse(content) as RawConfig;
  } catch {
    return [];
  }
  if (!Array.isArray(config.outbounds)) {
    return [];
  }
  return config.outbounds.filter(
    (item): item is RawOutbound => typeof item === "object" && item !== null,
  );
}

async function listChainableOutbounds(
  profileId: string,
): Promise<ProfileChainableOutbound[]> {
  const content = await readProfileContent(profileId);
  const outbounds = parseOutbounds(content);
  const result: ProfileChainableOutbound[] = [];
  for (const outbound of outbounds) {
    if (typeof outbound.tag !== "string" || typeof outbound.type !== "string") {
      continue;
    }
    if (NON_CHAINABLE_TYPES.has(outbound.type)) {
      continue;
    }
    result.push({ tag: outbound.tag, type: outbound.type });
  }
  return result;
}

function validateHops(hops: string[]): void {
  if (hops.length < 2) {
    throw new Error("a chain needs at least two hops");
  }
  if (new Set(hops).size !== hops.length) {
    throw new Error("a chain cannot repeat the same node twice");
  }
}

function createChain(init: ProfileChainCreate): ProfileChain {
  validateHops(init.hops);
  const id = crypto.randomUUID();
  const store = settingsDatabase();
  store.transaction(() => {
    const nextOrder = (
      store
        .prepare(
          "SELECT COALESCE(MAX(item_order) + 1, 0) AS next_order FROM profile_chains WHERE profile_id = ?",
        )
        .get(init.profileId) as { next_order: number }
    ).next_order;
    store
      .prepare(
        `INSERT INTO profile_chains (id, profile_id, name, hops, item_order)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, init.profileId, init.name, JSON.stringify(init.hops), nextOrder);
  })();
  notifyChanged(init.profileId);
  return { id, profileId: init.profileId, name: init.name, hops: init.hops };
}

function findChainRow(id: string): ProfileChainRow {
  const row = settingsDatabase()
    .prepare("SELECT * FROM profile_chains WHERE id = ?")
    .get(id) as ProfileChainRow | undefined;
  if (row === undefined) {
    throw new Error(`chain not found: ${id}`);
  }
  return row;
}

function updateChain(id: string, patch: ProfileChainPatch): void {
  const row = findChainRow(id);
  if (patch.hops !== undefined) {
    validateHops(patch.hops);
  }
  const store = settingsDatabase();
  store.transaction(() => {
    if (patch.name !== undefined) {
      store.prepare("UPDATE profile_chains SET name = ? WHERE id = ?").run(patch.name, id);
    }
    if (patch.hops !== undefined) {
      store
        .prepare("UPDATE profile_chains SET hops = ? WHERE id = ?")
        .run(JSON.stringify(patch.hops), id);
    }
  })();
  notifyChanged(row.profile_id);
}

function removeChain(id: string): void {
  const row = findChainRow(id);
  settingsDatabase().prepare("DELETE FROM profile_chains WHERE id = ?").run(id);
  notifyChanged(row.profile_id);
}

function reorderChains(profileId: string, ids: string[]): void {
  const store = settingsDatabase();
  store.transaction(() => {
    const currentIds = (
      store
        .prepare(
          "SELECT id FROM profile_chains WHERE profile_id = ? ORDER BY item_order ASC",
        )
        .all(profileId) as { id: string }[]
    ).map((r) => r.id);
    const known = new Set(currentIds);
    const ordered = ids.filter((id) => known.has(id));
    const orderedSet = new Set(ordered);
    ordered.push(...currentIds.filter((id) => !orderedSet.has(id)));
    const statement = store.prepare(
      "UPDATE profile_chains SET item_order = ? WHERE id = ?",
    );
    for (const [index, id] of ordered.entries()) {
      statement.run(index, id);
    }
  })();
  notifyChanged(profileId);
}

/**
 * Applies every saved chain binding for `profileId` to `content` (the
 * profile's base config, exactly as read from disk) and returns the
 * resulting config as a JSON string, ready to hand to the sing-box core.
 *
 * This NEVER mutates the file on disk — it runs on a fresh parse of the
 * base content every time it's called, so remote-subscription refreshes
 * and manual edits to the base config are never clobbered by a previous
 * chain application. If a chain references a tag that no longer exists in
 * the config (e.g. the base config was edited or refreshed), that chain is
 * silently skipped rather than failing the whole start-up.
 */
export function applyChainBindings(profileId: string, content: string): string {
  const chains = listChainsForProfile(profileId);
  if (chains.length === 0) {
    return content;
  }

  let config: RawConfig;
  try {
    config = JSON.parse(content) as RawConfig;
  } catch {
    // Malformed base config — let the existing checkConfig/start-up path
    // surface this error as usual, untouched.
    return content;
  }
  if (!Array.isArray(config.outbounds)) {
    return content;
  }

  const byTag = new Map<string, RawOutbound>();
  for (const outbound of config.outbounds) {
    if (
      typeof outbound === "object" &&
      outbound !== null &&
      typeof (outbound as RawOutbound).tag === "string"
    ) {
      byTag.set((outbound as RawOutbound).tag as string, outbound as RawOutbound);
    }
  }

  for (const chain of chains) {
    if (chain.hops.length < 2) {
      continue;
    }
    const hopsExist = chain.hops.every((tag) => byTag.has(tag));
    if (!hopsExist) {
      continue;
    }
    for (let i = 1; i < chain.hops.length; i += 1) {
      const outbound = byTag.get(chain.hops[i]);
      if (outbound !== undefined) {
        outbound.detour = chain.hops[i - 1];
      }
    }
  }

  return JSON.stringify(config);
}

const handlers: Record<string, (...args: never[]) => Promise<unknown>> = {
  async list(profileId: string): Promise<ProfileChain[]> {
    return listChainsForProfile(profileId);
  },
  async listChainableOutbounds(profileId: string): Promise<ProfileChainableOutbound[]> {
    return await listChainableOutbounds(profileId);
  },
  async create(init: ProfileChainCreate): Promise<ProfileChain> {
    return createChain(init);
  },
  async update(id: string, patch: ProfileChainPatch): Promise<void> {
    updateChain(id, patch);
  },
  async remove(id: string): Promise<void> {
    removeChain(id);
  },
  async reorder(profileId: string, ids: string[]): Promise<void> {
    reorderChains(profileId, ids);
  },
};

export function registerProfileChains(): void {
  ipcMain.handle(
    PROFILE_CHAINS_CALL,
    async (
      _event,
      method: string,
      ...callArguments: unknown[]
    ): Promise<ProfilesResult> => {
      const handler = handlers[method];
      if (!handler) {
        return { ok: false, error: `unknown profileChains method: ${method}` };
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
