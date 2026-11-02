// Helpers are the little UI managed building blocks in Home Assistant: toggles
// (input_boolean), numbers, text boxes, dropdowns, date pickers, counters, timers and
// schedules. Automations use them to remember things ("is guest mode on?").
//
// All nine types follow the same pattern over the WebSocket API (a /list, /create,
// /update and /delete command each), so one set of functions handles all of them.
//
// Risk levels here:
//   list    - read only
//   create  - low risk, a brand new helper cannot break anything
//   update  - HIGH risk, because automations may rely on the old values
//   delete  - HIGH risk, because anything using it will break
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HAClient } from "../ha-client.js";
import { evaluateGate } from "../safety.js";
import { describeChanges, diffObjects } from "../util.js";
import { defineTool, registerTool, type ToolContext } from "./registry.js";

// The nine helper types we support.
export const HELPER_TYPES = [
  "input_boolean",
  "input_number",
  "input_text",
  "input_select",
  "input_datetime",
  "input_button",
  "counter",
  "timer",
  "schedule",
] as const;
// A TypeScript type built from the list above, so the compiler rejects typos in a helper type.
export type HelperType = (typeof HELPER_TYPES)[number];

// Asks Home Assistant for every UI managed helper of one type. Defaults to an empty list if it answers with nothing.
export async function helperList(ha: HAClient, type: HelperType): Promise<any[]> {
  return (await ha.wsCommand<any[]>({ type: `${type}/list` })) ?? [];
}

// Creates a helper. The command name is built from the type, for example input_boolean/create.
export async function helperCreate(ha: HAClient, type: HelperType, config: Record<string, unknown>): Promise<any> {
  return ha.wsCommand({ type: `${type}/create`, ...config });
}

// Updates a helper. Home Assistant expects the id under a key named after the type, for example input_boolean_id.
export async function helperUpdate(ha: HAClient, type: HelperType, id: string, config: Record<string, unknown>): Promise<any> {
  return ha.wsCommand({ type: `${type}/update`, [`${type}_id`]: id, ...config });
}

// Deletes a helper using the same naming pattern.
export async function helperDelete(ha: HAClient, type: HelperType, id: string): Promise<void> {
  await ha.wsCommand({ type: `${type}/delete`, [`${type}_id`]: id });
}

// Removes the 'id' field so before and after versions can be compared fairly.
export function stripHelperId(type: HelperType, item: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = item;
  return rest;
}

// Catches obvious mistakes before we bother Home Assistant: a missing name, an
// input_number whose min is not below its max, a dropdown with no options, a
// datetime with neither date nor time. The local helper 'num' complains if a value
// that should be a number is not.
/** Light structural validation of helper creation payloads, so mistakes are caught before the WebSocket write. */
export function validateHelper(type: HelperType, config: Record<string, any>, creating: boolean): string[] {
  const errors: string[] = [];
  if (creating && (typeof config.name !== "string" || !config.name.trim())) errors.push("name is required.");
  const num = (k: string) => config[k] !== undefined && typeof config[k] !== "number" && errors.push(`${k} must be a number.`);
  switch (type) {
    case "input_number":
      if (creating && (typeof config.min !== "number" || typeof config.max !== "number")) {
        errors.push("min and max are required numbers.");
      }
      if (typeof config.min === "number" && typeof config.max === "number" && config.min >= config.max) {
        errors.push("min must be lower than max.");
      }
      num("step");
      num("initial");
      break;
    case "input_text":
      num("min");
      num("max");
      break;
    case "input_select":
      if (creating && (!Array.isArray(config.options) || config.options.length === 0)) {
        errors.push("options is required and must be a non empty list of strings.");
      }
      if (Array.isArray(config.options) && config.initial !== undefined && !config.options.includes(config.initial)) {
        errors.push("initial must be one of options.");
      }
      break;
    case "input_datetime":
      if (creating && !config.has_date && !config.has_time) errors.push("At least one of has_date or has_time must be true.");
      break;
    case "counter":
      num("initial");
      num("step");
      num("minimum");
      num("maximum");
      break;
    default:
      break;
  }
  return errors;
}

// Accepts either 'guest_mode' or 'input_boolean.guest_mode' and returns the short id.
function objectId(type: HelperType, idOrEntity: string): string {
  return idOrEntity.startsWith(`${type}.`) ? idOrEntity.slice(type.length + 1) : idOrEntity;
}

// The list of valid helper types as a zod value, for the tool arguments.
const typeEnum = z.enum(HELPER_TYPES);

// Lists one type or all types. The types are fetched in parallel, and if one type
// fails (some integrations are missing) the others still return.
const listHelpers = defineTool({
  name: "list_helpers",
  title: "List helpers",
  description:
    "List UI managed helpers (input_boolean, input_number, input_text, input_select, input_datetime, input_button, counter, timer, schedule). Helpers defined in YAML are not editable through the API and are not listed here.",
  risk: "read",
  shape: { helper_type: typeEnum.optional().describe("Restrict to one helper type. Omit to list all types.") },
  handler: async ({ helper_type }, ctx) => {
    const types = helper_type ? [helper_type] : [...HELPER_TYPES];
    const out: Record<string, unknown> = {};
    await Promise.all(
      types.map(async (t) => {
        try {
          out[t] = await helperList(ctx.ha, t);
        } catch (err) {
          out[t] = { error: (err as Error).message };
        }
      })
    );
    return out;
  },
});

