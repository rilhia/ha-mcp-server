// Integrations are how Home Assistant connects to things: Hue, MQTT, Zigbee, Sonos
// and so on. Each configured one is called a "config entry". This file covers:
//   list_integrations   - see what is set up and what failed to load
//   manage_config_entry - reload, enable, disable, rename or remove one
//   run_config_flow     - walk through the same setup forms the UI shows
//   list_repairs        - the issues listed under Settings > Repairs
//   ignore_repair       - hide (or unhide) one of those issues
//
// The dangerous ones are disabling and removing an integration, because that takes
// its devices offline or deletes them. Those go through the two step approval.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { evaluateGate } from "../safety.js";
import { defineTool, registerTool, type ToolContext } from "./registry.js";

// Helper style integrations (groups, templates, utility meters and similar) only
// create virtual entities and cannot control real hardware, so finishing a setup
// flow for one of these is considered low risk.
/** Config flow handlers that only create helper entities, so finishing them is low risk. */
const SAFE_HELPER_HANDLERS = new Set([
  "group", "template", "utility_meter", "derivative", "integration", "threshold", "min_max", "statistics", "trend",
  "random", "history_stats", "filter", "tod", "mold_indicator", "compensation", "bayesian",
]);

// Lists configured integrations. With problems_only we hide healthy ones, plus
// disabled ones and ones you deliberately chose to ignore, since those show up as
// 'not loaded' without being a fault.
const listIntegrations = defineTool({
  name: "list_integrations",
  title: "List integrations (config entries)",
  description:
    "List configured integrations and helpers with their entry_id, domain, title, state and any problem reason. Set problems_only to see just entries that failed to load or need attention.",
  risk: "read",
  shape: {
    domain: z.string().optional().describe("Only this integration domain, for example 'mqtt'."),
    query: z.string().optional().describe("Text matched against title and domain."),
    problems_only: z.boolean().default(false).describe("Only entries in a state other than loaded. Entries you chose to ignore are skipped."),
    max_items: z.number().int().min(1).max(500).default(100),
  },
  handler: async ({ domain, query, problems_only, max_items }, ctx) => {
    let entries = (await ctx.ha.wsCommand<any[]>({ type: "config_entries/get", ...(domain ? { domain } : {}) })) ?? [];
    if (query) {
      const q = query.toLowerCase();
      entries = entries.filter((e) => `${e.title} ${e.domain}`.toLowerCase().includes(q));
    }
    if (problems_only) entries = entries.filter((e) => e.state !== "loaded" && !e.disabled_by && e.source !== "ignore");
    return {
      total: entries.length,
      entries: entries.slice(0, max_items).map((e) => ({
        entry_id: e.entry_id, domain: e.domain, title: e.title, state: e.state, source: e.source,
        disabled_by: e.disabled_by, reason: e.reason, supports_options: e.supports_options,
      })),
    };
  },
});

