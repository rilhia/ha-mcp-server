// The "raw" tools are the escape hatch. The typed tools cover the common jobs, but
// Home Assistant has hundreds of API commands and endpoints, and the goal of this
// project is that nothing the API allows is out of reach. These four tools can talk
// to ANY endpoint:
//   ha_ws_read   - any WebSocket command that only reads
//   ha_ws_write  - any WebSocket command that changes something (always high risk)
//   ha_rest_read - any REST GET (plus two harmless POSTs)
//   ha_rest_write- any REST POST, PUT, PATCH or DELETE (always high risk)
//
// Because they are so open, they are the most carefully fenced tools here:
//   * Reads are checked against a list of commands known to be read only. Anything
//     unrecognised is treated as a write, never as a read. When in doubt, it asks.
//   * Writes always need the full preview, plan token and confirmation, and they
//     cannot be used to sidestep the proper tools (services and automation config
//     are redirected to call_service and save_automation).
//   * The never-touch list is checked against every entity id in the request.
//   * No automatic backup exists for raw commands, and the tool descriptions say so.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { evaluateGate, neverTouchHits, scanConfigRisk } from "../safety.js";
import { NEVER_TOUCH_HELP } from "../settings-help.js";
import { ToolOutcome } from "../util.js";
import { defineTool, registerTool, type ToolContext } from "./registry.js";

// The allow list of read only commands. Reading is only automatic for commands on
// this list (or matching the safe naming pattern below). If a read command you need
// is missing, the error message says so and it can be added.
/** WebSocket commands known to only read. Anything not recognised is treated as a write. */
const WS_READ_EXACT = new Set([
  "get_states", "get_config", "get_services", "get_panels", "ping", "validate_config", "search/related",
  "lovelace/config", "lovelace/resources", "lovelace/dashboards/list",
  "trace/list", "trace/get", "trace/contexts", "logbook/get_events", "history/history_during_period",
  "recorder/statistics_during_period", "recorder/statistic_during_period", "recorder/list_statistic_ids",
  "recorder/get_statistics_metadata", "recorder/info", "recorder/validate_statistics",
  "energy/get_prefs", "energy/info", "energy/validate", "energy/fossil_energy_consumption",
  "auth/current_user", "config/auth/list", "media_player/browse_media", "media_source/browse_media",
  "conversation/agent/list", "repairs/list_issues", "persistent_notification/get", "system_log/list",
  "blueprint/list", "blueprint/substitute", "manifest/list", "manifest/get", "integration/descriptions",
  "entity/source", "config_entries/get", "config_entries/flow/progress", "webhook/list",
  "backup/info", "backup/details", "backup/agents/info", "diagnostics/list", "diagnostics/get",
  "application_credentials/config", "zone/list", "sun/events",
]);

// Commands that reply and then stream events (like system health). We listen for a few seconds and report what arrived.
/** Observation style commands: they answer, then stream events for a short window. */
const WS_SUBSCRIBE = new Set(["system_health/info", "render_template", "subscribe_events", "subscribe_trigger"]);

// Many read commands follow a naming pattern: they end in /list, /get or /info (or
// list_something and so on). This lets us recognise new, unlisted ones that follow
// the convention, while a command like 'config/entity_registry/update' is not matched.
const WS_READ_PATTERN = /^[a-z_]+(\/[a-z_]+)*\/(list|get|info|(list|get|info)_[a-z_]+)$/;

// The three categories a command can fall into.
export type WsKind = "read" | "subscribe" | "write";

// Decides whether a WebSocket command reads, streams, or writes. The Supervisor
// proxy is special: whether it reads or writes depends on its HTTP method, so we
// look at that. Anything we do not recognise is classified as a write, which is the
// safe default.
export function classifyWsCommand(type: string, params: Record<string, unknown> = {}): WsKind {
  if (type === "supervisor/api") {
    const method = String(params.method ?? "get").toLowerCase();
    return method === "get" ? "read" : "write";
  }
  if (WS_SUBSCRIBE.has(type)) return "subscribe";
  if (WS_READ_EXACT.has(type) || WS_READ_PATTERN.test(type)) return "read";
  return "write";
}

