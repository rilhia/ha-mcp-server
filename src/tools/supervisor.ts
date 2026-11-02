// Tools for the Home Assistant Supervisor: add-ons, host information and full
// backups. IMPORTANT: the Supervisor only exists on Home Assistant OS and
// Supervised installs. If you run Home Assistant in a plain Docker container or as
// Core (like a Mac or NAS Docker setup), there is no Supervisor, none of these will
// work, and that is why this whole group is switched OFF by default.
//
// We reach the Supervisor through Home Assistant's WebSocket proxy command
// 'supervisor/api', so no extra credentials are needed.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HAError } from "../ha-client.js";
import { evaluateGate } from "../safety.js";
import { defineTool, registerTool, type ToolContext } from "./registry.js";

// (One helper to do the calling.) If Home Assistant answers 'unknown command', that
// means there is no Supervisor, and we convert it into a clear explanation instead of
// a confusing error.
/** Call the Supervisor API through Home Assistant's WebSocket proxy. Only exists on HAOS and Supervised installs. */
async function sup(ctx: ToolContext, endpoint: string, method: "get" | "post" = "get", data?: unknown, timeoutMs?: number): Promise<any> {
  try {
    return await ctx.ha.wsCommand(
      { type: "supervisor/api", endpoint, method, ...(data !== undefined ? { data } : {}), ...(timeoutMs ? { timeout: timeoutMs / 1000 } : {}) },
      timeoutMs
    );
  } catch (err) {
    if (err instanceof HAError && (err.code === "unknown_command" || /unknown command|not.*supervisor/i.test(err.message))) {
      throw new Error("The Supervisor is not available. This looks like a Home Assistant Container or Core install, which has no add-ons, Supervisor backups or host controls.");
    }
    throw err;
  }
}

// Fetches four things at once (supervisor, core, host, operating system) and summarises versions, health and disk space.
const getSupervisorInfo = defineTool({
  name: "get_supervisor_info",
  title: "Get Supervisor, host and OS info",
  description: "Versions and health of the Supervisor, Home Assistant core, the operating system and the host (disk space, memory, hostname). Fails with a clear message on installs without a Supervisor.",
  risk: "read",
  shape: {},
  handler: async (_a, ctx) => {
    const [supervisor, core, host, os] = await Promise.all([
      sup(ctx, "/supervisor/info"), sup(ctx, "/core/info"), sup(ctx, "/host/info"), sup(ctx, "/os/info"),
    ]);
    return {
      supervisor: { version: supervisor?.version, latest: supervisor?.version_latest, healthy: supervisor?.healthy, supported: supervisor?.supported, channel: supervisor?.channel },
      core: { version: core?.version, latest: core?.version_latest, update_available: core?.update_available },
      host: { hostname: host?.hostname, operating_system: host?.operating_system, disk_free_gb: host?.disk_free, disk_total_gb: host?.disk_total, disk_used_gb: host?.disk_used },
      os: { version: os?.version, latest: os?.version_latest, update_available: os?.update_available, board: os?.board },
    };
  },
});

// Lists installed add-ons. 'update_available' shows which have a newer version.
const listAddons = defineTool({
  name: "list_addons",
  title: "List add-ons",
  description: "Installed add-ons with their slug, state, version and whether an update is available.",
  risk: "read",
  shape: { query: z.string().optional().describe("Text matched against name and slug.") },
  handler: async ({ query }, ctx) => {
    const r = await sup(ctx, "/addons");
    const q = query?.toLowerCase();
    return (r?.addons ?? [])
      .filter((a: any) => !q || `${a.name} ${a.slug}`.toLowerCase().includes(q))
      .map((a: any) => ({ slug: a.slug, name: a.name, state: a.state, version: a.version, latest: a.version_latest, update_available: a.update_available, repository: a.repository }));
  },
});

