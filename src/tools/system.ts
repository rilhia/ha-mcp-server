// The "health and maintenance" tools:
//   get_ha_config        - basic facts about this Home Assistant (and which URL we use)
//   check_config         - ask Home Assistant if its configuration is valid
//   get_error_log        - read recent log lines, with filters
//   get_system_health    - the per integration health report
//   restart_home_assistant / stop_home_assistant - power controls (high risk)
//   list_backups         - the rollback copies this server has taken
//   restore_backup       - put something back the way it was (high risk)
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchConfigItem, stripId, writeConfigItem, type ConfigKind } from "../resources.js";
import { HAError } from "../ha-client.js";
import { evaluateGate } from "../safety.js";
import { REGISTRIES, commandIdKey, type RegistryName } from "./registries.js";
import { ToolOutcome, describeChanges, diffObjects } from "../util.js";
import { HELPER_TYPES, helperCreate, helperList, helperUpdate, stripHelperId, type HelperType } from "./helpers.js";
import { defineTool, registerTool, type ToolContext } from "./registry.js";

// Handy as a first test of the connection. We include which URL and WebSocket address
// this server is really using, which instantly answers 'is it pointed at the right
// place?'.
const getHaConfig = defineTool({
  name: "get_ha_config",
  title: "Get Home Assistant config summary",
  description: "Core facts about the instance: version, location name, time zone, unit system, run state, safe mode, and loaded integration count.",
  risk: "read",
  shape: {
    include_components: z.boolean().default(false).describe("List every loaded component (long)."),
  },
  handler: async ({ include_components }, ctx) => {
    const c = await ctx.ha.getConfig();
    return {
      server_connection: {
        ha_url_in_use: ctx.cfg.url,
        websocket_url_in_use: ctx.cfg.wsUrl,
        read_only: ctx.cfg.readOnly,
        insecure_tls: ctx.cfg.insecureTls,
      },
      version: c.version,
      location_name: c.location_name,
      time_zone: c.time_zone,
      unit_system: c.unit_system,
      state: c.state,
      safe_mode: c.safe_mode,
      recovery_mode: c.recovery_mode,
      external_url: c.external_url,
      internal_url: c.internal_url,
      loaded_component_count: c.components?.length,
      components: include_components ? c.components : undefined,
    };
  },
});

// Asks Home Assistant to validate its configuration. It only reads, so it is available in read only mode.
const checkConfig = defineTool({
  name: "check_config",
  title: "Check configuration validity",
  description: "Run Home Assistant's configuration check (POST /api/config/core/check_config). Use before and after any change to YAML or storage config.",
  risk: "read",
  shape: {},
  handler: async (_a, ctx) => {
    const r = await ctx.ha.checkConfig();
    return { valid: r.result === "valid", result: r.result, errors: r.errors, warnings: r.warnings };
  },
});

