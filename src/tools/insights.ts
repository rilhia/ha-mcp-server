// The "insight" tools. These are all READ ONLY and they are where a lot of the
// everyday value is. The discovery tools tell you what exists. These tell you what
// it all MEANS:
//   get_home_overview    - one call snapshot of the whole house
//   find_problems        - things that need attention
//   explain_state_change - why did that just change?
//   get_statistics       - long term numbers (energy, temperature trends)
//   get_calendar_events  - what is on the calendar
//   get_todo_items       - the items on a to-do list
//   get_forecast         - the weather forecast
//   get_camera_snapshot  - look at a camera picture
//   wait_for_state       - wait until something has actually happened
//   get_system_log       - the structured warnings and errors
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import type { HAState } from "../ha-client.js";
import { fetchConfigItem, referencedEntities } from "../resources.js";
import { ImageOutcome, domainOf, globToRegExp } from "../util.js";
import { defineTool, registerTool, type ToolContext } from "./registry.js";

// Converts a timestamp into readable ISO text. Home Assistant's statistics use
// either seconds or milliseconds since 1970, so we guess which by the size of the
// number (anything above 100 billion must already be milliseconds).
const iso = (n: number | string | undefined) =>
  typeof n === "number" ? new Date(n > 1e11 ? n : n * 1000).toISOString() : n;
// A small wait helper, used when polling.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// True when an entity matches one of the user's 'expected to be unavailable' patterns. Those are skipped in the overview and problem scan so they do not drown out real faults.
function ignored(entityId: string, cfg: Config): boolean {
  return cfg.ignoreUnavailable.some((p) => globToRegExp(p).test(entityId));
}

// Long term statistics are the compact hourly, daily and monthly numbers Home
// Assistant keeps for years (unlike normal history, which is pruned). Used for
// energy use, temperature trends and anything with a state class.
//
// With no ids it LISTS what exists. With ids it returns the numbers per period plus a
// tiny summary (the lowest and highest averages, and total change).
const getStatistics = defineTool({
  name: "get_statistics",
  title: "Get long-term statistics",
  description:
    "Long-term statistics (hourly, daily, monthly aggregates that outlive the normal history), used for energy, temperature trends and any sensor with a state class. Without statistic_ids it lists the available statistic ids, optionally filtered by query. With ids it returns mean, min, max, sum, state or change per period, plus a small summary.",
  risk: "read",
  shape: {
    statistic_ids: z.array(z.string()).optional().describe("Statistic ids, usually entity ids such as sensor.energy_total. Omit to list what exists."),
    query: z.string().optional().describe("When listing, text matched against id and name."),
    period: z.enum(["5minute", "hour", "day", "week", "month"]).default("hour"),
    hours: z.number().min(1).max(87600).default(24).describe("How far back to look when start is not given."),
    start: z.string().optional().describe("ISO start time. Overrides hours."),
    end: z.string().optional().describe("ISO end time."),
    types: z.array(z.enum(["mean", "min", "max", "sum", "state", "change"])).optional(),
    max_points: z.number().int().min(1).max(1000).default(100).describe("Maximum periods per statistic, newest kept."),
  },
  handler: async ({ statistic_ids, query, period, hours, start, end, types, max_points }, ctx) => {
    if (!statistic_ids?.length) {
      let list = (await ctx.ha.wsCommand<any[]>({ type: "recorder/list_statistic_ids" })) ?? [];
      if (query) {
        const q = query.toLowerCase();
        list = list.filter((s) => `${s.statistic_id} ${s.name ?? ""}`.toLowerCase().includes(q));
      }
      return {
        total: list.length,
        items: list.slice(0, 100).map((s) => ({ statistic_id: s.statistic_id, name: s.name, unit: s.display_unit_of_measurement ?? s.unit_of_measurement, has_mean: s.has_mean, has_sum: s.has_sum, source: s.source })),
      };
    }
    const start_time = start ?? new Date(Date.now() - hours * 3_600_000).toISOString();
    const result = (await ctx.ha.wsCommand<Record<string, any[]>>({
      type: "recorder/statistics_during_period",
      start_time,
      ...(end ? { end_time: end } : {}),
      statistic_ids,
      period,
      ...(types ? { types } : {}),
    })) ?? {};
    return Object.fromEntries(
      statistic_ids.map((id) => {
        const rows = result[id] ?? [];
        const points = rows.slice(-max_points).map((r) => ({ start: iso(r.start), end: iso(r.end), mean: r.mean, min: r.min, max: r.max, sum: r.sum, state: r.state, change: r.change }));
        const means = rows.map((r) => r.mean).filter((v) => typeof v === "number");
        const changes = rows.map((r) => r.change).filter((v) => typeof v === "number");
        return [
          id,
          {
            periods: rows.length,
            returned: points.length,
            summary: {
              lowest_mean: means.length ? Math.min(...means) : undefined,
              highest_mean: means.length ? Math.max(...means) : undefined,
              total_change: changes.length ? changes.reduce((a, b) => a + b, 0) : undefined,
            },
            points,
          },
        ];
      })
    );
  },
});

