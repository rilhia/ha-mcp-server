// Automations and scripts are nearly identical as far as the API is concerned, so
// instead of writing everything twice we write it ONCE in buildKindTools() and call
// it for each kind. That is why you will see template strings like `list_${plural}`
// in here: the same code produces list_automations and list_scripts, get_automation
// and get_script, and so on.
//
// For each kind we create seven tools:
//   list_*      - see what exists
//   get_*       - read one in full
//   validate_*  - check a draft without saving
//   save_*      - create or update (guarded)
//   delete_*    - permanently remove (always high risk)
//   get_*_trace - work out why a run failed
//   reload_*    - reload from storage and YAML
//
// The save tool is the careful one. It validates, checks Home Assistant is healthy,
// shows a diff, asks the safety gate, backs up the old version, writes, verifies the
// result, and automatically rolls back if Home Assistant ends up unhappy.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  deleteConfigItem,
  fetchConfigItem,
  normalizeConfig,
  referencedEntities,
  resolveItemId,
  stripId,
  validateInternal,
  validateWithHA,
  writeConfigItem,
  type ConfigKind,
} from "../resources.js";
import { evaluateGate, neverTouchHits, scanConfigRisk } from "../safety.js";
import { NEVER_TOUCH_HELP } from "../settings-help.js";
import { ToolOutcome, describeChanges, diffObjects, slugify } from "../util.js";
import { defineTool, registerTool, type ToolContext } from "./registry.js";

// A tiny helper that waits for a number of milliseconds. We use it to give Home Assistant a moment to register a change before we look at it.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Plain English explanations for the outcomes a traced run can have. A model (or a
// person) reading 'failed_conditions' might not know what it means, so we translate.
const TRACE_DIAGNOSIS: Record<string, string> = {
  finished: "The run completed all of its steps.",
  failed_conditions: "The run stopped because a condition was false. See condition_failures.",
  failed_single: "The run was skipped because another run was already in progress and mode is single.",
  failed_max_runs: "The run was skipped because the maximum number of parallel runs was reached.",
  aborted: "The run was aborted part way, often because Home Assistant stopped or the automation was turned off.",
  cancelled: "The run was cancelled, for example by mode restart starting a newer run.",
  error: "A step raised an error. See errors and last_step.",
};