// Home Assistant's log can be huge. This returns just the tail, and can narrow it
// down by log level or a search word. The filter is treated as a regular expression
// when possible, and as plain text if it is not a valid one (so odd characters in
// what you typed cannot cause an error).
const getErrorLog = defineTool({
  name: "get_error_log",
  title: "Get error log",
  description: "Fetch the tail of the Home Assistant error log, optionally keeping only lines that match a filter.",
  risk: "read",
  shape: {
    lines: z.number().int().min(1).max(2000).default(150).describe("How many lines from the end to return."),
    filter: z.string().optional().describe("Case insensitive substring or regular expression. Only matching lines are kept."),
    level: z.enum(["ERROR", "WARNING", "CRITICAL"]).optional().describe("Keep only lines at this log level."),
  },
  handler: async ({ lines, filter, level }, ctx) => {
    const raw = await ctx.ha.getErrorLog();
    let all = raw.split("\n");
    if (level) all = all.filter((l) => l.includes(` ${level} `));
    if (filter) {
      let re: RegExp;
      try {
        re = new RegExp(filter, "i");
      } catch {
        re = new RegExp(filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }
      all = all.filter((l) => re.test(l));
    }
    const tail = all.slice(-lines);
    return { total_matching_lines: all.length, returned: tail.length, log: tail.join("\n") };
  },
});

// System health is delivered as a stream of events rather than a normal reply, so we
// use commandCollect to listen for a few seconds and merge what arrives, section by
// section. If the feature is unavailable we still return the basic summary.
const getSystemHealth = defineTool({
  name: "get_system_health",
  title: "Get system health",
  description: "System health report per integration (Home Assistant core, supervisor, recorder database, and others), plus the core config summary.",
  risk: "read",
  shape: {},
  handler: async (_a, ctx) => {
    const config = await ctx.ha.getConfig();
    const summary = { version: config.version, state: config.state, safe_mode: config.safe_mode };
    try {
      const { events } = await ctx.ha.ws.commandCollect({ type: "system_health/info" }, 4000);
      const sections: Record<string, unknown> = {};
      for (const ev of events) {
        for (const [domain, entry] of Object.entries<any>(ev ?? {})) {
          if (entry && typeof entry === "object") sections[domain] = { ...(sections[domain] as object), ...entry };
        }
      }
      return { summary, sections };
    } catch (err) {
      return { summary, sections: null, note: `system_health/info was not available: ${(err as Error).message}` };
    }
  },
});

// Shared logic for restart and stop, since they only differ in the verb.
async function powerAction(ctx: ToolContext, mode: "restart" | "stop", confirm: boolean, dryRun: boolean) {
  // This check matters a lot. If the configuration is invalid and we restart, Home
  // Assistant may fail to come back up, and nothing in this server can fix that. So we
  // refuse unless check_config passes.
  // Never restart into a broken config: a failed restart can leave the instance offline.
  const check = await ctx.ha.checkConfig();
  const config = await ctx.ha.getConfig();
  if (check.result !== "valid") {
    return new ToolOutcome(
      {
        status: "blocked",
        executed: false,
        message: `check_config failed, so ${mode} was refused. A restart with an invalid configuration can leave Home Assistant unable to start.`,
        check_config: check,
      },
      true
    );
  }
  const verb = mode === "restart" ? "Restart" : "Shut down";
  const gate = await evaluateGate({
    risk: "high",
    reasons: [mode === "restart" ? "restarts Home Assistant core" : "shuts down Home Assistant core"],
    action: `${verb} Home Assistant ${config.version} (${config.location_name}).`,
    plan: {
      mode,
      pre_flight: "check_config passed",
      effect:
        mode === "restart"
          ? "All automations, integrations and dashboards are unavailable for roughly 30 to 120 seconds. Running scripts are interrupted."
          : "Home Assistant will stay OFF until it is started again outside Home Assistant (host or supervisor). This server cannot bring it back.",
    },
    confirm,
    dryRun,
  });
  if (!gate.proceed) return gate.outcome;
  // When Home Assistant begins shutting down, the connection may drop before it replies.
  // That is expected and counts as success, so we only rethrow errors that do not look
  // like a dropped connection.
  // The request may be cut off as the core goes down, which counts as success.
  try {
    await ctx.ha.callService("homeassistant", mode);
  } catch (err) {
    const msg = (err as Error).message;
    if (!/timed out|closed|ECONNRESET|socket hang up|fetch failed/i.test(msg)) throw err;
  }
  ctx.ha.invalidateCaches();
  return { status: "requested", executed: true, mode, note: mode === "restart" ? "Home Assistant is restarting. Tools will work again once it is back." : "Home Assistant is shutting down." };
}

// Restarts Home Assistant. Always high risk, with the full two step approval.
const restartHa = defineTool({
  name: "restart_home_assistant",
  title: "Restart Home Assistant",
  description:
    "Restart Home Assistant core. HIGH RISK. Runs check_config first and refuses if it fails. Rejected unless confirm is true and dry_run is false.",
  risk: "high",
  shape: {
    confirm: z.boolean().default(false).describe("Explicit user consent."),
    dry_run: z.boolean().default(true).describe("Preview only. Must be false to execute."),
  },
  handler: ({ confirm, dry_run }, ctx) => powerAction(ctx, "restart", confirm, dry_run),
});

// Shuts Home Assistant down. This is the more dangerous one, because nothing here can start it again.
const stopHa = defineTool({
  name: "stop_home_assistant",
  title: "Shut down Home Assistant",
  description:
    "Shut down Home Assistant core. HIGH RISK and not reversible from here, because Home Assistant stays off until started externally. Rejected unless confirm is true and dry_run is false.",
  risk: "high",
  shape: {
    confirm: z.boolean().default(false).describe("Explicit user consent."),
    dry_run: z.boolean().default(true).describe("Preview only. Must be false to execute."),
  },
  handler: ({ confirm, dry_run }, ctx) => powerAction(ctx, "stop", confirm, dry_run),
});

// Shows the rollback copies we have taken, newest first. Use this to find a backup_id.
const listBackups = defineTool({
  name: "list_backups",
  title: "List rollback backups",
  description: "List rollback backups taken automatically before automations, scripts or helpers were changed or deleted.",
  risk: "read",
  shape: {
    kind: z.string().optional().describe("automation, script, or helper:<type>."),
    item_id: z.string().optional().describe("Restrict to one item id."),
    limit: z.number().int().min(1).max(100).default(25),
  },
  handler: async ({ kind, item_id, limit }, ctx) => ({ backups: ctx.backups.list({ kind, item_id }, limit) }),
});

// Puts an older version back. Because backups come from many places, the first half
// of this function is a set of branches that each know how to read the CURRENT
// version and how to APPLY the old one for a different kind of thing: helpers,
// dashboards, registry items (areas, labels and so on), and automations, scripts and
// scenes. After that the flow is shared: show a diff, ask the gate, take a safety
// backup of what is there now (so the restore itself can be undone), then apply.
const restoreBackup = defineTool({
  name: "restore_backup",
  title: "Restore a rollback backup",
  description:
    "Roll an automation, script, scene, dashboard, helper or registry item (area, floor, label, device, entity, zone) back to a saved backup. HIGH RISK because it overwrites the current version. Rejected unless confirm is true and dry_run is false. The current version is backed up first so the restore itself can be undone.",
  risk: "high",
  shape: {
    backup_id: z.string().describe("A backup_id from a rollback receipt or list_backups."),
    confirm: z.boolean().default(false).describe("Explicit user consent."),
    dry_run: z.boolean().default(true).describe("Preview only. Must be false to execute."),
  },
  handler: async ({ backup_id, confirm, dry_run }, ctx) => {
    const rec = ctx.backups.load(backup_id);
    if (!rec) throw new Error(`No backup "${backup_id}". Use list_backups to see what exists.`);

    let current: any = null;
    let before: unknown = {};
    let target: any = {};
    let snapshot: unknown;
    let apply: (existing: any) => Promise<void>;

    // Helpers: update the existing one, or recreate it if it was deleted.
    if (rec.kind.startsWith("helper:")) {
      const helperType = rec.kind.slice("helper:".length) as HelperType;
      if (!HELPER_TYPES.includes(helperType)) throw new Error(`Backup has an unknown helper type "${helperType}".`);
      current = (await helperList(ctx.ha, helperType)).find((h) => h.id === rec.item_id) ?? null;
      before = current ? stripHelperId(helperType, current) : {};
      target = stripHelperId(helperType, rec.config as any);
      snapshot = current;
      apply = async (c) => {
        if (c) await helperUpdate(ctx.ha, helperType, rec.item_id, target);
        else await helperCreate(ctx.ha, helperType, target);
      };
    // Dashboards: read the current config (a missing one is fine), and on apply
    // recreate the dashboard entry first if it was deleted, then save its config.
    } else if (rec.kind === "dashboard") {
      const urlPath = rec.item_id === "default" ? null : rec.item_id;
      try {
        current = await ctx.ha.wsCommand({ type: "lovelace/config", url_path: urlPath, force: true });
      } catch (err) {
        if (!(err instanceof HAError && err.code === "config_not_found")) throw err;
      }
      const saved = rec.config as { config?: any; meta?: any };
      before = current ?? {};
      target = saved.config ?? {};
      snapshot = current ? { config: current } : null;
      apply = async () => {
        if (saved.meta) {
          const list = await ctx.ha.wsCommand<any[]>({ type: "lovelace/dashboards/list" });
          if (!list.some((d) => d.url_path === saved.meta.url_path)) {
            await ctx.ha.wsCommand({
              type: "lovelace/dashboards/create", url_path: saved.meta.url_path, title: saved.meta.title, icon: saved.meta.icon,
              show_in_sidebar: saved.meta.show_in_sidebar, require_admin: saved.meta.require_admin, mode: "storage",
            });
          }
        }
        if (saved.config) await ctx.ha.wsCommand({ type: "lovelace/config/save", url_path: urlPath, config: saved.config });
      };
    // Registry items: only the writable fields are compared and restored. A removed
    // entity registry entry cannot be recreated through the API, and we say so.
    } else if (rec.kind.startsWith("registry:")) {
      const name = rec.kind.slice("registry:".length) as RegistryName;
      const spec = REGISTRIES[name];
      if (!spec) throw new Error(`Backup has an unknown registry "${name}".`);
      const items = (await ctx.ha.wsCommand<any[]>({ type: spec.list })) ?? [];
      current = items.find((i) => i[spec.idField] === rec.item_id) ?? null;
      const pick = (o: any) => Object.fromEntries(spec.writable.filter((k) => k !== "new_entity_id" && k in o).map((k) => [k, o[k]]));
      before = current ? pick(current) : {};
      target = pick(rec.config as any);
      snapshot = current;
      apply = async (c) => {
        if (c) await ctx.ha.wsCommand({ type: spec.update as string, [commandIdKey(name)]: rec.item_id, ...target });
        else if (spec.create) await ctx.ha.wsCommand({ type: spec.create, ...target });
        else throw new Error(`A removed ${name} cannot be recreated through the API.`);
      };
    } else {
      const kind = rec.kind as ConfigKind;
      current = await fetchConfigItem(ctx.ha, kind, rec.item_id);
      before = current ? stripId(current) : {};
      target = stripId(rec.config as any);
      snapshot = current;
      apply = async () => {
        await writeConfigItem(ctx.ha, kind, rec.item_id, target);
        if (kind === "scene") await ctx.ha.callService("scene", "reload");
      };
    }

    // Work out exactly what the restore would change, so the person can see it before agreeing.
    const changes = diffObjects(before, target);
    const gate = await evaluateGate({
      risk: "high",
      reasons: [current ? `overwrites the current ${rec.kind} "${rec.item_id}" with an older version` : `recreates the deleted ${rec.kind} "${rec.item_id}"`],
      action: current
        ? `Restore ${rec.kind} "${rec.item_id}" to its state at ${rec.created_at}.`
        : `Recreate ${rec.kind} "${rec.item_id}" from the backup taken at ${rec.created_at}.`,
      plan: { backup_id, taken_at: rec.created_at, reason: rec.reason, changes: describeChanges(changes) },
      confirm,
      dryRun: dry_run,
    });
    if (!gate.proceed) return gate.outcome;

    // Before overwriting, snapshot the current version too. That way a restore can itself be undone.
    const safety = current ? ctx.backups.save(rec.kind, rec.item_id, snapshot, `before restore_backup ${backup_id}`) : null;
    await apply(current);
    ctx.ha.invalidateCaches();
    return {
      status: "restored",
      executed: true,
      kind: rec.kind,
      item_id: rec.item_id,
      rollback_receipt: safety ?? undefined,
    };
  },
});

// Adds the eight tools.
export function registerSystemTools(server: McpServer, ctx: ToolContext): void {
  for (const def of [getHaConfig, checkConfig, getErrorLog, getSystemHealth, restartHa, stopHa, listBackups, restoreBackup]) {
    registerTool(server, ctx, def as any);
  }
}
