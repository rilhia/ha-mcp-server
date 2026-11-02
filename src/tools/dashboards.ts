// Dashboards (Home Assistant calls them "Lovelace") are the screens you look at in
// the app. Each dashboard has a stored config: a list of views (tabs), each holding
// cards or sections. This file lets the model read them, build new ones, add or
// replace a single view, and delete them.
//
// Two ideas to keep in mind while reading:
//   * The default Overview dashboard has no url_path. Everywhere in here, "no
//     url_path" means "the default dashboard".
//   * A dashboard can be "auto generated". Then it has no stored config until
//     someone saves one. Creating that first config is low risk, but overwriting
//     an existing one is high risk and goes through the two step approval.
//
// Every overwrite or delete backs up the old config first, so restore_backup can
// bring it back.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HAError } from "../ha-client.js";
import { evaluateGate } from "../safety.js";
import { ToolOutcome, describeChanges, diffObjects } from "../util.js";
import { defineTool, registerTool, type ToolContext } from "./registry.js";

// The shape of a valid entity id, used to find entity references in cards.
const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
// A view's path becomes part of a web address, so only letters, digits, hyphens and underscores are allowed.
const VIEW_PATH_RE = /^[A-Za-z0-9_-]+$/;
// The name we use for the default dashboard in backups and messages.
const DEFAULT_ID = "default";

// Turns 'no url_path' into the word 'default', which is used to name backups.
const itemId = (urlPath?: string | null) => urlPath || DEFAULT_ID;

// Reads a dashboard's stored config. 'force: true' bypasses Home Assistant's own
// caching so we always see the latest. A 'config_not_found' answer just means the
// dashboard is auto generated, so we return null rather than failing.
/** Stored config of a dashboard, or null when it is still auto generated. */
async function getDash(ctx: ToolContext, urlPath?: string | null): Promise<any | null> {
  try {
    return await ctx.ha.wsCommand({ type: "lovelace/config", url_path: urlPath ?? null, force: true });
  } catch (err) {
    if (err instanceof HAError && err.code === "config_not_found") return null;
    throw err;
  }
}

// Walks a dashboard config and collects entity ids from the keys that normally hold
// them (entity, entities, entity_id). Cards often list entities inside an
// 'entities' array, so the key is remembered while we step into the array.
function entityRefs(node: unknown, out = new Set<string>(), key?: string): Set<string> {
  if (typeof node === "string") {
    if ((key === "entity" || key === "entities" || key === "entity_id") && ENTITY_RE.test(node)) out.add(node);
  } else if (Array.isArray(node)) {
    node.forEach((n) => entityRefs(n, out, key === "entities" ? "entities" : key));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) entityRefs(v, out, k);
  }
  return out;
}

// Checks one view is sensible: it is an object, it has a title or path, the path
// only has allowed characters, and cards, badges and sections are lists.
function validateView(view: any, where: string, errors: string[]): void {
  if (!view || typeof view !== "object" || Array.isArray(view)) {
    errors.push(`${where} must be an object.`);
    return;
  }
  if (!view.title && !view.path) errors.push(`${where} needs a title or a path.`);
  if (view.path !== undefined && !VIEW_PATH_RE.test(String(view.path))) {
    errors.push(`${where}.path "${view.path}" may only contain letters, digits, hyphens and underscores.`);
  }
  for (const k of ["cards", "badges", "sections"]) {
    if (view[k] !== undefined && !Array.isArray(view[k])) errors.push(`${where}.${k} must be a list.`);
  }
}

// Checks a whole dashboard config. A dashboard built with a 'strategy' (an automatic
// layout) is allowed to have no views. Otherwise we need at least one view, and no
// two views may share a path.
export function validateDashboardConfig(config: any): string[] {
  const errors: string[] = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) return ["The dashboard config must be an object."];
  if (config.strategy && typeof config.strategy === "object") return errors;
  if (!Array.isArray(config.views) || config.views.length === 0) {
    errors.push('A dashboard needs a non-empty "views" list (or a "strategy").');
    return errors;
  }
  const paths = new Set<string>();
  config.views.forEach((v: any, i: number) => {
    validateView(v, `views[${i}]`, errors);
    if (v?.path) {
      if (paths.has(v.path)) errors.push(`views[${i}].path "${v.path}" is used twice.`);
      paths.add(v.path);
    }
  });
  return errors;
}