// With no entity it lists your calendars. With one it returns events in a time window, defaulting to the next 7 days.
const getCalendarEvents = defineTool({
  name: "get_calendar_events",
  title: "Get calendar events",
  description: "List calendar entities, or the events of one calendar between two times (default: the next 7 days).",
  risk: "read",
  shape: {
    entity_id: z.string().optional().describe("Calendar entity such as calendar.family. Omit to list calendars."),
    start: z.string().optional().describe("ISO start. Defaults to now."),
    end: z.string().optional().describe("ISO end. Defaults to 7 days after start."),
    max_items: z.number().int().min(1).max(500).default(50),
  },
  handler: async ({ entity_id, start, end, max_items }, ctx) => {
    if (!entity_id) return await ctx.ha.rest("GET", "/api/calendars");
    const s = start ?? new Date().toISOString();
    const e = end ?? new Date(new Date(s).getTime() + 7 * 86_400_000).toISOString();
    const events = (await ctx.ha.rest<any[]>("GET", `/api/calendars/${encodeURIComponent(entity_id)}`, { query: { start: s, end: e } })) ?? [];
    return {
      total: events.length,
      events: events.slice(0, max_items).map((ev) => ({ summary: ev.summary, start: ev.start, end: ev.end, location: ev.location, description: ev.description })),
    };
  },
});

// Reads a to-do list. Home Assistant only returns the items through a service that sends back a response, which is why this calls a service.
const getTodoItems = defineTool({
  name: "get_todo_items",
  title: "Get to-do list items",
  description: "Items on a to-do list entity such as todo.shopping_list. To add, complete or remove items use call_service with the todo domain.",
  risk: "read",
  shape: {
    entity_id: z.string(),
    status: z.enum(["needs_action", "completed"]).optional().describe("Filter by status."),
  },
  handler: async ({ entity_id, status }, ctx) => {
    const r = await ctx.ha.callService("todo", "get_items", { entity_id, ...(status ? { status } : {}) }, true);
    return { entity_id, items: r?.service_response?.[entity_id]?.items ?? [] };
  },
});

// Same idea as the to-do list: the weather forecast is only available through a service that returns data, not from the entity itself.
const getForecast = defineTool({
  name: "get_forecast",
  title: "Get weather forecast",
  description: "Daily, hourly or twice-daily forecast from a weather entity.",
  risk: "read",
  shape: {
    entity_id: z.string().describe("Weather entity such as weather.home."),
    type: z.enum(["daily", "hourly", "twice_daily"]).default("daily"),
    max_items: z.number().int().min(1).max(100).default(8),
  },
  handler: async ({ entity_id, type, max_items }, ctx) => {
    const r = await ctx.ha.callService("weather", "get_forecasts", { entity_id, type }, true);
    const forecast: any[] = r?.service_response?.[entity_id]?.forecast ?? [];
    return { entity_id, type, total: forecast.length, forecast: forecast.slice(0, max_items) };
  },
});

