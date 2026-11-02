// These are the "look around" tools. They are all read only, so they are available
// even in read only mode, and they are the ones a model should reach for FIRST.
// The golden rule of this server is: discover before you act. Instead of guessing
// that a lamp is called light.living_room_lamp, search for it, then use the real id.
//
// What is in here:
//   search_entities      - find things by words, area, type or state
//   get_entity_details   - everything about one entity
//   list_areas           - the rooms/zones in the house
//   get_area_summary     - everything inside one room
//   list_services        - what actions Home Assistant can perform
//   get_history          - how an entity's state changed over time
//   get_logbook          - what happened, and what caused it
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HAState, Registry } from "../ha-client.js";
import { asArray, domainOf, redactKeys, slugify } from "../util.js";
import { defineTool, registerTool, type ToolContext } from "./registry.js";

// People say "lamp", Home Assistant says "light". This little dictionary lets a
// search for one find the other. Synonym matches count for half as much as exact
// matches, so a real match always ranks above a guessed one.
/** Small synonym table so that "lamp" finds lights and "heating" finds climate entities. */
const SYNONYMS: Record<string, string[]> = {
  lamp: ["light"],
  lights: ["light"],
  bulb: ["light"],
  heating: ["climate", "heater", "thermostat"],
  thermostat: ["climate"],
  temperature: ["temperature", "climate"],
  blind: ["cover"],
  blinds: ["cover"],
  shutter: ["cover"],
  curtain: ["cover"],
  garage: ["cover", "garage"],
  plug: ["switch", "outlet"],
  outlet: ["switch", "plug"],
  socket: ["switch", "plug"],
  motion: ["motion", "occupancy"],
  door: ["door", "lock", "cover"],
  speaker: ["media_player"],
  tv: ["media_player"],
  battery: ["battery"],
  power: ["power", "energy"],
};

// For one search word, returns the word itself plus any synonyms.
function tokenAlternatives(token: string): string[] {
  return [token, ...(SYNONYMS[token] ?? [])];
}

// A flattened, easy to search version of an entity that combines its state with its area, device and device class.
interface Row {
  entity_id: string;
  name: string;
  state: string;
  area: string | null;
  device: string | null;
  device_class?: string;
  unit?: string;
}

// Turns the raw list of states into searchable rows. If the registry could not be
// loaded (reg is null) we still work, we just have no area or device information.
function buildRows(states: HAState[], reg: Registry | null): Row[] {
  return states.map((s) => {
    const areaId = reg?.areaIdOf(s.entity_id) ?? null;
    const entry = reg?.entityById.get(s.entity_id);
    const device = entry?.device_id ? reg?.deviceById.get(entry.device_id) : undefined;
    return {
      entity_id: s.entity_id,
      name: (s.attributes.friendly_name as string | undefined) ?? s.entity_id,
      state: s.state,
      area: areaId ? (reg?.areaById.get(areaId)?.name ?? areaId) : null,
      device: device ? (device.name_by_user ?? device.name ?? null) : null,
      device_class: s.attributes.device_class as string | undefined,
      unit: s.attributes.unit_of_measurement as string | undefined,
    };
  });
}

// Ranks how well one entity matches the search words. Each word is scored by how
// good its best match is:
//    10  the id or name IS the word
//     6  the id ends with the word, or the name starts with it
//     4  the id or name contains it
//     2  it appears somewhere in the area, device or class text
// Synonyms are worth half. 'all' tells us whether EVERY search word matched
// something, which we use to prefer entities that match the whole query.
function score(row: Row, tokens: string[]): { score: number; all: boolean } {
  const id = row.entity_id.toLowerCase();
  const name = row.name.toLowerCase();
  const hay = `${id} ${name} ${row.area ?? ""} ${row.device ?? ""} ${row.device_class ?? ""}`.toLowerCase();
  let total = 0;
  let matched = 0;
  for (const t of tokens) {
    let best = 0;
    for (const alt of tokenAlternatives(t)) {
      const isSyn = alt !== t;
      const w = isSyn ? 0.5 : 1;
      if (id === alt || name === alt) best = Math.max(best, 10 * w);
      else if (id.endsWith(`.${alt}`) || id.includes(`.${alt}_`) || name.startsWith(alt)) best = Math.max(best, 6 * w);
      else if (id.includes(alt) || name.includes(alt)) best = Math.max(best, 4 * w);
      else if (hay.includes(alt)) best = Math.max(best, 2 * w);
    }
    if (best > 0) matched++;
    total += best;
  }
  return { score: total, all: tokens.length > 0 && matched === tokens.length };
}

