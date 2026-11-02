// THE SAFETY LAYER. If you only read one file to decide whether to trust this
// project, read this one.
//
// Everything in here exists to answer two questions before a change is made:
//   1. How risky is this? (the 'assess' and 'RiskReasons' functions)
//   2. Has the human really agreed to it? (the 'gate' functions at the bottom)
//
// Risk is worked out by looking at WHAT would be touched: the domain (locks, alarms
// and heating are always high risk), special device classes (garage doors), names
// that sound like major appliances, services like restart, and user supplied
// patterns. It even looks inside scripts, automations and scenes that would be run,
// because calling a harmless looking script could still unlock a door.
import type { Config } from "./config.js";
import type { HAClient, HAState } from "./ha-client.js";
import { callStore, type CallContext } from "./context.js";
import { consumePlanToken, issuePlanToken, verifyPlanToken } from "./plan.js";
import { APPROVAL_HELP } from "./settings-help.js";
import { ToolOutcome, asArray, domainOf, globToRegExp } from "./util.js";

// The three risk levels. Only 'high' triggers the two step approval process.
export type RiskLevel = "read" | "low" | "high";

// A short description of an entity (id, friendly name, current state) used when showing the human what a change will touch.
export interface EntitySummary {
  entity_id: string;
  name: string;
  state: string;
}

// The result of judging a service call: the level, the reasons in plain English, and the entities involved.
export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
  entities: EntitySummary[];
}

// Domains where changing ANYTHING is treated as high risk, with a plain English
// reason that is shown to the user. Locks, alarms, heating, water heating and
// valves can affect safety or security. shell_command and python_script can run
// arbitrary code on the host.
/** Domains where any mutation is high risk. */
const HIGH_RISK_DOMAINS: Record<string, string> = {
  lock: "security and entry control (locks)",
  alarm_control_panel: "security alarm system",
  climate: "thermal hardware (heating and cooling)",
  water_heater: "water heating hardware",
  valve: "water or gas valve",
  shell_command: "runs arbitrary shell commands on the host",
  python_script: "runs arbitrary Python on the host",
};

// Individual services that are dangerous no matter what they target: restarting
// or stopping Home Assistant, rebooting the host, installing updates (which can
// break things) and purging recorded history (which cannot be undone).
/** Specific services that are high risk regardless of target. */
const HIGH_RISK_SERVICES: Record<string, string> = {
  "homeassistant.restart": "restarts Home Assistant core",
  "homeassistant.stop": "shuts down Home Assistant core",
  "homeassistant.reload_all": "reloads every Home Assistant integration at once",
  "hassio.host_reboot": "reboots the Home Assistant host machine",
  "hassio.host_shutdown": "powers off the Home Assistant host machine",
  "hassio.supervisor_restart": "restarts the Home Assistant Supervisor",
  "hassio.addon_restart": "restarts an add-on",
  "hassio.addon_stop": "stops an add-on",
  "update.install": "installs an update, which can restart or break Home Assistant, add-ons or devices",
  "recorder.purge": "permanently deletes recorded history",
  "recorder.purge_entities": "permanently deletes recorded history for entities",
};

// Garage doors, gates and doors are covers that move an entry point into the house.
/** Cover device classes that move entry points. */
const HIGH_RISK_COVER_CLASSES = new Set(["garage", "gate", "door"]);

// A name based guess at "this is a big appliance". It looks for words like boiler,
// oven, dishwasher, pump or garage in the entity id or friendly name. It only applies
// to switches, covers and fans, because that is where smart plugs controlling real
// appliances show up. It is a heuristic, so it errs on the side of asking.
/** Entity id or friendly name hints for major appliances and entry hardware on controllable domains. */
const APPLIANCE_HINT =
  /(^|[._\s-])(boiler|immersion|oven|cooker|hob|stove|dishwasher|washing_machine|washer|dryer|heater|heating|hot_?water|pump|garage|gate|siren)(?=$|[._\s-])/i;
// The domains the appliance name guess applies to.
const HEURISTIC_DOMAINS = new Set(["switch", "cover", "fan"]);

