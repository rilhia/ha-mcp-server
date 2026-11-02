// Plain English help about the settings. This file exists for one reason: when someone
// asks the assistant to do something the current settings do not allow, we want the
// assistant to be able to say WHY it cannot, and exactly WHAT to change to allow it.
//
// There are two ways the user hears about it:
//   1. The "server instructions" the assistant reads when it connects. Tools that are
//      switched off do not exist, so the assistant cannot "try and get refused". It has to
//      know up front what is off and how to turn it on. statusNote() builds that briefing.
//   2. Refusal messages. When a call IS made and refused (for example a lock in control
//      only mode, or an entity on the never touch list), the message includes the fix.
//
// Important: the assistant cannot change settings itself. Only the person can, by editing
// the extension settings (Claude Desktop) or the config file (LM Studio and others),
// then restarting the server. Every message here says so.
import type { Config } from "./config.js";

// How a setting is called in each place. 'form' is the label in the Claude Desktop
// settings form, and 'env' is the environment variable name used in LM Studio's mcp.json.
const SETTINGS = {
  readOnly: { form: "Read only mode", env: "HA_READ_ONLY" },
  controlOnly: { form: "Control only mode", env: "HA_CONTROL_ONLY" },
  raw: { form: "Raw API tools", env: "HA_ENABLE_RAW" },
  config: { form: "Dashboards, registries, scenes, blueprints and integrations", env: "HA_ENABLE_CONFIG" },
  insights: { form: "Insight tools", env: "HA_ENABLE_INSIGHTS" },
  supervisor: { form: "Supervisor tools", env: "HA_ENABLE_SUPERVISOR" },
  neverTouch: { form: "Never touch entities", env: "HA_NEVER_TOUCH" },
  approval: { form: "Require an approval prompt for high risk actions", env: "HA_REQUIRE_APPROVAL_PROMPT" },
} as const;

export type SettingKey = keyof typeof SETTINGS;

// Every instruction ends with the same reminder, because settings are only read when the server starts.
const RESTART = "Settings only take effect after the server restarts (Claude Desktop restarts the extension, and in LM Studio you switch the server off and on).";

/** "In Claude Desktop, tick X. In LM Studio or another client, set ENV to "true"." */
export function howToTurnOn(key: SettingKey): string {
  const s = SETTINGS[key];
  return `To turn this on: in Claude Desktop tick "${s.form}", or in LM Studio or another client set ${s.env} to "true" in the config. ${RESTART}`;
}

/** The reverse: untick the box, or set the variable to "false". */
export function howToTurnOff(key: SettingKey): string {
  const s = SETTINGS[key];
  return `To turn this off: in Claude Desktop untick "${s.form}", or in LM Studio or another client set ${s.env} to "false" (or remove it) in the config. ${RESTART}`;
}

/** Used in every never touch refusal. Removing a pattern is the only way to allow the change. */
export const NEVER_TOUCH_HELP = `To allow it, the user would have to remove the matching pattern from the "${SETTINGS.neverTouch.form}" setting (${SETTINGS.neverTouch.env}) and restart the server. ${RESTART} You cannot change this setting yourself.`;

/** Used when an approval prompt is required but the client cannot show one. */
export const APPROVAL_HELP = `If the user wants to allow this without a prompt, they can turn off "${SETTINGS.approval.form}" (${SETTINGS.approval.env}) and restart the server. They will then use the normal preview and confirm steps instead. ${RESTART}`;

/** Added to refusals in control only mode. */
export const CONTROL_ONLY_HELP = `If the user really needs this, they can turn off "${SETTINGS.controlOnly.form}" (${SETTINGS.controlOnly.env}) to get full access, with approval for risky actions. Before suggesting that, remind them to take a Home Assistant backup, and that local models are less reliable at following safety rules. ${RESTART} You cannot change this setting yourself.`;

// Builds the paragraph added to the server instructions. It states the current mode,
// lists what is switched off, and says how to enable each thing. The assistant is told
// to pass this on when asked for something it cannot do.
/** A status briefing for the assistant: current mode, what is disabled, and how the user can enable it. */
export function statusNote(cfg: Config): string {
  const lines: string[] = [];

  if (cfg.readOnly) {
    lines.push(
      `Read only mode is ON. You can look at everything but you cannot change anything: no switching devices, and no creating, editing or deleting automations, scripts, scenes, helpers, dashboards or settings. To allow switching everyday devices only, the user can turn off "${SETTINGS.readOnly.form}" (${SETTINGS.readOnly.env}) and turn on "${SETTINGS.controlOnly.form}" (${SETTINGS.controlOnly.env}). To allow all changes, they can just turn off "${SETTINGS.readOnly.form}".`
    );
  } else if (cfg.controlOnly) {
    lines.push(
      `Control only mode is ON. You can read everything and use call_service for everyday devices such as lights, switches, fans, covers, media players and helper toggles. You cannot create, edit or delete automations, scripts, scenes, helpers, dashboards, registries, integrations or settings, you cannot restart Home Assistant, and locks, alarms and climate cannot be controlled. To allow everything, the user can turn off "${SETTINGS.controlOnly.form}" (${SETTINGS.controlOnly.env}). To go back to looking only, they can turn on "${SETTINGS.readOnly.form}" (${SETTINGS.readOnly.env}).`
    );
  }

  // Toolsets that are switched off. Raw and Supervisor are off unless asked for. Config and insights are on unless the user switched them off.
  const off: string[] = [];
  if (!cfg.toolsets.raw) off.push(`the raw API tools (turn on "${SETTINGS.raw.form}", ${SETTINGS.raw.env})`);
  if (!cfg.toolsets.config) off.push(`the dashboard, registry, scene, blueprint and integration tools (turn on "${SETTINGS.config.form}", ${SETTINGS.config.env})`);
  if (!cfg.toolsets.insights) off.push(`the insight tools such as the home overview and problem finder (turn on "${SETTINGS.insights.form}", ${SETTINGS.insights.env})`);
  if (!cfg.toolsets.supervisor) off.push(`the add-on and host tools (turn on "${SETTINGS.supervisor.form}", ${SETTINGS.supervisor.env}, which only works on Home Assistant OS or Supervised)`);
  if (off.length) lines.push(`These tool groups are switched off: ${off.join("; ")}.`);

  if (cfg.neverTouch.length) {
    lines.push(
      `These entity patterns are protected and can never be changed, even with confirmation: ${cfg.neverTouch.join(", ")}. The user can remove them from "${SETTINGS.neverTouch.form}" (${SETTINGS.neverTouch.env}).`
    );
  }
  if (cfg.approval === "elicit") {
    lines.push(`High risk actions need a human approval prompt (${SETTINGS.approval.env}). If the client cannot show one, they are refused.`);
  }

  // Nothing restrictive to say (full mode, nothing switched off).
  if (!lines.length) return "";

  return [
    "Current settings (the user chose these):",
    ...lines.map((l) => `- ${l}`),
    "If the user asks for something these settings do not allow, do not say it is broken or impossible. Say which setting prevents it, and tell them what to change, using the names above (the quoted names are the Claude Desktop settings, the capitalised names are for LM Studio and other clients). " + RESTART + " You cannot change settings yourself, and you must never claim you did. If the change would allow writes, advise taking a Home Assistant backup first.",
  ].join("\n");
}