// Home Assistant stores an entity's capabilities as one number where each bit means
// something (bit 1 = can open, bit 2 = can close and so on). This table maps those
// bits to readable names for the domains we know about, so a model can see "this
// cover supports OPEN, CLOSE and SET_POSITION" instead of the number 15.
const FEATURES: Record<string, Record<string, number>> = {
  cover: { OPEN: 1, CLOSE: 2, SET_POSITION: 4, STOP: 8, OPEN_TILT: 16, CLOSE_TILT: 32, STOP_TILT: 64, SET_TILT_POSITION: 128 },
  climate: {
    TARGET_TEMPERATURE: 1,
    TARGET_TEMPERATURE_RANGE: 2,
    TARGET_HUMIDITY: 4,
    FAN_MODE: 8,
    PRESET_MODE: 16,
    SWING_MODE: 32,
    TURN_OFF: 128,
    TURN_ON: 256,
  },
  fan: { SET_SPEED: 1, OSCILLATE: 2, DIRECTION: 4, PRESET_MODE: 8, TURN_OFF: 16, TURN_ON: 32 },
  lock: { OPEN: 1 },
  light: { EFFECT: 4, FLASH: 8, TRANSITION: 32 },
  alarm_control_panel: { ARM_HOME: 1, ARM_AWAY: 2, ARM_NIGHT: 4, TRIGGER: 8, ARM_CUSTOM_BYPASS: 16, ARM_VACATION: 32 },
  media_player: {
    PAUSE: 1,
    SEEK: 2,
    VOLUME_SET: 4,
    VOLUME_MUTE: 8,
    PREVIOUS_TRACK: 16,
    NEXT_TRACK: 32,
    TURN_ON: 128,
    TURN_OFF: 256,
    PLAY_MEDIA: 512,
    VOLUME_STEP: 1024,
    SELECT_SOURCE: 2048,
    STOP: 4096,
    PLAY: 16384,
    SHUFFLE_SET: 32768,
    BROWSE_MEDIA: 131072,
  },
};

// Checks each known bit against the number using a bitwise AND, and returns the names of the ones that are set.
function decodeFeatures(domain: string, value: unknown): string[] | undefined {
  const map = FEATURES[domain];
  if (!map || typeof value !== "number") return undefined;
  return Object.entries(map)
    .filter(([, bit]) => (value & bit) !== 0)
    .map(([name]) => name);
}

// Loads the registry but never fails. Area and device info is a nice extra, not a necessity, so a problem there should not break the search.
async function tryRegistry(ctx: ToolContext): Promise<Registry | null> {
  try {
    return await ctx.ha.getRegistry();
  } catch {
    return null;
  }
}

// Finds an area from whatever the user typed. It tries, in order: exact id, exact
// name, an alias, and finally a partial name match. The first hit wins, so 'living
// room' finds 'Living Room' but a looser guess can still work.
function findArea(reg: Registry, query: string) {
  const q = query.trim().toLowerCase();
  const slug = slugify(query);
  return (
    reg.areas.find((a) => a.area_id === q || a.area_id === slug) ??
    reg.areas.find((a) => a.name.toLowerCase() === q) ??
    reg.areas.find((a) => (a.aliases ?? []).some((al) => al.toLowerCase() === q)) ??
    reg.areas.find((a) => a.name.toLowerCase().includes(q))
  );
}