// Builds the short entity description. If the entity is unknown we fall back to the id and the state 'unknown'.
function summarize(entityId: string, states: Map<string, HAState>): EntitySummary {
  const s = states.get(entityId);
  return {
    entity_id: entityId,
    name: (s?.attributes?.friendly_name as string | undefined) ?? entityId,
    state: s?.state ?? "unknown",
  };
}

// Collects every reason this one entity counts as high risk. An empty list means it
// is not. We gather ALL reasons, not just the first, so the plan shown to the human
// is complete.
/** Reasons an entity is high risk to mutate, or an empty array when it is not. */
export function entityRiskReasons(entityId: string, states: Map<string, HAState>, cfg: Config): string[] {
  const reasons: string[] = [];
  const domain = domainOf(entityId);
  const state = states.get(entityId);
  const name = (state?.attributes?.friendly_name as string | undefined) ?? "";

  if (HIGH_RISK_DOMAINS[domain]) reasons.push(`${entityId} is in the ${domain} domain: ${HIGH_RISK_DOMAINS[domain]}`);
  if (cfg.extraHighRiskDomains.includes(domain)) {
    reasons.push(`${entityId} is in the ${domain} domain, which is configured as high risk (HA_HIGH_RISK_DOMAINS)`);
  }
  if (domain === "cover") {
    const dc = state?.attributes?.device_class as string | undefined;
    if (dc && HIGH_RISK_COVER_CLASSES.has(dc)) {
      reasons.push(`${entityId} is a ${dc} cover, which moves an entry point`);
    }
  }
  if (HEURISTIC_DOMAINS.has(domain) && (APPLIANCE_HINT.test(entityId) || APPLIANCE_HINT.test(name))) {
    reasons.push(`${entityId} looks like a major appliance or entry hardware based on its name`);
  }
  for (const pattern of cfg.highRiskEntityPatterns) {
    if (globToRegExp(pattern).test(entityId)) {
      reasons.push(`${entityId} matches the configured high risk pattern "${pattern}" (HA_HIGH_RISK_ENTITIES)`);
    }
  }
  return reasons;
}

// Same idea but for the service itself, before looking at its targets (for example homeassistant.restart).
export function serviceRiskReasons(domain: string, service: string, cfg: Config): string[] {
  const reasons: string[] = [];
  const key = `${domain}.${service}`;
  if (HIGH_RISK_SERVICES[key]) reasons.push(`${key} ${HIGH_RISK_SERVICES[key]}`);
  if (HIGH_RISK_DOMAINS[domain]) reasons.push(`${key} acts on the ${domain} domain: ${HIGH_RISK_DOMAINS[domain]}`);
  if (cfg.extraHighRiskDomains.includes(domain)) {
    reasons.push(`${key} acts on the ${domain} domain, which is configured as high risk (HA_HIGH_RISK_DOMAINS)`);
  }
  return reasons;
}

