// This file reads the settings. Everything the user can configure arrives as an
// environment variable (the MCPB manifest fills them in from the settings form,
// and if you run the server by hand you set them yourself). We read them all in
// one place, tidy them up, and hand the rest of the program a nice typed object.
//
// If you want to know what a setting does, the table in the README is the best
// reference. The comments on the interface below say the same thing in short form.
import os from "node:os";
import path from "node:path";

export interface Config {
  /** Base URL of Home Assistant, without a trailing slash or /api suffix. */
  url: string;
  /** WebSocket URL, derived from url. */
  wsUrl: string;
  // The long-lived access token. Never print this anywhere. (util.ts also
  // registers it as a secret so it gets scrubbed from any output.)
  token: string;
  /** Skip TLS verification, for self-signed certificates on a LAN. */
  insecureTls: boolean;
  /** When true, only read-only tools are registered. */
  readOnly: boolean;
  // "Control only" mode, for everyday use. Every read tool is available, plus
  // call_service restricted to everyday devices (lights, switches, fans, media
  // players and so on). All tools that edit automations, scripts, helpers,
  // dashboards, scenes, settings or the system itself are not registered.
  // If readOnly is also on, readOnly wins.
  controlOnly: boolean;
  // How long to wait for Home Assistant to answer before giving up.
  timeoutMs: number;
  // Folder where rollback copies are saved.
  backupDir: string;
  /** Extra service domains to treat as high risk. */
  extraHighRiskDomains: string[];
  /** Glob patterns of entity_ids to always treat as high risk. */
  highRiskEntityPatterns: string[];
  // Upper limit on the size of any single tool reply, so a huge result cannot
  // swamp the model's context window.
  maxOutputChars: number;
  /** Entity id globs that can never be changed through this server, even with confirmation. */
  neverTouch: string[];
  /** auto: ask the human through MCP elicitation when the client supports it. elicit: require it. */
  approval: "auto" | "elicit";
  // Where the audit diary lives.
  auditPath: string;
  /** Entity id globs that are expected to be unavailable, so overview and problem checks skip them. */
  ignoreUnavailable: string[];
  /** Optional tool groups. The core tools are always on. */
  toolsets: { config: boolean; insights: boolean; raw: boolean; supervisor: boolean };
}

/** Treat unset, empty and unresolved "${user_config.x}" placeholders as missing. */
// Quick story on why this exists. When a setting is left blank in the MCPB form,
// some hosts pass through the literal text "${user_config.something}" instead of
// an empty value. If we treated that as real we would, for example, try to use
// "${user_config.ha_url}" as a web address. So anything that looks like an
// unfilled placeholder is treated as "not set".
function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v === "" || v.startsWith("${")) return undefined;
  return v;
}

