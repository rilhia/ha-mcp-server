// End to end smoke test: spawns the built server over stdio and drives it against the mock Home Assistant.
// The end to end test. It starts the REAL compiled server as a child process, connects
// to it like a real MCP client (Claude, LM Studio) would over stdio, and drives it
// against the mock Home Assistant. Nothing is mocked inside the server itself, which
// means a passing run is good evidence the whole thing hangs together.
//
// What it covers, roughly in order: tool registration, discovery, the two step
// approval on service calls, automations, helpers, diagnostics, read only mode, auth
// failures, the raw API tools, dashboards and registries, plan tokens and approval
// prompts, the never-touch list, secret redaction, the audit log, the insight tools,
// toolset switches and the Supervisor tools.
//
// Run it with: npm test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOKEN, startMock } from "./mock-ha.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mock = await startMock();
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-mcp-backups-"));
const auditFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ha-mcp-audit-")), "audit.jsonl");

// Starts a fresh copy of the server with the given settings (environment variables) and returns a connected client. Many tests start their own copy to try different settings, like read only mode.
async function connect(env = {}, opts = {}) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [process.env.MCP_ENTRY ?? path.join(root, "dist", "index.js")],
    env: { ...process.env, HA_URL: mock.url, HA_TOKEN: TOKEN, HA_BACKUP_DIR: backupDir, HA_AUDIT_LOG: auditFile, HA_ENABLE_RAW: "true", HA_ALLOW_CONTROL: "true", HA_ALLOW_EDIT: "true", HA_REQUIRE_APPROVAL_PROMPT: "false", ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "smoke", version: "1.0.0" }, opts.capabilities ? { capabilities: opts.capabilities } : undefined);
  if (opts.onElicit) client.setRequestHandler(ElicitRequestSchema, opts.onElicit);
  await client.connect(transport);
  return client;
}

const client = await connect();

// Calls a tool and parses the JSON text it returns. Returns the data, whether it was flagged as an error, and the raw text.
async function rawCall(c, name, args = {}) {
  const res = await c.callTool({ name, arguments: args });
  const raw = res.content?.[0]?.text ?? "";
  let data = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    /* plain text */
  }
  return { data, isError: !!res.isError, raw };
}

/**
 * Calls a tool. When the arguments ask for confirm true and dry_run false, this does what a well behaved
 * model does: preview first to obtain the plan_token, then repeat the identical call with it.
 */
// A helper that behaves like a well mannered AI. When a test asks for a confirmed
// high risk action, it first makes the PREVIEW call to obtain the plan token, then
// repeats the identical call with that token. Tests that want to check what happens
// WITHOUT a token use rawCall instead.
async function call(name, args = {}, c = client) {
  if (args.confirm === true && args.dry_run === false && !args.plan_token) {
    const { confirm: _c, dry_run: _d, ...preview } = args;
    const p = await rawCall(c, name, preview);
    if (p.data?.plan_token) args = { ...args, plan_token: p.data.plan_token };
  }
  return rawCall(c, name, args);
}

