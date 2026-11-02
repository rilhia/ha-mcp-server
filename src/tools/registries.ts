// Home Assistant keeps several "registries": master lists of the things in your
// house. This file manages them:
//   area    - rooms or zones, like Kitchen
//   floor   - groups of areas, like First Floor
//   label   - tags you can stick on anything
//   device  - physical or virtual devices (lights, hubs, plugs)
//   entity  - the individual controllable or readable things a device exposes
//   zone    - map zones used for presence detection (Home, Work)
//
// There are three tools: list_registry and find_related (both read only), and
// manage_registry for create, update and delete (guarded).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { evaluateGate, neverTouchHits } from "../safety.js";
import { NEVER_TOUCH_HELP } from "../settings-help.js";
import { ToolOutcome, describeChanges, diffObjects } from "../util.js";
import { defineTool, registerTool, type ToolContext } from "./registry.js";

// The six registries this file knows about.
export type RegistryName = "area" | "floor" | "label" | "device" | "entity" | "zone";

// Describes how to talk to one registry: which command lists it, which creates,
// updates and deletes (not every registry supports all four), which field holds the
// item's id, and which fields we allow to be written.
interface RegistrySpec {
  list: string;
  create?: string;
  update?: string;
  delete?: string;
  idField: string;
  /** Fields that can be sent on create or update. */
  writable: string[];
  /** item_type for the search/related command, when supported. */
  relatedType?: string;
}

// The facts about each registry, in one table, so the tools do not need a pile of
// special cases. For example devices can only be updated (you cannot create or
// delete a device from here) and entities can be updated or removed but not created.
export const REGISTRIES: Record<RegistryName, RegistrySpec> = {
  area: {
    list: "config/area_registry/list", create: "config/area_registry/create", update: "config/area_registry/update", delete: "config/area_registry/delete",
    idField: "area_id", writable: ["name", "aliases", "floor_id", "icon", "labels", "picture"], relatedType: "area",
  },
  floor: {
    list: "config/floor_registry/list", create: "config/floor_registry/create", update: "config/floor_registry/update", delete: "config/floor_registry/delete",
    idField: "floor_id", writable: ["name", "level", "aliases", "icon"], relatedType: "floor",
  },
  label: {
    list: "config/label_registry/list", create: "config/label_registry/create", update: "config/label_registry/update", delete: "config/label_registry/delete",
    idField: "label_id", writable: ["name", "color", "icon", "description"], relatedType: "label",
  },
  device: {
    list: "config/device_registry/list", update: "config/device_registry/update",
    idField: "id", writable: ["area_id", "name_by_user", "disabled_by", "labels"], relatedType: "device",
  },
  entity: {
    list: "config/entity_registry/list", update: "config/entity_registry/update", delete: "config/entity_registry/remove",
    idField: "entity_id", writable: ["name", "icon", "area_id", "aliases", "labels", "disabled_by", "hidden_by", "device_class", "new_entity_id"], relatedType: "entity",
  },
  zone: {
    list: "zone/list", create: "zone/create", update: "zone/update", delete: "zone/delete",
    idField: "id", writable: ["name", "latitude", "longitude", "radius", "passive", "icon"],
  },
};

// Quirk alert: the id field you READ from a list is not always the one you must
// SEND when updating. Devices are listed with 'id' but updated with 'device_id', and
// zones likewise. This function returns the right key for sending.
/** The id key that update and delete commands expect, which differs from the list key for devices and zones. */
export function commandIdKey(registry: RegistryName): string {
  return registry === "device" ? "device_id" : registry === "zone" ? "zone_id" : REGISTRIES[registry].idField;
}

// Fetches every item from one registry.
async function listRegistry(ctx: ToolContext, registry: RegistryName): Promise<any[]> {
  return (await ctx.ha.wsCommand<any[]>({ type: REGISTRIES[registry].list })) ?? [];
}

// Looks up one item by its id field.
function findItem(items: any[], registry: RegistryName, id: string): any | undefined {
  const key = REGISTRIES[registry].idField;
  return items.find((i) => i[key] === id);
}

// Asks Home Assistant 'what uses this?'. It uses the search/related command. The
// result is optional, so any failure just means we show no references rather than
// failing the whole operation.
async function related(ctx: ToolContext, registry: RegistryName, id: string): Promise<Record<string, string[]> | undefined> {
  const t = REGISTRIES[registry].relatedType;
  if (!t) return undefined;
  try {
    const r = await ctx.ha.wsCommand<Record<string, string[]>>({ type: "search/related", item_type: t, item_id: id });
    const out = Object.fromEntries(Object.entries(r ?? {}).filter(([, v]) => Array.isArray(v) && v.length));
    return Object.keys(out).length ? out : {};
  } catch {
    return undefined;
  }
}