// Shortens a value to a readable snippet for traces, adding '...' when it is cut.
function short(v: unknown, max = 220): string | undefined {
  if (v === undefined) return undefined;
  const s = JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

// The pre-flight checks, shared by validate_* and save_*. In order:
//   1. Our own structural check.
//   2. Look up which entities in the config do not currently exist (a warning, not
//      an error, because an entity may be created later).
//   3. Ask Home Assistant itself to validate, but only if our own check passed.
/** Shared validation used by save and by the standalone validate tool. */
async function runPreflight(ctx: ToolContext, kind: ConfigKind, config: Record<string, unknown>) {
  const schema = validateInternal(kind, config);
  const states = new Map((await ctx.ha.getStates()).map((s) => [s.entity_id, s]));
  const unknownEntities = referencedEntities(config).filter((e) => !states.has(e));
  const warnings = [...schema.warnings];
  for (const e of unknownEntities) warnings.push(`Entity ${e} does not exist right now.`);
  let ha: Awaited<ReturnType<typeof validateWithHA>> = { status: "unavailable", errors: [] };
  if (schema.errors.length === 0) ha = await validateWithHA(ctx.ha, kind, config);
  return { schema, ha, warnings, states };
}

// This function builds all seven tools for one kind (automation or script) and returns them. It is called once per kind at the bottom of the file.
function buildKindTools(kind: ConfigKind) {
  // 'plural' is used in tool names such as list_automations. 'isAuto' lets us handle the few places where automations and scripts differ.
  const plural = `${kind}s`;
  const isAuto = kind === "automation";

  // Lists everything of this kind, using the live states. For automations the
  // 'config_id' is the internal id needed by get and save. For scripts it is simply
  // the script's name without the 'script.' prefix.
  const list = defineTool({
    name: `list_${plural}`,
    title: `List ${plural}`,
    description: `List ${plural} with their state, last triggered time, mode and config id.${
      isAuto ? " The id is what get_automation and save_automation take." : ""
    } Optionally filter by a word in the name or id.`,
    risk: "read",
    shape: {
      query: z.string().optional().describe("Substring to match against name, entity id or config id."),
      limit: z.number().int().min(1).max(300).default(100).describe("Maximum rows."),
    },
    handler: async ({ query, limit }, ctx) => {
      const states = (await ctx.ha.getStates()).filter((s) => s.entity_id.startsWith(`${kind}.`));
      const q = query?.toLowerCase();
      const rows = states
        .filter(
          (s) =>
            !q ||
            s.entity_id.includes(q) ||
            String(s.attributes.friendly_name ?? "").toLowerCase().includes(q) ||
            String(s.attributes.id ?? "").toLowerCase().includes(q)
        )
        .map((s) => ({
          entity_id: s.entity_id,
          name: s.attributes.friendly_name,
          config_id: isAuto ? s.attributes.id : s.entity_id.slice("script.".length),
          state: s.state,
          last_triggered: s.attributes.last_triggered,
          mode: s.attributes.mode,
          running_now: s.attributes.current,
        }));
      return { total: rows.length, returned: Math.min(rows.length, limit), [plural]: rows.slice(0, limit) };
    },
  });

  // Reads one item's full stored config. It also lists any high risk actions inside it
  // (for example an automation that unlocks a door), so the reader knows before they
  // edit or run it. If there is no stored config it is probably YAML, and we say so.
  const get = defineTool({
    name: `get_${kind}`,
    title: `Get ${kind} config`,
    description: `Read the full stored configuration of one ${kind} through the Home Assistant config pipeline, together with its entity state and any high risk actions it contains. Accepts the config id or the entity id.`,
    risk: "read",
    shape: {
      [`${kind}_id`]: z.string().describe(`The ${kind} config id or its entity id, for example '${kind}.example'.`),
    },
    handler: async (args: Record<string, string>, ctx) => {
      const { id, entity_id, state } = await resolveItemId(ctx.ha, kind, args[`${kind}_id`]);
      const config = await fetchConfigItem(ctx.ha, kind, id);
      if (!config) {
        return {
          found: false,
          id,
          entity_id,
          message: `No stored config for ${kind} "${id}". It may be defined in YAML, which this server cannot read through the API.`,
          state: state ? { state: state.state, attributes: state.attributes } : undefined,
        };
      }
      const states = new Map((await ctx.ha.getStates()).map((s) => [s.entity_id, s]));
      return {
        found: true,
        id,
        entity_id,
        state: state?.state,
        last_triggered: state?.attributes.last_triggered,
        config,
        high_risk_actions: scanConfigRisk(config, states, ctx.cfg),
      };
    },
  });

  // A dry check of a draft. Nothing is saved. It reports errors, Home Assistant's own verdict, warnings about missing entities and any high risk actions.
  const validate = defineTool({
    name: `validate_${kind}_config`,
    title: `Validate ${kind} config`,
    description: `Check a draft ${kind} config without saving it. Runs a local structural check, asks Home Assistant to validate the ${
      isAuto ? "triggers, conditions and actions" : "sequence"
    } through the validate_config WebSocket command, and warns about entities that do not exist.`,
    risk: "read",
    shape: { config: z.record(z.string(), z.any()).describe(`The ${kind} config to check, as JSON.`) },
    handler: async ({ config }, ctx) => {
      const cfg = normalizeConfig(config);
      const r = await runPreflight(ctx, kind, cfg);
      return {
        valid: r.schema.errors.length === 0 && r.ha.status !== "invalid",
        schema_errors: r.schema.errors,
        home_assistant_validation: r.ha,
        warnings: r.warnings,
        high_risk_actions: scanConfigRisk(cfg, r.states, ctx.cfg),
      };
    },
  });

  // Create or update. Risk is 'dynamic' because it depends on the content: a brand new
  // harmless automation just saves, while overwriting an existing one, or saving one
  // that touches a lock, goes through the two step approval.
  const save = defineTool({
    name: `save_${kind}`,
    title: `Create or update ${kind}`,
    description: `Create a new ${kind} or overwrite an existing one. Every write is validated first (local schema, Home Assistant validate_config, and a core check_config). Overwriting an existing ${kind}, or saving one whose actions touch locks, alarms, climate, valves, entry covers or restarts, is HIGH RISK and needs confirm true and dry_run false. The previous config is backed up and returned as a rollback receipt. If check_config fails after the write, the change is rolled back automatically. For brand new low risk items dry_run defaults to false. For high risk items it defaults to true.`,
    risk: "dynamic",
    shape: {
      [`${kind}_id`]: z
        .string()
        .optional()
        .describe(
          isAuto
            ? "Config id. Omit to create a new automation with a generated id."
            : "Script key, lowercase letters, digits and underscores. Derived from the alias when omitted."
        ),
      config: z.record(z.string(), z.any()).describe(`The full ${kind} config as JSON.`),
      confirm: z.boolean().default(false).describe("Explicit user consent for a high risk write."),
      dry_run: z.boolean().optional().describe("Preview and validate only. Defaults to true for high risk writes and false otherwise."),
    },
    handler: async (args: Record<string, any>, ctx) => {
      const config = normalizeConfig(args.config);
      // Work out the id. If one was given we use it (translating an entity id if needed).
      // New automations get a timestamp as their id, which is what the Home Assistant UI
      // does. New scripts get an id built from their alias.
      const requestedId: string | undefined = args[`${kind}_id`];
      let id: string;
      if (requestedId) {
        id = (await resolveItemId(ctx.ha, kind, requestedId)).id;
      } else if (isAuto) {
        id = String(Date.now());
      } else {
        id = slugify(String(config.alias ?? ""));
        if (!id) throw new Error("Provide script_id or an alias so a script key can be derived.");
      }
      if (!isAuto && !/^[a-z0-9_]+$/.test(id)) {
        throw new Error(`Script key "${id}" is invalid. Use lowercase letters, digits and underscores only.`);
      }

      // If the config mentions anything on the never-touch list we refuse outright, because a saved automation could change that entity later.
      const blockedRefs = neverTouchHits(referencedEntities(config), ctx.cfg);
      if (blockedRefs.length) {
        return new ToolOutcome(
          {
            status: "blocked_never_touch",
            executed: false,
            entities: blockedRefs,
            message: `This ${kind} references entities on the never-touch list (HA_NEVER_TOUCH), so it cannot be saved through this server. ${NEVER_TOUCH_HELP}`,
          },
          true
        );
      }

      // Checks one and two: our own structural check, then Home Assistant's validation.
      // Pre-flight 1 and 2: local schema and Home Assistant's own validation.
      const pre = await runPreflight(ctx, kind, config);
      const validation = {
        schema_errors: pre.schema.errors,
        home_assistant_validation: pre.ha,
        warnings: pre.warnings,
      };
      if (pre.schema.errors.length || pre.ha.status === "invalid") {
        return new ToolOutcome({ status: "invalid", executed: false, stage: "pre_flight_validation", ...validation }, true);
      }

      // Check three: if Home Assistant's configuration is ALREADY broken, we refuse to
      // stack another change on top. Otherwise we could not tell whether a later problem
      // was caused by us.
      // Pre-flight 3: do not stack a change on top of a broken core configuration.
      const before = await ctx.ha.checkConfig();
      if (before.result !== "valid") {
        return new ToolOutcome(
          {
            status: "blocked",
            executed: false,
            stage: "check_config",
            message: "Home Assistant's current configuration already fails check_config, so this write was refused. Fix that first.",
            check_config: before,
          },
          true
        );
      }

      const existing = await fetchConfigItem(ctx.ha, kind, id);
      // See whether this item already exists (that was the lookup above) and work out exactly what would change. If nothing would change we say so and stop.
      const changes = existing ? diffObjects(stripId(existing), config) : [];
      if (existing && changes.length === 0) {
        return { status: "no_change", executed: false, id, message: `The stored ${kind} already matches this config.` };
      }

      const reasons: string[] = [];
      // Build the list of reasons this write is high risk: overwriting something that exists, plus anything risky inside the actions.
      if (existing) reasons.push(`overwrites the existing ${kind} "${existing.alias ?? id}"`);
      reasons.push(...scanConfigRisk(config, pre.states, ctx.cfg));

      const gate = await evaluateGate({
        risk: reasons.length ? "high" : "low",
        reasons,
        action: existing
          ? `Overwrite ${kind} "${existing.alias ?? id}" (id ${id}) with ${changes.length} change(s).`
          : `Create new ${kind} "${config.alias ?? id}" (id ${id}).`,
        plan: {
          operation: existing ? "update" : "create",
          id,
          validation,
          changes: existing ? describeChanges(changes) : undefined,
          proposed_config: existing ? undefined : config,
          rollback: existing ? "The previous config will be backed up and returned as a rollback receipt." : undefined,
        },
        confirm: args.confirm,
        dryRun: args.dry_run,
      });
      if (!gate.proceed) return gate.outcome;

      // The old version is saved BEFORE we change it, so there is always a way back.
      // Automatic backup before mutating.
      const receipt = existing ? ctx.backups.save(kind, id, existing, `before save_${kind}`) : null;

      await writeConfigItem(ctx.ha, kind, id, config);
      ctx.ha.invalidateCaches();

      // After writing we run check_config again. If Home Assistant is now unhappy, we put
      // the old version back (or delete the new item if it was brand new) and report what
      // happened. The user is never left with a broken config because of us.
      // Post-write verification with automatic rollback.
      let after;
      try {
        after = await ctx.ha.checkConfig();
      } catch (err) {
        after = { result: "invalid" as const, errors: (err as Error).message };
      }
      if (after.result !== "valid") {
        let rolledBack = false;
        try {
          if (existing) await writeConfigItem(ctx.ha, kind, id, existing);
          else await deleteConfigItem(ctx.ha, kind, id);
          rolledBack = true;
        } catch {
          /* reported below */
        }
        return new ToolOutcome(
          {
            status: "rolled_back",
            executed: false,
            message: rolledBack
              ? "check_config failed after the write, so the change was rolled back automatically."
              : "check_config failed after the write and the automatic rollback ALSO failed. Restore manually using the receipt.",
            check_config: after,
            rollback_receipt: receipt ?? undefined,
          },
          true
        );
      }

      // Give Home Assistant a moment to create the entity, so we can report its id.
      await sleep(400);
      const refreshed = (await ctx.ha.getStates()).find((s) =>
        isAuto ? s.entity_id.startsWith("automation.") && s.attributes.id === id : s.entity_id === `script.${id}`
      );
      return {
        status: "saved",
        executed: true,
        operation: existing ? "update" : "create",
        id,
        entity_id: refreshed?.entity_id,
        warnings: pre.warnings,
        rollback_receipt: receipt ?? undefined,
        undo: receipt ? `Call restore_backup with backup_id "${receipt.backup_id}".` : `Call delete_${kind} to remove it.`,
      };
    },
  });

  // Always high risk. Shows what would be deleted (name, description, how many triggers and steps), backs up the whole config, then deletes.
  const del = defineTool({
    name: `delete_${kind}`,
    title: `Delete ${kind}`,
    description: `Permanently delete a stored ${kind}. Always HIGH RISK. Rejected unless confirm is true and dry_run is false. The config is backed up first and returned as a rollback receipt.`,
    risk: "high",
    shape: {
      [`${kind}_id`]: z.string().describe(`The ${kind} config id or entity id.`),
      confirm: z.boolean().default(false).describe("Explicit user consent."),
      dry_run: z.boolean().default(true).describe("Preview only. Must be false to execute."),
    },
    handler: async (args: Record<string, any>, ctx) => {
      const { id, entity_id, state } = await resolveItemId(ctx.ha, kind, args[`${kind}_id`]);
      const existing = await fetchConfigItem(ctx.ha, kind, id);
      if (!existing) {
        throw new Error(`No stored ${kind} with id "${id}". YAML defined items cannot be deleted through the API.`);
      }
      const gate = await evaluateGate({
        risk: "high",
        reasons: [`permanently deletes the ${kind} "${existing.alias ?? id}"`],
        action: `Delete ${kind} "${existing.alias ?? id}" (id ${id}).`,
        plan: {
          id,
          entity_id,
          current_state: state?.state,
          last_triggered: state?.attributes.last_triggered,
          summary: {
            alias: existing.alias,
            description: existing.description,
            triggers: isAuto ? (existing.triggers ?? existing.trigger)?.length ?? 1 : undefined,
            steps: (existing.actions ?? existing.action ?? existing.sequence)?.length,
          },
          rollback: "The full config is backed up first and can be restored with restore_backup.",
        },
        confirm: args.confirm,
        dryRun: args.dry_run,
      });
      if (!gate.proceed) return gate.outcome;

      const receipt = ctx.backups.save(kind, id, existing, `before delete_${kind}`);
      await deleteConfigItem(ctx.ha, kind, id);
      ctx.ha.invalidateCaches();
      return {
        status: "deleted",
        executed: true,
        id,
        rollback_receipt: receipt,
        undo: `Call restore_backup with backup_id "${receipt.backup_id}".`,
      };
    },
  });

  // The debugging tool. A 'trace' is Home Assistant's record of one run of an
  // automation or script: which steps ran, which conditions failed, which step threw
  // an error. We list recent runs, then dig into one (the latest by default, the latest
  // failure if only_failed is set, or a specific run id).
  const trace = defineTool({
    name: `get_${kind}_trace`,
    title: `Get ${kind} trace`,
    description: `Inspect past runs of ${isAuto ? "an automation" : "a script"} to diagnose failures. Without run_id it lists recent runs and details the most recent one. Reports the last step reached, node level errors, failed conditions and a plain English diagnosis.`,
    risk: "read",
    shape: {
      [`${kind}_id`]: z.string().describe(`The ${kind} config id or entity id.`),
      run_id: z.string().optional().describe("A specific run id from the run list. Defaults to the most recent run."),
      only_failed: z.boolean().default(false).describe("Pick the most recent run that did not finish cleanly."),
      runs_limit: z.number().int().min(1).max(30).default(10).describe("How many recent runs to list."),
    },
    handler: async (args: Record<string, any>, ctx) => {
      const { id, entity_id } = await resolveItemId(ctx.ha, kind, args[`${kind}_id`]);
      // Ask for the list of stored runs, then sort newest first.
      const runs = await ctx.ha.wsCommand<any[]>({ type: "trace/list", domain: kind, item_id: id });
      const sorted = [...(runs ?? [])].sort((a, b) =>
        String(b.timestamp?.start ?? "").localeCompare(String(a.timestamp?.start ?? ""))
      );
      const runSummaries = sorted.slice(0, args.runs_limit).map((r) => ({
        run_id: r.run_id,
        started: r.timestamp?.start,
        finished: r.timestamp?.finish,
        state: r.state,
        script_execution: r.script_execution,
        last_step: r.last_step,
        error: r.error,
        trigger: r.trigger,
      }));
      if (sorted.length === 0) {
        return { id, entity_id, runs: [], message: "No stored runs. The trace may not have run yet, or tracing is disabled for it." };
      }

      let chosen = args.run_id ? sorted.find((r) => r.run_id === args.run_id) : undefined;
      if (args.run_id && !chosen) throw new Error(`Run ${args.run_id} was not found. Pick one of the listed run ids.`);
      if (!chosen && args.only_failed) {
        chosen = sorted.find((r) => r.error || (r.script_execution && r.script_execution !== "finished"));
        if (!chosen) return { id, entity_id, runs: runSummaries, message: "No failed runs among the stored traces." };
      }
      chosen = chosen ?? sorted[0];

      // Fetch the full record of the chosen run, then flatten it into a time ordered list of steps.
      const detail = await ctx.ha.wsCommand<any>({ type: "trace/get", domain: kind, item_id: id, run_id: chosen.run_id });
      const steps: { path: string; at?: string; error?: string; result?: string }[] = [];
      for (const [path, nodes] of Object.entries<any[]>(detail.trace ?? {})) {
        for (const n of nodes) {
          steps.push({ path, at: n.timestamp, error: n.error, result: short(n.result) });
        }
      }
      steps.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
      const errors = steps.filter((s) => s.error).map((s) => ({ path: s.path, error: s.error }));
      // A condition that evaluated to false is the most common reason an automation 'did not fire', so we pull those out specially.
      const conditionFailures = Object.entries<any[]>(detail.trace ?? {})
        .filter(([p]) => p.startsWith("condition"))
        .flatMap(([p, nodes]) => nodes.filter((n) => n.result?.result === false).map((n) => ({ path: p, result: short(n.result) })));

      const exec: string | undefined = detail.script_execution;
      const diagnosis =
        errors.length || detail.error
          ? TRACE_DIAGNOSIS.error
          : exec
            ? (TRACE_DIAGNOSIS[exec] ?? `script_execution was "${exec}".`)
            : undefined;

      return {
        id,
        entity_id,
        recent_runs: runSummaries,
        detailed_run: {
          run_id: chosen.run_id,
          started: detail.timestamp?.start,
          finished: detail.timestamp?.finish,
          state: detail.state,
          script_execution: exec,
          last_step: detail.last_step,
          trigger: detail.trigger,
          error: detail.error,
          diagnosis,
          node_errors: errors,
          condition_failures: conditionFailures,
          steps: steps.slice(0, 80),
          steps_truncated: steps.length > 80,
        },
      };
    },
  });

  // Reloads from storage and YAML without a full restart. It runs check_config first
  // and refuses if the configuration is invalid, because reloading a broken config
  // could knock out automations that currently work.
  const reload = defineTool({
    name: `reload_${plural}`,
    title: `Reload ${plural}`,
    description: `Reload ${plural} from storage and YAML without restarting Home Assistant. Runs check_config first and refuses to reload if the configuration is invalid.`,
    risk: "low",
    shape: {},
    handler: async (_args, ctx) => {
      const check = await ctx.ha.checkConfig();
      if (check.result !== "valid") {
        return new ToolOutcome(
          { status: "blocked", executed: false, message: "check_config failed, so nothing was reloaded.", check_config: check },
          true
        );
      }
      await ctx.ha.callService(kind, "reload");
      ctx.ha.invalidateCaches();
      await sleep(500);
      const count = (await ctx.ha.getStates()).filter((s) => s.entity_id.startsWith(`${kind}.`)).length;
      return { status: "reloaded", executed: true, [`${plural}_loaded`]: count };
    },
  });

  return [list, get, validate, save, del, trace, reload];
}

// Builds the tool set for automations and then again for scripts.
export function registerAutomationTools(server: McpServer, ctx: ToolContext): void {
  for (const kind of ["automation", "script"] as const) {
    for (const def of buildKindTools(kind)) registerTool(server, ctx, def as any);
  }
}