// Reads a yes/no setting. Accepts 1, true, yes or on in any capitalisation.
// Anything else (or missing) falls back to the default we were given.
function bool(value: string | undefined, fallback: boolean): boolean {
  const v = clean(value);
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

// Reads a list setting. People separate items with commas or new lines, so we
// accept both and trim away stray spaces and empty bits.
function list(value: string | undefined): string[] {
  const v = clean(value);
  if (!v) return [];
  return v
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Reads a whole number setting. Zero, negative numbers and rubbish fall back to
// the default, because none of our numeric settings make sense as zero.
function int(value: string | undefined, fallback: number): number {
  const v = clean(value);
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Remove quotes, a pasted "Bearer " prefix, and any whitespace or line breaks inside a token. */
// This came from a real headache. A pasted token often arrives with a trailing
// newline, wrapped in quotes, or with "Bearer " on the front, and any of those
// makes Home Assistant answer 401 Unauthorized with no clue why. Cleaning the
// token here removes a whole category of confusing failures.
export function sanitizeToken(raw: string): string {
  let t = raw.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  t = t.replace(/^authorization:\s*/i, "").replace(/^bearer\s+/i, "");
  // Real tokens never contain whitespace, so any that crept in (for example from
  // a line break in the middle of a paste) gets removed.
  return t.replace(/\s+/g, "");
}

// Builds the Config from the environment. Takes the environment as a parameter
// (defaulting to the real one) so that tests can pass in their own.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let rawUrl = clean(env.HA_URL);
  const rawToken = clean(env.HA_TOKEN);
  const token = rawToken ? sanitizeToken(rawToken) : undefined;
  // The URL and token are the only two settings we cannot do without, so fail
  // loudly and clearly if either is missing.
  if (!rawUrl) {
    throw new Error(
      "HA_URL is not set. Set it to your Home Assistant address, for example http://homeassistant.local:8123"
    );
  }
  if (!token) {
    throw new Error(
      "HA_TOKEN is not set. Create a long-lived access token in your Home Assistant profile page."
    );
  }
  // Be forgiving if someone types just "192.168.1.5:8123" without http://.
  if (!/^https?:\/\//i.test(rawUrl)) rawUrl = `http://${rawUrl}`;
  // Strip any trailing slashes and a trailing "/api", since we add our own paths.
  const url = rawUrl.replace(/\/+$/, "").replace(/\/api$/i, "");
  // http becomes ws and https becomes wss, because the regex only swaps the
  // leading "http" and leaves the "s" alone.
  const wsUrl = url.replace(/^http/i, "ws") + "/api/websocket";

  // Backups default to a hidden folder in the user's home directory.
  const backupDir = clean(env.HA_BACKUP_DIR) ?? path.join(os.homedir(), ".ha-mcp-server", "backups");
  return {
    url,
    wsUrl,
    token,
    insecureTls: bool(env.HA_INSECURE_TLS, false),
    // Read only defaults to OFF here. The MCPB form can default it differently.
    readOnly: bool(env.HA_READ_ONLY, false),
    // Control only is also OFF unless asked for. See the comment on the interface.
    controlOnly: bool(env.HA_CONTROL_ONLY, false),
    timeoutMs: int(env.HA_TIMEOUT_MS, 30_000),
    backupDir,
    // Patterns are lowercased once here so the matching code does not have to.
    extraHighRiskDomains: list(env.HA_HIGH_RISK_DOMAINS).map((d) => d.toLowerCase()),
    highRiskEntityPatterns: list(env.HA_HIGH_RISK_ENTITIES).map((p) => p.toLowerCase()),
    maxOutputChars: int(env.HA_MAX_OUTPUT_CHARS, 40_000),
    neverTouch: list(env.HA_NEVER_TOUCH).map((p) => p.toLowerCase()),
    // If the user insists on an approval prompt, we use "elicit" which refuses to
    // proceed without one. Otherwise "auto" asks when the client can, and carries
    // on with the plan token check alone when it cannot.
    approval: bool(env.HA_REQUIRE_APPROVAL_PROMPT, false) ? "elicit" : "auto",
    // The audit log sits next to the backups folder unless told otherwise.
    auditPath: clean(env.HA_AUDIT_LOG) ?? path.join(path.dirname(backupDir), "audit.jsonl"),
    ignoreUnavailable: list(env.HA_IGNORE_UNAVAILABLE).map((p) => p.toLowerCase()),
    toolsets: {
      // Config and insights are on unless switched off. Raw is OFF unless switched on,
      // because the raw tools are the most powerful and least guarded ones, so a user
      // should choose to have them. Supervisor is the
      // opposite: off unless switched on, because most people run Docker or Core
      // installs that have no Supervisor at all.
      config: bool(env.HA_ENABLE_CONFIG, true),
      insights: bool(env.HA_ENABLE_INSIGHTS, true),
      raw: bool(env.HA_ENABLE_RAW, false),
      supervisor: bool(env.HA_ENABLE_SUPERVISOR, false),
    },
  };
}