// The workhorse for finding things. Filters (domain, area, state) are applied first
// to shrink the list, then any words are scored and ranked. If no result matches
// ALL the words we fall back to matching ANY word and say so in 'match_mode', so the
// caller knows the match was looser.
const searchEntities = defineTool({
  name: "search_entities",
  title: "Search entities",
  description:
    "Keyword search across entity ids, friendly names, areas, devices and device classes. Returns a compact summary per entity so large installations do not exhaust context. Use domain and area filters to narrow results. Synonyms such as lamp, heating and blind are understood.",
  risk: "read",
  shape: {
    query: z.string().optional().describe("Words to look for, for example 'kitchen lamp' or 'battery'. Omit to list by filter only."),
    domain: z.string().optional().describe("Entity domain or comma separated domains, for example 'light' or 'sensor,binary_sensor'."),
    area: z.string().optional().describe("Area name or id, matched case insensitively as a substring."),
    state: z.string().optional().describe("Only entities currently in this state, for example 'on' or 'unavailable'."),
    limit: z.number().int().min(1).max(200).default(25).describe("Maximum rows to return."),
  },
  handler: async ({ query, domain, area, state, limit }, ctx) => {
    const [states, reg] = await Promise.all([ctx.ha.getStates(), tryRegistry(ctx)]);
    let rows = buildRows(states, reg);

    const domains = domain ? domain.toLowerCase().split(/[,\s]+/).filter(Boolean) : [];
    if (domains.length) rows = rows.filter((r) => domains.includes(domainOf(r.entity_id)));
    if (area) {
      const a = area.toLowerCase();
      rows = rows.filter((r) => (r.area ?? "").toLowerCase().includes(a));
    }
    if (state) rows = rows.filter((r) => r.state.toLowerCase() === state.toLowerCase());

    let matchMode: "all_words" | "any_word" | "filters_only" = "filters_only";
    const tokens = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length) {
      const scored = rows.map((r) => ({ r, ...score(r, tokens) }));
      let hits = scored.filter((x) => x.all);
      matchMode = "all_words";
      if (hits.length === 0) {
        hits = scored.filter((x) => x.score > 0);
        matchMode = "any_word";
      }
      hits.sort((a, b) => b.score - a.score || a.r.entity_id.localeCompare(b.r.entity_id));
      rows = hits.map((x) => x.r);
    } else {
      rows.sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    }

    // If there are more matches than we are returning, include a count per type so the caller can see what was left out and narrow the search.
    const counts: Record<string, number> = {};
    for (const r of rows) counts[domainOf(r.entity_id)] = (counts[domainOf(r.entity_id)] ?? 0) + 1;

    return {
      total_matches: rows.length,
      returned: Math.min(rows.length, limit),
      match_mode: matchMode,
      area_info_available: reg !== null,
      domain_counts: rows.length > limit ? counts : undefined,
      entities: rows.slice(0, limit).map((r) => ({
        entity_id: r.entity_id,
        name: r.name,
        state: r.unit ? `${r.state} ${r.unit}` : r.state,
        area: r.area ?? undefined,
        device_class: r.device_class,
      })),
    };
  },
});