// Finds entities mentioned in a config that do not currently exist. Used for warnings, not errors, because an entity may be added later.
async function unknownEntities(ctx: ToolContext, config: unknown): Promise<string[]> {
  const known = new Set((await ctx.ha.getStates()).map((s) => s.entity_id));
  return [...entityRefs(config)].filter((e) => !known.has(e));
}

// A compact outline of a dashboard (titles, paths, card counts) so plans and listings stay short instead of dumping the whole config.
function summarise(config: any) {
  if (!config) return null;
  if (config.strategy) return { strategy: config.strategy };
  return {
    title: config.title,
    views: (config.views ?? []).map((v: any, i: number) => ({
      index: i,
      title: v.title,
      path: v.path,
      type: v.type ?? "masonry",
      icon: v.icon,
      cards: Array.isArray(v.cards) ? v.cards.length : undefined,
      sections: Array.isArray(v.sections) ? v.sections.length : undefined,
      badges: Array.isArray(v.badges) ? v.badges.length : undefined,
    })),
  };
}

// The shared description of the optional url_path argument, reused by several tools.
const urlPathField = z
  .string()
  .optional()
  .describe("Dashboard url_path, for example 'dashboard-house'. Omit for the default Overview dashboard.");

// Lists every dashboard, with the default Overview first, because it does not appear in Home Assistant's own list.
const listDashboards = defineTool({
  name: "list_dashboards",
  title: "List dashboards",
  description: "List all dashboards with their url_path, title, mode (storage or yaml) and sidebar settings. The default Overview dashboard is listed first.",
  risk: "read",
  shape: {},
  handler: async (_a, ctx) => {
    const list = await ctx.ha.wsCommand<any[]>({ type: "lovelace/dashboards/list" });
    return [
      { id: DEFAULT_ID, url_path: null, title: "Overview (default dashboard)", note: "Omit url_path in the other dashboard tools to use this one." },
      ...(list ?? []).map((d) => ({
        id: d.id,
        url_path: d.url_path,
        title: d.title,
        icon: d.icon,
        mode: d.mode,
        show_in_sidebar: d.show_in_sidebar,
        require_admin: d.require_admin,
      })),
    ];
  },
});

// Three levels of detail: a summary by default, one whole view if asked for it (by
// path, title or position), or everything with full set to true.
const getDashboard = defineTool({
  name: "get_dashboard",
  title: "Get dashboard config",
  description:
    "Read a dashboard's stored configuration. By default returns a summary of its views. Set view to a view path, title or index to read one view in full, or full true for the whole config. Auto generated dashboards have no stored config.",
  risk: "read",
  shape: {
    url_path: urlPathField,
    view: z.string().optional().describe("A view's path, title or index. Returns just that view's full config."),
    full: z.boolean().default(false).describe("Return the entire config. Can be large."),
  },
  handler: async ({ url_path, view, full }, ctx) => {
    const config = await getDash(ctx, url_path);
    if (!config) {
      return { stored: false, message: "This dashboard is auto generated and has no stored config yet. Saving one with save_dashboard creates it." };
    }
    if (view !== undefined) {
      const views: any[] = config.views ?? [];
      const found = views.find((v, i) => v.path === view || v.title === view || String(i) === view);
      if (!found) throw new Error(`No view matches "${view}". Views: ${views.map((v, i) => `${i}:${v.path ?? v.title}`).join(", ")}`);
      return { url_path: url_path ?? null, view: found };
    }
    if (full) return { url_path: url_path ?? null, config };
    return { url_path: url_path ?? null, summary: summarise(config), hint: "Pass view for one view in full, or full true for everything." };
  },
});