// Fetches the current picture from a camera or image entity and returns it as a real
// image so the model can look at it. Safeguards: the entity must be a camera or image,
// it must exist, the reply must really be an image, and it must be under 4 MB.
const getCameraSnapshot = defineTool({
  name: "get_camera_snapshot",
  title: "Get a camera or image snapshot",
  description: "Fetch the current picture from a camera or image entity and return it as an image, so it can be looked at directly. Cameras that are off or show black in the UI will return that too. Limited to 4 MB.",
  risk: "read",
  shape: { entity_id: z.string().describe("A camera.* or image.* entity.") },
  handler: async ({ entity_id }, ctx) => {
    const d = domainOf(entity_id);
    if (d !== "camera" && d !== "image") throw new Error("entity_id must be a camera.* or image.* entity.");
    const state = await ctx.ha.getState(entity_id);
    if (!state) throw new Error(`Entity ${entity_id} does not exist.`);
    const path = d === "camera" ? `/api/camera_proxy/${entity_id}` : `/api/image_proxy/${entity_id}`;
    const { data, contentType } = await ctx.ha.restBinary(path);
    const mime = contentType.split(";")[0].trim();
    if (!mime.startsWith("image/")) throw new Error(`Home Assistant returned ${mime} instead of an image.`);
    return new ImageOutcome(data.toString("base64"), mime, `${state.attributes.friendly_name ?? entity_id} (${state.state}), ${data.length} bytes`);
  },
});

// Polls once a second until an entity reaches a given state (or changes at all, if
// no target is given) or the timeout passes. This is how you confirm a command
// really worked: 'I asked the light to turn on. Did it?' Waits up to two minutes.
const waitForState = defineTool({
  name: "wait_for_state",
  title: "Wait for an entity state",
  description: "Wait until an entity reaches a state, or changes from its current state if no target is given, or the timeout passes. Useful after sending a command, to confirm the device really did it.",
  risk: "read",
  shape: {
    entity_id: z.string(),
    state: z.string().optional().describe("Target state, for example 'on' or 'locked'. Omit to wait for any change."),
    timeout_s: z.number().min(1).max(120).default(30),
  },
  handler: async ({ entity_id, state, timeout_s }, ctx) => {
    const first = await ctx.ha.getState(entity_id);
    if (!first) throw new Error(`Entity ${entity_id} does not exist.`);
    const started = Date.now();
    const done = (s: HAState) => (state !== undefined ? s.state === state : s.last_changed !== first.last_changed || s.state !== first.state);
    if (state !== undefined && done(first)) return { matched: true, state: first.state, waited_s: 0 };
    while (Date.now() - started < timeout_s * 1000) {
      await sleep(1000);
      const now = await ctx.ha.getState(entity_id);
      if (now && done(now)) return { matched: true, state: now.state, previous_state: first.state, waited_s: Math.round((Date.now() - started) / 100) / 10 };
    }
    const last = await ctx.ha.getState(entity_id);
    return { matched: false, state: last?.state, waited_s: timeout_s, message: "Timed out before the state changed." };
  },
});

// The structured version of the log: grouped errors and warnings with how many times each happened. Much easier to scan than the raw text.
const getSystemLog = defineTool({
  name: "get_system_log",
  title: "Get the structured system log",
  description: "Errors and warnings Home Assistant has logged, grouped with occurrence counts, source and the last message. Easier to scan than the raw error log.",
  risk: "read",
  shape: {
    level: z.enum(["CRITICAL", "ERROR", "WARNING"]).optional(),
    query: z.string().optional().describe("Text matched against logger name and message."),
    limit: z.number().int().min(1).max(100).default(25),
  },
  handler: async ({ level, query, limit }, ctx) => {
    let list = (await ctx.ha.wsCommand<any[]>({ type: "system_log/list" })) ?? [];
    if (level) list = list.filter((e) => e.level === level);
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((e) => `${e.name} ${(e.message ?? []).join(" ")}`.toLowerCase().includes(q));
    }
    return {
      total: list.length,
      entries: list.slice(0, limit).map((e) => ({
        level: e.level, logger: e.name, count: e.count, first: iso(e.first_occurred), last: iso(e.timestamp),
        message: (e.message ?? []).join(" ").slice(0, 400), source: Array.isArray(e.source) ? e.source.join(":") : e.source,
        exception: e.exception ? String(e.exception).slice(0, 600) : undefined,
      })),
    };
  },
});