// Everything about one entity: state, attributes, decoded features, which device
// and area it belongs to, and which services apply to it. If the entity does not
// exist we suggest similar ids, which saves a round trip when a name was slightly
// wrong. Attributes pass through redactKeys so access tokens on cameras never leak.
const getEntityDetails = defineTool({
  name: "get_entity_details",
  title: "Get entity details",
  description:
    "Complete inspection of one entity: current state, all attributes, decoded supported features, registry data (platform, device, area, disabled or hidden status) and the services available for its domain.",
  risk: "read",
  shape: {
    entity_id: z.string().describe("Full entity id, for example 'light.kitchen'."),
  },
  handler: async ({ entity_id }, ctx) => {
    const state = await ctx.ha.getState(entity_id);
    if (!state) {
      const all = await ctx.ha.getStates();
      const needle = entity_id.split(".").pop()?.toLowerCase() ?? entity_id;
      const similar = all
        .map((s) => s.entity_id)
        .filter((id) => id.includes(needle))
        .slice(0, 8);
      throw new Error(
        `Entity ${entity_id} does not exist.${similar.length ? ` Similar entities: ${similar.join(", ")}` : " Try search_entities."}`
      );
    }
    const domain = domainOf(entity_id);
    let registry: Record<string, unknown> | undefined;
    let device: Record<string, unknown> | undefined;
    let areaName: string | undefined;
    try {
      const reg = await ctx.ha.getRegistry();
      const entry = reg.entityById.get(entity_id);
      if (entry) {
        registry = {
          platform: entry.platform,
          device_id: entry.device_id,
          area_id: entry.area_id,
          disabled_by: entry.disabled_by,
          hidden_by: entry.hidden_by,
          original_name: entry.original_name,
          name_override: entry.name,
          labels: entry.labels,
        };
        const dev = entry.device_id ? reg.deviceById.get(entry.device_id) : undefined;
        if (dev) {
          device = {
            id: dev.id,
            name: dev.name_by_user ?? dev.name,
            manufacturer: dev.manufacturer,
            model: dev.model,
            area_id: dev.area_id,
          };
        }
        const areaId = reg.areaIdOf(entity_id);
        areaName = areaId ? reg.areaById.get(areaId)?.name : undefined;
      }
    } catch {
      /* registry optional */
    }

    let services: string[] | undefined;
    try {
      const all = await ctx.ha.getServices();
      services = Object.keys(all.find((d) => d.domain === domain)?.services ?? {});
    } catch {
      /* optional */
    }

    const sf = state.attributes.supported_features;
    return {
      entity_id,
      domain,
      state: state.state,
      friendly_name: state.attributes.friendly_name,
      last_changed: state.last_changed,
      last_updated: state.last_updated,
      area: areaName,
      supported_features: typeof sf === "number" ? { raw: sf, decoded: decodeFeatures(domain, sf) } : undefined,
      attributes: redactKeys(state.attributes),
      registry,
      device,
      domain_services: services,
    };
  },
});

// A quick tour of the rooms, each with a count of the (enabled) entities in it.
const listAreas = defineTool({
  name: "list_areas",
  title: "List areas",
  description: "List every area (physical zone) with its id, name and the number of entities assigned to it.",
  risk: "read",
  shape: {},
  handler: async (_args, ctx) => {
    const reg = await ctx.ha.getRegistry();
    return reg.areas.map((a) => ({
      area_id: a.area_id,
      name: a.name,
      floor_id: a.floor_id ?? undefined,
      entity_count: reg.entities.filter((e) => !e.disabled_by && reg.areaIdOf(e.entity_id) === a.area_id).length,
    }));
  },
});

