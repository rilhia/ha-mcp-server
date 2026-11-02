// This file is the toolbox for reading and writing the STORED config of automations,
// scripts and scenes (the ones you create in the Home Assistant UI), and for checking
// that a config looks sane before we ever send it. Items defined by hand in YAML
// files are not reachable this way, which is why a few functions below say "or is
// defined in YAML".
import { HAError, type HAClient, type HAState } from "./ha-client.js";
import { asArray } from "./util.js";

// The three kinds of stored config this file knows how to handle.
export type ConfigKind = "automation" | "script" | "scene";

// What a valid entity id looks like: lowercase domain, a dot, then a lowercase name. We use it to pick entity ids out of config.
const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;

// Builds the REST address for one item. The id is URL encoded so odd characters cannot break the path.
/** Automation and script storage config is exposed by the Home Assistant config REST endpoints. */
function itemPath(kind: ConfigKind, id: string): string {
  return `/api/config/${kind}/config/${encodeURIComponent(id)}`;
}

// A 404 simply means there is no such stored item, so we return null instead of treating it as a failure. Anything else is a real error and is rethrown.
/** Fetch one stored config item, or null when it does not exist (or is defined in YAML). */
export async function fetchConfigItem(ha: HAClient, kind: ConfigKind, id: string): Promise<any | null> {
  try {
    return await ha.rest("GET", itemPath(kind, id));
  } catch (err) {
    if (err instanceof HAError && err.status === 404) return null;
    throw err;
  }
}

// Saves (creates or replaces) one stored item. Home Assistant uses POST for both.
export async function writeConfigItem(ha: HAClient, kind: ConfigKind, id: string, config: unknown): Promise<void> {
  await ha.rest("POST", itemPath(kind, id), { body: config });
}

// Permanently removes one stored item. The tools that call this always back it up first.
export async function deleteConfigItem(ha: HAClient, kind: ConfigKind, id: string): Promise<void> {
  await ha.rest("DELETE", itemPath(kind, id));
}

// People and models refer to automations in two ways: by the entity id
// (automation.morning_lights) or by the internal config id (a long number). The
// REST config endpoints want the internal id, so this function translates.
//  * Scripts are easy: the config id is just the entity id without the prefix.
//  * Automations and scenes keep their config id in the 'id' attribute. If that is
//    missing the item must have come from YAML, and we explain that clearly.
/** Accepts a config id or an entity id and returns the storage id plus the entity id when known. */
export async function resolveItemId(
  ha: HAClient,
  kind: ConfigKind,
  idOrEntity: string
): Promise<{ id: string; entity_id?: string; state?: HAState }> {
  const raw = idOrEntity.trim();
  if (raw.startsWith(`${kind}.`)) {
    const state = await ha.getState(raw);
    if (!state) throw new Error(`Entity ${raw} does not exist.`);
    if (kind === "script") return { id: raw.slice("script.".length), entity_id: raw, state };
    const id = state.attributes.id as string | undefined;
    if (!id) {
      throw new Error(`${raw} has no config id, so it is defined in YAML and cannot be read or changed through the API.`);
    }
    return { id, entity_id: raw, state };
  }
  const states = await ha.getStates();
  const match = states.find((s) =>
    kind === "script" ? s.entity_id === `script.${raw}` : s.entity_id.startsWith(`${kind}.`) && s.attributes.id === raw
  );
  return { id: raw, entity_id: match?.entity_id, state: match };
}

// The top level keys Home Assistant understands. We use these to warn about typos
// (a misspelt key is silently ignored by Home Assistant, which can be confusing).
// Both the old names (trigger, action, condition) and new names (triggers, actions,
// conditions) are listed because both are valid.
const AUTOMATION_KEYS = new Set([
  "alias", "description", "id", "mode", "max", "max_exceeded", "trigger", "triggers", "condition", "conditions",
  "action", "actions", "variables", "trigger_variables", "initial_state", "hide_entity", "trace", "use_blueprint",
]);
const SCRIPT_KEYS = new Set([
  "alias", "description", "icon", "mode", "max", "max_exceeded", "sequence", "fields", "variables", "trace",
  "use_blueprint", "title",
]);
// The four run modes an automation or script can have.
const MODES = new Set(["single", "restart", "queued", "parallel"]);

// Returns a copy of the config without its 'id' field. The id lives in the address, not the body, when saving.
export function stripId<T extends Record<string, unknown>>(config: T): Omit<T, "id"> {
  const { id: _id, ...rest } = config;
  return rest;
}

// Deep copies the config (via JSON) and strips the id, so we never accidentally modify the caller's object.
export function normalizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  return stripId(JSON.parse(JSON.stringify(config)));
}

// Outcome of our local check. Errors block a save, warnings are just advice.
export interface SchemaResult {
  errors: string[];
  warnings: string[];
}