// The 'tell me about my house' tool. It pulls states and config together and
// summarises: who is home, locks and alarms, entry covers that are not closed,
// climate, lights on, unavailable things (skipping the ones you said are expected),
// low batteries, pending updates, automation counts, integration problems and open
// repairs. Each optional part is wrapped so one failure cannot break the whole
// overview.
const getOverview = defineTool({
  name: "get_home_overview",
  title: "Home overview",
  description:
    "One call snapshot of the whole home: version, counts by domain, who is home, locks and alarms, open entry covers, climate, lights on, unavailable entities (skipping the ones you expect to be off), low batteries, pending updates, automation counts, integration problems and repairs.",
  risk: "read",
  shape: { sample: z.number().int().min(1).max(50).default(10).describe("How many example entities to list per group.") },
  handler: async ({ sample }, ctx) => {
    const [states, config] = await Promise.all([ctx.ha.getStates(), ctx.ha.getConfig()]);
    const name = (s: HAState) => (s.attributes.friendly_name as string | undefined) ?? s.entity_id;
    const byDomain: Record<string, number> = {};
    for (const s of states) byDomain[domainOf(s.entity_id)] = (byDomain[domainOf(s.entity_id)] ?? 0) + 1;
    const of = (d: string) => states.filter((s) => domainOf(s.entity_id) === d);

    const unavailable = states.filter((s) => (s.state === "unavailable" || s.state === "unknown") && !ignored(s.entity_id, ctx.cfg));
    const batteries = states
      .filter((s) => s.attributes.device_class === "battery" && s.attributes.unit_of_measurement === "%" && Number.isFinite(Number(s.state)) && Number(s.state) <= 20)
      .sort((a, b) => Number(a.state) - Number(b.state));

    let integrationProblems: number | undefined;
    let repairs: number | undefined;
    try {
      const entries = (await ctx.ha.wsCommand<any[]>({ type: "config_entries/get" })) ?? [];
      integrationProblems = entries.filter((e) => e.state !== "loaded" && !e.disabled_by && e.source !== "ignore").length;
    } catch { /* optional */ }
    try {
      repairs = ((await ctx.ha.wsCommand<{ issues?: any[] }>({ type: "repairs/list_issues" }))?.issues ?? []).filter((i) => !i.ignored).length;
    } catch { /* optional */ }
    const autos = of("automation");

    return {
      home: { version: config.version, name: config.location_name, time_zone: config.time_zone, state: config.state, safe_mode: config.safe_mode },
      entities: { total: states.length, by_domain: Object.fromEntries(Object.entries(byDomain).sort((a, b) => b[1] - a[1]).slice(0, 15)) },
      people: of("person").map((s) => ({ name: name(s), state: s.state })),
      security: {
        locks: of("lock").map((s) => ({ entity_id: s.entity_id, name: name(s), state: s.state })),
        alarms: of("alarm_control_panel").map((s) => ({ entity_id: s.entity_id, name: name(s), state: s.state })),
        entry_covers_not_closed: of("cover").filter((s) => ["garage", "gate", "door"].includes(String(s.attributes.device_class)) && s.state !== "closed").map((s) => ({ entity_id: s.entity_id, name: name(s), state: s.state })),
      },
      climate: of("climate").map((s) => ({ entity_id: s.entity_id, name: name(s), mode: s.state, current: s.attributes.current_temperature, target: s.attributes.temperature, action: s.attributes.hvac_action })),
      lights: { on: of("light").filter((s) => s.state === "on").length, total: of("light").length, on_examples: of("light").filter((s) => s.state === "on").slice(0, sample).map(name) },
      unavailable: { count: unavailable.length, examples: unavailable.slice(0, sample).map((s) => ({ entity_id: s.entity_id, state: s.state })), ignored_patterns: ctx.cfg.ignoreUnavailable.length },
      low_batteries: batteries.slice(0, sample).map((s) => ({ entity_id: s.entity_id, name: name(s), percent: Number(s.state) })),
      updates_available: of("update").filter((s) => s.state === "on").map((s) => ({ entity_id: s.entity_id, name: name(s), installed: s.attributes.installed_version, latest: s.attributes.latest_version })),
      automations: { total: autos.length, on: autos.filter((s) => s.state === "on").length, off: autos.filter((s) => s.state === "off").length, running_now: autos.filter((s) => Number(s.attributes.current) > 0).length },
      integrations_with_problems: integrationProblems,
      open_repairs: repairs,
    };
  },
});