// The contents of a room, grouped by device so it reads naturally ("the Hue bridge
// has these 4 entities"). Entities that belong to no device are listed separately.
// A cap (max_entities) keeps big rooms from flooding the reply.
const getAreaSummary = defineTool({
  name: "get_area_summary",
  title: "Get area summary",
  description:
    "All devices and entities assigned to a physical area, grouped by device, with current states. Accepts the area name or id.",
  risk: "read",
  shape: {
    area_name: z.string().describe("Area name or id, for example 'Living Room' or 'living_room'."),
    include_disabled: z.boolean().default(false).describe("Include disabled registry entries."),
    max_entities: z.number().int().min(1).max(500).default(150).describe("Cap on entities listed."),
  },
  handler: async ({ area_name, include_disabled, max_entities }, ctx) => {
    const [reg, states] = await Promise.all([ctx.ha.getRegistry(), ctx.ha.getStates()]);
    const area = findArea(reg, area_name);
    if (!area) {
      throw new Error(
        `No area matches "${area_name}". Available areas: ${reg.areas.map((a) => a.name).join(", ") || "(none defined)"}`
      );
    }
    const stateById = new Map(states.map((s) => [s.entity_id, s]));
    const inArea = reg.entities.filter(
      (e) => (include_disabled || !e.disabled_by) && reg.areaIdOf(e.entity_id) === area.area_id
    );
    const view = (id: string) => {
      const s = stateById.get(id);
      return {
        entity_id: id,
        name: (s?.attributes.friendly_name as string | undefined) ?? id,
        state: s ? (s.attributes.unit_of_measurement ? `${s.state} ${s.attributes.unit_of_measurement}` : s.state) : "no state",
      };
    };
    const byDevice = new Map<string | null, string[]>();
    let listed = 0;
    for (const e of inArea) {
      if (listed >= max_entities) break;
      const key = e.device_id;
      byDevice.set(key, [...(byDevice.get(key) ?? []), e.entity_id]);
      listed++;
    }
    const devices = [...byDevice.entries()]
      .filter(([k]) => k !== null)
      .map(([k, ids]) => {
        const d = reg.deviceById.get(k as string);
        return {
          device: d?.name_by_user ?? d?.name ?? k,
          manufacturer: d?.manufacturer ?? undefined,
          model: d?.model ?? undefined,
          entities: ids.map(view),
        };
      });
    // A device can sit in a room while its individual entities are assigned elsewhere. We still list it so nothing about the room is hidden.
    // Devices placed in the area whose entities have their own area are still part of the area.
    const deviceOnly = reg.devices
      .filter((d) => d.area_id === area.area_id && !byDevice.has(d.id))
      .map((d) => ({ device: d.name_by_user ?? d.name ?? d.id, manufacturer: d.manufacturer ?? undefined, entities: [] as unknown[] }));
    return {
      area: { id: area.area_id, name: area.name },
      total_entities: inArea.length,
      listed_entities: listed,
      truncated: inArea.length > listed,
      devices: [...devices, ...deviceOnly],
      entities_without_device: (byDevice.get(null) ?? []).map(view),
    };
  },
});

// Three levels of detail, to avoid overwhelming the model:
//   no arguments        -> just domains and service names
//   a domain            -> short descriptions and fields for each service
//   domain and service  -> the complete definition of one service
const listServices = defineTool({
  name: "list_services",
  title: "List services",
  description:
    "Expose registered service signatures. With no arguments returns each domain and its service names. With a domain returns descriptions and parameter schemas for its services. With domain and service returns that one service in full detail.",
  risk: "read",
  shape: {
    domain: z.string().optional().describe("Service domain, for example 'light' or 'climate'."),
    service: z.string().optional().describe("Single service name within the domain, for example 'turn_on'."),
  },
  handler: async ({ domain, service }, ctx) => {
    const all = await ctx.ha.getServices();
    if (!domain) {
      return all.map((d) => ({ domain: d.domain, services: Object.keys(d.services) }));
    }
    const d = all.find((x) => x.domain === domain);
    if (!d) {
      throw new Error(`Unknown service domain "${domain}". Known domains: ${all.map((x) => x.domain).join(", ")}`);
    }
    const compactField = (f: any) => ({
      description: f.description || undefined,
      required: f.required || undefined,
      example: f.example,
      default: f.default,
      selector: f.selector ? Object.keys(f.selector)[0] : undefined,
    });
    const compact = (svc: any, full: boolean) => ({
      name: svc.name || undefined,
      description: svc.description || undefined,
      target: svc.target,
      fields: Object.fromEntries(
        Object.entries(svc.fields ?? {}).map(([k, f]: [string, any]) => [k, full ? f : compactField(f)])
      ),
      response: svc.response,
    });
    if (service) {
      const svc = d.services[service];
      if (!svc) throw new Error(`Service ${domain}.${service} does not exist. ${domain} has: ${Object.keys(d.services).join(", ")}`);
      return { service: `${domain}.${service}`, ...compact(svc, true) };
    }
    return Object.fromEntries(Object.entries(d.services).map(([name, svc]) => [name, compact(svc, false)]));
  },
});