// Fetches an add-on's log through the REST proxy (a different route from the
// WebSocket one, because logs are plain text). We can keep only lines matching a
// filter, then return the last N.
const getAddonLogs = defineTool({
  name: "get_addon_logs",
  title: "Get add-on logs",
  description: "The recent log output of an add-on.",
  risk: "read",
  shape: { slug: z.string(), lines: z.number().int().min(1).max(1000).default(100), filter: z.string().optional().describe("Case insensitive text. Only matching lines are kept.") },
  handler: async ({ slug, lines, filter }, ctx) => {
    const text = await ctx.ha.rest<string>("GET", `/api/hassio/addons/${encodeURIComponent(slug)}/logs`, { text: true });
    let all = String(text).split("\n");
    if (filter) all = all.filter((l) => l.toLowerCase().includes(filter.toLowerCase()));
    return { slug, returned: Math.min(lines, all.length), log: all.slice(-lines).join("\n") };
  },
});

// Home Assistant's own full or partial backups, not to be confused with this server's small rollback copies (see list_backups).
const listHaBackups = defineTool({
  name: "list_ha_backups",
  title: "List Home Assistant backups",
  description: "Full and partial Supervisor backups with date, size and location. Not the same as list_backups, which lists this server's own rollback copies.",
  risk: "read",
  shape: {},
  handler: async (_a, ctx) => {
    const r = await sup(ctx, "/backups");
    return (r?.backups ?? []).map((b: any) => ({ slug: b.slug, name: b.name, date: b.date, type: b.type, size_mb: b.size, protected: b.protected, location: b.location }));
  },
});

// Starts a full backup. Low risk because it only adds a file, but it takes a while and uses disk space, hence the 15 minute allowance.
const createHaBackup = defineTool({
  name: "create_ha_backup",
  title: "Create a full Home Assistant backup",
  description: "Start a full Supervisor backup. Low risk, but it uses disk space and can take several minutes, during which Home Assistant may be slower.",
  risk: "low",
  shape: { name: z.string().optional().describe("Backup name. Defaults to a timestamp.") },
  handler: async ({ name }, ctx) => {
    const r = await sup(ctx, "/backups/new/full", "post", { name: name ?? `MCP backup ${new Date().toISOString().slice(0, 16)}` }, 900_000);
    return { status: "created", executed: true, backup: r };
  },
});

// Start, stop, restart or update an add-on. Starting is low risk. Stop, restart and
// update are high risk, because add-ons like the MQTT broker or Zigbee2MQTT carry
// many of your devices. An update cannot be undone from here, so the plan says to
// take a backup first.
const manageAddon = defineTool({
  name: "manage_addon",
  title: "Start, stop, restart or update an add-on",
  description:
    "Control an add-on. start is low risk. stop, restart and update are HIGH RISK because add-ons such as the MQTT broker or Zigbee2MQTT carry the devices in your home, and need confirm true, dry_run false and the plan_token from the preview. Updates cannot be undone by this server.",
  risk: "dynamic",
  shape: {
    slug: z.string().describe("Add-on slug from list_addons."),
    action: z.enum(["start", "stop", "restart", "update"]),
    confirm: z.boolean().default(false).describe("Explicit user consent for high risk actions."),
    dry_run: z.boolean().optional().describe("Preview only. Defaults to true for high risk actions and false otherwise."),
  },
  handler: async ({ slug, action, confirm, dry_run }, ctx) => {
    const info = await sup(ctx, `/addons/${encodeURIComponent(slug)}/info`);
    const high = action !== "start";
    const gate = await evaluateGate({
      risk: high ? "high" : "low",
      reasons: high ? [`${action}s the add-on "${info?.name ?? slug}", which can interrupt everything that depends on it`] : [],
      action: `${action[0].toUpperCase()}${action.slice(1)} add-on "${info?.name ?? slug}" (currently ${info?.state}, version ${info?.version}).`,
      plan: { slug, action, state: info?.state, version: info?.version, latest: info?.version_latest, rollback: action === "update" ? "Not reversible from here. Take a backup first with create_ha_backup." : undefined },
      confirm,
      dryRun: dry_run,
    });
    if (!gate.proceed) return gate.outcome;
    const result = await sup(ctx, `/addons/${encodeURIComponent(slug)}/${action}`, "post", undefined, 600_000);
    return { status: "done", executed: true, slug, action, result };
  },
});

// Adds the six tools. They are only registered when the Supervisor toolset is switched on.
export function registerSupervisorTools(server: McpServer, ctx: ToolContext): void {
  for (const def of [getSupervisorInfo, listAddons, getAddonLogs, listHaBackups, createHaBackup, manageAddon]) {
    registerTool(server, ctx, def as any);
  }
}