// Saves a whole dashboard config. The risk depends on the situation: creating the
// first config for an auto generated dashboard is low risk, overwriting an existing
// config is high risk. The plan shows an exact before/after diff.
const saveDashboard = defineTool({
  name: "save_dashboard",
  title: "Create or overwrite a dashboard config",
  description:
    "Save the full config of a dashboard. Overwriting an existing stored config is HIGH RISK and needs confirm true, dry_run false and the plan_token from the preview. The previous config is backed up and returned as a rollback receipt. Creating the first config for an auto generated dashboard is low risk. For small changes prefer save_dashboard_view. YAML mode dashboards cannot be saved through the API.",
  risk: "dynamic",
  shape: {
    url_path: urlPathField,
    config: z.record(z.string(), z.any()).describe("Full dashboard config with a views list."),
    confirm: z.boolean().default(false).describe("Explicit user consent for overwriting."),
    dry_run: z.boolean().optional().describe("Preview only. Defaults to true when overwriting and false when creating."),
  },
  handler: async ({ url_path, config, confirm, dry_run }, ctx) => {
    const errors = validateDashboardConfig(config);
    if (errors.length) return new ToolOutcome({ status: "invalid", executed: false, errors }, true);
    const warnings = (await unknownEntities(ctx, config)).map((e) => `Entity ${e} does not exist right now.`);
    const existing = await getDash(ctx, url_path);
    const changes = existing ? diffObjects(existing, config) : [];
    if (existing && changes.length === 0) return { status: "no_change", executed: false };

    const gate = await evaluateGate({
      risk: existing ? "high" : "low",
      reasons: existing ? [`overwrites the stored config of dashboard "${url_path ?? "Overview"}"`] : [],
      action: existing
        ? `Overwrite dashboard "${url_path ?? "Overview"}" with ${changes.length} change(s).`
        : `Create the stored config for dashboard "${url_path ?? "Overview"}".`,
      plan: existing
        ? { changes: describeChanges(changes), views_before: summarise(existing)?.views?.length, views_after: summarise(config)?.views?.length, warnings }
        : { summary: summarise(config), warnings },
      confirm,
      dryRun: dry_run,
    });
    if (!gate.proceed) return gate.outcome;

    const receipt = existing ? ctx.backups.save("dashboard", itemId(url_path), { config: existing }, "before save_dashboard") : null;
    await ctx.ha.wsCommand({ type: "lovelace/config/save", url_path: url_path ?? null, config });
    return {
      status: "saved",
      executed: true,
      warnings,
      rollback_receipt: receipt ?? undefined,
      undo: receipt ? `Call restore_backup with backup_id "${receipt.backup_id}".` : "Call delete_dashboard_config to return to an auto generated dashboard.",
    };
  },
});