// Uses Home Assistant's history endpoint. By default it asks for a minimal response
// without attributes, which is much smaller. If the caller wants specific attributes
// (temperature, brightness) we ask for the full response and pick just those.
const getHistory = defineTool({
  name: "get_history",
  title: "Get state history",
  description: "State changes for one or more entities over the last N hours, as a compact timeline.",
  risk: "read",
  shape: {
    entity_ids: z.union([z.string(), z.array(z.string())]).describe("One entity id or a list of entity ids."),
    hours: z.number().min(0.1).max(720).default(24).describe("How far back to look."),
    limit: z.number().int().min(1).max(500).default(60).describe("Maximum state changes per entity, newest kept."),
    attributes: z.array(z.string()).optional().describe("Also return these attributes at each change, for example ['temperature','brightness']."),
  },
  handler: async ({ entity_ids, hours, limit, attributes }, ctx) => {
    const ids = asArray(entity_ids);
    const start = new Date(Date.now() - hours * 3_600_000).toISOString();
    const data = await ctx.ha.rest<any[][]>("GET", `/api/history/period/${encodeURIComponent(start)}`, {
      query: {
        filter_entity_id: ids.join(","),
        ...(attributes?.length ? {} : { minimal_response: "true", no_attributes: "true" }),
        significant_changes_only: "true",
      },
    });
    return (data ?? []).map((series) => {
      const entityId = series[0]?.entity_id ?? "unknown";
      const trimmed = series.slice(-limit);
      return {
        entity_id: entityId,
        total_changes: series.length,
        shown: trimmed.length,
        timeline: trimmed.map((p: any) => ({
          at: p.last_changed ?? p.last_updated,
          state: p.state,
          ...(attributes?.length ? Object.fromEntries(attributes.filter((a) => a in (p.attributes ?? {})).map((a) => [a, p.attributes[a]])) : {}),
        })),
      };
    });
  },
});

// The logbook records what happened AND why (which automation or user caused it).
// We trim each entry to the useful fields, and keep the newest ones if there are
// too many.
const getLogbook = defineTool({
  name: "get_logbook",
  title: "Get logbook",
  description: "Logbook entries (what happened and why) over the last N hours, optionally for a single entity.",
  risk: "read",
  shape: {
    entity_id: z.string().optional().describe("Restrict to one entity."),
    hours: z.number().min(0.1).max(168).default(6).describe("How far back to look."),
    limit: z.number().int().min(1).max(300).default(50).describe("Maximum entries, newest kept."),
  },
  handler: async ({ entity_id, hours, limit }, ctx) => {
    const start = new Date(Date.now() - hours * 3_600_000).toISOString();
    const entries = await ctx.ha.rest<any[]>("GET", `/api/logbook/${encodeURIComponent(start)}`, {
      query: { entity: entity_id },
    });
    const trimmed = (entries ?? []).slice(-limit);
    return {
      total: entries?.length ?? 0,
      shown: trimmed.length,
      entries: trimmed.map((e) => ({
        when: e.when,
        entity_id: e.entity_id,
        name: e.name,
        message: e.message,
        state: e.state,
        context_entity: e.context_entity_id,
        context_event: e.context_event_type,
      })),
    };
  },
});

// Registers all seven tools. They are all read only so none are skipped in read only mode.
export function registerDiscoveryTools(server: McpServer, ctx: ToolContext): void {
  for (const def of [searchEntities, getEntityDetails, listAreas, getAreaSummary, listServices, getHistory, getLogbook]) {
    registerTool(server, ctx, def as any);
  }
}