// Scans for things that need attention: unavailable entities, sensors that stopped
// reporting (stale), low batteries, pending updates, integrations that failed to
// load, open repairs, and (optionally, since it is slower) automations or scripts
// that refer to entities that no longer exist. Disabled and hidden entities, and
// anything on your ignore list, are left out so the results are about real faults.
const findProblems = defineTool({
  name: "find_problems",
  title: "Find problems in the home",
  description:
    "Scan for things that need attention: unavailable or unknown entities (skipping expected ones), stale sensors that stopped reporting, low batteries, integrations that failed to load, open repairs, available updates, and optionally automations and scripts that reference entities that no longer exist.",
  risk: "read",
  shape: {
    stale_hours: z.number().min(1).max(8760).default(48).describe("A measurement sensor with no update for this long is stale."),
    check_references: z.boolean().default(false).describe("Also read automation and script configs to find missing entities. Slower on large installs."),
    limit: z.number().int().min(1).max(100).default(15).describe("Maximum items per section."),
  },
  handler: async ({ stale_hours, check_references, limit }, ctx) => {
    const states = await ctx.ha.getStates();
    const known = new Set(states.map((s) => s.entity_id));
    const out: Record<string, unknown> = {};
    const section = (key: string, items: unknown[]) => {
      out[key] = { count: items.length, items: items.slice(0, limit) };
    };

    let disabled = new Set<string>();
    try {
      const reg = await ctx.ha.getRegistry();
      disabled = new Set(reg.entities.filter((e) => e.disabled_by || e.hidden_by).map((e) => e.entity_id));
    } catch { /* optional */ }
    const watch = states.filter((s) => !ignored(s.entity_id, ctx.cfg) && !disabled.has(s.entity_id));

    section("unavailable_entities", watch.filter((s) => s.state === "unavailable" || s.state === "unknown").map((s) => ({ entity_id: s.entity_id, state: s.state, since: s.last_changed })));
    const cutoff = Date.now() - stale_hours * 3_600_000;
    section("stale_sensors", watch
      .filter((s) => domainOf(s.entity_id) === "sensor" && s.attributes.state_class === "measurement" && s.state !== "unavailable" && Date.parse(s.last_updated) < cutoff)
      .map((s) => ({ entity_id: s.entity_id, last_updated: s.last_updated })));
    section("low_batteries", watch
      .filter((s) => s.attributes.device_class === "battery" && s.attributes.unit_of_measurement === "%" && Number.isFinite(Number(s.state)) && Number(s.state) <= 20)
      .sort((a, b) => Number(a.state) - Number(b.state))
      .map((s) => ({ entity_id: s.entity_id, percent: Number(s.state) })));
    section("updates_available", states.filter((s) => domainOf(s.entity_id) === "update" && s.state === "on").map((s) => ({ entity_id: s.entity_id, installed: s.attributes.installed_version, latest: s.attributes.latest_version })));
    try {
      const entries = (await ctx.ha.wsCommand<any[]>({ type: "config_entries/get" })) ?? [];
      section("integration_problems", entries.filter((e) => e.state !== "loaded" && !e.disabled_by && e.source !== "ignore").map((e) => ({ entry_id: e.entry_id, domain: e.domain, title: e.title, state: e.state, reason: e.reason })));
    } catch { out.integration_problems = { note: "Could not read config entries." }; }
    try {
      const r = await ctx.ha.wsCommand<{ issues?: any[] }>({ type: "repairs/list_issues" });
      section("open_repairs", (r?.issues ?? []).filter((i) => !i.ignored).map((i) => ({ domain: i.domain, issue_id: i.issue_id, severity: i.severity, fixable: i.is_fixable })));
    } catch { out.open_repairs = { note: "Could not read repairs." }; }

    if (check_references) {
      // For the missing entity check we read each automation and script config, four at a
      // time so we do not flood Home Assistant, and cap it at 200 items.
      const targets = states
        .filter((s) => (s.entity_id.startsWith("automation.") && s.attributes.id) || s.entity_id.startsWith("script."))
        .slice(0, 200);
      const broken: unknown[] = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < targets.length) {
          const s = targets[cursor++];
          const kind = s.entity_id.startsWith("automation.") ? "automation" : "script";
          const id = kind === "automation" ? String(s.attributes.id) : s.entity_id.slice("script.".length);
          try {
            const cfg = await fetchConfigItem(ctx.ha, kind, id);
            if (!cfg) continue;
            const missing = referencedEntities(cfg).filter((e) => !known.has(e));
            if (missing.length) broken.push({ item: s.entity_id, name: s.attributes.friendly_name, missing_entities: missing });
          } catch { /* skip unreadable */ }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      section("automations_and_scripts_with_missing_entities", broken);
      out.checked_items = targets.length;
    }
    out.note = ctx.cfg.ignoreUnavailable.length ? `${ctx.cfg.ignoreUnavailable.length} ignore pattern(s) applied to unavailable and stale checks.` : "No ignore patterns set. Add HA_IGNORE_UNAVAILABLE to skip entities that are expected to be offline.";
    return out;
  },
});

