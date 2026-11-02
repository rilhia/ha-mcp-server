// Scenes are saved snapshots of how a set of entities should look ("Movie night":
// lights dim, TV on). This file lets the model list them, read them, create or
// update them, and delete them.
//
// One subtle point about risk: SAVING a scene does not change any device. But
// ACTIVATING it later does. So a scene that sets a lock or the heating is treated as
// high risk to save, because it is a loaded gun waiting to be fired.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deleteConfigItem, fetchConfigItem, resolveItemId, stripId, writeConfigItem } from "../resources.js";
import { entityRiskReasons, evaluateGate, neverTouchHits } from "../safety.js";
import { NEVER_TOUCH_HELP } from "../settings-help.js";
import { ToolOutcome, describeChanges, diffObjects } from "../util.js";
import { defineTool, registerTool, type ToolContext } from "./registry.js";

// Valid entity id pattern.
const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;

// Checks a scene config: it needs a name and a non empty 'entities' object that maps
// entity ids to their wanted state. Unknown entities only give a warning.
function validateScene(config: any, knownIds: Set<string>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!config || typeof config !== "object") return { errors: ["The scene config must be an object."], warnings };
  if (typeof config.name !== "string" || !config.name.trim()) errors.push("name is required.");
  if (!config.entities || typeof config.entities !== "object" || Array.isArray(config.entities) || Object.keys(config.entities).length === 0) {
    errors.push('entities must be an object of entity ids to their target state, for example {"light.kitchen": {"state": "on", "brightness": 120}}.');
  } else {
    for (const id of Object.keys(config.entities)) {
      if (!ENTITY_RE.test(id)) errors.push(`"${id}" is not a valid entity id.`);
      else if (!knownIds.has(id)) warnings.push(`Entity ${id} does not exist right now.`);
    }
  }
  return { errors, warnings };
}

// Lists scenes. 'editable' tells you whether the scene has a stored config (made in the UI) or is defined in YAML (read only through the API). A scene's own state is the time it was last activated.
const listScenes = defineTool({
  name: "list_scenes",
  title: "List scenes",
  description: "List scenes with their entity id, config id and last activation. Scenes defined in YAML are listed but cannot be edited through the API.",
  risk: "read",
  shape: { query: z.string().optional().describe("Substring of name or id.") },
  handler: async ({ query }, ctx) => {
    const q = query?.toLowerCase();
    return (await ctx.ha.getStates())
      .filter((s) => s.entity_id.startsWith("scene.") && (!q || s.entity_id.includes(q) || String(s.attributes.friendly_name ?? "").toLowerCase().includes(q)))
      .map((s) => ({
        entity_id: s.entity_id,
        name: s.attributes.friendly_name,
        config_id: s.attributes.id,
        editable: Boolean(s.attributes.id),
        entities_count: Array.isArray(s.attributes.entity_id) ? s.attributes.entity_id.length : undefined,
        last_activated: s.state,
      }));
  },
});

// Reads a scene's config and lists any high risk entities it would change when activated.
const getScene = defineTool({
  name: "get_scene",
  title: "Get scene config",
  description: "Read the stored config of a scene by config id or entity id, with the high risk entities it would change when activated.",
  risk: "read",
  shape: { scene_id: z.string().describe("Scene config id or entity id such as scene.movie_night.") },
  handler: async ({ scene_id }, ctx) => {
    const { id, entity_id } = await resolveItemId(ctx.ha, "scene", scene_id);
    const config = await fetchConfigItem(ctx.ha, "scene", id);
    if (!config) return { found: false, id, entity_id, message: "No stored config. It may be defined in YAML." };
    const states = new Map((await ctx.ha.getStates()).map((s) => [s.entity_id, s]));
    const risks = Object.keys(config.entities ?? {}).flatMap((e) => entityRiskReasons(e, states, ctx.cfg));
    return { found: true, id, entity_id, config, high_risk_entities: risks };
  },
});