// The list of registry names as a zod value.
const registryEnum = z.enum(["area", "floor", "label", "device", "entity", "zone"]);

// Lists a registry, with an optional text filter and the option to keep only certain fields. Fields keep the output small, which matters for entities because there can be thousands.
const listRegistryTool = defineTool({
  name: "list_registry",
  title: "List registry items",
  description:
    "List areas, floors, labels, devices, entities or zones from the Home Assistant registries, with an optional text filter. Use fields to keep results small, for example fields ['entity_id','name','area_id'] for entities.",
  risk: "read",
  shape: {
    registry: registryEnum,
    query: z.string().optional().describe("Case insensitive text matched against all string values of an item."),
    fields: z.array(z.string()).optional().describe("Keep only these keys of each item."),
    max_items: z.number().int().min(1).max(500).default(100),
  },
  handler: async ({ registry, query, fields, max_items }, ctx) => {
    let items = await listRegistry(ctx, registry);
    if (query) {
      const q = query.toLowerCase();
      items = items.filter((i) => Object.values(i).some((v) => typeof v === "string" && v.toLowerCase().includes(q)));
    }
    const total = items.length;
    const picked = items.slice(0, max_items).map((i) => (fields?.length ? Object.fromEntries(fields.filter((f) => f in i).map((f) => [f, i[f]])) : i));
    return { registry, total, returned: picked.length, items: picked };
  },
});

// Impact analysis. Before renaming, disabling or deleting something, this shows
// which automations, scripts, scenes, groups, devices and areas reference it. It is
// the 'what will I break?' tool.
const whatUses = defineTool({
  name: "find_related",
  title: "Find what uses an item",
  description:
    "Impact analysis. Shows which automations, scripts, scenes, groups, devices and areas reference an entity, device, area, floor, label, automation, script or scene (search/related). Use before renaming, disabling or deleting.",
  risk: "read",
  shape: {
    item_type: z.enum(["entity", "device", "area", "floor", "label", "automation", "script", "scene", "group", "config_entry", "integration", "person"]),
    item_id: z.string().describe("The id: entity_id, device id, area_id, automation entity id and so on."),
  },
  handler: async ({ item_type, item_id }, ctx) => ({
    item_type,
    item_id,
    related: (await ctx.ha.wsCommand({ type: "search/related", item_type, item_id })) ?? {},
  }),
});