// Matches a valid entity id.
const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;

// Digs through any nested request and collects everything that looks like an entity id, so the never-touch list can be checked against it.
function collectEntityIds(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (ENTITY_RE.test(value)) out.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectEntityIds(v, out));
  } else if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((v) => collectEntityIds(v, out));
  }
  return out;
}

// Locks down the path for REST calls. It must start with /api/, contain no query
// characters, no '..' tricks and no double slashes, so it cannot be used to reach
// another host or climb out of the API. The WebSocket address has its own tools.
/** Only /api/ paths on the configured Home Assistant, never another host or the WebSocket upgrade path. */
export function cleanApiPath(path: string): string {
  if (!path.startsWith("/api/")) throw new Error('path must start with "/api/", for example /api/states/light.kitchen');
  if (/[?#\s\\]/.test(path)) throw new Error("path must not contain spaces, backslashes, ? or #. Pass query values in the query field.");
  if (path.includes("..") || path.includes("//")) throw new Error("path must not contain .. or //");
  if (path === "/api/websocket") throw new Error("Use ha_ws_read or ha_ws_write for WebSocket commands.");
  return path;
}

// If the reply is a list, trim it to the requested size (and optionally to chosen fields) and say how many there were, so a huge list does not flood the reply.
function shapeResult(result: unknown, maxItems: number, fields?: string[]): unknown {
  if (!Array.isArray(result)) return result;
  let items = result;
  if (fields?.length) {
    items = items.map((it) =>
      it && typeof it === "object" ? Object.fromEntries(fields.filter((f) => f in (it as object)).map((f) => [f, (it as any)[f]])) : it
    );
  }
  return {
    total: result.length,
    returned: Math.min(result.length, maxItems),
    truncated: result.length > maxItems,
    items: items.slice(0, maxItems),
  };
}

// The shared definition of the 'params' argument.
const paramsSchema = z
  .record(z.string(), z.any())
  .optional()
  .describe("Fields of the command, for example {entity_id: 'light.kitchen'}. Do not include id or type.");

// 'id' and 'type' are set by the server itself, so passing them as params would only cause confusion.
function checkParams(params?: Record<string, unknown>): void {
  if (params && ("id" in params || "type" in params)) {
    throw new Error('params must not contain "id" or "type". Pass the command name in the type argument.');
  }
}

// Runs any read only WebSocket command. Unknown commands are refused with a clear
// message instead of being guessed at, and the helpful part of that message tells the
// caller the right tool to use if it actually does change something.
const wsRead = defineTool({
  name: "ha_ws_read",
  title: "Run a read-only WebSocket command",
  description:
    "Send any read-only Home Assistant WebSocket command, for example lovelace/config, recorder/statistics_during_period, config/entity_registry/list, search/related, energy/get_prefs, repairs/list_issues or persistent_notification/get. Known read commands run immediately. Anything that could change something is refused here and must go through ha_ws_write. Array results can be trimmed with max_items and fields.",
  risk: "read",
  shape: {
    type: z.string().min(1).describe("The WebSocket command type, for example 'config/area_registry/list'."),
    params: paramsSchema,
    max_items: z.number().int().min(1).max(1000).default(100).describe("Maximum array items to return."),
    fields: z.array(z.string()).optional().describe("For array results, keep only these keys of each item."),
    collect_ms: z.number().int().min(200).max(30000).default(3000).describe("For observation commands such as subscribe_events, how long to listen for events."),
  },
  handler: async ({ type, params, max_items, fields, collect_ms }, ctx) => {
    checkParams(params);
    const kind = classifyWsCommand(type, params);
    if (kind === "write") {
      throw new Error(
        `"${type}" is not a known read-only command, so it is not allowed here. If it only reads, tell me and I can add it to the list. If it changes something, use ha_ws_write, which asks for confirmation.`
      );
    }
    const payload = { type, ...(params ?? {}) };
    if (kind === "subscribe") {
      const { result, events } = await ctx.ha.ws.commandCollect(payload, collect_ms);
      return { result, events: events.slice(0, max_items), events_received: events.length };
    }
    return shapeResult(await ctx.ha.wsCommand(payload), max_items, fields);
  },
});

// Runs any other WebSocket command, behind the full gate. We refuse call_service
// here (use the proper tool so the risk checks apply), check the never-touch list,
// and look inside execute_script requests for risky actions.
const wsWrite = defineTool({
  name: "ha_ws_write",
  title: "Run a WebSocket command that changes something",
  description:
    "Send any Home Assistant WebSocket command that is not known to be read-only, for example config/entity_registry/update or lovelace/config/save. Always HIGH RISK and rejected unless confirm is true, dry_run is false and the plan_token from the preview is supplied. No automatic backup is taken for raw commands, so read the current state first if you may need to undo. Service calls must use call_service.",
  risk: "high",
  shape: {
    type: z.string().min(1).describe("The WebSocket command type."),
    params: paramsSchema,
    confirm: z.boolean().default(false).describe("Explicit user consent."),
    dry_run: z.boolean().default(true).describe("Preview only. Must be false to execute."),
  },
  handler: async ({ type, params, confirm, dry_run }, ctx) => {
    checkParams(params);
    if (type === "call_service") {
      throw new Error("Use the call_service tool for services so its risk checks apply.");
    }
    if (classifyWsCommand(type, params) !== "write") {
      throw new Error(`"${type}" only reads. Use ha_ws_read.`);
    }
    const ids = [...collectEntityIds(params)];
    const blocked = neverTouchHits(ids, ctx.cfg);
    if (blocked.length) {
      return new ToolOutcome(
        { status: "blocked_never_touch", executed: false, entities: blocked, message: `These entities are on the never-touch list (HA_NEVER_TOUCH). ${NEVER_TOUCH_HELP}` },
        true
      );
    }
    const reasons = [`${type} is a WebSocket command that can change Home Assistant, and raw commands have no automatic backup`];
    if (type === "execute_script" && params) {
      const states = new Map((await ctx.ha.getStates()).map((s) => [s.entity_id, s]));
      reasons.push(...scanConfigRisk({ sequence: params.sequence }, states, ctx.cfg));
    }
    const gate = await evaluateGate({
      risk: "high",
      reasons,
      action: `Send WebSocket command ${type}${ids.length ? ` affecting ${ids.join(", ")}` : ""}.`,
      plan: { type, params: params ?? {} },
      confirm,
      dryRun: dry_run,
    });
    if (!gate.proceed) return gate.outcome;
    const result = await ctx.ha.wsCommand({ type, ...(params ?? {}) }, 60_000);
    ctx.ha.invalidateCaches();
    return { status: "executed", executed: true, type, result };
  },
});

// Reads anything through the REST API. POST is permitted only for two endpoints that look like writes but only read.
const restRead = defineTool({
  name: "ha_rest_read",
  title: "Run a read-only REST request",
  description:
    "Read anything from the Home Assistant REST API with GET, for example /api/calendars, /api/events, /api/history/period/<time>, /api/error_log or /api/config/scene/config/<id>. POST is allowed only for /api/template and /api/config/core/check_config, which do not change anything. Anything else must use ha_rest_write.",
  risk: "read",
  shape: {
    path: z.string().describe("Path starting with /api/. Query values go in the query field."),
    method: z.enum(["GET", "POST"]).default("GET"),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Query string values."),
    body: z.record(z.string(), z.any()).optional().describe("JSON body, only for the two POST paths."),
    max_items: z.number().int().min(1).max(1000).default(100).describe("Maximum array items to return."),
    fields: z.array(z.string()).optional().describe("For array results, keep only these keys of each item."),
  },
  handler: async ({ path, method, query, body, max_items, fields }, ctx) => {
    const clean = cleanApiPath(path);
    if (method === "POST" && !["/api/template", "/api/config/core/check_config"].includes(clean)) {
      throw new Error("POST is only allowed here for /api/template and /api/config/core/check_config. Use ha_rest_write for anything else.");
    }
    const result = await ctx.ha.rest(method, clean, { query, body });
    return shapeResult(result, max_items, fields);
  },
});

// Endpoints that have proper, safer tools. If someone tries to reach them through the raw tool, we point them to the right one.
const REST_REDIRECTS: [RegExp, string][] = [
  [/^\/api\/services\//, "Use the call_service tool for services so its risk checks apply."],
  [/^\/api\/config\/(automation|script)\/config\//, "Use save_automation, save_script, delete_automation or delete_script, which validate and back up."],
];

// Any REST request that changes something, always high risk. A few extra warnings
// are added for endpoints with side effects: writing a state fakes an entity's
// value, and webhooks and events can trigger automations.
const restWrite = defineTool({
  name: "ha_rest_write",
  title: "Run a REST request that changes something",
  description:
    "Send POST, PUT, PATCH or DELETE to the Home Assistant REST API, for example POST /api/events/<type> to fire an event or POST /api/config/scene/config/<id> to save a scene. Always HIGH RISK and rejected unless confirm is true, dry_run is false and the plan_token from the preview is supplied. No automatic backup is taken, so read the current state first if you may need to undo. Services and automation or script config have their own tools.",
  risk: "high",
  shape: {
    method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().describe("Path starting with /api/."),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: z.record(z.string(), z.any()).optional().describe("JSON body."),
    confirm: z.boolean().default(false).describe("Explicit user consent."),
    dry_run: z.boolean().default(true).describe("Preview only. Must be false to execute."),
  },
  handler: async ({ method, path, query, body, confirm, dry_run }, ctx) => {
    const clean = cleanApiPath(path);
    for (const [re, msg] of REST_REDIRECTS) if (re.test(clean)) throw new Error(msg);
    if (method === "POST" && ["/api/template", "/api/config/core/check_config"].includes(clean)) {
      throw new Error("That endpoint only reads. Use ha_rest_read.");
    }
    const ids = [...collectEntityIds([clean.split("/").pop(), body])];
    const blocked = neverTouchHits(ids, ctx.cfg);
    if (blocked.length) {
      return new ToolOutcome(
        { status: "blocked_never_touch", executed: false, entities: blocked, message: `These entities are on the never-touch list (HA_NEVER_TOUCH). ${NEVER_TOUCH_HELP}` },
        true
      );
    }
    const reasons = [`${method} ${clean} can change Home Assistant, and raw requests have no automatic backup`];
    if (clean.startsWith("/api/states/")) reasons.push("writing a state creates or overrides an entity state without touching the real device");
    if (clean.startsWith("/api/webhook/")) reasons.push("calling a webhook can trigger automations");
    if (clean.startsWith("/api/events/")) reasons.push("firing an event can trigger automations");
    const gate = await evaluateGate({
      risk: "high",
      reasons,
      action: `Send ${method} ${clean}.`,
      plan: { method, path: clean, query: query ?? {}, body: body ?? {} },
      confirm,
      dryRun: dry_run,
    });
    if (!gate.proceed) return gate.outcome;
    const result = await ctx.ha.rest(method, clean, { query, body, timeoutMs: 60_000 });
    ctx.ha.invalidateCaches();
    return { status: "executed", executed: true, method, path: clean, result };
  },
});

// Adds the four raw tools.
export function registerRawTools(server: McpServer, ctx: ToolContext): void {
  for (const def of [wsRead, wsWrite, restRead, restWrite]) registerTool(server, ctx, def as any);
}