// Creates or updates a scene. It is high risk when it overwrites an existing scene
// OR when any entity inside it is high risk. After saving it reloads scenes so the
// change takes effect immediately.
const saveScene = defineTool({
  name: "save_scene",
  title: "Create or update a scene",
  description:
    "Create a scene or overwrite an existing one. Overwriting is HIGH RISK and needs confirm true, dry_run false and the plan_token. A scene that sets locks, climate, garage covers or similar is also high risk, because activating it would change them. The previous config is backed up and returned as a rollback receipt. To capture the current states of entities as a scene, read them first and pass them in entities.",
  risk: "dynamic",
  shape: {
    scene_id: z.string().optional().describe("Config id. Omit to create a new scene with an id derived from the name."),
    config: z.record(z.string(), z.any()).describe('Scene config: {name, icon?, entities: {"light.kitchen": {state: "on", brightness: 120}}}.'),
    confirm: z.boolean().default(false).describe("Explicit user consent for a high risk write."),
    dry_run: z.boolean().optional().describe("Preview only. Defaults to true for high risk writes and false otherwise."),
  },
  handler: async ({ scene_id, config, confirm, dry_run }, ctx) => {
    const cfg = stripId(JSON.parse(JSON.stringify(config)));
    const states = new Map((await ctx.ha.getStates()).map((s) => [s.entity_id, s]));
    const { errors, warnings } = validateScene(cfg, new Set(states.keys()));
    if (errors.length) return new ToolOutcome({ status: "invalid", executed: false, errors }, true);
    const blocked = neverTouchHits(Object.keys((cfg as any).entities), ctx.cfg);
    if (blocked.length) {
      return new ToolOutcome({ status: "blocked_never_touch", executed: false, entities: blocked, message: `The scene includes entities on the never-touch list (HA_NEVER_TOUCH). ${NEVER_TOUCH_HELP}` }, true);
    }
    const id = scene_id ? (await resolveItemId(ctx.ha, "scene", scene_id)).id : String(Date.now());
    const existing = await fetchConfigItem(ctx.ha, "scene", id);
    const changes = existing ? diffObjects(stripId(existing), cfg) : [];
    if (existing && changes.length === 0) return { status: "no_change", executed: false, id };

    const reasons: string[] = [];
    if (existing) reasons.push(`overwrites the existing scene "${existing.name ?? id}"`);
    for (const e of Object.keys((cfg as any).entities)) reasons.push(...entityRiskReasons(e, states, ctx.cfg).map((r) => `activating this scene would change: ${r}`));

    const gate = await evaluateGate({
      risk: reasons.length ? "high" : "low",
      reasons,
      action: existing ? `Overwrite scene "${existing.name ?? id}" with ${changes.length} change(s).` : `Create scene "${(cfg as any).name}".`,
      plan: { id, changes: existing ? describeChanges(changes) : undefined, proposed_config: existing ? undefined : cfg, warnings },
      confirm,
      dryRun: dry_run,
    });
    if (!gate.proceed) return gate.outcome;

    const receipt = existing ? ctx.backups.save("scene", id, existing, "before save_scene") : null;
    await writeConfigItem(ctx.ha, "scene", id, cfg);
    await ctx.ha.callService("scene", "reload");
    ctx.ha.invalidateCaches();
    return {
      status: "saved",
      executed: true,
      id,
      warnings,
      rollback_receipt: receipt ?? undefined,
      undo: receipt ? `Call restore_backup with backup_id "${receipt.backup_id}".` : "Call delete_scene to remove it.",
    };
  },
});

// Always high risk. Backed up first, then deleted, then scenes are reloaded.
const deleteScene = defineTool({
  name: "delete_scene",
  title: "Delete a scene",
  description: "Permanently delete a stored scene. Always HIGH RISK. Rejected unless confirm is true, dry_run is false and the plan_token is supplied. The config is backed up first.",
  risk: "high",
  shape: {
    scene_id: z.string().describe("Scene config id or entity id."),
    confirm: z.boolean().default(false).describe("Explicit user consent."),
    dry_run: z.boolean().default(true).describe("Preview only. Must be false to execute."),
  },
  handler: async ({ scene_id, confirm, dry_run }, ctx) => {
    const { id } = await resolveItemId(ctx.ha, "scene", scene_id);
    const existing = await fetchConfigItem(ctx.ha, "scene", id);
    if (!existing) throw new Error(`No stored scene "${id}". YAML scenes cannot be deleted through the API.`);
    const gate = await evaluateGate({
      risk: "high",
      reasons: [`permanently deletes the scene "${existing.name ?? id}"`],
      action: `Delete scene "${existing.name ?? id}" (id ${id}).`,
      plan: { id, entities: Object.keys(existing.entities ?? {}), rollback: "Backed up first and restorable with restore_backup." },
      confirm,
      dryRun: dry_run,
    });
    if (!gate.proceed) return gate.outcome;
    const receipt = ctx.backups.save("scene", id, existing, "before delete_scene");
    await deleteConfigItem(ctx.ha, "scene", id);
    await ctx.ha.callService("scene", "reload");
    ctx.ha.invalidateCaches();
    return { status: "deleted", executed: true, id, rollback_receipt: receipt, undo: `Call restore_backup with backup_id "${receipt.backup_id}".` };
  },
});


// Adds the four scene tools.
export function registerSceneTools(server: McpServer, ctx: ToolContext): void {
  for (const def of [listScenes, getScene, saveScene, deleteScene]) registerTool(server, ctx, def as any);
}
