// call_service is the most powerful tool in the whole server, so it is also the most
// carefully guarded. It can run ANY Home Assistant service (turn a light on, play
// music, unlock a door, restart the system), so every call is judged for risk first.
//
// The steps, top to bottom:
//   1. Check the service really exists and all required fields were supplied.
//   2. Work out exactly which entities would be affected, including those hiding
//      inside areas, devices, scripts, automations and scenes.
//   3. Refuse if any of them are on the never-touch list.
//   4. Ask the safety gate whether this may go ahead (low risk: yes. High risk: only
//      with a preview, a plan token and explicit confirmation).
//   5. Only then actually call Home Assistant.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assessServiceCall, controlModeViolation, evaluateGate, neverTouchHits, type ServiceTarget } from "../safety.js";
import { ToolOutcome, asArray } from "../util.js";
import { defineTool, registerTool, type ToolContext } from "./registry.js";

// Several fields accept either a single id or a list of ids, so this describes 'a string or an array of strings'.
const idList = z.union([z.string(), z.array(z.string())]);

// 'dynamic' risk means the risk is decided per call, not per tool. Turning on a
// desk lamp is low risk and just happens. Unlocking the front door is high risk and
// needs the two step approval.
const callService = defineTool({
  name: "call_service",
  title: "Call a Home Assistant service",
  description:
    "Execute any Home Assistant service, for example light.turn_on or switch.toggle. Low risk calls run immediately. High risk calls (locks, alarm panels, climate, water heaters, valves, garage and gate covers, major appliances, restart or shutdown, and scripts or automations that do those things) are rejected unless confirm is true and dry_run is false. Call once without confirm to get a plain English breakdown, show it to the user, then call again with confirm true and dry_run false only after they agree. For low risk calls, dry_run defaults to false. For high risk calls it defaults to true.",
  risk: "dynamic",
  shape: {
    domain: z.string().describe("Service domain, for example 'light'."),
    service: z.string().describe("Service name, for example 'turn_on'."),
    entity_id: idList.optional().describe("Target entity id or ids."),
    target: z
      .object({
        entity_id: idList.optional(),
        area_id: idList.optional(),
        device_id: idList.optional(),
        label_id: idList.optional(),
      })
      .optional()
      .describe("Targets by area, device or label."),
    data: z.record(z.string(), z.any()).optional().describe("Service data, for example {brightness_pct: 40}."),
    return_response: z.boolean().default(false).describe("Request the service response for services that return data."),
    confirm: z.boolean().default(false).describe("Explicit user consent for a high risk call."),
    dry_run: z.boolean().optional().describe("Preview only. Defaults to true for high risk calls and false for low risk calls."),
  },
  handler: async (args, ctx) => {
    // Pull out the plain settings. 'data' is copied so we never change the caller's object.
    const { domain, service, return_response, confirm, dry_run } = args;
    const data: Record<string, unknown> = { ...(args.data ?? {}) };

    // Pre-flight: the service must exist and required fields must be present.
    const services = await ctx.ha.getServices();
    const dom = services.find((d) => d.domain === domain);
    if (!dom) {
      throw new Error(`Unknown service domain "${domain}". Use list_services to see what is available.`);
    }
    const def = dom.services[service];
    if (!def) {
      throw new Error(`Service ${domain}.${service} does not exist. ${domain} offers: ${Object.keys(dom.services).join(", ")}`);
    }

    // People can say what to target in three different places: a top level entity_id, a
    // 'target' object, or inside the data. We merge all of them into one list so nothing
    // slips past the risk check just because it was passed in an unusual spot.
    const target: ServiceTarget = {
      entity_ids: [
        ...asArray(args.entity_id),
        ...asArray(args.target?.entity_id),
        ...asArray(data.entity_id as string | string[] | undefined),
      ],
      area_ids: [...asArray(args.target?.area_id), ...asArray(data.area_id as string | string[] | undefined)],
      device_ids: [...asArray(args.target?.device_id), ...asArray(data.device_id as string | string[] | undefined)],
      label_ids: [...asArray(args.target?.label_id), ...asArray(data.label_id as string | string[] | undefined)],
    };

    // (The comment above covers the idea.) Home Assistant's REST API wants one flat body,
    // so we write the merged targets back into it. A single entity goes in as a string,
    // several go in as a list.
    // Merge targets into the request body so that REST receives one flat payload.
    if (target.entity_ids.length) data.entity_id = target.entity_ids.length === 1 ? target.entity_ids[0] : target.entity_ids;
    if (target.area_ids.length) data.area_id = target.area_ids;
    if (target.device_ids.length) data.device_id = target.device_ids;
    if (target.label_ids.length) data.label_id = target.label_ids;

    // Control only mode: refuse anything outside everyday device control, before we do
    // any further work. There is no confirmation route for these, they are simply not allowed.
    const notAllowed = controlModeViolation(ctx.cfg, domain, service, target);
    if (notAllowed) {
      return new ToolOutcome(
        { status: "blocked_control_only", executed: false, message: `${notAllowed} (HA_CONTROL_ONLY is on.)` },
        true
      );
    }

    // Collect any fields the service marks as required that were not supplied, so we can give a clear error before calling.
    const missing = Object.entries(def.fields ?? {})
      .filter(([name, f]: [string, any]) => f?.required && !(name in data))
      .map(([name]) => name);
    if (missing.length) {
      throw new Error(`Missing required field(s) for ${domain}.${service}: ${missing.join(", ")}`);
    }

    // This is where the safety judgement happens. See safety.ts for how it decides.
    const risk = await assessServiceCall(ctx.ha, ctx.cfg, domain, service, target, data);

    // The never-touch list is checked against everything the call would affect,
    // including entities discovered inside areas or scripts, not just the ones named.
    // This is an absolute block, with no confirmation route.
    const blocked = neverTouchHits(
      [...risk.entities.map((e) => e.entity_id), ...target.entity_ids.filter((e) => e !== "all")],
      ctx.cfg
    );
    if (blocked.length) {
      return new ToolOutcome(
        {
          status: "blocked_never_touch",
          executed: false,
          entities: blocked,
          message: "These entities are on the never-touch list (HA_NEVER_TOUCH) and cannot be changed through this server, even with confirmation.",
        },
        true
      );
    }

    // Build a human readable sentence about what will be touched. This is what the person sees in the plan.
    const targetText = risk.entities.length
      ? risk.entities.map((e) => `${e.entity_id} (${e.name}, currently ${e.state})`).join(", ")
      : "no specific entity";
    const extra = Object.keys(data).filter((k) => !["entity_id", "area_id", "device_id", "label_id"].includes(k));
    const action = `Call ${domain}.${service} on ${targetText}${
      extra.length ? ` with ${extra.map((k) => `${k}=${JSON.stringify(data[k])}`).join(", ")}` : ""
    }.`;

    // Hand everything to the gate. If it says no, we return its explanation (a preview,
    // a rejection or a request for the plan token) and do not call Home Assistant at all.
    const gate = await evaluateGate({
      risk: risk.level,
      reasons: risk.reasons,
      action,
      plan: {
        service: `${domain}.${service}`,
        service_description: def.description || undefined,
        request_body: data,
        affected_entities: risk.entities,
      },
      confirm,
      dryRun: dry_run,
    });
    if (!gate.proceed) return gate.outcome;

    // The moment of truth: the gate approved, so we really do it. The caches are cleared because the call may have changed things.
    const response = await ctx.ha.callService(domain, service, data, return_response);
    ctx.ha.invalidateCaches();

    // Home Assistant returns either a plain list of changed states or, when we asked for
    // a response, an object holding the list plus the service's own response data.
    const changed = Array.isArray(response) ? response : response?.changed_states;
    return {
      status: "executed",
      risk: risk.level,
      executed: true,
      service: `${domain}.${service}`,
      changed_states: Array.isArray(changed)
        ? changed.map((s: any) => ({ entity_id: s.entity_id, state: s.state }))
        : undefined,
      service_response: response?.service_response,
    };
  },
});

// The one thing this file exports: it adds call_service to the server.
export function registerControlTools(server: McpServer, ctx: ToolContext): void {
  registerTool(server, ctx, callService as any);
}