// Creating is low risk so it just happens. dry_run lets a caller validate without creating.
const createHelper = defineTool({
  name: "create_helper",
  title: "Create helper",
  description:
    "Create a new UI managed helper. Creating a new helper is low risk, so it runs immediately. The config is the helper's fields, for example {name: 'Guest mode'} for input_boolean or {name: 'Target', min: 5, max: 30, step: 0.5, unit_of_measurement: 'C'} for input_number.",
  risk: "low",
  shape: {
    helper_type: typeEnum,
    config: z.record(z.string(), z.any()).describe("Helper fields. name is required."),
    dry_run: z.boolean().default(false).describe("Validate only."),
  },
  handler: async ({ helper_type, config, dry_run }, ctx) => {
    const errors = validateHelper(helper_type, config, true);
    if (errors.length) throw new Error(`Invalid ${helper_type} config: ${errors.join(" ")}`);
    if (dry_run) return { status: "dry_run", executed: false, helper_type, config };
    const created = await helperCreate(ctx.ha, helper_type, config);
    ctx.ha.invalidateCaches();
    return { status: "created", executed: true, helper_type, helper: created, entity_id: `${helper_type}.${created?.id}` };
  },
});

// High risk, so it needs a preview, a plan token and confirmation. We show a diff of
// exactly which fields change, and back up the old settings first.
const updateHelper = defineTool({
  name: "update_helper",
  title: "Update helper",
  description:
    "Overwrite fields of an existing UI managed helper. HIGH RISK because automations may depend on it. Rejected unless confirm is true and dry_run is false. The previous settings are backed up and returned as a rollback receipt.",
  risk: "high",
  shape: {
    helper_type: typeEnum,
    helper_id: z.string().describe("Helper id or entity id, for example 'guest_mode' or 'input_boolean.guest_mode'."),
    config: z.record(z.string(), z.any()).describe("Fields to change."),
    confirm: z.boolean().default(false).describe("Explicit user consent."),
    dry_run: z.boolean().default(true).describe("Preview only. Must be false to execute."),
  },
  handler: async ({ helper_type, helper_id, config, confirm, dry_run }, ctx) => {
    const id = objectId(helper_type, helper_id);
    const existing = (await helperList(ctx.ha, helper_type)).find((h) => h.id === id);
    if (!existing) throw new Error(`No UI managed ${helper_type} with id "${id}". YAML defined helpers cannot be edited through the API.`);
    const errors = validateHelper(helper_type, { ...existing, ...config }, false);
    if (errors.length) throw new Error(`Invalid ${helper_type} config: ${errors.join(" ")}`);
    const before = stripHelperId(helper_type, existing);
    const after = { ...before, ...config };
    const changes = diffObjects(before, after);
    if (changes.length === 0) return { status: "no_change", executed: false, message: "The helper already has these values." };

    const gate = await evaluateGate({
      risk: "high",
      reasons: [`overwrites the existing ${helper_type} "${existing.name ?? id}"`],
      action: `Update ${helper_type} "${existing.name ?? id}" with ${changes.length} change(s).`,
      plan: { helper_type, id, changes: describeChanges(changes) },
      confirm,
      dryRun: dry_run,
    });
    if (!gate.proceed) return gate.outcome;

    const receipt = ctx.backups.save(`helper:${helper_type}`, id, existing, "before update_helper");
    const updated = await helperUpdate(ctx.ha, helper_type, id, config);
    ctx.ha.invalidateCaches();
    return {
      status: "updated",
      executed: true,
      helper: updated,
      rollback_receipt: receipt,
      undo: `Call restore_backup with backup_id "${receipt.backup_id}".`,
    };
  },
});

// High risk. The plan warns that anything using the helper will break, and the old settings are backed up so restore_backup can recreate it.
const deleteHelper = defineTool({
  name: "delete_helper",
  title: "Delete helper",
  description:
    "Permanently delete a UI managed helper. Always HIGH RISK. Rejected unless confirm is true and dry_run is false. Its settings are backed up and returned as a rollback receipt.",
  risk: "high",
  shape: {
    helper_type: typeEnum,
    helper_id: z.string().describe("Helper id or entity id."),
    confirm: z.boolean().default(false).describe("Explicit user consent."),
    dry_run: z.boolean().default(true).describe("Preview only. Must be false to execute."),
  },
  handler: async ({ helper_type, helper_id, confirm, dry_run }, ctx) => {
    const id = objectId(helper_type, helper_id);
    const existing = (await helperList(ctx.ha, helper_type)).find((h) => h.id === id);
    if (!existing) throw new Error(`No UI managed ${helper_type} with id "${id}". YAML defined helpers cannot be deleted through the API.`);
    const gate = await evaluateGate({
      risk: "high",
      reasons: [`permanently deletes the ${helper_type} "${existing.name ?? id}"`, "automations, scripts or dashboards that use it will break"],
      action: `Delete ${helper_type} "${existing.name ?? id}" (${helper_type}.${id}).`,
      plan: { helper_type, id, settings: existing },
      confirm,
      dryRun: dry_run,
    });
    if (!gate.proceed) return gate.outcome;
    const receipt = ctx.backups.save(`helper:${helper_type}`, id, existing, "before delete_helper");
    await helperDelete(ctx.ha, helper_type, id);
    ctx.ha.invalidateCaches();
    return {
      status: "deleted",
      executed: true,
      rollback_receipt: receipt,
      undo: `Call restore_backup with backup_id "${receipt.backup_id}" to recreate it. A recreated helper keeps its settings but may get a new entity id if the name has changed.`,
    };
  },
});

// Adds the four helper tools.
export function registerHelperTools(server: McpServer, ctx: ToolContext): void {
  for (const def of [listHelpers, createHelper, updateHelper, deleteHelper]) registerTool(server, ctx, def as any);
}
