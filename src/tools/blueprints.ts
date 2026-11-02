// Blueprints are reusable automation templates ("turn on a light when motion is
// detected") that you fill in with your own entities. They are YAML files, and the
// important thing to understand is that a blueprint is CODE: once installed, it runs
// actions whenever an automation uses it. So installing one from the internet is
// treated as high risk, and the preview shows you the source so you can read it.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { evaluateGate } from "../safety.js";
import { ToolOutcome } from "../util.js";
import { defineTool, registerTool, type ToolContext } from "./registry.js";

// A rough scan of the blueprint's source text for high risk services (locks, alarms,
// heating, restarts and so on). If any appear, the human is told. This is a hint
// and not a guarantee, which is why the full source is also shown.
const RISKY_TEXT =
  /\b(lock|alarm_control_panel|climate|water_heater|valve|shell_command|python_script)\.[a-z_]+|\bhomeassistant\.(restart|stop)\b|\bhassio\.(host_reboot|host_shutdown)\b/g;

// Blueprints exist for automations and scripts.
const domainEnum = z.enum(["automation", "script"]);

// Lists installed blueprints with their inputs. An input with no default value is required, which is how we mark it.
const listBlueprints = defineTool({
  name: "list_blueprints",
  title: "List blueprints",
  description:
    "List installed blueprints for automations or scripts with their path, name, author, source and input names. To use one, save an automation whose config is {alias, use_blueprint: {path, input: {...}}}.",
  risk: "read",
  shape: { domain: domainEnum.default("automation") },
  handler: async ({ domain }, ctx) => {
    const all = (await ctx.ha.wsCommand<Record<string, any>>({ type: "blueprint/list", domain })) ?? {};
    return Object.entries(all).map(([path, bp]) => {
      if (bp?.error) return { path, error: bp.error };
      const m = bp?.metadata ?? {};
      return {
        path,
        name: m.name,
        description: m.description,
        author: m.author,
        source_url: m.source_url,
        inputs: Object.entries(m.input ?? {}).map(([k, v]: [string, any]) => ({ name: k, required: v?.default === undefined, description: v?.description })),
      };
    });
  },
});

// Downloads a blueprint from a URL (GitHub, a forum post, a gist) and installs it.
// Two stages: first Home Assistant fetches and checks it for us (blueprint/import),
// and we show the result. Only after approval do we save it (blueprint/save). If one
// with the same path is already installed we refuse unless allow_override is set.
const importBlueprint = defineTool({
  name: "import_blueprint",
  title: "Import a blueprint from a URL",
  description:
    "Download a blueprint from a URL (GitHub, Home Assistant community forum or gist) and install it. Blueprints contain actions that run whenever they are used, so this is always HIGH RISK. The preview shows the blueprint's name, inputs, validation result and its source so it can be reviewed, and the execution needs confirm true, dry_run false and the plan_token.",
  risk: "high",
  shape: {
    url: z.string().url().describe("Link to the blueprint."),
    allow_override: z.boolean().default(false).describe("Replace an installed blueprint with the same path."),
    confirm: z.boolean().default(false).describe("Explicit user consent."),
    dry_run: z.boolean().default(true).describe("Preview only. Must be false to execute."),
  },
  handler: async ({ url, allow_override, confirm, dry_run }, ctx) => {
    const preview = await ctx.ha.wsCommand<any>({ type: "blueprint/import", url });
    const meta = preview?.blueprint?.metadata ?? {};
    const errors: string[] = preview?.validation_errors ?? [];
    if (!meta.domain || !preview?.raw_data || !preview?.suggested_filename) {
      return new ToolOutcome({ status: "invalid", executed: false, message: "Home Assistant could not read a blueprint at that URL.", validation_errors: errors }, true);
    }
    if (errors.length) return new ToolOutcome({ status: "invalid", executed: false, validation_errors: errors }, true);

    // Home Assistant suggests a file name. We make sure it ends in exactly one .yaml.
    const path = `${preview.suggested_filename}.yaml`.replace(/\.yaml\.yaml$/, ".yaml");
    const installed = (await ctx.ha.wsCommand<Record<string, unknown>>({ type: "blueprint/list", domain: meta.domain })) ?? {};
    const exists = Object.keys(installed).some((p) => p === path);
    if (exists && !allow_override) {
      return new ToolOutcome({ status: "already_installed", executed: false, path, message: "A blueprint with this path is already installed. Set allow_override true to replace it." }, true);
    }
    const mentions = [...new Set(String(preview.raw_data).match(RISKY_TEXT) ?? [])];
    const reasons = [`installs code from ${url}, and blueprints run actions whenever an automation or script uses them`];
    if (mentions.length) reasons.push(`the blueprint mentions high risk services: ${mentions.join(", ")}`);
    if (exists) reasons.push(`replaces the installed blueprint ${path}`);

    const gate = await evaluateGate({
      risk: "high",
      reasons,
      action: `Install ${meta.domain} blueprint "${meta.name}" from ${url} as ${path}.`,
      plan: {
        name: meta.name,
        domain: meta.domain,
        author: meta.author,
        inputs: Object.keys(meta.input ?? {}),
        path,
        source_yaml_start: String(preview.raw_data).slice(0, 3000),
        note: "Review the source before agreeing. Installing does not run anything yet.",
      },
      confirm,
      dryRun: dry_run,
    });
    if (!gate.proceed) return gate.outcome;
    await ctx.ha.wsCommand({ type: "blueprint/save", domain: meta.domain, path, yaml: preview.raw_data, source_url: url, allow_override });
    return { status: "installed", executed: true, domain: meta.domain, path, name: meta.name };
  },
});

// Removes an installed blueprint. Home Assistant itself refuses if something still
// uses it. We cannot back up a blueprint, but if it came from a URL it can be
// imported again, and the preview says whether that is possible.
const deleteBlueprint = defineTool({
  name: "delete_blueprint",
  title: "Delete a blueprint",
  description:
    "Delete an installed blueprint. Always HIGH RISK. Home Assistant refuses if an automation or script still uses it. No backup of the YAML is possible, but blueprints imported from a URL can be re-imported.",
  risk: "high",
  shape: {
    domain: domainEnum,
    path: z.string().describe("Blueprint path from list_blueprints."),
    confirm: z.boolean().default(false).describe("Explicit user consent."),
    dry_run: z.boolean().default(true).describe("Preview only. Must be false to execute."),
  },
  handler: async ({ domain, path, confirm, dry_run }, ctx) => {
    const all = (await ctx.ha.wsCommand<Record<string, any>>({ type: "blueprint/list", domain })) ?? {};
    const bp = all[path];
    if (!bp) throw new Error(`No ${domain} blueprint at "${path}". Use list_blueprints.`);
    const gate = await evaluateGate({
      risk: "high",
      reasons: [`permanently deletes the blueprint ${path}`],
      action: `Delete ${domain} blueprint "${bp.metadata?.name ?? path}".`,
      plan: { path, source_url: bp.metadata?.source_url ?? "none, so it could not be re-imported", rollback: "No automatic backup is possible for blueprints." },
      confirm,
      dryRun: dry_run,
    });
    if (!gate.proceed) return gate.outcome;
    await ctx.ha.wsCommand({ type: "blueprint/delete", domain, path });
    return { status: "deleted", executed: true, path };
  },
});

// Adds the three blueprint tools.
export function registerBlueprintTools(server: McpServer, ctx: ToolContext): void {
  for (const def of [listBlueprints, importBlueprint, deleteBlueprint]) registerTool(server, ctx, def as any);
}