// Pattern for a valid entity id.
const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;
// Detects Jinja template syntax ({{ }} or {% %}) in a value.
const TEMPLATE_RE = /\{\{|\{%/;

// Looks inside an automation, script or scene config for anything risky it would do.
// We only read the ACTION side, because triggers and conditions just read state. It
// walks the whole tree and notes:
//  * services that are high risk
//  * entities that are high risk (including 'all')
//  * services chosen by a template, which we cannot verify ahead of time, so they
//    are flagged for caution.
/**
 * Scan the action side of an automation or script for calls that touch high risk services or entities.
 * Triggers and conditions only read state, so they are skipped.
 */
export function scanConfigRisk(config: unknown, states: Map<string, HAState>, cfg: Config): string[] {
  const reasons = new Set<string>();
  const c = (config ?? {}) as Record<string, unknown>;
  const roots = [c.actions, c.action, c.sequence].filter((v) => v !== undefined);

  // Handles an entity_id value that may be one id, a list, or the word 'all'.
  const checkEntities = (value: unknown) => {
    for (const id of asArray(value as string | string[])) {
      if (typeof id !== "string") continue;
      if (id === "all") {
        reasons.add("targets all entities");
      } else if (ENTITY_ID_RE.test(id)) {
        for (const r of entityRiskReasons(id, states, cfg)) reasons.add(r);
      }
    }
  };

  // The recursive walk through the config tree.
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const obj = node as Record<string, unknown>;
    // Skip conditions and waits, they only observe and never change anything.
    if (typeof obj.condition === "string" || "wait_for_trigger" in obj || "wait_template" in obj) return;

    const svc = (obj.action ?? obj.service) as unknown;
    if (typeof svc === "string") {
      if (TEMPLATE_RE.test(svc)) {
        reasons.add("calls a service chosen by a template, so the effect cannot be verified in advance");
      } else if (svc.includes(".")) {
        const [d, s] = svc.split(".", 2);
        for (const r of serviceRiskReasons(d, s, cfg)) reasons.add(r);
      }
    }
    checkEntities(obj.entity_id);
    const target = obj.target as Record<string, unknown> | undefined;
    if (target && typeof target === "object") checkEntities(target.entity_id);
    const data = obj.data as Record<string, unknown> | undefined;
    if (data && typeof data === "object") checkEntities(data.entity_id);

    for (const [k, v] of Object.entries(obj)) {
      if (k === "data" || k === "target" || k === "entity_id") continue;
      walk(v);
    }
  };

  roots.forEach(walk);
  return [...reasons];
}

// The different ways a service call can say what it targets: entities, areas, devices or labels.
export interface ServiceTarget {
  entity_ids: string[];
  area_ids: string[];
  device_ids: string[];
  label_ids: string[];
}

// The big one. Given a service call, work out how risky it is. Steps:
//  1. Start with risks of the service itself.
//  2. Load all current states, so we can look entities up.
//  3. 'all' and labels are flagged because we cannot see exactly what they hit.
//  4. Areas and devices are resolved to the real entities inside them via the
//     registry. If that lookup fails we assume the worst.
//  5. If this runs a script or triggers an automation, read its stored config and
//     scan what it does.
//  6. If this activates a scene, check every entity the scene sets.
//  7. Finally check each directly targeted entity.
// If there is any reason at all the result is 'high', otherwise 'low'.
/** Classify a service call, resolving area and device targets to entities where possible. */
export async function assessServiceCall(
  ha: HAClient,
  cfg: Config,
  domain: string,
  service: string,
  target: ServiceTarget,
  data: Record<string, unknown> = {}
): Promise<RiskAssessment> {
  const reasons = new Set<string>(serviceRiskReasons(domain, service, cfg));
  const states = new Map((await ha.getStates()).map((s) => [s.entity_id, s]));
  const entityIds = new Set<string>(target.entity_ids);

  if (target.entity_ids.includes("all")) {
    reasons.add("targets all entities");
    entityIds.delete("all");
  }
  if (target.label_ids.length) {
    reasons.add("targets entities by label, which cannot be fully resolved in advance");
  }
  if (target.area_ids.length || target.device_ids.length) {
    try {
      const reg = await ha.getRegistry();
      for (const e of reg.entities) {
        if (e.disabled_by) continue;
        const area = reg.areaIdOf(e.entity_id);
        if ((area && target.area_ids.includes(area)) || (e.device_id && target.device_ids.includes(e.device_id))) {
          entityIds.add(e.entity_id);
        }
      }
    } catch {
      reasons.add("targets an area or device that could not be resolved, so it is treated as high risk");
    }
  }

  // Calling a script or triggering an automation runs its actions, so inspect them.
  // Scripts and automations run other actions, so we collect them to inspect.
  const nested: { kind: "script" | "automation"; id: string }[] = [];
  if (domain === "script" && !["turn_on", "turn_off", "toggle", "reload"].includes(service)) {
    nested.push({ kind: "script", id: service });
  }
  for (const id of entityIds) {
    if (domain === "script" && domainOf(id) === "script") nested.push({ kind: "script", id: id.split(".")[1] });
    if (domain === "automation" && service === "trigger" && domainOf(id) === "automation") {
      const configId = states.get(id)?.attributes?.id as string | undefined;
      if (configId) nested.push({ kind: "automation", id: configId });
    }
  }
  for (const n of nested) {
    try {
      const nestedConfig = await ha.rest("GET", `/api/config/${n.kind}/config/${encodeURIComponent(n.id)}`);
      for (const r of scanConfigRisk(nestedConfig, states, cfg)) reasons.add(`${n.kind} ${n.id}: ${r}`);
    } catch {
      /* YAML defined or unreadable, cannot inspect */
    }
  }

  // Activating a scene sets every entity it contains, so inspect those too.
  if (domain === "scene") {
    const sceneEntities = new Set<string>();
    if (service === "apply" && data.entities && typeof data.entities === "object") {
      Object.keys(data.entities as object).forEach((e) => sceneEntities.add(e));
    }
    for (const id of entityIds) {
      if (domainOf(id) !== "scene") continue;
      const configId = states.get(id)?.attributes?.id as string | undefined;
      if (configId) {
        try {
          const sc = await ha.rest<any>("GET", `/api/config/scene/config/${encodeURIComponent(configId)}`);
          Object.keys(sc?.entities ?? {}).forEach((e) => sceneEntities.add(e));
        } catch {
          /* YAML defined or unreadable */
        }
      } else if (Array.isArray(states.get(id)?.attributes?.entity_id)) {
        (states.get(id)!.attributes.entity_id as string[]).forEach((e) => sceneEntities.add(e));
      }
    }
    for (const e of sceneEntities) for (const r of entityRiskReasons(e, states, cfg)) reasons.add(`scene sets ${e}: ${r}`);
  }

  for (const id of entityIds) {
    for (const r of entityRiskReasons(id, states, cfg)) reasons.add(r);
  }

  return {
    level: reasons.size > 0 ? "high" : "low",
    reasons: [...reasons],
    entities: [...entityIds].slice(0, 50).map((id) => summarize(id, states)),
  };
}

// CONTROL ONLY MODE
// -----------------
// In control only mode call_service is the one writing tool left, and this is the
// rule book that keeps it to everyday jobs. The idea: a basic user should be able
// to switch things on and off, and nothing else. Anything that could change how the
// house is set up, or that touches security, is refused outright, with no
// confirmation route.

// The service domains an everyday user may call. Notice what is NOT here: lock,
// alarm_control_panel, climate, water_heater, valve, siren, camera, notify, script,
// automation, homeassistant (handled separately below), hassio, shell_command,
// python_script, rest_command, recorder, backup and anything else that is about
// configuration or security rather than switching things.
export const CONTROL_ONLY_DOMAINS = new Set([
  "light", "switch", "fan", "cover", "media_player", "humidifier", "vacuum", "remote",
  "button", "number", "select", "scene",
  "input_boolean", "input_button", "input_number", "input_select",
]);

// Service names that change how something is set up rather than operating it, so they
// are refused even inside an allowed domain. For example input_select.set_options
// rewrites a dropdown helper, and scene.apply can set ANY entity (even an automation).
const CONTROL_ONLY_BLOCKED_SERVICES = new Set([
  "reload", "reload_all", "set_options", "create", "delete", "apply", "remove",
]);

// homeassistant.turn_on, turn_off and toggle are the generic versions that work on any
// entity, so they are allowed, but only for named entities in the allowed domains.
const CONTROL_ONLY_GENERIC_SERVICES = new Set(["turn_on", "turn_off", "toggle"]);

// Returns a plain English reason if this call is not allowed in control only mode, or
// undefined if it is fine. It does not look at risk. Risky but allowed calls (such as
// a whole area at once) still go through the normal two step approval afterwards.
/** Why a service call is refused in control only mode, or undefined when it is allowed. */
export function controlModeViolation(
  cfg: Config,
  domain: string,
  service: string,
  target: ServiceTarget
): string | undefined {
  if (!cfg.controlOnly || cfg.readOnly) return undefined;
  if (CONTROL_ONLY_BLOCKED_SERVICES.has(service)) {
    return `${domain}.${service} changes how things are set up, which is not allowed in control only mode.`;
  }
  // The generic homeassistant services work on any entity, so we check each named one.
  if (domain === "homeassistant") {
    if (!CONTROL_ONLY_GENERIC_SERVICES.has(service)) {
      return `homeassistant.${service} is not allowed in control only mode. Only turn_on, turn_off and toggle are.`;
    }
    if (target.area_ids.length || target.device_ids.length || target.label_ids.length || !target.entity_ids.length) {
      return "homeassistant.turn_on, turn_off and toggle need named entities in control only mode, not areas, devices or labels.";
    }
    const bad = target.entity_ids.filter((e) => !CONTROL_ONLY_DOMAINS.has(domainOf(e)));
    if (bad.length) {
      return `These entities are not everyday devices, so they cannot be controlled in control only mode: ${bad.join(", ")}.`;
    }
    return undefined;
  }
  if (!CONTROL_ONLY_DOMAINS.has(domain)) {
    return `The "${domain}" service domain is not allowed in control only mode. Allowed: ${[...CONTROL_ONLY_DOMAINS].join(", ")}.`;
  }
  // Labels cannot be fully resolved in advance, so they could hide something unexpected.
  if (target.label_ids.length) {
    return "Targeting by label is not allowed in control only mode. Name the entities, or use an area.";
  }
  // A named entity from another domain (for example an automation passed to light.turn_off) is refused too.
  const bad = target.entity_ids.filter((e) => e !== "all" && domainOf(e) !== domain);
  if (bad.length) {
    return `${domain}.${service} was given entities from other domains (${bad.join(", ")}), which is not allowed in control only mode.`;
  }
  return undefined;
}

// Checks the never-touch list. These patterns are an absolute block: even with
// confirmation, nothing here will change them.
/** Entities from the list that match a configured never-touch pattern. */
export function neverTouchHits(entityIds: string[], cfg: Config): string[] {
  if (cfg.neverTouch.length === 0) return [];
  const res = cfg.neverTouch.map(globToRegExp);
  return entityIds.filter((id) => res.some((re) => re.test(id)));
}

// Everything the gate needs to make its decision and to write a helpful message back to the user.
export interface GateParams {
  risk: RiskLevel;
  reasons: string[];
  /** Plain English summary of what will happen. */
  action: string;
  /** Diff, parameters or other details to show the user. */
  plan: unknown;
  confirm: boolean;
  /** Undefined means "use the default for this risk level": true for high risk, false for low risk. */
  dryRun: boolean | undefined;
}

// Either 'go ahead' or 'stop, and here is the reply to give the caller'.
export type GateResult = { proceed: true } | { proceed: false; outcome: ToolOutcome };

// Creates the plan_token to include in a preview reply, bound to this exact tool and
// these exact arguments. Without a call context there is nothing to bind to, so no
// token is made.
function tokenFields(): { plan_token?: string } {
  const cc = callStore.getStore();
  return cc ? { plan_token: issuePlanToken(cc.tool, cc.argsKey) } : {};
}

// Stage one is about the flags. Low risk actions simply run (unless a dry run was
// requested). High risk actions need BOTH confirm=true and dry_run=false. Every other
// combination returns a different, carefully worded reply so the model understands
// exactly what is missing:
//   * confirm true but still dry run  -> a preview with a token
//   * dry_run false but no confirm    -> an outright rejection
//   * neither                         -> the normal "here is the plan" reply
/**
 * Stage one of the two phase commit.
 * High risk operations pass only when confirm is true AND dry_run is false.
 * Low risk operations execute unless dry_run was explicitly requested.
 */
function baseGate(p: GateParams): GateResult {
  // If dry_run was not specified, high risk defaults to a dry run (safe) and low risk defaults to really doing it.
  const dry = p.dryRun ?? p.risk === "high";

  if (p.risk !== "high") {
    if (!dry) return { proceed: true };
    return {
      proceed: false,
      outcome: new ToolOutcome({
        status: "dry_run",
        risk: p.risk,
        executed: false,
        action: p.action,
        plan: p.plan,
        message: "Dry run only. Nothing was changed. Call again without dry_run to execute.",
      }),
    };
  }

  const header = {
    risk: "high" as const,
    executed: false,
    why_high_risk: p.reasons,
    action: p.action,
    plan: p.plan,
  };
  const how =
    "To execute, call again with the same arguments plus confirm: true, dry_run: false and the plan_token below, after the user has explicitly agreed.";

  if (p.confirm && !dry) return { proceed: true };

  if (p.confirm && dry) {
    return {
      proceed: false,
      outcome: new ToolOutcome({
        status: "dry_run",
        ...header,
        ...tokenFields(),
        message: `Dry run only. Nothing was changed. ${how}`,
      }),
    };
  }

  if (!p.confirm && !dry) {
    return {
      proceed: false,
      outcome: new ToolOutcome(
        {
          status: "rejected_confirmation_required",
          ...header,
          ...tokenFields(),
          message: `REJECTED. This is a high risk operation and confirm was not true. Nothing was changed. Explain the plan above to the user and get their explicit consent. ${how}`,
        },
        true
      ),
    };
  }

  return {
    proceed: false,
    outcome: new ToolOutcome({
      status: "confirmation_required",
      ...header,
      ...tokenFields(),
      message: `HIGH RISK. Nothing was changed. Explain the plan above to the user and ask for explicit consent. ${how}`,
    }),
  };
}

// The possible answers when we try to ask the human directly.
type Approval = "approved" | "declined" | "skipped" | "unsupported";

// If the connected client supports MCP elicitation (a pop up question), we use it to
// ask the actual person to approve. If it does not, we either carry on (the plan
// token has already protected us) or refuse, depending on whether the user chose to
// make the approval prompt mandatory.
/** Stage two: ask the human directly through MCP elicitation when the client supports it. */
async function requestApproval(cc: CallContext, p: GateParams): Promise<Approval> {
  const supported = Boolean(cc.server.server.getClientCapabilities()?.elicitation);
  if (!supported) return cc.approval === "elicit" ? "unsupported" : "skipped";
  try {
    const r = await cc.server.server.elicitInput({
      message: `Approve this high risk Home Assistant change?\n\n${p.action}\n\nWhy it is high risk: ${p.reasons.join(", ")}`,
      requestedSchema: {
        type: "object",
        properties: { approve: { type: "boolean", title: "Approve", description: "Tick to approve this change" } },
        required: ["approve"],
      },
    });
    return r.action === "accept" && r.content?.approve === true ? "approved" : "declined";
  } catch {
    return cc.approval === "elicit" ? "unsupported" : "skipped";
  }
}

// The full gate, in order:
//   1. Stage one (the flags).
//   2. Check the plan token is present, genuine, unexpired, unused and matches the
//      exact request. If not, return a fresh token and explain.
//   3. Ask the human directly if the client can.
//   4. Mark the token as used so it can never be replayed.
// Only after all of that do we say 'proceed'.
/**
 * Two phase commit gate.
 * Stage one needs confirm true and dry_run false. Stage two binds the execution to the exact previewed request
 * with a single use plan token, and asks the human directly when the client can show a prompt.
 */
export async function evaluateGate(p: GateParams): Promise<GateResult> {
  const first = baseGate(p);
  if (!first.proceed || p.risk !== "high") return first;

  const cc = callStore.getStore();
  if (!cc) return first;

  const state = verifyPlanToken(cc.planToken, cc.tool, cc.argsKey);
  if (state !== "ok") {
    const why: Record<string, string> = {
      missing: "No plan_token was supplied.",
      invalid: "The plan_token does not match this request. The arguments changed after the preview, or the token was not issued by this server.",
      expired: "The plan_token has expired.",
      used: "The plan_token was already used.",
    };
    return {
      proceed: false,
      outcome: new ToolOutcome(
        {
          status: "plan_token_required",
          risk: "high",
          executed: false,
          why_high_risk: p.reasons,
          action: p.action,
          plan: p.plan,
          plan_token: issuePlanToken(cc.tool, cc.argsKey),
          message: `Nothing was changed. ${why[state]} Show the plan to the user, get their explicit consent, then repeat the identical call with confirm: true, dry_run: false and this plan_token.`,
        },
        true
      ),
    };
  }

  const approval = await requestApproval(cc, p);
  if (approval === "declined" || approval === "unsupported") {
    return {
      proceed: false,
      outcome: new ToolOutcome(
        {
          status: approval === "declined" ? "declined_by_user" : "approval_prompt_unavailable",
          risk: "high",
          executed: false,
          action: p.action,
          message:
            approval === "declined"
              ? "The user declined the approval prompt. Nothing was changed."
              : "Approval prompts are required (HA_REQUIRE_APPROVAL_PROMPT) but this client cannot show one. Nothing was changed. " + APPROVAL_HELP,
        },
        true
      ),
    };
  }

  consumePlanToken(cc.planToken as string);
  return { proceed: true };
}