// This is the cheap first line of defence. It cannot know whether a service really
// exists, but it catches the common mistakes quickly with no network call:
//  * the config is not an object
//  * an invalid run mode
//  * using both 'trigger' and 'triggers' (or action/actions, condition/conditions)
//  * no trigger or no action at all
//  * a step that is empty or not an object
// Blueprint based configs are skipped, because their real content lives elsewhere.
/** Local structural validation that runs before anything is sent to Home Assistant. */
export function validateInternal(kind: ConfigKind, config: Record<string, unknown>): SchemaResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return { errors: ["The config must be a JSON object."], warnings };
  }
  const known = kind === "automation" ? AUTOMATION_KEYS : SCRIPT_KEYS;
  for (const k of Object.keys(config)) {
    if (!known.has(k)) warnings.push(`Unknown top level key "${k}" for a ${kind}. Home Assistant may reject it.`);
  }
  if (!config.alias) warnings.push("No alias set. Give it a descriptive alias so it is recognisable in the UI.");
  if (config.mode !== undefined && !MODES.has(String(config.mode))) {
    errors.push(`mode must be one of ${[...MODES].join(", ")}.`);
  }
  if (config.use_blueprint) return { errors, warnings };

  // Helper: true for a non empty list or any object. Used to check a trigger or action section has something in it.
  const nonEmpty = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === "object" && v !== null);

  if (kind === "automation") {
    if ("trigger" in config && "triggers" in config) errors.push('Use either "trigger" or "triggers", not both.');
    if ("action" in config && "actions" in config) errors.push('Use either "action" or "actions", not both.');
    if ("condition" in config && "conditions" in config) errors.push('Use either "condition" or "conditions", not both.');
    const triggers = config.triggers ?? config.trigger;
    const actions = config.actions ?? config.action;
    if (!nonEmpty(triggers)) errors.push('At least one trigger is required under "triggers".');
    else {
      asArray(triggers as unknown[]).forEach((t, i) => {
        const o = t as Record<string, unknown>;
        if (typeof o !== "object" || o === null || !(typeof o.trigger === "string" || typeof o.platform === "string")) {
          errors.push(`triggers[${i}] needs a "trigger" type such as state, time, sun or template.`);
        }
      });
    }
    if (!nonEmpty(actions)) errors.push('At least one action is required under "actions".');
    else validateSteps(asArray(actions as unknown[]), "actions", errors);
    const conditions = config.conditions ?? config.condition;
    if (conditions !== undefined) {
      asArray(conditions as unknown[]).forEach((c, i) => {
        if (typeof c !== "string" && (typeof c !== "object" || c === null)) {
          errors.push(`conditions[${i}] must be an object or a template string.`);
        }
      });
    }
  } else {
    if (!nonEmpty(config.sequence)) errors.push('At least one step is required under "sequence".');
    else validateSteps(asArray(config.sequence as unknown[]), "sequence", errors);
    if (config.fields !== undefined && (typeof config.fields !== "object" || config.fields === null)) {
      errors.push('"fields" must be an object.');
    }
  }
  return { errors, warnings };
}

// Checks each step in a list of actions is a real, non empty object.
function validateSteps(steps: unknown[], label: string, errors: string[]): void {
  steps.forEach((s, i) => {
    if (typeof s !== "object" || s === null || Array.isArray(s)) {
      errors.push(`${label}[${i}] must be an object.`);
    } else if (Object.keys(s).length === 0) {
      errors.push(`${label}[${i}] is empty.`);
    }
  });
}

// What Home Assistant itself said about the config. 'unavailable' means we could not ask, for example on an older version.
export interface HAValidation {
  status: "valid" | "invalid" | "unavailable";
  errors: string[];
}

// Home Assistant has a validate_config command that checks triggers, conditions and
// actions properly, including whether services exist and fields are right, WITHOUT
// saving anything. Different Home Assistant versions expect the keys in singular
// (trigger) or plural (triggers) form, so we try one then the other. If both fail for
// another reason we report 'unavailable' rather than blocking the save, because our
// local checks have already run.
/**
 * Ask Home Assistant itself to validate the triggers, conditions and actions without saving anything,
 * using the validate_config WebSocket command. Falls back to "unavailable" on older versions.
 */
export async function validateWithHA(
  ha: HAClient,
  kind: ConfigKind,
  config: Record<string, unknown>
): Promise<HAValidation> {
  const trigger = config.triggers ?? config.trigger;
  const condition = config.conditions ?? config.condition;
  const action = kind === "script" ? config.sequence : (config.actions ?? config.action);
  const variants: Array<[string, string, string]> = [
    ["trigger", "condition", "action"],
    ["triggers", "conditions", "actions"],
  ];
  for (const [tk, ck, ak] of variants) {
    const payload: { type: string; [k: string]: unknown } = { type: "validate_config" };
    if (kind === "automation" && trigger !== undefined) payload[tk] = trigger;
    if (kind === "automation" && condition !== undefined) payload[ck] = condition;
    if (action !== undefined) payload[ak] = action;
    try {
      const result = await ha.wsCommand<Record<string, { valid: boolean; error?: string }>>(payload);
      const errors = Object.entries(result ?? {})
        .filter(([, v]) => v && v.valid === false)
        .map(([k, v]) => `${k}: ${v.error ?? "invalid"}`);
      return { status: errors.length ? "invalid" : "valid", errors };
    } catch (err) {
      const code = err instanceof HAError ? err.code : undefined;
      if (code === "invalid_format") continue;
      return { status: "unavailable", errors: [] };
    }
  }
  return { status: "unavailable", errors: [] };
}

// Walks the whole config tree and collects every value that sits under a key called
// entity_id and looks like a real entity id. Used to warn about references to
// entities that do not exist, and to build the "what does this touch" picture.
/** Entity ids referenced under an entity_id key anywhere in the config. */
export function referencedEntities(config: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown, key?: string) => {
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, key));
    } else if (typeof node === "object" && node !== null) {
      for (const [k, v] of Object.entries(node)) walk(v, k);
    } else if (typeof node === "string" && key === "entity_id" && ENTITY_ID_RE.test(node)) {
      found.add(node);
    }
  };
  walk(config);
  return [...found];
}