// Reload, enable and rename are low risk. Disable and remove are high risk, and the
// plan lists what depends on the integration. Removal cannot be undone by
// restore_backup, because the integration has to be set up again.
const manageEntry = defineTool({
  name: "manage_config_entry",
  title: "Reload, disable, enable, rename or remove an integration",
  description:
    "Manage a configured integration. reload, enable and rename are low risk. disable and remove are HIGH RISK because they take the integration's devices and entities offline or delete them, and need confirm true, dry_run false and the plan_token. The plan lists what depends on the entry. Removal cannot be undone by restore_backup.",
  risk: "dynamic",
  shape: {
    entry_id: z.string().describe("Entry id from list_integrations."),
    action: z.enum(["reload", "disable", "enable", "rename", "remove"]),
    title: z.string().optional().describe("New title for rename."),
    confirm: z.boolean().default(false).describe("Explicit user consent for high risk actions."),
    dry_run: z.boolean().optional().describe("Preview only. Defaults to true for high risk actions and false otherwise."),
  },
  handler: async ({ entry_id, action, title, confirm, dry_run }, ctx) => {
    const entries = (await ctx.ha.wsCommand<any[]>({ type: "config_entries/get" })) ?? [];
    const entry = entries.find((e) => e.entry_id === entry_id);
    if (!entry) throw new Error(`No config entry "${entry_id}". Use list_integrations.`);
    if (action === "rename" && !title) throw new Error("title is required to rename.");

    const reasons: string[] = [];
    let related: unknown;
    if (action === "disable") reasons.push(`disables "${entry.title}" (${entry.domain}), taking all of its devices and entities offline`);
    if (action === "remove") reasons.push(`permanently removes "${entry.title}" (${entry.domain}) with its devices and entities`);
    if (reasons.length) {
      try {
        related = await ctx.ha.wsCommand({ type: "search/related", item_type: "config_entry", item_id: entry_id });
      } catch {
        /* optional */
      }
    }
    const gate = await evaluateGate({
      risk: reasons.length ? "high" : "low",
      reasons,
      action: `${action[0].toUpperCase()}${action.slice(1)} integration "${entry.title}" (${entry.domain}).`,
      plan: { entry: { entry_id, domain: entry.domain, title: entry.title, state: entry.state }, depends_on_it: related, rollback: action === "remove" ? "Not reversible with restore_backup. It must be set up again." : undefined },
      confirm,
      dryRun: dry_run,
    });
    if (!gate.proceed) return gate.outcome;

    let result: unknown;
    if (action === "reload") result = await ctx.ha.rest("POST", `/api/config/config_entries/entry/${encodeURIComponent(entry_id)}/reload`, { timeoutMs: 120_000 });
    else if (action === "remove") result = await ctx.ha.rest("DELETE", `/api/config/config_entries/entry/${encodeURIComponent(entry_id)}`, { timeoutMs: 120_000 });
    else if (action === "rename") result = await ctx.ha.wsCommand({ type: "config_entries/entry/update", entry_id, title });
    else result = await ctx.ha.wsCommand({ type: "config_entries/entry/disable", entry_id, disabled_by: action === "disable" ? "user" : null });
    ctx.ha.invalidateCaches();
    return { status: "done", executed: true, action, entry_id, result };
  },
});

// Config flows and options flows use two similar but different REST paths.
function flowBase(flowType: "config" | "options"): string {
  return flowType === "config" ? "/api/config/config_entries/flow" : "/api/config/config_entries/options/flow";
}