// The gentler option for small edits. Only the view you send is added or replaced
// and the rest of the dashboard is left alone. Adding a new view is low risk,
// replacing an existing one is high risk. A view is matched by its path (or by its
// title if it has no path).
const saveView = defineTool({
  name: "save_dashboard_view",
  title: "Add or replace one dashboard view",
  description:
    "Add a view to a dashboard, or replace the view with the same path (or title). Only the view you send changes. Adding a new view is low risk. Replacing an existing view is HIGH RISK and needs confirm true, dry_run false and the plan_token. The previous dashboard config is backed up first.",
  risk: "dynamic",
  shape: {
    url_path: urlPathField,
    view: z.record(z.string(), z.any()).describe("The view config, for example {title, path, icon, cards: [...]}."),
    position: z.number().int().min(0).optional().describe("Where to insert a new view. Defaults to the end."),
    confirm: z.boolean().default(false).describe("Explicit user consent for replacing."),
    dry_run: z.boolean().optional().describe("Preview only. Defaults to true when replacing and false when adding."),
  },
  handler: async ({ url_path, view, position, confirm, dry_run }, ctx) => {
    const errors: string[] = [];
    validateView(view, "view", errors);
    if (errors.length) return new ToolOutcome({ status: "invalid", executed: false, errors }, true);
    const warnings = (await unknownEntities(ctx, view)).map((e) => `Entity ${e} does not exist right now.`);

    const existing = await getDash(ctx, url_path);
    const base: any = existing ? JSON.parse(JSON.stringify(existing)) : { views: [] };
    if (base.strategy) throw new Error("This dashboard uses a strategy, so it has no views to edit. Save a full config with save_dashboard instead.");
    base.views = base.views ?? [];
    const idx = base.views.findIndex((v: any) => (view.path && v.path === view.path) || (!view.path && view.title && v.title === view.title));
    const replacing = idx >= 0;
    const before = replacing ? base.views[idx] : undefined;
    const changes = replacing ? diffObjects(before, view) : [];
    if (replacing && changes.length === 0) return { status: "no_change", executed: false };

    const next = JSON.parse(JSON.stringify(base));
    if (replacing) next.views[idx] = view;
    else next.views.splice(position ?? next.views.length, 0, view);
    const gate = await evaluateGate({
      risk: replacing ? "high" : "low",
      reasons: replacing ? [`replaces the existing view "${before.path ?? before.title}"`] : [],
      action: replacing
        ? `Replace view "${before.path ?? before.title}" on dashboard "${url_path ?? "Overview"}" with ${changes.length} change(s).`
        : `Add view "${view.path ?? view.title}" to dashboard "${url_path ?? "Overview"}".`,
      plan: replacing ? { changes: describeChanges(changes), warnings } : { view_summary: { title: view.title, path: view.path, cards: view.cards?.length, sections: view.sections?.length }, warnings },
      confirm,
      dryRun: dry_run,
    });
    if (!gate.proceed) return gate.outcome;

    const receipt = existing ? ctx.backups.save("dashboard", itemId(url_path), { config: existing }, "before save_dashboard_view") : null;
    await ctx.ha.wsCommand({ type: "lovelace/config/save", url_path: url_path ?? null, config: next });
    return {
      status: "saved",
      executed: true,
      operation: replacing ? "replaced" : "added",
      views_now: next.views.length,
      warnings,
      rollback_receipt: receipt ?? undefined,
      undo: receipt ? `Call restore_backup with backup_id "${receipt.backup_id}".` : undefined,
    };
  },
});

// Creates a new, empty dashboard entry in the sidebar. Home Assistant insists the
// url_path contains a hyphen, so the input pattern enforces that. We also check the
// name is not already taken.
const createDashboard = defineTool({
  name: "create_dashboard",
  title: "Create a dashboard",
  description:
    "Create a new, empty storage mode dashboard. The url_path must contain a hyphen, for example 'house-overview'. Low risk. Add content afterwards with save_dashboard or save_dashboard_view.",
  risk: "low",
  shape: {
    url_path: z.string().regex(/^[a-z0-9_]+-[a-z0-9_-]+$/, "Lowercase letters, digits, underscores and at least one hyphen."),
    title: z.string().min(1),
    icon: z.string().optional().describe("For example mdi:home."),
    show_in_sidebar: z.boolean().default(true),
    require_admin: z.boolean().default(false),
  },
  handler: async ({ url_path, title, icon, show_in_sidebar, require_admin }, ctx) => {
    const list = await ctx.ha.wsCommand<any[]>({ type: "lovelace/dashboards/list" });
    if (list.some((d) => d.url_path === url_path)) throw new Error(`A dashboard with url_path "${url_path}" already exists.`);
    const created = await ctx.ha.wsCommand({ type: "lovelace/dashboards/create", url_path, title, icon, show_in_sidebar, require_admin, mode: "storage" });
    return { status: "created", executed: true, dashboard: created };
  },
});

