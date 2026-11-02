// A small in-memory imitation of the Home Assistant REST and WebSocket APIs, used by the smoke test.
// This is a pretend Home Assistant, built so the tests never touch a real house. It
// imitates just enough of the REST API (over HTTP) and the WebSocket API to exercise
// every tool: entities, areas, automations, dashboards, registries, scenes,
// blueprints, config entries, repairs, statistics and (optionally) a Supervisor.
//
// It keeps everything in memory and records what was done to it (service calls,
// websocket writes, events) so tests can check that a risky action really did NOT
// happen when it should have been blocked.
import http from "node:http";
import { WebSocketServer } from "ws";

// The fake access token the mock accepts. Anything else gets a 401, which lets us test authentication failures.
export const TOKEN = "test-token";

// Builds a state object shaped like the ones Home Assistant returns.
function mkState(entity_id, state, attributes = {}) {
  const now = new Date().toISOString();
  return { entity_id, state, attributes, last_changed: now, last_updated: now, context: {} };
}

// Starts the mock on a random free port and returns handles the tests use to inspect and change it.
export async function startMock() {
  const m = {
    states: new Map(),
    automations: new Map(),
    scripts: new Map(),
    helpers: { input_boolean: [{ id: "guest_mode", name: "Guest mode" }] },
    serviceCalls: [],
    checkConfigValid: true,
    supervisor: true,
    invalidAfterNextWrite: false,
    wsCommands: [],
    wsConnections: 0,
    wsWrites: [],
    scenes: new Map(),
    lovelace: {},
    dashboards: [],
    blueprints: {},
    entries: [],
    entryOps: [],
    flows: new Map(),
    events: [],
  };
  const add = (id, state, attrs) => m.states.set(id, mkState(id, state, attrs));
  add("light.office_lamp", "on", { friendly_name: "Office Desk Lamp" });
  add("light.kitchen", "off", { friendly_name: "Kitchen Light" });
  add("lock.front_door", "locked", { friendly_name: "Front Door" });
  add("cover.garage_door", "closed", { friendly_name: "Garage Door", device_class: "garage", supported_features: 3 });
  add("cover.office_blind", "open", { friendly_name: "Office Blind", device_class: "blind" });
  add("climate.living_room", "heat", { friendly_name: "Living Room Thermostat", supported_features: 385 });
  add("switch.washing_machine", "off", { friendly_name: "Washing Machine" });
  add("switch.desk_fan_plug", "off", { friendly_name: "Desk Fan Plug" });
  add("sensor.kitchen_temperature", "21.5", { friendly_name: "Kitchen Temperature", unit_of_measurement: "C", device_class: "temperature" });
  add("automation.morning_lights", "on", { friendly_name: "Morning lights", id: "1001", last_triggered: null, mode: "single", current: 0 });
  add("script.goodnight", "off", { friendly_name: "Goodnight", last_triggered: null, mode: "single", current: 0 });
  add("script.harmless", "off", { friendly_name: "Harmless", mode: "single", current: 0 });
  add("scene.movie_night", "unknown", { friendly_name: "Movie night", id: "s1" });
  m.scenes.set("s1", { name: "Movie night", entities: { "light.kitchen": { state: "off" }, "lock.front_door": { state: "unlocked" } } });
  m.lovelace.default = { views: [{ title: "Home", path: "home", cards: [{ type: "entities", entities: ["light.kitchen"] }] }] };
  m.dashboards.push({ id: "dash1", url_path: "house-overview", title: "House", mode: "storage", show_in_sidebar: true, require_admin: false });
  m.lovelace["house-overview"] = { views: [{ title: "Ground", path: "ground", cards: [] }] };
  m.blueprints.automation = { "homeassistant/motion_light.yaml": { metadata: { name: "Motion-activated Light", domain: "automation", author: "Home Assistant", input: { motion_entity: {}, light_target: {}, no_motion_wait: { default: 120 } }, source_url: "https://example.com/bp.yaml" } } };
  m.blueprints.script = {};
  m.entries.push(
    { entry_id: "e_mqtt", domain: "mqtt", title: "MQTT", state: "loaded", source: "user", supports_options: true, disabled_by: null },
    { entry_id: "e_zha", domain: "zha", title: "Zigbee", state: "setup_error", reason: "Radio not found", source: "user", disabled_by: null },
    { entry_id: "e_ign", domain: "samsungtv", title: "Old TV", state: "not_loaded", source: "ignore", disabled_by: null }
  );
  add("input_boolean.guest_mode", "off", { friendly_name: "Guest mode" });

  m.automations.set("1001", {
    id: "1001",
    alias: "Morning lights",
    description: "",
    triggers: [{ trigger: "time", at: "07:00:00" }],
    conditions: [],
    actions: [{ action: "light.turn_on", target: { entity_id: "light.kitchen" } }],
    mode: "single",
  });
  m.scripts.set("goodnight", {
    alias: "Goodnight",
    sequence: [{ action: "lock.lock", target: { entity_id: "lock.front_door" } }, { action: "light.turn_off", target: { entity_id: "light.office_lamp" } }],
  });
  m.scripts.set("harmless", { alias: "Harmless", sequence: [{ action: "light.turn_off", target: { entity_id: "light.kitchen" } }] });

  const areas = [
    { area_id: "living_room", name: "Living Room" },
    { area_id: "kitchen", name: "Kitchen" },
    { area_id: "office", name: "Office" },
  ];
  const devices = [
    { id: "dev_lamp", name: "Desk Lamp", area_id: "office", manufacturer: "IKEA", model: "TRADFRI" },
    { id: "dev_stat", name: "Thermostat", area_id: "living_room", manufacturer: "Acme", model: "T1" },
  ];
  const floors = [];
  const labels = [{ label_id: "critical", name: "Critical" }];
  const zones = [{ id: "cabin", name: "Cabin", latitude: 51, longitude: 0, radius: 100 }];
  const entities = [
    { entity_id: "light.office_lamp", device_id: "dev_lamp", area_id: null, platform: "zha" },
    { entity_id: "light.kitchen", device_id: null, area_id: "kitchen", platform: "hue" },
    { entity_id: "climate.living_room", device_id: "dev_stat", area_id: null, platform: "acme" },
    { entity_id: "sensor.kitchen_temperature", device_id: null, area_id: "kitchen", platform: "mqtt" },
    { entity_id: "lock.front_door", device_id: null, area_id: null, platform: "zwave" },
    { entity_id: "cover.office_blind", device_id: null, area_id: "office", platform: "mqtt" },
  ];

  const services = [
    { domain: "scene", services: { turn_on: { name: "Activate", fields: {} }, apply: { name: "Apply", fields: {} }, reload: { name: "Reload", fields: {} } } },
    { domain: "light", services: { turn_on: { name: "Turn on", description: "Turn on lights", fields: { brightness_pct: { description: "Brightness", selector: { number: {} } } } }, turn_off: { name: "Turn off", description: "Turn off", fields: {} } } },
    { domain: "lock", services: { lock: { name: "Lock", fields: {} }, unlock: { name: "Unlock", fields: {} } } },
    { domain: "cover", services: { open_cover: { name: "Open", fields: {} }, close_cover: { name: "Close", fields: {} } } },
    { domain: "climate", services: { set_temperature: { name: "Set temperature", fields: { temperature: { required: true, selector: { number: {} } } } } } },
    { domain: "switch", services: { turn_on: { name: "Turn on", fields: {} }, turn_off: { name: "Turn off", fields: {} } } },
    { domain: "script", services: { turn_on: { name: "Turn on", fields: {} }, reload: { name: "Reload", fields: {} }, goodnight: { name: "Goodnight", fields: {} } } },
    { domain: "automation", services: { reload: { name: "Reload", fields: {} }, trigger: { name: "Trigger", fields: {} } } },
    { domain: "homeassistant", services: { restart: { name: "Restart", fields: {} }, stop: { name: "Stop", fields: {} } } },
  ];

  const json = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const text = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "text/plain" });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { message: "Unauthorized" });
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : undefined;

    if (req.method === "GET" && p === "/api/states") return json(res, 200, [...m.states.values()]);
    if (req.method === "GET" && p.startsWith("/api/states/")) {
      const s = m.states.get(decodeURIComponent(p.slice("/api/states/".length)));
      return s ? json(res, 200, s) : json(res, 404, { message: "Entity not found." });
    }
    if (p === "/api/config" && req.method === "GET") {
      return json(res, 200, { version: "2026.10.0", location_name: "Home", time_zone: "Europe/London", unit_system: {}, state: "RUNNING", safe_mode: false, components: ["light", "lock", "api"] });
    }
    if (p === "/api/services" && req.method === "GET") return json(res, 200, services);
    if (p === "/api/template" && req.method === "POST") {
      if (data.template.includes("boom")) return text(res, 400, "TemplateError: boom is undefined");
      return text(res, 200, `rendered:${data.template}`);
    }
    if (p === "/api/config/core/check_config") {
      return json(res, 200, m.checkConfigValid ? { result: "valid", errors: null } : { result: "invalid", errors: "Integration error: broken_thing" });
    }
    if (p === "/api/error_log") {
      return text(res, 200, "2026-10-29 10:00:00 INFO (MainThread) started\n2026-10-29 10:01:00 ERROR (MainThread) [homeassistant.components.zha] radio failed\n2026-10-29 10:02:00 WARNING (MainThread) slow\n");
    }
    if (p.startsWith("/api/history/period/")) {
      const ids = (url.searchParams.get("filter_entity_id") ?? "").split(",");
      return json(res, 200, ids.map((id) => [{ entity_id: id, state: "on", last_changed: "2026-10-29T08:00:00Z" }, { state: "off", last_changed: "2026-10-29T09:00:00Z" }]));
    }
    if (p.startsWith("/api/logbook/")) return json(res, 200, [{ when: "2026-10-29T09:00:00Z", entity_id: "light.kitchen", name: "Kitchen Light", message: "turned off", context_entity_id: "automation.morning_lights", context_entity_id_name: "Morning lights", context_message: "triggered by state of sensor.motion" }, { when: "2026-10-29T08:00:00Z", entity_id: "light.kitchen", name: "Kitchen Light", message: "turned on", context_service: "turn_on", context_domain: "light", context_user_id: "u1" }]);

    if (req.method === "GET" && p === "/api/calendars") return json(res, 200, [{ entity_id: "calendar.family", name: "Family" }]);
    if (req.method === "GET" && p === "/api/calendars/calendar.family") return json(res, 200, [{ summary: "Dentist", start: { dateTime: "2026-11-02T09:00:00Z" }, end: { dateTime: "2026-11-02T10:00:00Z" } }]);
    if (req.method === "GET" && p.startsWith("/api/camera_proxy/")) {
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
    }
    if (req.method === "GET" && p.startsWith("/api/hassio/addons/") && p.endsWith("/logs")) return text(res, 200, "line one\nERROR something\nline three\n");
    const evt = p.match(/^\/api\/events\/([^/]+)$/);
    if (evt && req.method === "POST") { m.events.push({ type: evt[1], data }); return json(res, 200, { message: `Event ${evt[1]} fired.` }); }

    const ce = p.match(/^\/api\/config\/config_entries\/entry\/([^/]+)(\/reload)?$/);
    if (ce && ((req.method === "POST" && ce[2]) || (req.method === "DELETE" && !ce[2]))) { m.entryOps.push({ op: ce[2] ? "reload" : "remove", id: ce[1] }); return json(res, 200, { require_restart: false }); }
    const fl = p.match(/^\/api\/config\/config_entries\/(options\/)?flow(?:\/([^/]+))?$/);
    if (fl) {
      const kind = fl[1] ? "options" : "config";
      if (!fl[2] && req.method === "POST") {
        const f = { flow_id: `f${m.flows.size + 1}`, handler: data.handler, kind, step_id: "user" };
        m.flows.set(f.flow_id, f);
        return json(res, 200, { type: "form", flow_id: f.flow_id, handler: f.handler, step_id: "user", data_schema: [{ name: "name", required: true, type: "string" }], errors: null });
      }
      const f = m.flows.get(fl[2]);
      if (!f) return json(res, 404, { message: "Invalid flow specified" });
      if (req.method === "GET") return json(res, 200, { type: "form", flow_id: f.flow_id, handler: f.handler, step_id: f.step_id });
      if (req.method === "DELETE") { m.flows.delete(f.flow_id); return json(res, 200, { message: "Flow aborted" }); }
      m.flows.delete(f.flow_id);
      m.entryOps.push({ op: "flow_submit", handler: f.handler, kind: f.kind, input: data });
      return json(res, 200, { type: "create_entry", flow_id: f.flow_id, handler: f.handler, title: data?.name ?? "Created", result: { entry_id: "new1" } });
    }

    const cfgMatch = p.match(/^\/api\/config\/(automation|script|scene)\/config\/(.+)$/);
    if (cfgMatch) {
      const store = cfgMatch[1] === "automation" ? m.automations : cfgMatch[1] === "scene" ? m.scenes : m.scripts;
      const id = decodeURIComponent(cfgMatch[2]);
      if (req.method === "GET") return store.has(id) ? json(res, 200, store.get(id)) : json(res, 404, { message: "Resource not found" });
      if (req.method === "POST") {
        const value = cfgMatch[1] === "automation" ? { id, ...data } : data;
        store.set(id, value);
        if (cfgMatch[1] === "automation") add(`automation.${(data.alias ?? id).toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, "on", { friendly_name: data.alias, id, last_triggered: null, mode: "single", current: 0 });
        else if (cfgMatch[1] === "scene") add(`scene.${data.name.toLowerCase().replace(/\W+/g, "_")}`, "unknown", { friendly_name: data.name, id });
        else add(`script.${id}`, "off", { friendly_name: data.alias, mode: "single", current: 0 });
        if (m.invalidAfterNextWrite) { m.checkConfigValid = false; m.invalidAfterNextWrite = false; }
        return json(res, 200, { result: "ok" });
      }
      if (req.method === "DELETE") {
        if (!store.has(id)) return json(res, 404, { message: "Resource not found" });
        store.delete(id);
        for (const [eid, s] of m.states) if (s.attributes.id === id && eid.startsWith(`${cfgMatch[1]}.`)) m.states.delete(eid);
        return json(res, 200, { result: "ok" });
      }
    }

    const svc = p.match(/^\/api\/services\/([^/]+)\/([^/]+)$/);
    if (svc && req.method === "POST" && url.searchParams.get("return_response")) {
      m.serviceCalls.push({ domain: svc[1], service: svc[2], data });
      const id = data?.entity_id;
      if (svc[1] === "todo") return json(res, 200, { changed_states: [], service_response: { [id]: { items: [{ summary: "Milk", status: "needs_action" }] } } });
      if (svc[1] === "weather") return json(res, 200, { changed_states: [], service_response: { [id]: { forecast: [{ datetime: "2026-11-01", condition: "rainy", temperature: 11 }, { datetime: "2026-11-02", condition: "sunny", temperature: 14 }] } } });
      return json(res, 200, { changed_states: [], service_response: {} });
    }
    if (svc && req.method === "POST") {
      m.serviceCalls.push({ domain: svc[1], service: svc[2], data });
      const changed = [];
      const ids = data?.entity_id ? [].concat(data.entity_id) : [];
      for (const id of ids) {
        const s = m.states.get(id);
        if (!s) continue;
        const next = { turn_on: "on", turn_off: "off", lock: "locked", unlock: "unlocked", open_cover: "open", close_cover: "closed" }[svc[2]];
        if (next) { s.state = next; changed.push(s); }
      }
      return json(res, 200, changed);
    }
    return json(res, 404, { message: `no route ${req.method} ${p}` });
  });

  const wss = new WebSocketServer({ server, path: "/api/websocket" });
  wss.on("connection", (ws) => {
    m.wsConnections++;
    ws.send(JSON.stringify({ type: "auth_required", ha_version: "2026.10.0" }));
    let authed = false;
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (!authed) {
        if (msg.type === "auth" && msg.access_token === TOKEN) { authed = true; ws.send(JSON.stringify({ type: "auth_ok" })); }
        else ws.send(JSON.stringify({ type: "auth_invalid", message: "Invalid access token" }));
        return;
      }
      m.wsCommands.push(msg);
      const reply = (result) => ws.send(JSON.stringify({ id: msg.id, type: "result", success: true, result }));
      const error = (code, message) => ws.send(JSON.stringify({ id: msg.id, type: "result", success: false, error: { code, message } }));
      switch (msg.type) {
        case "ping": return ws.send(JSON.stringify({ id: msg.id, type: "pong" }));
        case "config/area_registry/list": return reply(areas);
        case "config/device_registry/list": return reply(devices);
        case "config/entity_registry/list": return reply(entities);
        case "validate_config": {
          const result = {};
          for (const k of ["trigger", "condition", "action"]) if (msg[k] !== undefined) result[k] = JSON.stringify(msg[k]).includes("BAD") ? { valid: false, error: "Invalid action: BAD" } : { valid: true };
          return reply(result);
        }
        case "trace/list":
          return reply([
            { run_id: "run1", timestamp: { start: "2026-10-29T07:00:00Z", finish: "2026-10-29T07:00:01Z" }, state: "stopped", script_execution: "finished", last_step: "action/0", trigger: "time" },
            { run_id: "run2", timestamp: { start: "2026-10-29T08:00:00Z", finish: "2026-10-29T08:00:01Z" }, state: "stopped", script_execution: "error", last_step: "action/0", error: "Entity light.gone not found", trigger: "time" },
          ]);
        case "trace/get":
          return reply({
            run_id: msg.run_id, state: "stopped", script_execution: msg.run_id === "run2" ? "error" : "finished", last_step: "action/0",
            error: msg.run_id === "run2" ? "Entity light.gone not found" : undefined, timestamp: { start: "2026-10-29T08:00:00Z" }, trigger: "time",
            trace: { "trigger/0": [{ path: "trigger/0", timestamp: "2026-10-29T08:00:00Z" }], "action/0": [{ path: "action/0", timestamp: "2026-10-29T08:00:00.5Z", error: msg.run_id === "run2" ? "Entity light.gone not found" : undefined }] },
          });
        case "recorder/list_statistic_ids": return reply([{ statistic_id: "sensor.energy_total", name: "Energy", unit_of_measurement: "kWh", has_mean: false, has_sum: true, source: "recorder" }]);
        case "recorder/statistics_during_period": return reply({ "sensor.energy_total": [{ start: 1761700000000, end: 1761703600000, sum: 10, change: 1.5 }, { start: 1761703600000, end: 1761707200000, sum: 11.5, change: 1.5 }] });
        case "system_log/list": return reply([{ level: "ERROR", name: "homeassistant.components.zha", count: 3, timestamp: 1761700000, first_occurred: 1761600000, message: ["radio failed"], source: ["x.py", 1] }, { level: "WARNING", name: "other", count: 1, timestamp: 1761700001, first_occurred: 1761700001, message: ["slow"], source: "y" }]);
        case "supervisor/api": {
          if (!m.supervisor) return error("unknown_command", "Unknown command.");
          const ep = msg.endpoint;
          if (ep === "/supervisor/info") return reply({ version: "2026.10.0", version_latest: "2026.10.0", healthy: true, supported: true, channel: "stable" });
          if (ep === "/core/info") return reply({ version: "2026.10.0", version_latest: "2026.10.1", update_available: true });
          if (ep === "/host/info") return reply({ hostname: "ha", operating_system: "HAOS", disk_free: 10, disk_total: 32, disk_used: 22 });
          if (ep === "/os/info") return reply({ version: "13.0", version_latest: "13.0", update_available: false, board: "rpi4" });
          if (ep === "/addons") return reply({ addons: [{ slug: "core_mosquitto", name: "Mosquitto broker", state: "started", version: "6.4", version_latest: "6.5", update_available: true }] });
          if (ep === "/backups") return reply({ backups: [{ slug: "b1", name: "Nightly", date: "2026-10-30", type: "full", size: 120, protected: false }] });
          if (ep === "/backups/new/full") { m.entryOps.push({ op: "ha_backup", name: msg.data?.name }); return reply({ slug: "b2" }); }
          const a = ep.match(/^\/addons\/([^/]+)\/(info|start|stop|restart|update)$/);
          if (a) { if (a[2] === "info") return reply({ name: "Mosquitto broker", state: "started", version: "6.4", version_latest: "6.5" }); m.entryOps.push({ op: `addon_${a[2]}`, id: a[1] }); return reply({}); }
          return error("not_found", "Unknown endpoint");
        }
        case "system_health/info":
          reply(null);
          ws.send(JSON.stringify({ id: msg.id, type: "event", event: { homeassistant: { info: { version: "2026.10.0", installation_type: "Home Assistant OS" } } } }));
          return ws.send(JSON.stringify({ id: msg.id, type: "event", event: { recorder: { info: { oldest_recorder_run: "2026-01-01" } } } }));
        case "lovelace/config": { const k = msg.url_path ?? "default"; return m.lovelace[k] ? reply(m.lovelace[k]) : error("config_not_found", "No config found."); }
        case "lovelace/config/save": m.lovelace[msg.url_path ?? "default"] = msg.config; return reply(null);
        case "lovelace/config/delete": delete m.lovelace[msg.url_path ?? "default"]; return reply(null);
        case "lovelace/dashboards/list": return reply(m.dashboards);
        case "lovelace/dashboards/create": { const d = { id: msg.url_path.replace(/\W/g, "_"), url_path: msg.url_path, title: msg.title, icon: msg.icon, mode: "storage", show_in_sidebar: msg.show_in_sidebar, require_admin: msg.require_admin }; m.dashboards.push(d); return reply(d); }
        case "lovelace/dashboards/delete": { const i = m.dashboards.findIndex((d) => d.id === msg.dashboard_id); if (i < 0) return error("not_found", "Unknown dashboard"); const [d] = m.dashboards.splice(i, 1); delete m.lovelace[d.url_path]; return reply(null); }
        case "config/entity_registry/update": {
          m.wsWrites.push(msg);
          const e = entities.find((x) => x.entity_id === msg.entity_id);
          if (!e) return error("not_found", "Entity not found");
          const { id: _i, type: _t, entity_id: _e, new_entity_id, ...rest } = msg;
          Object.assign(e, rest);
          if (new_entity_id) e.entity_id = new_entity_id;
          return reply({ entity_entry: e });
        }
        case "config/entity_registry/remove": { const i = entities.findIndex((x) => x.entity_id === msg.entity_id); if (i < 0) return error("not_found", "Entity not found"); entities.splice(i, 1); return reply(null); }
        case "config/device_registry/update": { const d = devices.find((x) => x.id === msg.device_id); if (!d) return error("not_found", "Device not found"); const { id: _i, type: _t, device_id: _d, ...rest } = msg; Object.assign(d, rest); return reply(d); }
        case "search/related": return reply(msg.item_id === "light.kitchen" || msg.item_id === "kitchen" ? { automation: ["automation.morning_lights"], script: ["script.harmless"] } : {});
        case "blueprint/list": return reply(m.blueprints[msg.domain] ?? {});
        case "blueprint/import":
          if (msg.url.includes("bad")) return reply({ url: msg.url, raw_data: "", suggested_filename: "", blueprint: { metadata: {} }, validation_errors: ["bad blueprint"] });
          return reply({ url: msg.url, suggested_filename: msg.url.includes("lock") ? "someone/lock_door" : "someone/new_bp", raw_data: msg.url.includes("lock") ? "blueprint:\n  name: Lock it\naction:\n  - action: lock.lock\n" : "blueprint:\n  name: New\naction: []\n", blueprint: { metadata: { name: "Imported BP", domain: "automation", author: "Someone", input: { a: {} } } }, validation_errors: null });
        case "blueprint/save": m.blueprints[msg.domain][msg.path] = { metadata: { name: "Imported BP", source_url: msg.source_url } }; return reply({ overrides_existing: false });
        case "blueprint/delete": delete m.blueprints[msg.domain][msg.path]; return reply(null);
        case "config_entries/get": return reply(msg.domain ? m.entries.filter((e) => e.domain === msg.domain) : m.entries);
        case "config_entries/entry/disable": m.entryOps.push({ op: msg.disabled_by ? "disable" : "enable", id: msg.entry_id }); return reply({ require_restart: false });
        case "config_entries/entry/update": m.entryOps.push({ op: "rename", id: msg.entry_id, title: msg.title }); return reply({ require_restart: false, config_entry: {} });
        case "repairs/list_issues": return reply({ issues: [{ domain: "zha", issue_id: "i1", severity: "warning", is_fixable: false, ignored: false, translation_key: "k", created: "2026-10-01" }, { domain: "x", issue_id: "i2", severity: "error", ignored: true }] });
        case "repairs/ignore_issue": m.entryOps.push({ op: "ignore", id: msg.issue_id, ignore: msg.ignore }); return reply(null);
        case "subscribe_events":
          reply(null);
          return ws.send(JSON.stringify({ id: msg.id, type: "event", event: { event_type: msg.event_type ?? "state_changed", data: { entity_id: "light.kitchen" } } }));
        case "unsubscribe_events": return reply(null);
        default: {
          const REG = { area: { list: areas, key: "area_id" }, floor: { list: floors, key: "floor_id" }, label: { list: labels, key: "label_id" }, zone: { list: zones, key: "id", cmdKey: "zone_id" } };
          const rg = msg.type.match(/^config\/(area|floor|label)_registry\/(list|create|update|delete)$/) || msg.type.match(/^(zone)\/(list|create|update|delete)$/);
          if (rg) {
            const spec = REG[rg[1]];
            const op = rg[2];
            if (op === "list") return reply(spec.list);
            const idKey = spec.cmdKey ?? spec.key;
            if (op === "create") { const { id: _i, type: _t, ...rest } = msg; const item = { [spec.key]: rest.name.toLowerCase().replace(/\W+/g, "_"), ...rest }; spec.list.push(item); return reply(item); }
            const idx = spec.list.findIndex((x) => x[spec.key] === msg[idKey]);
            if (idx < 0) return error("not_found", "Item not found");
            if (op === "update") { const { id: _i, type: _t, [idKey]: _k, ...rest } = msg; spec.list[idx] = { ...spec.list[idx], ...rest }; return reply(spec.list[idx]); }
            spec.list.splice(idx, 1);
            return reply(null);
          }
          const h = msg.type.match(/^(\w+)\/(list|create|update|delete)$/);
          if (h && m.helpers[h[1]]) {
            const list = m.helpers[h[1]];
            if (h[2] === "list") return reply(list);
            if (h[2] === "create") { const item = { id: msg.name.toLowerCase().replace(/\W+/g, "_"), name: msg.name }; list.push(item); return reply(item); }
            const idKey = `${h[1]}_id`;
            const idx = list.findIndex((x) => x.id === msg[idKey]);
            if (idx < 0) return error("not_found", "Unable to find item");
            if (h[2] === "update") { const { id: _i, type: _t, [idKey]: _k, ...rest } = msg; list[idx] = { ...list[idx], ...rest }; return reply(list[idx]); }
            list.splice(idx, 1); return reply(null);
          }
          return error("unknown_command", `Unknown command ${msg.type}`);
        }
      }
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  m.url = `http://127.0.0.1:${port}`;
  m.add = add;
  m.close = () => new Promise((r) => { wss.close(); server.closeAllConnections?.(); server.close(r); });
  return m;
}