// Drives a setup form step by step, exactly like the UI would. Three actions:
//   start  - begins a flow and returns the first form
//   submit - sends the answers for the current step
//   cancel - abandons the flow
// Starting and cancelling are low risk. Submitting is judged by what flow it is:
// helper type flows are low risk, anything else (a real integration, or any
// options flow) is high risk.
const runFlow = defineTool({
  name: "run_config_flow",
  title: "Run an integration or helper setup flow",
  description:
    "Drive Home Assistant's setup forms step by step, the way the UI does. start begins a flow (handler is the integration domain such as 'template' or 'group', or an entry_id when flow_type is options). The result shows the form fields, then submit each step with user_input until the type is create_entry. cancel abandons a flow. Starting and cancelling are low risk. Submitting a step of a helper type flow (group, template, utility_meter and similar) is low risk. Submitting any other integration's flow, or any options flow, is HIGH RISK and needs confirm true, dry_run false and the plan_token.",
  risk: "dynamic",
  shape: {
    action: z.enum(["start", "submit", "cancel"]),
    flow_type: z.enum(["config", "options"]).default("config"),
    handler: z.string().optional().describe("For start: the integration domain, or the entry_id for an options flow."),
    flow_id: z.string().optional().describe("For submit and cancel: the flow_id returned by start."),
    user_input: z.record(z.string(), z.any()).optional().describe("For submit: the values for the current form, or {next_step_id: '...'} for a menu."),
    confirm: z.boolean().default(false).describe("Explicit user consent for high risk submissions."),
    dry_run: z.boolean().optional().describe("Preview only. Defaults to true for high risk submissions and false otherwise."),
  },
  handler: async ({ action, flow_type, handler, flow_id, user_input, confirm, dry_run }, ctx) => {
    const base = flowBase(flow_type);
    if (action === "start") {
      if (!handler) throw new Error("handler is required to start a flow.");
      const body = flow_type === "config" ? { handler, show_advanced_options: false } : { handler };
      return { flow_type, ...(await ctx.ha.rest<any>("POST", base, { body })) };
    }
    if (!flow_id) throw new Error("flow_id is required.");
    if (action === "cancel") {
      await ctx.ha.rest("DELETE", `${base}/${encodeURIComponent(flow_id)}`);
      return { status: "cancelled", executed: true, flow_id };
    }

    // Look up the flow's current step so the plan can say exactly what is being submitted.
    const current = await ctx.ha.rest<any>("GET", `${base}/${encodeURIComponent(flow_id)}`);
    const flowHandler: string = current?.handler ?? handler ?? "unknown";
    const risky = flow_type === "options" || !SAFE_HELPER_HANDLERS.has(flowHandler);
    const gate = await evaluateGate({
      risk: risky ? "high" : "low",
      reasons: risky ? [flow_type === "options" ? `changes the options of an existing integration (${flowHandler})` : `submitting a step of the "${flowHandler}" integration flow can add or change an integration`] : [],
      action: `Submit step "${current?.step_id ?? "?"}" of the ${flowHandler} ${flow_type} flow.`,
      plan: { flow_id, handler: flowHandler, step_id: current?.step_id, user_input: user_input ?? {} },
      confirm,
      dryRun: dry_run,
    });
    if (!gate.proceed) return gate.outcome;
    const result = await ctx.ha.rest<any>("POST", `${base}/${encodeURIComponent(flow_id)}`, { body: user_input ?? {}, timeoutMs: 120_000 });
    ctx.ha.invalidateCaches();
    return { flow_type, executed: true, ...result };
  },
});

// Lists the entries from Settings > Repairs. Ignored ones are hidden unless asked for.
const listRepairs = defineTool({
  name: "list_repairs",
  title: "List repairs",
  description: "List the issues shown under Settings, Repairs, with severity, domain and whether each can be fixed or has been ignored.",
  risk: "read",
  shape: { include_ignored: z.boolean().default(false) },
  handler: async ({ include_ignored }, ctx) => {
    const r = await ctx.ha.wsCommand<{ issues?: any[] }>({ type: "repairs/list_issues" });
    const issues = (r?.issues ?? []).filter((i) => include_ignored || !i.ignored);
    return {
      total: issues.length,
      issues: issues.map((i) => ({
        domain: i.domain, issue_id: i.issue_id, severity: i.severity, is_fixable: i.is_fixable, ignored: i.ignored,
        breaks_in_ha_version: i.breaks_in_ha_version, translation_key: i.translation_key, placeholders: i.translation_placeholders, created: i.created,
      })),
    };
  },
});

// Hides or restores a repair. It is low risk because it is just a flag and is fully reversible.
const ignoreRepair = defineTool({
  name: "ignore_repair",
  title: "Ignore or restore a repair",
  description: "Mark a repair issue as ignored, or bring it back. Low risk and reversible.",
  risk: "low",
  shape: { domain: z.string(), issue_id: z.string(), ignore: z.boolean().default(true) },
  handler: async ({ domain, issue_id, ignore }, ctx) => {
    await ctx.ha.wsCommand({ type: "repairs/ignore_issue", domain, issue_id, ignore });
    return { status: ignore ? "ignored" : "restored", executed: true, domain, issue_id };
  },
});

// Adds the five tools.
export function registerIntegrationTools(server: McpServer, ctx: ToolContext): void {
  for (const def of [listIntegrations, manageEntry, runFlow, listRepairs, ignoreRepair]) registerTool(server, ctx, def as any);
}