// Create, update or delete a registry item. What is high risk here:
//   * any delete
//   * renaming an entity id (anything still using the old id will break)
//   * disabling an entity or a device
// Everything else (new items, changing names, icons, areas or labels) is low risk and
// just happens. For risky changes the plan lists everything that references the item.
const manage = defineTool({
  name: "manage_registry",
  title: "Create, update or delete registry items",
  description:
    "Create, update or delete an area, floor, label, zone, device or entity registry item. Creating, and updating names, icons, areas or labels, is low risk. Renaming an entity id, disabling an entity or device, and every delete is HIGH RISK and needs confirm true, dry_run false and the plan_token from the preview. The previous item is backed up and the plan lists everything that references it. Devices can only be updated, entities can be updated or removed, others can be created, updated and deleted.",
  risk: "dynamic",
  shape: {
    registry: registryEnum,
    action: z.enum(["create", "update", "delete"]),
    id: z.string().optional().describe("Id of the item for update and delete: area_id, floor_id, label_id, device id, entity_id or zone id."),
    fields: z.record(z.string(), z.any()).optional().describe("Fields to set. For entity renames use new_entity_id."),
    confirm: z.boolean().default(false).describe("Explicit user consent for high risk changes."),
    dry_run: z.boolean().optional().describe("Preview only. Defaults to true for high risk changes and false otherwise."),
  },
  handler: async ({ registry, action, id, fields, confirm, dry_run }, ctx) => {
    // First, make sure the request makes sense for this registry and these fields, before touching anything.
    const spec = REGISTRIES[registry];
    const cmd = spec[action];
    if (!cmd) throw new Error(`${registry} registry items cannot be ${action}d through this tool. Use ha_ws_write if the API supports it.`);
    const data = fields ?? {};
    const bad = Object.keys(data).filter((k) => !spec.writable.includes(k));
    if (bad.length) throw new Error(`Unknown field(s) for ${registry}: ${bad.join(", ")}. Allowed: ${spec.writable.join(", ")}`);
    if (action !== "create" && !id) throw new Error(`id is required to ${action} a ${registry}.`);
    if (action === "create" && (typeof data.name !== "string" || !data.name.trim())) throw new Error("fields.name is required to create an item.");
    if (action === "update" && Object.keys(data).length === 0) throw new Error("fields is empty, nothing to update.");

    // Check the never-touch list against both the old id and, for a rename, the new one.
    const touched = [id, data.new_entity_id].filter(Boolean) as string[];
    const blocked = neverTouchHits(touched, ctx.cfg);
    if (blocked.length) {
      return new ToolOutcome({ status: "blocked_never_touch", executed: false, entities: blocked, message: `These entities are on the never-touch list (HA_NEVER_TOUCH). ${NEVER_TOUCH_HELP}` }, true);
    }

    // For anything but create, fetch the current item so we can show a diff and back it up.
    const items = action === "create" ? [] : await listRegistry(ctx, registry);
    const existing = action === "create" ? undefined : findItem(items, registry, id as string);
    if (action !== "create" && !existing) throw new Error(`No ${registry} with id "${id}".`);

    // Decide whether this is high risk, and why.
    const reasons: string[] = [];
    if (action === "delete") reasons.push(`permanently ${registry === "entity" ? "removes" : "deletes"} the ${registry} "${existing.name ?? existing.original_name ?? id}"`);
    if (action === "update" && registry === "entity") {
      if (data.new_entity_id && data.new_entity_id !== id) reasons.push(`renames entity id ${id} to ${data.new_entity_id}, which breaks anything still using the old id`);
      if (data.disabled_by) reasons.push(`disables entity ${id}`);
    }
    if (action === "update" && registry === "device" && data.disabled_by) reasons.push(`disables device "${existing.name_by_user ?? existing.name}" and all of its entities`);

    // For risky changes, look up what references the item, so the human can see the knock on effects.
    let refs: Record<string, string[]> | undefined;
    if (action !== "create" && (reasons.length || action === "delete")) refs = await related(ctx, registry, id as string);
    if (refs && Object.keys(refs).length && reasons.length) reasons.push("other items reference it, see references in the plan");

    const changes = action === "update" ? diffObjects(Object.fromEntries(Object.keys(data).map((k) => [k, existing[k]])), data) : [];
    if (action === "update" && changes.length === 0) return { status: "no_change", executed: false };

    // Ask the gate. Low risk changes go straight through, high risk ones need the two step approval.
    const gate = await evaluateGate({
      risk: reasons.length ? "high" : "low",
      reasons,
      action:
        action === "create" ? `Create ${registry} "${data.name}".`
        : action === "update" ? `Update ${registry} ${id}: ${describeChanges(changes, 6).join(", ")}.`
        : `Delete ${registry} ${id}.`,
      plan: { registry, action, id, changes: action === "update" ? describeChanges(changes) : undefined, fields: action === "create" ? data : undefined, references: refs },
      confirm,
      dryRun: dry_run,
    });
    if (!gate.proceed) return gate.outcome;

    // Back up the old item first. Deleted entity registry entries are the one thing we cannot recreate, and the reply says so.
    const receipt = existing ? ctx.backups.save(`registry:${registry}`, id as string, existing, `before ${action} ${registry}`) : null;
    const payload: { type: string; [k: string]: unknown } = { type: cmd, ...data };
    if (action !== "create") payload[commandIdKey(registry)] = id;
    const result = await ctx.ha.wsCommand(payload);
    ctx.ha.invalidateCaches();
    return {
      status: action === "create" ? "created" : action === "update" ? "updated" : "deleted",
      executed: true,
      result,
      rollback_receipt: receipt ?? undefined,
      undo: receipt && !(registry === "entity" && action === "delete") ? `Call restore_backup with backup_id "${receipt.backup_id}".` : receipt ? "A removed entity registry entry cannot be recreated by restore_backup. The integration may re-add it on reload." : undefined,
    };
  },
});

// Adds the three registry tools.
export function registerRegistryTools(server: McpServer, ctx: ToolContext): void {
  for (const def of [listRegistryTool, whatUses, manage]) registerTool(server, ctx, def as any);
}