// Deletes a dashboard completely. The default dashboard cannot be deleted this way.
// Both its config AND its settings (title, icon and so on) are saved in the backup,
// so restore_backup can recreate it as it was.
const deleteDashboard = defineTool({
  name: "delete_dashboard",
  title: "Delete a dashboard",
  description:
    "Permanently delete a dashboard and its stored config. Always HIGH RISK. Rejected unless confirm is true, dry_run is false and the plan_token from the preview is supplied. The config and settings are backed up and returned as a rollback receipt.",
  risk: "high",
  shape: {
    url_path: z.string().describe("url_path of the dashboard to delete. The default dashboard cannot be deleted, use delete_dashboard_config."),
    confirm: z.boolean().default(false).describe("Explicit user consent."),
    dry_run: z.boolean().default(true).describe("Preview only. Must be false to execute."),
  },
  handler: async ({ url_path, confirm, dry_run }, ctx) => {
    const list = await ctx.ha.wsCommand<any[]>({ type: "lovelace/dashboards/list" });
    const meta = list.find((d) => d.url_path === url_path);
    if (!meta) throw new Error(`No dashboard with url_path "${url_path}". Use list_dashboards.`);
    const config = await getDash(ctx, url_path);
    const gate = await evaluateGate({
      risk: "high",
      reasons: [`permanently deletes dashboard "${meta.title}" and its stored config`],
      action: `Delete dashboard "${meta.title}" (${url_path}).`,
      plan: { dashboard: { title: meta.title, url_path, mode: meta.mode }, content: summarise(config), rollback: "Config and settings are backed up and restorable with restore_backup." },
      confirm,
      dryRun: dry_run,
    });
    if (!gate.proceed) return gate.outcome;
    const receipt = ctx.backups.save("dashboard", itemId(url_path), { config, meta }, "before delete_dashboard");
    await ctx.ha.wsCommand({ type: "lovelace/dashboards/delete", dashboard_id: meta.id });
    return { status: "deleted", executed: true, rollback_receipt: receipt, undo: `Call restore_backup with backup_id "${receipt.backup_id}".` };
  },
});

// A softer reset: the dashboard stays, but its stored config is discarded so Home
// Assistant goes back to generating it automatically. Still high risk, because the
// layout someone built is lost until restored.
const deleteDashboardConfig = defineTool({
  name: "delete_dashboard_config",
  title: "Reset a dashboard to auto generated",
  description:
    "Remove a dashboard's stored config so Home Assistant generates it automatically again. The dashboard itself stays. Always HIGH RISK. The config is backed up and returned as a rollback receipt.",
  risk: "high",
  shape: {
    url_path: urlPathField,
    confirm: z.boolean().default(false).describe("Explicit user consent."),
    dry_run: z.boolean().default(true).describe("Preview only. Must be false to execute."),
  },
  handler: async ({ url_path, confirm, dry_run }, ctx) => {
    const config = await getDash(ctx, url_path);
    if (!config) return { status: "no_change", executed: false, message: "This dashboard has no stored config." };
    const gate = await evaluateGate({
      risk: "high",
      reasons: [`discards the stored config of dashboard "${url_path ?? "Overview"}"`],
      action: `Reset dashboard "${url_path ?? "Overview"}" to auto generated.`,
      plan: { content_discarded: summarise(config) },
      confirm,
      dryRun: dry_run,
    });
    if (!gate.proceed) return gate.outcome;
    const receipt = ctx.backups.save("dashboard", itemId(url_path), { config }, "before delete_dashboard_config");
    await ctx.ha.wsCommand({ type: "lovelace/config/delete", url_path: url_path ?? null });
    return { status: "reset", executed: true, rollback_receipt: receipt, undo: `Call restore_backup with backup_id "${receipt.backup_id}".` };
  },
});

// Adds the seven dashboard tools.
export function registerDashboardTools(server: McpServer, ctx: ToolContext): void {
  for (const def of [listDashboards, getDashboard, saveDashboard, saveView, createDashboard, deleteDashboard, deleteDashboardConfig]) {
    registerTool(server, ctx, def as any);
  }
}