// Simple test bookkeeping: count passes, remember failures, and print one line each.
let passed = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(err.message).split("\n").join("\n       ")}`);
  }
}

console.log("Tool registry");
const { tools } = await client.listTools();
const names = tools.map((x) => x.name);
await t("registers the required tools", () => {
  for (const n of [
    "search_entities", "get_entity_details", "get_area_summary", "list_services", "render_template",
    "get_automation_trace", "reload_automations", "check_config", "get_error_log", "get_system_health",
    "call_service", "save_automation", "delete_automation", "save_script", "delete_script",
    "restart_home_assistant", "restore_backup", "create_helper", "update_helper", "delete_helper",
  ]) assert.ok(names.includes(n), `missing tool ${n}`);
});
await t("annotates read only and destructive tools", () => {
  const by = Object.fromEntries(tools.map((x) => [x.name, x]));
  assert.equal(by.search_entities.annotations.readOnlyHint, true);
  assert.equal(by.delete_automation.annotations.destructiveHint, true);
  assert.equal(by.call_service.annotations.readOnlyHint, false);
});
await t("high risk tools default confirm=false and dry_run=true in their schemas", () => {
  const props = tools.find((x) => x.name === "delete_automation").inputSchema.properties;
  assert.equal(props.confirm.default, false);
  assert.equal(props.dry_run.default, true);
});

console.log("Discovery");
await t("search_entities understands synonyms and returns a summary", async () => {
  const { data } = await call("search_entities", { query: "desk lamp" });
  assert.equal(data.entities[0].entity_id, "light.office_lamp");
  assert.equal(data.entities[0].area, "Office");
});
await t("search_entities filters by domain and area", async () => {
  const { data } = await call("search_entities", { domain: "light", area: "kitchen" });
  assert.deepEqual(data.entities.map((e) => e.entity_id), ["light.kitchen"]);
});
await t("get_entity_details decodes supported features", async () => {
  const { data } = await call("get_entity_details", { entity_id: "cover.garage_door" });
  assert.deepEqual(data.supported_features.decoded, ["OPEN", "CLOSE"]);
});
await t("get_entity_details suggests similar ids for a typo", async () => {
  const { data, isError } = await call("get_entity_details", { entity_id: "light.kitchn" });
  assert.equal(isError, true);
  assert.match(String(data), /does not exist/);
});
await t("get_area_summary groups entities by device", async () => {
  const { data } = await call("get_area_summary", { area_name: "living room" });
  assert.equal(data.area.id, "living_room");
  assert.equal(data.devices[0].entities[0].entity_id, "climate.living_room");
});
await t("list_services returns parameter schemas", async () => {
  const { data } = await call("list_services", { domain: "light" });
  assert.ok(data.turn_on.fields.brightness_pct);
});
await t("render_template returns output and surfaces template errors", async () => {
  const good = await call("render_template", { template: "{{ 1 + 1 }}" });
  assert.equal(good.data.rendered, "rendered:{{ 1 + 1 }}");
  const bad = await call("render_template", { template: "{{ boom }}" });
  assert.match(bad.data.error, /boom/);
});

console.log("Two phase commit on service calls");
await t("low risk call executes immediately", async () => {
  const { data } = await call("call_service", { domain: "light", service: "turn_on", entity_id: "light.office_lamp", data: { brightness_pct: 40 } });
  assert.equal(data.executed, true);
  assert.equal(data.risk, "low");
});
await t("lock.unlock without confirm is not executed", async () => {
  const before = mock.serviceCalls.length;
  const { data } = await call("call_service", { domain: "lock", service: "unlock", entity_id: "lock.front_door" });
  assert.equal(data.executed, false);
  assert.equal(data.risk, "high");
  assert.equal(data.status, "confirmation_required");
  assert.match(data.action, /lock\.front_door/);
  assert.equal(mock.serviceCalls.length, before);
  assert.equal(mock.states.get("lock.front_door").state, "locked");
});
await t("explicit dry_run=false without confirm is rejected as an error", async () => {
  const { data, isError } = await call("call_service", { domain: "lock", service: "unlock", entity_id: "lock.front_door", dry_run: false });
  assert.equal(isError, true);
  assert.equal(data.status, "rejected_confirmation_required");
  assert.equal(mock.states.get("lock.front_door").state, "locked");
});
await t("confirm=true alone still only does a dry run", async () => {
  const { data } = await call("call_service", { domain: "lock", service: "unlock", entity_id: "lock.front_door", confirm: true });
  assert.equal(data.status, "dry_run");
  assert.equal(mock.states.get("lock.front_door").state, "locked");
});
await t("confirm=true and dry_run=false executes", async () => {
  const { data } = await call("call_service", { domain: "lock", service: "unlock", entity_id: "lock.front_door", confirm: true, dry_run: false });
  assert.equal(data.executed, true);
  assert.equal(mock.states.get("lock.front_door").state, "unlocked");
});
await t("garage cover is high risk by device class", async () => {
  const { data } = await call("call_service", { domain: "cover", service: "open_cover", entity_id: "cover.garage_door" });
  assert.equal(data.risk, "high");
  assert.equal(mock.states.get("cover.garage_door").state, "closed");
});
await t("an ordinary blind is not high risk", async () => {
  const { data } = await call("call_service", { domain: "cover", service: "close_cover", entity_id: "cover.office_blind" });
  assert.equal(data.executed, true);
});
await t("climate is high risk", async () => {
  const { data } = await call("call_service", { domain: "climate", service: "set_temperature", entity_id: "climate.living_room", data: { temperature: 30 } });
  assert.equal(data.risk, "high");
});
await t("major appliance detected by name", async () => {
  const { data } = await call("call_service", { domain: "switch", service: "turn_on", entity_id: "switch.washing_machine" });
  assert.equal(data.risk, "high");
  assert.equal(mock.states.get("switch.washing_machine").state, "off");
});
await t("a normal switch runs without confirmation", async () => {
  const { data } = await call("call_service", { domain: "switch", service: "turn_on", entity_id: "switch.desk_fan_plug" });
  assert.equal(data.executed, true);
});
await t("area targets are resolved, so an area containing a thermostat is high risk", async () => {
  const { data } = await call("call_service", { domain: "light", service: "turn_off", target: { area_id: "living_room" } });
  assert.equal(data.risk, "high");
});
await t("running a script that locks a door is high risk", async () => {
  const { data } = await call("call_service", { domain: "script", service: "goodnight" });
  assert.equal(data.risk, "high");
  assert.match(data.why_high_risk.join(" "), /lock/);
});
await t("a harmless script runs immediately", async () => {
  const { data } = await call("call_service", { domain: "script", service: "turn_on", entity_id: "script.harmless" });
  assert.equal(data.executed, true);
});
await t("missing required service fields are caught before sending", async () => {
  const { data, isError } = await call("call_service", { domain: "climate", service: "set_temperature", entity_id: "climate.living_room" });
  assert.equal(isError, true);
  assert.match(String(data), /temperature/);
});
await t("unknown services are rejected with suggestions", async () => {
  const { data, isError } = await call("call_service", { domain: "light", service: "explode" });
  assert.equal(isError, true);
  assert.match(String(data), /turn_on/);
});

console.log("Automations");
const newAuto = {
  alias: "Desk lamp at dusk",
  triggers: [{ trigger: "sun", event: "sunset" }],
  actions: [{ action: "light.turn_on", target: { entity_id: "light.office_lamp" } }],
};
let createdId;
await t("validate_automation_config reports problems without writing", async () => {
  const { data } = await call("validate_automation_config", { config: { alias: "x", actions: [{ action: "light.turn_on" }] } });
  assert.equal(data.valid, false);
  assert.match(data.schema_errors.join(" "), /trigger/);
});
await t("creating a new low risk automation runs without confirmation", async () => {
  const { data } = await call("save_automation", { config: newAuto });
  assert.equal(data.status, "saved", JSON.stringify(data));
  createdId = data.id;
  assert.ok(mock.automations.has(createdId));
});
await t("home assistant side validation blocks a bad action before any write", async () => {
  const before = mock.automations.size;
  const { data, isError } = await call("save_automation", { config: { ...newAuto, actions: [{ action: "BAD" }] } });
  assert.equal(isError, true);
  assert.equal(data.status, "invalid");
  assert.equal(mock.automations.size, before);
});
await t("overwriting an existing automation requires confirmation and shows a diff", async () => {
  const changed = { ...newAuto, triggers: [{ trigger: "sun", event: "sunrise" }] };
  const { data } = await call("save_automation", { automation_id: createdId, config: changed });
  assert.equal(data.status, "confirmation_required");
  assert.match(data.plan.changes.join(" "), /sunset.*sunrise/);
  assert.equal(mock.automations.get(createdId).triggers[0].event, "sunset");
});
let receipt;
await t("confirmed overwrite saves, backs up the old config and returns a receipt", async () => {
  const changed = { ...newAuto, triggers: [{ trigger: "sun", event: "sunrise" }] };
  const { data } = await call("save_automation", { automation_id: createdId, config: changed, confirm: true, dry_run: false });
  assert.equal(data.status, "saved", JSON.stringify(data));
  receipt = data.rollback_receipt;
  assert.equal(receipt.previous_config.triggers[0].event, "sunset");
  assert.ok(fs.existsSync(receipt.path), "backup file should exist on disk");
  assert.equal(mock.automations.get(createdId).triggers[0].event, "sunrise");
});
await t("restore_backup is itself gated and then rolls back", async () => {
  const preview = await call("restore_backup", { backup_id: receipt.backup_id });
  assert.equal(preview.data.executed, false);
  const done = await call("restore_backup", { backup_id: receipt.backup_id, confirm: true, dry_run: false });
  assert.equal(done.data.status, "restored");
  assert.equal(mock.automations.get(createdId).triggers[0].event, "sunset");
});
await t("a write that breaks check_config is rolled back automatically", async () => {
  mock.invalidAfterNextWrite = true;
  const { data, isError } = await call("save_automation", {
    automation_id: createdId,
    config: { ...newAuto, triggers: [{ trigger: "sun", event: "sunrise" }, { trigger: "time", at: "06:00:00" }] },
    confirm: true,
    dry_run: false,
  });
  mock.checkConfigValid = true;
  assert.equal(isError, true);
  assert.equal(data.status, "rolled_back");
  assert.equal(mock.automations.get(createdId).triggers.length, 1);
});
await t("writes are refused when check_config is already failing", async () => {
  mock.checkConfigValid = false;
  const { data, isError } = await call("save_automation", { config: { ...newAuto, alias: "Another" } });
  mock.checkConfigValid = true;
  assert.equal(isError, true);
  assert.equal(data.status, "blocked");
});
await t("an automation that unlocks doors is high risk even when new", async () => {
  const { data } = await call("save_automation", {
    config: { alias: "Open up", triggers: [{ trigger: "time", at: "08:00:00" }], actions: [{ action: "lock.unlock", target: { entity_id: "lock.front_door" } }] },
  });
  assert.equal(data.status, "confirmation_required");
  assert.match(data.why_high_risk.join(" "), /lock/);
});
await t("delete_automation previews, then deletes with a receipt, and the receipt restores it", async () => {
  const preview = await call("delete_automation", { automation_id: createdId });
  assert.equal(preview.data.executed, false);
  assert.ok(mock.automations.has(createdId));
  const del = await call("delete_automation", { automation_id: createdId, confirm: true, dry_run: false });
  assert.equal(del.data.status, "deleted");
  assert.ok(!mock.automations.has(createdId));
  const restored = await call("restore_backup", { backup_id: del.data.rollback_receipt.backup_id, confirm: true, dry_run: false });
  assert.equal(restored.data.status, "restored");
  assert.ok(mock.automations.has(createdId));
});
await t("list_automations and get_automation work with entity ids", async () => {
  const list = await call("list_automations", { query: "morning" });
  assert.equal(list.data.automations[0].config_id, "1001");
  const got = await call("get_automation", { automation_id: "automation.morning_lights" });
  assert.equal(got.data.config.alias, "Morning lights");
});
await t("get_automation_trace explains a failed run", async () => {
  const { data } = await call("get_automation_trace", { automation_id: "1001", only_failed: true });
  assert.equal(data.detailed_run.run_id, "run2");
  assert.match(data.detailed_run.diagnosis, /error/i);
  assert.equal(data.detailed_run.node_errors[0].path, "action/0");
});
await t("reload_automations works, and refuses when check_config fails", async () => {
  const good = await call("reload_automations");
  assert.equal(good.data.status, "reloaded");
  mock.checkConfigValid = false;
  const bad = await call("reload_automations");
  mock.checkConfigValid = true;
  assert.equal(bad.isError, true);
});
await t("scripts support the same gated CRUD", async () => {
  const created = await call("save_script", { script_id: "movie_mode", config: { alias: "Movie mode", sequence: [{ action: "light.turn_off", target: { entity_id: "light.kitchen" } }] } });
  assert.equal(created.data.status, "saved", JSON.stringify(created.data));
  const del = await call("delete_script", { script_id: "movie_mode" });
  assert.equal(del.data.executed, false);
});

console.log("Helpers");
await t("create_helper is low risk, update and delete are gated", async () => {
  const created = await call("create_helper", { helper_type: "input_boolean", config: { name: "Holiday mode" } });
  assert.equal(created.data.status, "created");
  const upd = await call("update_helper", { helper_type: "input_boolean", helper_id: "holiday_mode", config: { name: "Holiday" } });
  assert.equal(upd.data.executed, false);
  assert.equal(mock.helpers.input_boolean.find((h) => h.id === "holiday_mode").name, "Holiday mode");
  const upd2 = await call("update_helper", { helper_type: "input_boolean", helper_id: "holiday_mode", config: { name: "Holiday" }, confirm: true, dry_run: false });
  assert.equal(upd2.data.status, "updated");
  const del = await call("delete_helper", { helper_type: "input_boolean", helper_id: "input_boolean.holiday_mode", confirm: true, dry_run: false });
  assert.equal(del.data.status, "deleted");
  assert.ok(!mock.helpers.input_boolean.some((h) => h.id === "holiday_mode"));
});
await t("helper validation catches bad input before sending", async () => {
  const { isError, data } = await call("create_helper", { helper_type: "input_number", config: { name: "T", min: 10, max: 5 } });
  assert.equal(isError, true);
  assert.match(String(data), /min must be lower/);
});

console.log("Diagnostics and lifecycle");
await t("check_config, error log filter and system health", async () => {
  assert.equal((await call("check_config")).data.valid, true);
  const log = await call("get_error_log", { level: "ERROR" });
  assert.equal(log.data.returned, 1);
  const health = await call("get_system_health");
  assert.ok(health.data.sections.homeassistant.info.version);
  assert.ok(health.data.sections.recorder);
});
await t("restart is gated, refuses on invalid config, and executes when confirmed", async () => {
  const preview = await call("restart_home_assistant");
  assert.equal(preview.data.executed, false);
  assert.ok(!mock.serviceCalls.some((c) => c.service === "restart"));
  mock.checkConfigValid = false;
  const blocked = await call("restart_home_assistant", { confirm: true, dry_run: false });
  mock.checkConfigValid = true;
  assert.equal(blocked.data.status, "blocked");
  const done = await call("restart_home_assistant", { confirm: true, dry_run: false });
  assert.equal(done.data.status, "requested");
  assert.ok(mock.serviceCalls.some((c) => c.domain === "homeassistant" && c.service === "restart"));
});
await t("restarting via call_service is also gated", async () => {
  const before = mock.serviceCalls.length;
  const { data } = await call("call_service", { domain: "homeassistant", service: "restart" });
  assert.equal(data.risk, "high");
  assert.equal(mock.serviceCalls.length, before);
});
await t("list_backups shows receipts", async () => {
  const { data } = await call("list_backups", { item_id: createdId });
  assert.ok(data.backups.length >= 2);
  assert.equal(data.backups[0].config, undefined);
});
await t("the WebSocket channel is reused across commands", async () => {
  assert.ok(mock.wsCommands.length > 5, "many commands were sent");
  assert.equal(mock.wsConnections, 1, "all commands should share one authenticated socket");
});

await client.close();

console.log("Read only mode and auth failures");
const ro = await connect({ HA_ALLOW_CONTROL: "", HA_ALLOW_EDIT: "" });
await t("read only mode registers only read tools", async () => {
  const { tools: roTools } = await ro.listTools();
  const roNames = roTools.map((x) => x.name);
  assert.ok(roNames.includes("search_entities"));
  assert.ok(roNames.includes("ha_ws_read") && roNames.includes("ha_rest_read") && roNames.includes("get_audit_log"));
  for (const n of ["get_dashboard", "list_registry", "find_related", "get_scene", "list_blueprints", "list_integrations", "list_repairs"]) assert.ok(roNames.includes(n), `${n} should be available read only`);
  for (const n of ["call_service", "save_automation", "delete_automation", "restart_home_assistant", "reload_automations", "create_helper", "ha_ws_write", "ha_rest_write", "manage_registry", "save_dashboard", "save_dashboard_view", "create_dashboard", "delete_dashboard", "save_scene", "delete_scene", "import_blueprint", "manage_config_entry", "run_config_flow", "ignore_repair"]) {
    assert.ok(!roNames.includes(n), `${n} must not be registered in read only mode`);
  }
  assert.ok(roTools.every((x) => x.annotations.readOnlyHint === true));
});
await ro.close();

const badAuth = await connect({ HA_TOKEN: "wrong" });
await t("a bad token produces a clear error, not a crash", async () => {
  const res = await badAuth.callTool({ name: "get_ha_config", arguments: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /401|Unauthorized/);
  const ws = await badAuth.callTool({ name: "list_areas", arguments: {} });
  assert.equal(ws.isError, true);
  assert.match(ws.content[0].text, /rejected the access token/);
  // The error names the length and a safe fingerprint of what was received, never the token.
  const { createHash } = await import("node:crypto");
  const fp = createHash("sha256").update("wrong").digest("hex").slice(0, 8);
  assert.match(res.content[0].text, new RegExp(`token length 5, fingerprint ${fp}`));
  assert.match(ws.content[0].text, new RegExp(`fingerprint ${fp}`));
  assert.ok(!res.content[0].text.includes("wrong)") && !/token "wrong"/.test(res.content[0].text));
});
await badAuth.close();

const messy = await connect({ HA_TOKEN: `  "Bearer ${TOKEN}"\n` });
await t("a token pasted with quotes, Bearer prefix or whitespace still works", async () => {
  const res = await messy.callTool({ name: "get_ha_config", arguments: {} });
  assert.ok(!res.isError, res.content[0].text);
  assert.match(res.content[0].text, /ha_url_in_use/);
});
await messy.close();


console.log("Raw API tools");
const raw = await connect();
await t("ha_ws_read runs known read commands and trims arrays", async () => {
  const lov = await call("ha_ws_read", { type: "lovelace/config" }, raw);
  assert.equal(lov.data.views[0].title, "Home");
  const areas = await call("ha_ws_read", { type: "config/area_registry/list", fields: ["name"], max_items: 2 }, raw);
  assert.equal(areas.data.total, 3);
  assert.equal(areas.data.returned, 2);
  assert.deepEqual(Object.keys(areas.data.items[0]), ["name"]);
});
await t("ha_ws_read refuses commands that could write, and reserved keys", async () => {
  const w = await call("ha_ws_read", { type: "config/entity_registry/update", params: { entity_id: "light.kitchen", name: "x" } }, raw);
  assert.equal(w.isError, true);
  assert.match(w.raw, /ha_ws_write/);
  const k = await call("ha_ws_read", { type: "lovelace/config", params: { type: "evil" } }, raw);
  assert.equal(k.isError, true);
  assert.equal(mock.wsWrites.length, 0);
});
await t("ha_ws_read listens to observation commands", async () => {
  const r = await call("ha_ws_read", { type: "subscribe_events", params: { event_type: "state_changed" }, collect_ms: 500 }, raw);
  assert.equal(r.data.events_received, 1);
  assert.equal(r.data.events[0].data.entity_id, "light.kitchen");
});
await t("ha_ws_write is gated, token bound and executes once confirmed", async () => {
  const args = { type: "config/entity_registry/update", params: { entity_id: "light.kitchen", name: "Kitchen Main" } };
  const preview = await call("ha_ws_write", args, raw);
  assert.equal(preview.data.status, "confirmation_required");
  assert.equal(mock.wsWrites.length, 0);
  const done = await call("ha_ws_write", { ...args, confirm: true, dry_run: false }, raw);
  assert.equal(done.data.executed, true, done.raw);
  assert.equal(mock.wsWrites.length, 1);
  assert.equal(mock.wsWrites[0].name, "Kitchen Main");
});
await t("ha_ws_write sends service calls to call_service and refuses read commands", async () => {
  const a = await call("ha_ws_write", { type: "call_service", params: { domain: "lock", service: "unlock" } }, raw);
  assert.match(a.raw, /call_service tool/);
  const b = await call("ha_ws_write", { type: "lovelace/config" }, raw);
  assert.match(b.raw, /ha_ws_read/);
});
await t("ha_rest_read reads, allows only the two harmless POSTs, and rejects bad paths", async () => {
  const cal = await call("ha_rest_read", { path: "/api/calendars" }, raw);
  assert.equal(cal.data.items[0].entity_id, "calendar.family");
  const tpl = await call("ha_rest_read", { path: "/api/template", method: "POST", body: { template: "{{ 1 }}" } }, raw);
  assert.match(String(tpl.data), /rendered/);
  assert.equal((await call("ha_rest_read", { path: "/api/events/x", method: "POST" }, raw)).isError, true);
  for (const bad of ["/etc/passwd", "/api/../secret", "/api//x", "/api/states?x=1", "/api/websocket", "http://evil.example/api/x"]) {
    assert.equal((await call("ha_rest_read", { path: bad }, raw)).isError, true, bad);
  }
});
await t("ha_rest_write is gated and redirects services and automation config", async () => {
  const before = mock.events.length;
  const args = { method: "POST", path: "/api/events/test_event", body: { hello: "world" } };
  const preview = await call("ha_rest_write", args, raw);
  assert.equal(preview.data.status, "confirmation_required");
  assert.equal(mock.events.length, before);
  const done = await call("ha_rest_write", { ...args, confirm: true, dry_run: false }, raw);
  assert.equal(done.data.executed, true, done.raw);
  assert.equal(mock.events.length, before + 1);
  assert.match((await call("ha_rest_write", { method: "POST", path: "/api/services/lock/unlock", body: {} }, raw)).raw, /call_service/);
  assert.match((await call("ha_rest_write", { method: "DELETE", path: "/api/config/automation/config/1001" }, raw)).raw, /delete_automation/);
});
await raw.close();
const rawNt = await connect({ HA_NEVER_TOUCH: "light.kitchen" });
await t("never-touch applies to raw write commands", async () => {
  const r = await call("ha_ws_write", { type: "config/entity_registry/update", params: { entity_id: "light.kitchen", name: "No" } }, rawNt);
  assert.equal(r.data.status, "blocked_never_touch");
  const r2 = await call("ha_rest_write", { method: "POST", path: "/api/states/light.kitchen", body: { state: "on" } }, rawNt);
  assert.equal(r2.data.status, "blocked_never_touch");
});
await rawNt.close();

console.log("Dashboards, registries, scenes, blueprints and integrations");
const adm = await connect();

await t("list_dashboards shows the default and stored dashboards", async () => {
  const r = await call("list_dashboards", {}, adm);
  assert.equal(r.data[0].id, "default");
  assert.ok(r.data.some((d) => d.url_path === "house-overview"));
});
await t("get_dashboard summarises, reads one view, and reports auto generated dashboards", async () => {
  const sum = await call("get_dashboard", {}, adm);
  assert.equal(sum.data.summary.views.length, 1);
  const view = await call("get_dashboard", { view: "home" }, adm);
  assert.equal(view.data.view.cards.length, 1);
  const none = await call("get_dashboard", { url_path: "nothing-here" }, adm);
  assert.equal(none.data.stored, false);
});
let dashReceipt;
await t("adding a view is low risk, replacing one is gated with a diff and a rollback", async () => {
  const add = await call("save_dashboard_view", { view: { title: "Garden", path: "garden", cards: [] } }, adm);
  assert.equal(add.data.operation, "added", add.raw);
  assert.equal(mock.lovelace.default.views.length, 2);
  const replacement = { title: "Home", path: "home", cards: [] };
  const preview = await call("save_dashboard_view", { view: replacement }, adm);
  assert.equal(preview.data.status, "confirmation_required");
  assert.match(preview.data.plan.changes.join(" "), /cards/);
  assert.equal(mock.lovelace.default.views[0].cards.length, 1);
  const done = await call("save_dashboard_view", { view: replacement, confirm: true, dry_run: false }, adm);
  assert.equal(done.data.operation, "replaced", done.raw);
  dashReceipt = done.data.rollback_receipt;
  assert.equal(mock.lovelace.default.views[0].cards.length, 0);
  const back = await call("restore_backup", { backup_id: dashReceipt.backup_id, confirm: true, dry_run: false }, adm);
  assert.equal(back.data.status, "restored", back.raw);
  assert.equal(mock.lovelace.default.views[0].cards.length, 1);
});
await t("save_dashboard validates input and gates overwrites", async () => {
  assert.equal((await call("save_dashboard", { config: { views: [] } }, adm)).data.status, "invalid");
  const dup = await call("save_dashboard", { config: { views: [{ title: "A", path: "x" }, { title: "B", path: "x" }] } }, adm);
  assert.match(dup.data.errors.join(" "), /used twice/);
  const preview = await call("save_dashboard", { config: { views: [{ title: "Only", path: "only", cards: [] }] } }, adm);
  assert.equal(preview.data.status, "confirmation_required");
  assert.equal(mock.lovelace.default.views.length, 2);
  const warn = await call("save_dashboard", { config: { views: [{ title: "Only", path: "only", cards: [{ type: "entities", entities: ["light.nope"] }] }] } }, adm);
  assert.match(warn.data.plan.warnings.join(" "), /light\.nope/);
});
await t("create, delete and restore a whole dashboard", async () => {
  let bad;
  try { bad = await call("create_dashboard", { url_path: "nohyphen", title: "x" }, adm); } catch { bad = { isError: true }; }
  assert.equal(bad.isError, true);
  const created = await call("create_dashboard", { url_path: "garden-view", title: "Garden" }, adm);
  assert.equal(created.data.status, "created", created.raw);
  assert.equal((await call("get_dashboard", { url_path: "garden-view" }, adm)).data.stored, false);
  const first = await call("save_dashboard", { url_path: "garden-view", config: { views: [{ title: "Beds", path: "beds", cards: [] }] } }, adm);
  assert.equal(first.data.status, "saved", first.raw);
  const preview = await call("delete_dashboard", { url_path: "garden-view" }, adm);
  assert.equal(preview.data.executed, false);
  assert.ok(mock.dashboards.some((d) => d.url_path === "garden-view"));
  const del = await call("delete_dashboard", { url_path: "garden-view", confirm: true, dry_run: false }, adm);
  assert.equal(del.data.status, "deleted", del.raw);
  assert.ok(!mock.dashboards.some((d) => d.url_path === "garden-view"));
  const back = await call("restore_backup", { backup_id: del.data.rollback_receipt.backup_id, confirm: true, dry_run: false }, adm);
  assert.equal(back.data.status, "restored", back.raw);
  assert.ok(mock.dashboards.some((d) => d.url_path === "garden-view"));
  assert.equal(mock.lovelace["garden-view"].views[0].path, "beds");
  const reset = await call("delete_dashboard_config", { url_path: "garden-view", confirm: true, dry_run: false }, adm);
  assert.equal(reset.data.status, "reset");
  assert.equal(mock.lovelace["garden-view"], undefined);
});

await t("list_registry filters and find_related reports references", async () => {
  const a = await call("list_registry", { registry: "area", query: "kit" }, adm);
  assert.equal(a.data.items.length, 1);
  const r = await call("find_related", { item_type: "entity", item_id: "light.kitchen" }, adm);
  assert.ok(r.data.related.automation.includes("automation.morning_lights"));
});
await t("manage_registry creates and updates low risk items and rejects unknown fields", async () => {
  const c = await call("manage_registry", { registry: "area", action: "create", fields: { name: "Garden Room" } }, adm);
  assert.equal(c.data.status, "created", c.raw);
  const u = await call("manage_registry", { registry: "area", action: "update", id: "garden_room", fields: { icon: "mdi:tree" } }, adm);
  assert.equal(u.data.status, "updated", u.raw);
  assert.ok(u.data.rollback_receipt);
  const bad = await call("manage_registry", { registry: "area", action: "update", id: "garden_room", fields: { colour: "red" } }, adm);
  assert.equal(bad.isError, true);
});
await t("deleting a registry item is gated and restorable", async () => {
  const preview = await call("manage_registry", { registry: "area", action: "delete", id: "garden_room" }, adm);
  assert.equal(preview.data.status, "confirmation_required");
  const del = await call("manage_registry", { registry: "area", action: "delete", id: "garden_room", confirm: true, dry_run: false }, adm);
  assert.equal(del.data.status, "deleted", del.raw);
  const back = await call("restore_backup", { backup_id: del.data.rollback_receipt.backup_id, confirm: true, dry_run: false }, adm);
  assert.equal(back.data.status, "restored", back.raw);
  const list = await call("list_registry", { registry: "area", query: "garden" }, adm);
  assert.equal(list.data.items[0].icon, "mdi:tree");
});
await t("renaming an entity id is high risk and lists references, other entity edits are not", async () => {
  const low = await call("manage_registry", { registry: "entity", action: "update", id: "light.kitchen", fields: { name: "Kitchen Ceiling" } }, adm);
  assert.equal(low.data.status, "updated", low.raw);
  const rename = { registry: "entity", action: "update", id: "light.kitchen", fields: { new_entity_id: "light.kitchen_main" } };
  const preview = await call("manage_registry", rename, adm);
  assert.equal(preview.data.status, "confirmation_required");
  assert.ok(preview.data.plan.references.automation.includes("automation.morning_lights"));
  const done = await call("manage_registry", { ...rename, confirm: true, dry_run: false }, adm);
  assert.equal(done.data.status, "updated", done.raw);
  const back = await call("restore_backup", { backup_id: done.data.rollback_receipt.backup_id, confirm: true, dry_run: false }, adm);
  assert.equal(back.isError, true);
  const undo = await call("manage_registry", { registry: "entity", action: "update", id: "light.kitchen_main", fields: { new_entity_id: "light.kitchen" }, confirm: true, dry_run: false }, adm);
  assert.equal(undo.data.status, "updated", undo.raw);
});
await t("devices can be updated but not deleted", async () => {
  const del = await call("manage_registry", { registry: "device", action: "delete", id: "dev_lamp" }, adm);
  assert.equal(del.isError, true);
  assert.match(del.raw, /cannot be/);
  const upd = await call("manage_registry", { registry: "device", action: "update", id: "dev_lamp", fields: { name_by_user: "Desk lamp" } }, adm);
  assert.equal(upd.data.status, "updated", upd.raw);
});

await t("scenes: get_scene flags locks and activating a lock scene is high risk", async () => {
  const sc = await call("get_scene", { scene_id: "scene.movie_night" }, adm);
  assert.ok(sc.data.high_risk_entities.some((r) => /lock/.test(r)));
  const act = await call("call_service", { domain: "scene", service: "turn_on", entity_id: "scene.movie_night" }, adm);
  assert.equal(act.data.risk, "high");
  assert.match(act.data.why_high_risk.join(" "), /lock\.front_door/);
  assert.equal(act.data.executed, false);
  const apply = await call("call_service", { domain: "scene", service: "apply", data: { entities: { "lock.front_door": "unlocked" } } }, adm);
  assert.equal(apply.data.risk, "high");
  const safe = await call("call_service", { domain: "scene", service: "apply", data: { entities: { "light.kitchen": "on" } } }, adm);
  assert.equal(safe.data.executed, true, safe.raw);
});
await t("scenes: low risk create, gated overwrite, gated lock scene, gated delete, restore", async () => {
  const bad = await call("save_scene", { config: { name: "Empty", entities: {} } }, adm);
  assert.equal(bad.data.status, "invalid");
  const created = await call("save_scene", { config: { name: "Cosy", entities: { "light.kitchen": { state: "on" } } } }, adm);
  assert.equal(created.data.status, "saved", created.raw);
  const id = created.data.id;
  assert.ok(mock.scenes.has(id));
  const changed = { name: "Cosy", entities: { "light.kitchen": { state: "on", brightness: 50 } } };
  assert.equal((await call("save_scene", { scene_id: id, config: changed }, adm)).data.status, "confirmation_required");
  const over = await call("save_scene", { scene_id: id, config: changed, confirm: true, dry_run: false }, adm);
  assert.equal(over.data.status, "saved", over.raw);
  assert.equal(mock.scenes.get(id).entities["light.kitchen"].brightness, 50);
  const lockScene = await call("save_scene", { config: { name: "Unlock", entities: { "lock.front_door": { state: "unlocked" } } } }, adm);
  assert.equal(lockScene.data.status, "confirmation_required");
  assert.equal(mock.scenes.size, 2);
  const del = await call("delete_scene", { scene_id: id, confirm: true, dry_run: false }, adm);
  assert.equal(del.data.status, "deleted", del.raw);
  assert.ok(!mock.scenes.has(id));
  const back = await call("restore_backup", { backup_id: del.data.rollback_receipt.backup_id, confirm: true, dry_run: false }, adm);
  assert.equal(back.data.status, "restored", back.raw);
  assert.ok(mock.scenes.has(id));
});

await t("blueprints: list, gated import with source preview, duplicate and invalid handling, gated delete", async () => {
  const list = await call("list_blueprints", {}, adm);
  assert.equal(list.data[0].name, "Motion-activated Light");
  assert.ok(list.data[0].inputs.some((i) => i.name === "motion_entity" && i.required));
  const url = "https://example.com/ok.yaml";
  const preview = await call("import_blueprint", { url }, adm);
  assert.equal(preview.data.status, "confirmation_required");
  assert.match(preview.data.plan.source_yaml_start, /blueprint:/);
  assert.ok(!mock.blueprints.automation["someone/new_bp.yaml"]);
  const done = await call("import_blueprint", { url, confirm: true, dry_run: false }, adm);
  assert.equal(done.data.status, "installed", done.raw);
  assert.ok(mock.blueprints.automation["someone/new_bp.yaml"]);
  assert.equal((await call("import_blueprint", { url }, adm)).data.status, "already_installed");
  assert.equal((await call("import_blueprint", { url: "https://example.com/bad.yaml" }, adm)).data.status, "invalid");
  const risky = await call("import_blueprint", { url: "https://example.com/lock.yaml" }, adm);
  assert.match(risky.data.why_high_risk.join(" "), /high risk services/);
  const delPreview = await call("delete_blueprint", { domain: "automation", path: "someone/new_bp.yaml" }, adm);
  assert.equal(delPreview.data.executed, false);
  const del = await call("delete_blueprint", { domain: "automation", path: "someone/new_bp.yaml", confirm: true, dry_run: false }, adm);
  assert.equal(del.data.status, "deleted");
  assert.ok(!mock.blueprints.automation["someone/new_bp.yaml"]);
});

await t("integrations: list problems, low risk reload, rename and enable, gated disable and remove", async () => {
  const bad = await call("list_integrations", { problems_only: true }, adm);
  assert.equal(bad.data.entries.length, 1);
  assert.equal(bad.data.entries[0].reason, "Radio not found");
  const ops = () => mock.entryOps.map((o) => o.op);
  assert.equal((await call("manage_config_entry", { entry_id: "e_mqtt", action: "reload" }, adm)).data.executed, true);
  assert.ok(ops().includes("reload"));
  await call("manage_config_entry", { entry_id: "e_mqtt", action: "rename", title: "Broker" }, adm);
  assert.ok(ops().includes("rename"));
  const preview = await call("manage_config_entry", { entry_id: "e_mqtt", action: "disable" }, adm);
  assert.equal(preview.data.status, "confirmation_required");
  assert.ok(!ops().includes("disable"));
  assert.equal((await call("manage_config_entry", { entry_id: "e_mqtt", action: "disable", confirm: true, dry_run: false }, adm)).data.executed, true);
  assert.ok(ops().includes("disable"));
  assert.equal((await call("manage_config_entry", { entry_id: "e_mqtt", action: "enable" }, adm)).data.executed, true);
  assert.ok(ops().includes("enable"));
  assert.equal((await call("manage_config_entry", { entry_id: "e_zha", action: "remove" }, adm)).data.executed, false);
  assert.ok(!ops().includes("remove"));
  assert.equal((await call("manage_config_entry", { entry_id: "e_zha", action: "remove", confirm: true, dry_run: false }, adm)).data.executed, true);
  assert.ok(ops().includes("remove"));
});
await t("config flows: helper flows run freely, integration and options flows are gated", async () => {
  const submits = () => mock.entryOps.filter((o) => o.op === "flow_submit");
  const start = await call("run_config_flow", { action: "start", handler: "template" }, adm);
  assert.equal(start.data.type, "form");
  const fin = await call("run_config_flow", { action: "submit", flow_id: start.data.flow_id, user_input: { name: "My helper" } }, adm);
  assert.equal(fin.data.type, "create_entry", fin.raw);
  assert.equal(submits().length, 1);
  const mq = await call("run_config_flow", { action: "start", handler: "mqtt" }, adm);
  const gated = await call("run_config_flow", { action: "submit", flow_id: mq.data.flow_id, user_input: { name: "x" } }, adm);
  assert.equal(gated.data.status, "confirmation_required");
  assert.equal(submits().length, 1);
  const go = await call("run_config_flow", { action: "submit", flow_id: mq.data.flow_id, user_input: { name: "x" }, confirm: true, dry_run: false }, adm);
  assert.equal(go.data.type, "create_entry", go.raw);
  const opt = await call("run_config_flow", { action: "start", flow_type: "options", handler: "e_mqtt" }, adm);
  const optGate = await call("run_config_flow", { action: "submit", flow_type: "options", flow_id: opt.data.flow_id, user_input: { name: "y" } }, adm);
  assert.equal(optGate.data.status, "confirmation_required");
  const cancel = await call("run_config_flow", { action: "cancel", flow_type: "options", flow_id: opt.data.flow_id }, adm);
  assert.equal(cancel.data.status, "cancelled");
});
await t("repairs: list hides ignored issues, ignore works", async () => {
  const r = await call("list_repairs", {}, adm);
  assert.equal(r.data.total, 1);
  assert.equal((await call("ignore_repair", { domain: "zha", issue_id: "i1" }, adm)).data.status, "ignored");
});
await adm.close();

const admNt = await connect({ HA_NEVER_TOUCH: "light.kitchen, lock.*" });
await t("never-touch covers registry changes and scenes", async () => {
  const r = await call("manage_registry", { registry: "entity", action: "update", id: "light.kitchen", fields: { name: "Nope" } }, admNt);
  assert.equal(r.data.status, "blocked_never_touch");
  const sc = await call("save_scene", { config: { name: "Nope", entities: { "lock.front_door": { state: "locked" } } } }, admNt);
  assert.equal(sc.data.status, "blocked_never_touch");
});
await admNt.close();

console.log("Plan tokens, approval prompts, never-touch list, redaction and audit");
const guard = await connect();
const reset = () => { mock.states.get("lock.front_door").state = "locked"; };
const unlock = { domain: "lock", service: "unlock", entity_id: "lock.front_door" };

await t("executing without a plan token is refused and a fresh token is issued", async () => {
  reset();
  const r = await rawCall(guard, "call_service", { ...unlock, confirm: true, dry_run: false });
  assert.equal(r.isError, true);
  assert.equal(r.data.status, "plan_token_required");
  assert.ok(r.data.plan_token);
  assert.equal(mock.states.get("lock.front_door").state, "locked");
});
await t("a token from one request cannot be used for different arguments", async () => {
  reset();
  const preview = await rawCall(guard, "call_service", { ...unlock });
  const swapped = await rawCall(guard, "call_service", { domain: "lock", service: "unlock", entity_id: "lock.front_door", data: { code: "1" }, confirm: true, dry_run: false, plan_token: preview.data.plan_token });
  assert.equal(swapped.data.status, "plan_token_required");
  assert.match(swapped.data.message, /does not match/);
  assert.equal(mock.states.get("lock.front_door").state, "locked");
});
await t("a token works once and cannot be replayed", async () => {
  reset();
  const preview = await rawCall(guard, "call_service", { ...unlock });
  const args = { ...unlock, confirm: true, dry_run: false, plan_token: preview.data.plan_token };
  const first = await rawCall(guard, "call_service", args);
  assert.equal(first.data.executed, true);
  reset();
  const second = await rawCall(guard, "call_service", args);
  assert.equal(second.data.status, "plan_token_required");
  assert.match(second.data.message, /already used/);
  assert.equal(mock.states.get("lock.front_door").state, "locked");
});
await t("a made up token is rejected", async () => {
  const r = await rawCall(guard, "call_service", { ...unlock, confirm: true, dry_run: false, plan_token: "zzzz.not-real" });
  assert.equal(r.data.status, "plan_token_required");
});
await guard.close();

let askedWith;
const yes = await connect({}, { capabilities: { elicitation: {} }, onElicit: async (req) => { askedWith = req.params.message; return { action: "accept", content: { approve: true } }; } });
await t("a client that supports elicitation shows the user a prompt, and approval executes", async () => {
  reset();
  const r = await call("call_service", { ...unlock, confirm: true, dry_run: false }, yes);
  assert.equal(r.data.executed, true, r.raw);
  assert.match(askedWith, /lock\.front_door/);
});
await yes.close();

const no = await connect({}, { capabilities: { elicitation: {} }, onElicit: async () => ({ action: "decline" }) });
await t("declining the prompt stops the action even with a valid token", async () => {
  reset();
  const r = await call("call_service", { ...unlock, confirm: true, dry_run: false }, no);
  assert.equal(r.data.status, "declined_by_user");
  assert.equal(mock.states.get("lock.front_door").state, "locked");
});
await no.close();

const strict = await connect({ HA_REQUIRE_APPROVAL_PROMPT: "true" });
await t("require approval prompt refuses clients that cannot show one", async () => {
  reset();
  const r = await call("call_service", { ...unlock, confirm: true, dry_run: false }, strict);
  assert.equal(r.data.status, "approval_prompt_unavailable");
  assert.equal(mock.states.get("lock.front_door").state, "locked");
});
await strict.close();

const nt = await connect({ HA_NEVER_TOUCH: "light.kitchen, switch.desk_*" });
await t("never-touch entities cannot be changed or referenced by saved automations", async () => {
  const a = await call("call_service", { domain: "light", service: "turn_on", entity_id: "light.kitchen" }, nt);
  assert.equal(a.data.status, "blocked_never_touch");
  const b = await call("call_service", { domain: "switch", service: "turn_on", entity_id: "switch.desk_fan_plug" }, nt);
  assert.equal(b.data.status, "blocked_never_touch");
  const c = await call("save_automation", { config: { alias: "x", triggers: [{ trigger: "time", at: "01:00:00" }], actions: [{ action: "light.turn_on", target: { entity_id: "light.kitchen" } }] } }, nt);
  assert.equal(c.data.status, "blocked_never_touch");
  const d = await call("call_service", { domain: "light", service: "turn_on", entity_id: "light.office_lamp" }, nt);
  assert.equal(d.data.executed, true);
});
await nt.close();

const rd = await connect();
await t("credentials are redacted from entity details", async () => {
  mock.add("camera.front", "idle", { friendly_name: "Front", access_token: "abcdef1234567890", entity_picture: "/api/camera_proxy/camera.front?token=abcdef1234567890&access_token=abcdef1234567890" });
  const r = await call("get_entity_details", { entity_id: "camera.front" }, rd);
  assert.ok(!r.raw.includes("abcdef1234567890"), r.raw);
  assert.match(r.raw, /REDACTED/);
});
await t("the access token itself never appears in any output", async () => {
  mock.add("sensor.leaky", "x", { friendly_name: `leak ${TOKEN}` });
  const r = await call("get_entity_details", { entity_id: "sensor.leaky" }, rd);
  assert.ok(!r.raw.includes(TOKEN), r.raw);
});
await t("the audit log records executed changes and previews without leaking plan tokens", async () => {
  const r = await call("get_audit_log", { limit: 100 }, rd);
  const executed = r.data.entries.filter((e) => e.executed === true && e.tool === "call_service");
  assert.ok(executed.length > 0, "executed call_service entries expected");
  assert.ok(r.data.entries.some((e) => e.status === "plan_token_required"));
  const onlyExecuted = await call("get_audit_log", { executed_only: true, limit: 100 }, rd);
  assert.ok(onlyExecuted.data.entries.every((e) => e.executed === true));
  const file = fs.readFileSync(auditFile, "utf8");
  assert.ok(!/"plan_token"\s*:/.test(file), "plan tokens must not be stored in the audit log");
  assert.ok(!/[0-9a-z]{6,}\.[A-Za-z0-9_-]{32}/.test(file), "no token shaped values in the audit log");
  assert.ok(!file.includes(TOKEN));
});
await rd.close();

console.log("Insights, toolsets and Supervisor");
const ins = await connect({ HA_ALLOW_CONTROL: "", HA_ALLOW_EDIT: "", HA_IGNORE_UNAVAILABLE: "light.hall*" });
const insNames = (await ins.listTools()).tools.map((x) => x.name);
await t("insight tools are available in read only mode", () => {
  for (const n of ["get_home_overview", "find_problems", "explain_state_change", "get_statistics", "get_calendar_events", "get_todo_items", "get_forecast", "get_camera_snapshot", "wait_for_state", "get_system_log"]) assert.ok(insNames.includes(n), n);
});
await t("supervisor tools are off by default", () => {
  assert.ok(!insNames.includes("list_addons") && !insNames.includes("manage_addon"));
});
await t("statistics list and fetch", async () => {
  const l = await call("get_statistics", {}, ins);
  assert.equal(l.data.items[0].statistic_id, "sensor.energy_total");
  const r = await call("get_statistics", { statistic_ids: ["sensor.energy_total"] }, ins);
  assert.equal(r.data["sensor.energy_total"].periods, 2);
  assert.equal(r.data["sensor.energy_total"].summary.total_change, 3);
  assert.match(r.data["sensor.energy_total"].points[0].start, /^20\d\d-/);
});
await t("calendar, todo and forecast", async () => {
  assert.equal((await call("get_calendar_events", {}, ins)).data[0].entity_id, "calendar.family");
  assert.equal((await call("get_calendar_events", { entity_id: "calendar.family" }, ins)).data.events[0].summary, "Dentist");
  assert.equal((await call("get_todo_items", { entity_id: "todo.shopping" }, ins)).data.items[0].summary, "Milk");
  assert.equal((await call("get_forecast", { entity_id: "weather.home" }, ins)).data.forecast.length, 2);
});
await t("camera snapshot returns an image", async () => {
  mock.add("camera.drive", "idle", { friendly_name: "Drive" });
  const res = await ins.callTool({ name: "get_camera_snapshot", arguments: { entity_id: "camera.drive" } });
  assert.equal(res.content[0].type, "image");
  assert.equal(res.content[0].mimeType, "image/png");
  const bad = await call("get_camera_snapshot", { entity_id: "light.kitchen" }, ins);
  assert.ok(bad.isError);
});
await t("wait_for_state matches immediately and times out", async () => {
  mock.add("switch.waiter", "on", { friendly_name: "Waiter" });
  const a = await call("wait_for_state", { entity_id: "switch.waiter", state: "on" }, ins);
  assert.equal(a.data.matched, true);
  const b = await call("wait_for_state", { entity_id: "switch.waiter", state: "off", timeout_s: 1 }, ins);
  assert.equal(b.data.matched, false);
});
await t("system log is filtered and structured", async () => {
  const r = await call("get_system_log", { level: "ERROR" }, ins);
  assert.equal(r.data.total, 1);
  assert.equal(r.data.entries[0].count, 3);
});
await t("explain_state_change attributes causes", async () => {
  const r = await call("explain_state_change", { entity_id: "light.kitchen" }, ins);
  assert.ok(r.data.changes.some((c) => c.caused_by.includes("Morning lights") && c.follow_up.includes("automation.morning_lights")));
  assert.match(JSON.stringify(r.data.changes), /call to light\.turn_on/);
});
await t("home overview and find_problems honour ignore patterns", async () => {
  mock.add("light.hall_lamp", "unavailable", { friendly_name: "Hall lamp" });
  mock.add("light.porch", "unavailable", { friendly_name: "Porch" });
  mock.add("sensor.phone_battery", "9", { friendly_name: "Phone", device_class: "battery", unit_of_measurement: "%" });
  const o = await call("get_home_overview", {}, ins);
  assert.ok(o.data.entities.total > 5);
  const un = JSON.stringify(o.data.unavailable.examples);
  assert.ok(un.includes("light.porch") && !un.includes("light.hall_lamp"), un);
  assert.equal(o.data.low_batteries[0].percent, 9);
  const f = await call("find_problems", { check_references: true }, ins);
  const fu = JSON.stringify(f.data.unavailable_entities);
  assert.ok(fu.includes("light.porch") && !fu.includes("light.hall_lamp"), fu);
  assert.ok(f.data.open_repairs.count >= 1);
  assert.ok(f.data.checked_items >= 1);
  assert.ok(!JSON.stringify(f.data.integration_problems).includes("e_ign"), "ignored config entries are not problems");
  assert.ok(JSON.stringify(f.data.integration_problems).includes("e_zha"));
});
await ins.close();

await t("toolset switches remove whole groups", async () => {
  const c = await connect({ HA_ENABLE_CONFIG: "false", HA_ENABLE_INSIGHTS: "false", HA_ENABLE_RAW: "false" });
  const n = (await c.listTools()).tools.map((x) => x.name);
  await c.close();
  assert.ok(n.includes("call_service") && n.includes("search_entities"));
  for (const g of ["list_dashboards", "manage_registry", "list_blueprints", "list_integrations", "get_home_overview", "ha_ws_read"]) assert.ok(!n.includes(g), g);
});
await t("supervisor toolset: reads work, writes need a plan token, read only hides writes", async () => {
  const ro = await connect({ HA_ENABLE_SUPERVISOR: "true", HA_ALLOW_CONTROL: "", HA_ALLOW_EDIT: "" });
  const rn = (await ro.listTools()).tools.map((x) => x.name);
  assert.ok(rn.includes("list_addons") && rn.includes("get_addon_logs") && rn.includes("get_supervisor_info"));
  assert.ok(!rn.includes("manage_addon") && !rn.includes("create_ha_backup"));
  assert.equal((await call("list_addons", {}, ro)).data[0].slug, "core_mosquitto");
  assert.equal((await call("get_supervisor_info", {}, ro)).data.core.update_available, true);
  assert.match((await call("get_addon_logs", { slug: "core_mosquitto", filter: "error" }, ro)).data.log, /ERROR something/);
  assert.equal((await call("list_ha_backups", {}, ro)).data[0].slug, "b1");
  await ro.close();
  const rw = await connect({ HA_ENABLE_SUPERVISOR: "true" });
  const before = mock.entryOps.length;
  const prev = await call("manage_addon", { slug: "core_mosquitto", action: "restart" }, rw);
  assert.equal(prev.data.executed, false);
  assert.equal(mock.entryOps.length, before);
  const bare = await call("manage_addon", { slug: "core_mosquitto", action: "restart", confirm: true, dry_run: false, plan_token: "bogus" }, rw);
  assert.equal(mock.entryOps.length, before);
  assert.notEqual(bare.data.executed, true);
  const done = await call("manage_addon", { slug: "core_mosquitto", action: "restart", confirm: true, dry_run: false }, rw);
  assert.equal(done.data.executed, true, done.raw);
  assert.equal(mock.entryOps.at(-1).op, "addon_restart");
  const start = await call("manage_addon", { slug: "core_mosquitto", action: "start" }, rw);
  assert.equal(start.data.executed, true, start.raw);
  await rw.close();
});
await t("supervisor tools explain themselves when no Supervisor exists", async () => {
  mock.supervisor = false;
  const c = await connect({ HA_ENABLE_SUPERVISOR: "true", HA_ALLOW_CONTROL: "", HA_ALLOW_EDIT: "" });
  const r = await call("list_addons", {}, c);
  mock.supervisor = true;
  await c.close();
  assert.ok(r.isError);
  assert.match(r.raw, /Supervisor is not available/);
});

await t("raw API tools are off unless switched on", async () => {
  // An empty value counts as "not set", so this exercises the real default.
  const c = await connect({ HA_ENABLE_RAW: "" });
  const n = (await c.listTools()).tools.map((x) => x.name);
  await c.close();
  for (const r of ["ha_ws_read", "ha_ws_write", "ha_rest_read", "ha_rest_write"]) assert.ok(!n.includes(r), `${r} must be off by default`);
  assert.ok(n.includes("call_service") && n.includes("save_automation"));
});

await t("server instructions only mention the raw tools when they are switched on", async () => {
  const off = await connect({ HA_ENABLE_RAW: "" });
  const offText = off.getInstructions() ?? "";
  await off.close();
  assert.ok(!/ha_ws_read|ha_rest_write/.test(offText), "instructions must not mention raw tools when they are off");
  const on = await connect({ HA_ENABLE_RAW: "true" });
  const onText = on.getInstructions() ?? "";
  await on.close();
  assert.match(onText, /ha_ws_write/);
  const roOn = await connect({ HA_ENABLE_RAW: "true", HA_ALLOW_CONTROL: "", HA_ALLOW_EDIT: "" });
  const roText = roOn.getInstructions() ?? "";
  await roOn.close();
  assert.ok(/ha_ws_read/.test(roText) && !/ha_ws_write/.test(roText));
});

console.log("Safe by default");
await t("with nothing set, the server starts read only, with raw tools off and approval prompts required", async () => {
  // An empty value counts as "not set", so this exercises the real defaults.
  const unset = { HA_ALLOW_CONTROL: "", HA_ALLOW_EDIT: "", HA_REQUIRE_APPROVAL_PROMPT: "", HA_ENABLE_RAW: "" };
  const c = await connect(unset);
  const names = (await c.listTools()).tools.map((x) => x.name);
  const text = c.getInstructions() ?? "";
  await c.close();
  assert.ok(!names.includes("call_service") && !names.includes("save_automation"), "default must be read only");
  assert.ok(!names.includes("ha_ws_read"), "raw tools off by default");
  assert.equal(names.length, 42);
  assert.match(text, /Read only mode is ON/);
  assert.match(text, /approval prompt/);
});
await t("each access level gives the right tools", async () => {
  const unset = { HA_REQUIRE_APPROVAL_PROMPT: "", HA_ENABLE_RAW: "" };
  const b = await connect({ ...unset, HA_ALLOW_CONTROL: "true", HA_ALLOW_EDIT: "" });
  const bn = (await b.listTools()).tools.map((x) => x.name);
  await b.close();
  assert.ok(bn.includes("call_service") && !bn.includes("save_automation"));
  assert.equal(bn.length, 43);
  const c = await connect({ ...unset, HA_ALLOW_CONTROL: "true", HA_ALLOW_EDIT: "true" });
  const cn = (await c.listTools()).tools.map((x) => x.name);
  await c.close();
  assert.ok(cn.includes("save_automation") && cn.includes("restart_home_assistant"));
  assert.equal(cn.length, 68);
});
await t("the two boxes are independent, and each one adds its own ability", async () => {
  const tools = async (env) => {
    const c = await connect({ HA_ENABLE_RAW: "", HA_REQUIRE_APPROVAL_PROMPT: "", ...env });
    const names = (await c.listTools()).tools.map((x) => x.name);
    await c.close();
    return names;
  };
  const none = await tools({ HA_ALLOW_CONTROL: "", HA_ALLOW_EDIT: "" });
  assert.equal(none.length, 42);
  assert.equal((await tools({ HA_ALLOW_CONTROL: "false", HA_ALLOW_EDIT: "false" })).length, 42);
  const control = await tools({ HA_ALLOW_CONTROL: "true", HA_ALLOW_EDIT: "" });
  assert.equal(control.length, 43);
  assert.ok(control.includes("call_service") && !control.includes("save_automation"));
  const edit = await tools({ HA_ALLOW_CONTROL: "", HA_ALLOW_EDIT: "true" });
  assert.equal(edit.length, 67, "full minus call_service");
  assert.ok(edit.includes("save_automation") && edit.includes("restart_home_assistant"));
  assert.ok(!edit.includes("call_service"), "editing alone cannot operate devices");
  const full = await tools({ HA_ALLOW_CONTROL: "true", HA_ALLOW_EDIT: "true" });
  assert.equal(full.length, 68);
});
await t("the raw write tools need both boxes, so editing alone cannot use them to operate devices", async () => {
  const names = async (env) => {
    const c = await connect({ HA_ENABLE_RAW: "true", HA_REQUIRE_APPROVAL_PROMPT: "", ...env });
    const n = (await c.listTools()).tools.map((x) => x.name);
    await c.close();
    return n;
  };
  const edit = await names({ HA_ALLOW_CONTROL: "", HA_ALLOW_EDIT: "true" });
  assert.ok(edit.includes("ha_rest_read") && !edit.includes("ha_rest_write") && !edit.includes("ha_ws_write"));
  assert.equal(edit.length, 69);
  const full = await names({ HA_ALLOW_CONTROL: "true", HA_ALLOW_EDIT: "true" });
  assert.ok(full.includes("ha_rest_write") && full.includes("ha_ws_write"));
  assert.equal(full.length, 72);
});
await t("edit only mode explains itself and how to add device control", async () => {
  const c = await connect({ HA_ALLOW_CONTROL: "", HA_ALLOW_EDIT: "true", HA_ENABLE_RAW: "" });
  const text = c.getInstructions() ?? "";
  await c.close();
  assert.match(text, /Edit only mode is ON/);
  assert.match(text, /HA_ALLOW_CONTROL/);
});
await t("with the approval prompt on by default, a client that cannot prompt is refused and told how to change it", async () => {
  const c = await connect({ HA_ALLOW_CONTROL: "true", HA_ALLOW_EDIT: "true", HA_REQUIRE_APPROVAL_PROMPT: "" });
  const r = await call("restart_home_assistant", { confirm: true, dry_run: false }, c);
  await c.close();
  assert.equal(r.data.status, "approval_prompt_unavailable", r.raw);
  assert.match(r.data.message, /Require an approval prompt/);
  assert.match(r.data.message, /HA_REQUIRE_APPROVAL_PROMPT/);
});

console.log("Telling the user which setting to change");
await t("the briefing explains what is off and how to turn it on, for each mode", async () => {
  const ro = await connect({ HA_ALLOW_CONTROL: "", HA_ALLOW_EDIT: "", HA_ENABLE_RAW: "" });
  const roText = ro.getInstructions() ?? "";
  await ro.close();
  assert.match(roText, /Read only mode is ON/);
  assert.match(roText, /HA_ALLOW_CONTROL/);
  assert.match(roText, /HA_ALLOW_EDIT/);
  assert.match(roText, /HA_ENABLE_RAW/, "off by default, so the briefing says how to turn raw on");
  assert.match(roText, /cannot change settings yourself/);
  const co = await connect({ HA_ALLOW_CONTROL: "true", HA_ALLOW_EDIT: "", HA_NEVER_TOUCH: "lock.*" });
  const coText = co.getInstructions() ?? "";
  await co.close();
  assert.match(coText, /Control only mode is ON/);
  assert.match(coText, /HA_ALLOW_EDIT/);
  assert.match(coText, /lock\.\*/);
  assert.match(coText, /Never touch entities/);
  // Fully open: nothing restrictive to say, so no settings briefing at all.
  const full = await connect({ HA_ENABLE_RAW: "true", HA_ENABLE_SUPERVISOR: "true" });
  const fullText = full.getInstructions() ?? "";
  await full.close();
  assert.ok(!/Current settings/.test(fullText), "no briefing when nothing is restricted");
  const noCfg = await connect({ HA_ENABLE_CONFIG: "false" });
  const noCfgText = noCfg.getInstructions() ?? "";
  await noCfg.close();
  assert.match(noCfgText, /HA_ENABLE_CONFIG/);
});
await t("refusals say what setting to change", async () => {
  const co = await connect({ HA_ALLOW_CONTROL: "true", HA_ALLOW_EDIT: "", HA_NEVER_TOUCH: "light.kitchen" });
  const blocked = await call("call_service", { domain: "lock", service: "unlock", entity_id: "lock.front_door" }, co);
  assert.equal(blocked.data.status, "blocked_control_only");
  assert.match(blocked.data.message, /control only mode/);
  assert.match(blocked.data.message, /HA_ALLOW_EDIT/);
  assert.match(blocked.data.message, /backup/);
  assert.match(blocked.data.message, /cannot change this setting yourself/);
  const nt = await call("call_service", { domain: "light", service: "turn_on", entity_id: "light.kitchen" }, co);
  assert.equal(nt.data.status, "blocked_never_touch");
  assert.match(nt.data.message, /Never touch entities/);
  assert.match(nt.data.message, /HA_NEVER_TOUCH/);
  await co.close();
});

console.log("Control only mode");
const co = await connect({ HA_ALLOW_CONTROL: "true", HA_ALLOW_EDIT: "" });
await t("control only registers the read tools plus call_service and nothing else that writes", async () => {
  const { tools } = await co.listTools();
  const names = tools.map((x) => x.name);
  assert.ok(names.includes("call_service") && names.includes("search_entities") && names.includes("get_audit_log"));
  for (const n of ["save_automation", "delete_automation", "save_script", "reload_automations", "create_helper", "update_helper", "ha_ws_write", "ha_rest_write", "manage_registry", "save_dashboard", "save_scene", "import_blueprint", "manage_config_entry", "restart_home_assistant", "stop_home_assistant", "restore_backup"]) {
    assert.ok(!names.includes(n), `${n} must not be registered in control only mode`);
  }
  // Every registered tool except call_service must be a read tool.
  assert.ok(tools.filter((x) => x.name !== "call_service").every((x) => x.annotations.readOnlyHint === true));
});
await t("control only still switches a light on and off", async () => {
  const before = mock.serviceCalls.length;
  const r = await call("call_service", { domain: "light", service: "turn_on", entity_id: "light.kitchen" }, co);
  assert.equal(r.data.executed, true, r.raw);
  assert.equal(mock.serviceCalls.length, before + 1);
  const h = await call("call_service", { domain: "homeassistant", service: "turn_off", entity_id: "light.kitchen" }, co);
  assert.equal(h.data.executed, true, h.raw);
});
await t("control only refuses anything that is not everyday device control", async () => {
  const before = mock.serviceCalls.length;
  const cases = [
    { domain: "automation", service: "trigger", entity_id: "automation.morning_lights" },
    { domain: "script", service: "turn_on", entity_id: "script.harmless" },
    { domain: "lock", service: "unlock", entity_id: "lock.front_door" },
    { domain: "climate", service: "set_temperature", entity_id: "climate.upper_hall", data: { temperature: 20 } },
    { domain: "homeassistant", service: "restart" },
    { domain: "homeassistant", service: "turn_off", entity_id: "automation.morning_lights" },
    { domain: "homeassistant", service: "turn_off", target: { area_id: "kitchen" } },
    { domain: "scene", service: "apply" },
    { domain: "scene", service: "reload" },
    { domain: "light", service: "turn_off", entity_id: "automation.morning_lights" },
    { domain: "light", service: "turn_off", target: { label_id: "everything" } },
  ];
  for (const c of cases) {
    const r = await call("call_service", c, co);
    assert.equal(r.data.status, "blocked_control_only", `${c.domain}.${c.service} should be blocked: ${r.raw}`);
    assert.equal(r.isError, true);
  }
  assert.equal(mock.serviceCalls.length, before, "no blocked call may reach Home Assistant");
});
await t("control only keeps the normal approval step for risky but allowed calls", async () => {
  const before = mock.serviceCalls.length;
  const r = await call("call_service", { domain: "switch", service: "turn_on", entity_id: "switch.washing_machine" }, co);
  assert.equal(r.data.executed, false, r.raw);
  assert.ok(r.data.plan_token);
  assert.equal(mock.serviceCalls.length, before);
});
await t("control only mentions itself in the server instructions", async () => {
  const text = co.getInstructions?.() ?? "";
  assert.match(text, /Control only mode is ON/);
});
await co.close();
await mock.close();
fs.rmSync(backupDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`Failed: ${failures.join(", ")}`);
  process.exit(1);
}