// Answers 'why did this change?'. For each recent logbook entry it works out the
// cause: an automation or script (and which trace tool to use to dig further), a
// service call, a person using the app, another event, or just the device itself.
const explainStateChange = defineTool({
  name: "explain_state_change",
  title: "Explain why something changed",
  description:
    "Why did this entity change? Reads the logbook and reports, for each recent change, what caused it: an automation or script (with the id to pass to get_automation_trace), a user or service call, or the device itself.",
  risk: "read",
  shape: {
    entity_id: z.string(),
    hours: z.number().min(0.1).max(168).default(6),
    limit: z.number().int().min(1).max(100).default(15),
  },
  handler: async ({ entity_id, hours, limit }, ctx) => {
    const start = new Date(Date.now() - hours * 3_600_000).toISOString();
    const entries = (await ctx.ha.rest<any[]>("GET", `/api/logbook/${encodeURIComponent(start)}`, { query: { entity: entity_id } })) ?? [];
    const recent = entries.slice(-limit).reverse();
    return {
      entity_id,
      window_hours: hours,
      total_changes: entries.length,
      changes: recent.map((e) => {
        let caused_by = "the device itself or an integration (no Home Assistant context recorded)";
        let follow_up: string | undefined;
        if (e.context_entity_id && /^(automation|script)\./.test(e.context_entity_id)) {
          caused_by = `${domainOf(e.context_entity_id)} "${e.context_entity_id_name ?? e.context_name ?? e.context_entity_id}"${e.context_message ? ` (${e.context_message})` : ""}`;
          follow_up = domainOf(e.context_entity_id) === "automation" ? `get_automation_trace with ${e.context_entity_id}` : `get_script_trace with ${e.context_entity_id}`;
        } else if (e.context_service) {
          caused_by = `a call to ${e.context_domain ?? "?"}.${e.context_service}${e.context_user_id ? " by a user" : ""}`;
        } else if (e.context_user_id) {
          caused_by = "a user action in the interface or app";
        } else if (e.context_event_type) {
          caused_by = `event ${e.context_event_type}${e.context_entity_id ? ` from ${e.context_entity_id}` : ""}`;
        }
        return { when: e.when, state: e.state, message: e.message, caused_by, follow_up };
      }),
    };
  },
});

// Adds the ten tools. All of them are read only.
export function registerInsightTools(server: McpServer, ctx: ToolContext): void {
  for (const def of [getOverview, findProblems, explainStateChange, getStatistics, getCalendarEvents, getTodoItems, getForecast, getCameraSnapshot, waitForState, getSystemLog]) {
    registerTool(server, ctx, def as any);
  }
}
