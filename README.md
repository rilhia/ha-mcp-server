# Home Assistant MCP Server (beta)

> **This is a beta, version 0.2.1.** It works well against a real Home Assistant 2026.10 instance, but some write paths have not been tried on real hardware (see [What has and has not been tested](#what-has-and-has-not-been-tested)). Please start in read only mode, keep backups of your Home Assistant, and report anything odd as a GitHub issue.

A Model Context Protocol (MCP) server that lets an AI assistant look at, understand and (if you allow it) change your Home Assistant. It has 72 tools by default (44 of them in read only mode, and 78 with the optional Supervisor group switched on), covering entities, areas, history, automations, scripts, helpers, dashboards, scenes, blueprints, integrations, repairs, diagnostics and a raw API escape hatch.

It works with any MCP client that can launch a local program over stdio, for example Claude Desktop and LM Studio.

## Contents

1. [Read this first: read only mode](#read-this-first-read-only-mode)
2. [What it can do](#what-it-can-do)
3. [Install in Claude Desktop](#install-in-claude-desktop)
4. [Explode the MCPB and run it by hand](#explode-the-mcpb-and-run-it-by-hand)
5. [Use it with LM Studio](#use-it-with-lm-studio)
6. [Configuration reference](#configuration-reference)
7. [How to use it](#how-to-use-it)
8. [The tools, one by one](#the-tools-one-by-one)
9. [Safety model](#safety-model)
10. [What has and has not been tested](#what-has-and-has-not-been-tested)
11. [Build from source](#build-from-source)
12. [Troubleshooting](#troubleshooting)
13. [Project layout](#project-layout)
14. [Licence](#licence)

## Read this first: read only mode

There is one switch that matters more than all the others: **read only mode** (`HA_READ_ONLY=true`, or the "Read only mode" checkbox in Claude Desktop).

With it on, every tool that could change anything is not registered at all. The model cannot call them because they do not exist. It can still look at everything.

My advice: **install it, leave read only on, and explore for a while.** Only turn it off when you know what you want to do with it.

### A serious warning for LM Studio and other local models

The safeguards in this server (preview first, single use plan tokens, the never touch list, backups) are good, but they rely on the model following instructions and on the client showing you what is going on. Claude is trained to respect those instructions. Many local models are not reliable at this. They can misread a plan, repeat a confirmation call on their own, invent entity names, or get talked into things by text they find inside your Home Assistant (an entity name, a calendar entry, a log line).

If you use this with LM Studio or any local model:

* **Keep `HA_READ_ONLY=true`.** Treat it as the normal way to run it.
* If you really must turn it off, be very careful. Do it for a short, specific task, then switch it back on.
* Put anything you could not bear to have changed on the never touch list (`HA_NEVER_TOUCH`), for example `lock.*`, `alarm_control_panel.*`, `cover.garage_*`.
* Turn on `HA_REQUIRE_APPROVAL_PROMPT` only if your client supports MCP approval prompts. LM Studio may not, in which case high risk actions will simply be refused, which is the safe outcome.
* Take a full Home Assistant backup first.
* Consider turning off the Raw toolset (`HA_ENABLE_RAW=false`), which is the most powerful and least guarded part.
* Never leave a write enabled model running unattended.

## What it can do

Roughly, in plain English:

* **Look around.** Find entities, list rooms, see what is in a room, read history and the logbook, run templates.
* **Understand your home.** Get an overview, find broken things (unavailable devices, flat batteries, failed integrations, repairs), work out why something changed, read energy statistics, calendars, to-do lists, weather forecasts and camera snapshots.
* **Control things.** Call any Home Assistant service. Dangerous ones (locks, alarms, heating, garage doors, whole area commands) need an explicit two step approval.
* **Manage automations and scripts.** List, read, validate, create, update, delete, reload, and debug failed runs using traces.
* **Manage helpers, scenes, dashboards, blueprints, areas, floors, labels, devices, entities and zones.**
* **Manage integrations and repairs.** Reload, rename, enable, disable and remove config entries, and run setup flows step by step.
* **Maintain the system.** Check the configuration, read logs, restart.
* **Reach anything else** through the raw REST and WebSocket tools.
* **Undo mistakes.** Config changes are validated, backed up, and can be rolled back.

## Install in Claude Desktop

1. Download `home-assistant-mcp-0.2.1.mcpb` from the GitHub release page.
2. Open Claude Desktop, go to Settings, then Extensions, and drag the file in (or double click it).
3. Fill in the form:
   * **Home Assistant URL**, for example `http://192.168.1.50:8123` (no trailing slash needed).
   * **Long-lived access token.** In Home Assistant, click your profile (bottom left), open the Security tab, scroll to the bottom and create a long-lived access token. The token is kept in your operating system keychain.
   * **Read only mode**: leave ticked to start with.
4. Start a new chat and ask: "Check you can reach Home Assistant."

Claude Desktop shows the server's log if something goes wrong. The first log line tells you which URL it is using and how long the token is (never the token itself).

## Explode the MCPB and run it by hand

An `.mcpb` file is just a zip file with a `manifest.json` and the program inside. You can open it up and run the server yourself, which is what you need to do for LM Studio or any other client.

**Option A: with the MCPB tool**

```bash
npx @anthropic-ai/mcpb unpack home-assistant-mcp-0.2.1.mcpb ha-mcp
```

**Option B: with any unzip tool**

```bash
mkdir ha-mcp
cd ha-mcp
unzip ../home-assistant-mcp-0.2.1.mcpb
```

On Windows you can rename the file to `.zip` and use Extract All.

You will end up with a folder like this:

```
ha-mcp/
  manifest.json        what the bundle is and which settings it takes
  package.json
  dist/index.js        the server itself (this is what you run)
  node_modules/        the dependencies, already installed
```

Everything needed is in there, so there is no `npm install` step. You only need **Node.js 18.17 or newer** (`node --version` to check).

Test it from a terminal:

```bash
cd ha-mcp
HA_URL=http://192.168.1.50:8123 HA_TOKEN=your_token HA_READ_ONLY=true node dist/index.js
```

It prints a few lines to the terminal (they go to stderr) like `[ha-mcp] v0.2.1 ready with ... (READ ONLY mode)` and then waits silently, because it is waiting for an MCP client to talk to it. Press Ctrl+C to stop it.

## Use it with LM Studio

LM Studio (0.3.17 or later) can run local MCP servers. Please read the [warning above](#a-serious-warning-for-lm-studio-and-other-local-models) first.

1. Explode the bundle as above and note the full path to `dist/index.js`.
2. In LM Studio, open the **Program** tab on the right of the chat window and choose **Install**, then **Edit mcp.json**. (The file is `~/.lmstudio/mcp.json` on macOS and Linux, and `%USERPROFILE%\.lmstudio\mcp.json` on Windows.)
3. Add an entry like this:

```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "node",
      "args": ["/full/path/to/ha-mcp/dist/index.js"],
      "env": {
        "HA_URL": "http://192.168.1.50:8123",
        "HA_TOKEN": "your_long_lived_token",
        "HA_READ_ONLY": "true",
        "HA_NEVER_TOUCH": "lock.*,alarm_control_panel.*,cover.garage_*",
        "HA_ENABLE_RAW": "false"
      }
    }
  }
}
```

4. Save the file. LM Studio starts the server and the tools appear in the Program tab. Switch the server on for the chat you want to use it in.
5. Use a model that is good at tool calling. Small models often call the wrong tool or invent entity ids. If a model struggles, turn off whole groups you do not need (`HA_ENABLE_CONFIG`, `HA_ENABLE_INSIGHTS`, `HA_ENABLE_RAW` set to `false`) so it has fewer tools to choose from.
6. On Windows, use forward slashes or doubled backslashes in the path (`C:/Users/me/ha-mcp/dist/index.js`).

Notes:

* The token is stored in plain text in `mcp.json`. Anyone who can read that file can control your Home Assistant, so protect it, and create a token just for this use so you can revoke it independently.
* If your Home Assistant is on a different machine, make sure the URL is reachable from the computer running LM Studio.
* **Do not change `HA_READ_ONLY` to `false` casually.** If you do, restart the server, test with something harmless (a single light), and keep the never touch list populated.

Other MCP clients (Cursor, Cline, Continue and so on) use the same idea: a `command` of `node`, an `args` entry that points at `dist/index.js`, and the settings as `env` values.

## Configuration reference

These are environment variables. In Claude Desktop most are tick boxes and text boxes in the extension settings.

| Variable | Required | Meaning |
| --- | --- | --- |
| `HA_URL` | yes | Home Assistant address, for example `http://192.168.1.50:8123` |
| `HA_TOKEN` | yes | Long-lived access token |
| `HA_READ_ONLY` | no | `true` registers only read only tools. **Recommended.** |
| `HA_INSECURE_TLS` | no | `true` skips TLS verification (self-signed certificates) |
| `HA_HIGH_RISK_ENTITIES` | no | Comma separated entity id patterns that always need the two step approval, for example `switch.workshop_*` |
| `HA_HIGH_RISK_DOMAINS` | no | Extra service domains to treat as high risk |
| `HA_NEVER_TOUCH` | no | Entity patterns this server must never change, even with approval |
| `HA_REQUIRE_APPROVAL_PROMPT` | no | `true` makes a human approval prompt mandatory for high risk actions |
| `HA_IGNORE_UNAVAILABLE` | no | Entity patterns `find_problems` and the overview should not report as unavailable |
| `HA_ENABLE_CONFIG` | no | Dashboards, registries, scenes, blueprints, integrations. Default `true` |
| `HA_ENABLE_INSIGHTS` | no | Overview, problems, statistics and so on. Default `true` |
| `HA_ENABLE_RAW` | no | Raw API tools. Default `true` |
| `HA_ENABLE_SUPERVISOR` | no | Add-on and host tools. Default `false`. Needs Home Assistant OS or Supervised |
| `HA_BACKUP_DIR` | no | Where rollback copies go. Default `~/.ha-mcp-server/backups` |
| `HA_AUDIT_LOG` | no | Audit log file. Default `~/.ha-mcp-server/audit.jsonl` |
| `HA_TIMEOUT_MS` | no | Request timeout. Default 30000 |
| `HA_MAX_OUTPUT_CHARS` | no | Cap on a single tool response. Default 40000 |

## How to use it

You just talk to your assistant normally. It picks the tools. Some good first things to try, all of which work in read only mode:

* "Check you can reach Home Assistant."
* "Give me an overview of the house."
* "Is anything wrong in my house?"
* "What is in the living room right now?"
* "How much energy did we use this week?"
* "Why did the hall light turn on at 3am?"
* "Why did my morning automation not run?"
* "List every automation that controls heating."

### What happens when you ask for a change

With read only mode off, a low risk request (turn on a lamp) just happens. A high risk request (unlock a door, change heating, delete an automation) goes like this:

1. The assistant calls the tool **without** confirming. Nothing changes. It gets back a plain English plan, and a one time `plan_token`.
2. The assistant shows you the plan and asks if you want to go ahead.
3. If you say yes, it repeats the identical call with `confirm: true`, `dry_run: false` and the token. Only then does it run.

If you change your mind about the details, the old token no longer matches, so the assistant has to preview again. Tokens last 10 minutes and work once.

### Undoing a change

Before changing an automation, script, scene, dashboard, helper or registry item, the server saves the old version and tells the assistant how to restore it. Ask: "Undo that last change", or "List your backups". If the configuration check fails right after a write, the change is reverted automatically.

## The tools, one by one

The **Risk** column means:

* **read**: cannot change anything. Available in read only mode.
* **low**: changes something, but a mistake is minor and easy to fix. Runs straight away.
* **gated**: can be dangerous, or is dangerous in some cases. Needs the two step approval (the assistant must preview first, and you must agree). Not available in read only mode.

In read only mode, anything that is not marked **read** does not exist.


### Looking around (discovery)

| Tool | Risk | What it does | Inputs |
| --- | --- | --- | --- |
| `search_entities` | read | Finds entities by words, area, type or state. Understands synonyms such as lamp and heating. | `query`, `domain`, `area`, `state`, `limit` |
| `get_entity_details` | read | Everything about one entity: state, attributes, features, device, area and available services. | `entity_id` (required) |
| `list_areas` | read | Lists your rooms with how many entities each holds. | none |
| `get_area_summary` | read | Shows all devices and entities in one room with current states. | `area_name` (required), `include_disabled`, `max_entities` |
| `list_services` | read | Shows the actions Home Assistant can perform, from a short list down to one service in full detail. | `domain`, `service` |
| `get_history` | read | A timeline of state changes for one or more entities. | `entity_ids` (required), `hours`, `limit`, `attributes` |
| `get_logbook` | read | What happened and why, over a recent period. | `entity_id`, `hours`, `limit` |
| `render_template` | read | Evaluates a Jinja template on Home Assistant. Read only, great for summaries across many entities. | `template` (required), `variables` |

Examples of how to ask:

* `search_entities`: "Find every light that is on in the kitchen."
* `get_entity_details`: "Tell me everything about climate.upper_hall."
* `list_areas`: "What areas do I have?"
* `get_area_summary`: "What is in the living room right now?"
* `list_services`: "What can light.turn_on do?"
* `get_history`: "Show the temperature history of the office for the last 12 hours."
* `get_logbook`: "What happened in the house in the last two hours?"
* `render_template`: "How many lights are on across the house?"

### Understanding your home (insights)

| Tool | Risk | What it does | Inputs |
| --- | --- | --- | --- |
| `get_home_overview` | read | A one call snapshot of the whole home. | `sample` |
| `find_problems` | read | Finds unavailable entities, stale sensors, low batteries, updates, failed integrations and repairs. | `stale_hours`, `check_references`, `limit` |
| `explain_state_change` | read | Works out why an entity changed: an automation, a person, a service call or the device itself. | `entity_id` (required), `hours`, `limit` |
| `get_statistics` | read | Long term statistics such as energy use, or a list of what is available. | `statistic_ids`, `query`, `period`, `hours`, `start`, `end`, `types`, `max_points` |
| `get_calendar_events` | read | Lists calendars or events in a time window. | `entity_id`, `start`, `end`, `max_items` |
| `get_todo_items` | read | Reads a to-do list. | `entity_id` (required), `status` |
| `get_forecast` | read | Weather forecast from a weather entity. | `entity_id` (required), `type`, `max_items` |
| `get_camera_snapshot` | read | Fetches a camera picture and returns it as an image. | `entity_id` (required) |
| `wait_for_state` | read | Waits until an entity reaches a state, to confirm a command worked. | `entity_id` (required), `state`, `timeout_s` |
| `get_system_log` | read | Grouped warnings and errors with counts. | `level`, `query`, `limit` |

Examples of how to ask:

* `get_home_overview`: "Give me an overview of the house."
* `find_problems`: "Is anything wrong in my house?"
* `explain_state_change`: "Why did the kitchen light turn off?"
* `get_statistics`: "How much energy did the dishwasher use this week?"
* `get_calendar_events`: "What is on the family calendar this week?"
* `get_todo_items`: "What is on the shopping list?"
* `get_forecast`: "What is the weather forecast for the next few days?"
* `get_camera_snapshot`: "Show me the front door camera."
* `wait_for_state`: "Turn on the lamp and tell me when it is actually on."
* `get_system_log`: "What keeps erroring in the log?"

### Controlling things

| Tool | Risk | What it does | Inputs |
| --- | --- | --- | --- |
| `call_service` | gated | Runs any Home Assistant service. Low risk calls run at once, high risk ones need the two step approval. | `domain` (required), `service` (required), `entity_id`, `target`, `data`, `return_response` |

Examples of how to ask:

* `call_service`: "Turn off the hall lights. / Unlock the front door."

### Automations

| Tool | Risk | What it does | Inputs |
| --- | --- | --- | --- |
| `list_automations` | read | Lists automations with state, last run and config id. | `query`, `limit` |
| `get_automation` | read | Reads one automation's full config and flags any high risk actions inside it. | `automation_id` (required) |
| `validate_automation_config` | read | Checks a draft automation without saving anything. | `config` (required) |
| `save_automation` | gated | Creates or updates an automation. Validated, backed up and rolled back automatically if Home Assistant objects. | `automation_id`, `config` (required) |
| `delete_automation` | gated | Permanently deletes an automation. Always high risk. | `automation_id` (required) |
| `get_automation_trace` | read | Debugs a run: last step reached, failed conditions, errors and a plain English diagnosis. | `automation_id` (required), `run_id`, `only_failed`, `runs_limit` |
| `reload_automations` | low | Reloads automations without a restart, after checking the config is valid. | none |

Examples of how to ask:

* `list_automations`: "List my automations that mention heating."
* `get_automation`: "Show me the Morning lights automation."
* `validate_automation_config`: "Check this automation before we save it."
* `save_automation`: "Create an automation that turns on the porch light at sunset."
* `delete_automation`: "Delete the old test automation."
* `get_automation_trace`: "Why did my morning automation not run?"
* `reload_automations`: "Reload automations."

### Scripts

| Tool | Risk | What it does | Inputs |
| --- | --- | --- | --- |
| `list_scripts` | read | Lists scripts. | `query`, `limit` |
| `get_script` | read | Reads one script's config. | `script_id` (required) |
| `validate_script_config` | read | Checks a draft script without saving. | `config` (required) |
| `save_script` | gated | Creates or updates a script, with the same safeguards as automations. | `script_id`, `config` (required) |
| `delete_script` | gated | Permanently deletes a script. Always high risk. | `script_id` (required) |
| `get_script_trace` | read | Debugs a script run. | `script_id` (required), `run_id`, `only_failed`, `runs_limit` |
| `reload_scripts` | low | Reloads scripts without a restart. | none |

Examples of how to ask:

* `list_scripts`: "What scripts do I have?"
* `get_script`: "Show me the goodnight script."
* `validate_script_config`: "Validate this script."
* `save_script`: "Create a script that dims the lights for a film."
* `delete_script`: "Delete the script called test_script."
* `get_script_trace`: "Why did the goodnight script fail last night?"
* `reload_scripts`: "Reload scripts."

### Helpers

| Tool | Risk | What it does | Inputs |
| --- | --- | --- | --- |
| `list_helpers` | read | Lists UI made helpers: toggles, numbers, text, dropdowns, dates, counters, timers and schedules. | `helper_type` |
| `create_helper` | low | Creates a new helper. Low risk. | `helper_type` (required), `config` (required) |
| `update_helper` | gated | Changes an existing helper. High risk because automations may depend on it. | `helper_type` (required), `helper_id` (required), `config` (required) |
| `delete_helper` | gated | Deletes a helper. High risk. | `helper_type` (required), `helper_id` (required) |

Examples of how to ask:

* `list_helpers`: "List my helpers."
* `create_helper`: "Create a toggle called Guest mode."
* `update_helper`: "Change the maximum of the target temperature helper to 25."
* `delete_helper`: "Delete the Guest mode helper."

### Dashboards

| Tool | Risk | What it does | Inputs |
| --- | --- | --- | --- |
| `list_dashboards` | read | Lists dashboards. | none |
| `get_dashboard` | read | Reads a dashboard as a summary, one view, or everything. | `url_path`, `view`, `full` |
| `save_dashboard` | gated | Saves a whole dashboard config. Overwriting is high risk. | `url_path`, `config` (required) |
| `save_dashboard_view` | gated | Adds or replaces a single view without touching the rest. | `url_path`, `view` (required), `position` |
| `create_dashboard` | low | Creates a new empty dashboard. Low risk. | `url_path` (required), `title` (required), `icon`, `show_in_sidebar`, `require_admin` |
| `delete_dashboard` | gated | Deletes a dashboard. High risk. | `url_path` (required) |
| `delete_dashboard_config` | gated | Resets a dashboard to auto generated. High risk. | `url_path` |

Examples of how to ask:

* `list_dashboards`: "What dashboards do I have?"
* `get_dashboard`: "Show the Kitchen view of my My House dashboard."
* `save_dashboard`: "Rebuild my Overview dashboard."
* `save_dashboard_view`: "Add a Garage view to the My House dashboard."
* `create_dashboard`: "Create a dashboard called Energy."
* `delete_dashboard`: "Delete the Test dashboard."
* `delete_dashboard_config`: "Reset the Overview dashboard to auto generated."

### Areas, floors, labels, devices, entities and zones

| Tool | Risk | What it does | Inputs |
| --- | --- | --- | --- |
| `list_registry` | read | Lists areas, floors, labels, devices, entities or zones. | `registry` (required), `query`, `fields`, `max_items` |
| `find_related` | read | Shows what uses an item, before you change it. | `item_type` (required), `item_id` (required) |
| `manage_registry` | gated | Creates, updates or deletes registry items. Renames, disabling and deletes are high risk. | `registry` (required), `action` (required), `id`, `fields` |

Examples of how to ask:

* `list_registry`: "List all my labels."
* `find_related`: "What uses the garage area?"
* `manage_registry`: "Create a label called Energy hog and put it on the tumble dryer plug."

### Scenes

| Tool | Risk | What it does | Inputs |
| --- | --- | --- | --- |
| `list_scenes` | read | Lists scenes. | `query` |
| `get_scene` | read | Reads a scene and flags high risk entities in it. | `scene_id` (required) |
| `save_scene` | gated | Creates or updates a scene. | `scene_id`, `config` (required) |
| `delete_scene` | gated | Deletes a scene. High risk. | `scene_id` (required) |

Examples of how to ask:

* `list_scenes`: "List my scenes."
* `get_scene`: "What does the Movie night scene do?"
* `save_scene`: "Make a scene that turns the living room lights to 30 percent."
* `delete_scene`: "Delete the old movie scene."

### Blueprints

| Tool | Risk | What it does | Inputs |
| --- | --- | --- | --- |
| `list_blueprints` | read | Lists installed blueprints and their inputs. | `domain` |
| `import_blueprint` | gated | Installs a blueprint from a URL after showing you its source. High risk. | `url` (required), `allow_override` |
| `delete_blueprint` | gated | Removes an installed blueprint. High risk. | `domain` (required), `path` (required) |

Examples of how to ask:

* `list_blueprints`: "Which blueprints are installed?"
* `import_blueprint`: "Import the blueprint at this GitHub link."
* `delete_blueprint`: "Remove the unused motion light blueprint."

### Integrations and repairs

| Tool | Risk | What it does | Inputs |
| --- | --- | --- | --- |
| `list_integrations` | read | Lists configured integrations and which have problems. | `domain`, `query`, `problems_only`, `max_items` |
| `manage_config_entry` | gated | Reloads, enables, renames, disables or removes an integration. Disable and remove are high risk. | `entry_id` (required), `action` (required), `title` |
| `run_config_flow` | gated | Walks through a setup form step by step, as the UI does. | `action` (required), `flow_type`, `handler`, `flow_id`, `user_input` |
| `list_repairs` | read | Lists issues from Settings, Repairs. | `include_ignored` |
| `ignore_repair` | low | Hides or restores a repair issue. | `domain` (required), `issue_id` (required), `ignore` |

Examples of how to ask:

* `list_integrations`: "Which integrations failed to load?"
* `manage_config_entry`: "Reload the MQTT integration."
* `run_config_flow`: "Start setting up a new Group helper."
* `list_repairs`: "What repairs does Home Assistant want?"
* `ignore_repair`: "Ignore that repair."

### System and maintenance

| Tool | Risk | What it does | Inputs |
| --- | --- | --- | --- |
| `get_ha_config` | read | Basic facts about the instance, plus which address this server is using. A good first connection test. | `include_components` |
| `check_config` | read | Asks Home Assistant to validate its configuration. | none |
| `get_error_log` | read | The tail of the log, filterable by level or text. | `lines`, `filter`, `level` |
| `get_system_health` | read | The per integration health report. | none |
| `restart_home_assistant` | gated | Restarts Home Assistant after checking the config. High risk. | none |
| `stop_home_assistant` | gated | Shuts Home Assistant down. High risk, and it cannot be started again from here. | none |
| `list_backups` | read | Lists the rollback copies this server took before changes. | `kind`, `item_id`, `limit` |
| `restore_backup` | gated | Puts an automation, script, scene, dashboard, helper or registry item back to a saved version. High risk. | `backup_id` (required) |
| `get_audit_log` | read | Reads back what this server changed or refused. | `limit`, `tool`, `executed_only` |

Examples of how to ask:

* `get_ha_config`: "Check you can reach Home Assistant."
* `check_config`: "Is my Home Assistant configuration valid?"
* `get_error_log`: "Show recent errors that mention mqtt."
* `get_system_health`: "How healthy is my Home Assistant?"
* `restart_home_assistant`: "Restart Home Assistant."
* `stop_home_assistant`: "Shut down Home Assistant."
* `list_backups`: "What backups have you taken?"
* `restore_backup`: "Undo that last dashboard change."
* `get_audit_log`: "What have you changed today?"

### Raw API access (anything else)

| Tool | Risk | What it does | Inputs |
| --- | --- | --- | --- |
| `ha_ws_read` | read | Any read only WebSocket command. | `type` (required), `params`, `max_items`, `fields`, `collect_ms` |
| `ha_ws_write` | gated | Any other WebSocket command. Always high risk. | `type` (required), `params` |
| `ha_rest_read` | read | Any REST GET. | `path` (required), `method`, `query`, `body`, `max_items`, `fields` |
| `ha_rest_write` | gated | Any REST POST, PUT, PATCH or DELETE. Always high risk. | `method` (required), `path` (required), `query`, `body` |

Examples of how to ask:

* `ha_ws_read`: "Read the energy preferences."
* `ha_rest_read`: "Fetch /api/calendars."

### Supervisor (Home Assistant OS and Supervised only)

| Tool | Risk | What it does | Inputs |
| --- | --- | --- | --- |
| `get_supervisor_info` | read | Supervisor, core, OS and host versions and disk space. Needs Home Assistant OS or Supervised. | none |
| `list_addons` | read | Installed add-ons. | `query` |
| `get_addon_logs` | read | An add-on's recent log. | `slug` (required), `lines`, `filter` |
| `list_ha_backups` | read | Home Assistant's own full backups. | none |
| `create_ha_backup` | low | Starts a full backup. Low risk. | `name` |
| `manage_addon` | gated | Starts, stops, restarts or updates an add-on. Only start is low risk. | `slug` (required), `action` (required) |

Examples of how to ask:

* `get_supervisor_info`: "How much disk space does the host have?"
* `list_addons`: "Which add-ons are installed?"
* `get_addon_logs`: "Show the Mosquitto add-on log."
* `list_ha_backups`: "When was my last backup?"
* `create_ha_backup`: "Take a full backup."
* `manage_addon`: "Restart the Zigbee2MQTT add-on."

## Safety model

Every tool is classified as read, low risk, dynamic (decided per call) or high risk.

* **Read only switch.** Described at the top. It is enforced at registration time, so it cannot be bypassed by clever prompting.
* **Two step approval for high risk actions.** High risk includes locks, alarms, climate, water heaters, valves, garage and gate covers, appliance like switches, restarts, deletes, overwrites, anything that targets a whole area or all entities, and any script, automation or scene that contains one of these. The preview returns a plan and a single use token bound to the tool and the exact arguments. It expires after 10 minutes and cannot be replayed.
* **Human approval prompt.** If the client supports MCP elicitation, a prompt can ask you directly before a high risk action runs. `HA_REQUIRE_APPROVAL_PROMPT=true` makes that mandatory, and clients that cannot show prompts are refused.
* **Never touch list.** `HA_NEVER_TOUCH` patterns are never changed, even with approval, and saved automations that reference them are refused.
* **Validation, backup and rollback.** Config writes are checked locally, by Home Assistant, and again by a configuration check. The old version is saved, and a failed check after a write reverts the change.
* **Audit log.** Every non read call, including previews and refusals, is written to a JSONL file. `get_audit_log` reads it back. Tokens and credentials are never stored.
* **Credential redaction.** The access token, camera tokens and similar secrets are removed from every output.
* **Untrusted data.** Names, logs and calendar text from Home Assistant may contain text written by someone else. The server tells the model to treat it as data and never as instructions.

None of this is a guarantee. The approval flow depends on the model and client behaving. That is why read only mode is the recommended default.

## What has and has not been tested

This is a beta. The automated suite (97 checks against an in-memory mock Home Assistant) passes. In addition, I ran it against a real Home Assistant 2026.10 Docker install: every read tool, and the write tools using throwaway items that were cleaned up afterwards.

**Not yet tried on a real instance:**

* Anything in the Supervisor group (add-ons, host info, Home Assistant backups). A Docker install has no Supervisor, so these are tested only against the mock.
* Changing real config entries (`manage_config_entry`) and running setup flows (`run_config_flow`).
* Importing a blueprint from a URL.
* Ignoring repairs.
* Camera snapshots, weather forecasts and to-do lists.

Known rough edge: on installs with many unavailable entities, `find_problems` can produce a very long list. Use `HA_IGNORE_UNAVAILABLE` to quiet entities you do not care about.

## Build from source

You need Node.js 18.17 or newer.

```bash
git clone https://github.com/YOUR-NAME/ha-mcp-server.git
cd ha-mcp-server
npm install
npm test          # builds, checks the manifest, runs the end to end tests
npm run bundle    # writes home-assistant-mcp-0.2.1.mcpb
```

To run from source against your instance:

```bash
HA_URL=http://192.168.1.50:8123 HA_TOKEN=your_token HA_READ_ONLY=true npm start
```

The tests use a mock Home Assistant and never touch a real one.

## Troubleshooting

* **401 Unauthorized.** The token is wrong, was revoked, or has stray spaces or quotes. Create a new long-lived token and paste it again. Make sure it is from the same Home Assistant as the URL.
* **It uses the wrong address.** The first log line shows the URL in use. Check the extension settings (or `HA_URL`) and restart the client.
* **Cannot reach Home Assistant.** Open the URL in a browser from the same computer. Check firewalls, and use the IP address if `homeassistant.local` does not resolve.
* **Self-signed certificate errors.** Set `HA_INSECURE_TLS=true`, or better, use a proper certificate.
* **A tool is missing.** Either read only mode is on, or its toolset is switched off. The Supervisor group is off by default.
* **Supervisor tools say it is not available.** Your install has no Supervisor (Docker or Core). That is expected.
* **The model keeps asking for confirmation.** That is the design for high risk actions. Say yes to the plan and it will proceed.
* **A local model calls the wrong tools.** Switch off toolsets you do not need, or use a stronger model.

Logs go to stderr. In Claude Desktop they are in the extension's log file. In LM Studio they appear in the MCP log area.

## Project layout

```
src/
  index.ts          Entry point: starts the MCP server on stdio
  config.ts         Reads the settings
  ha-client.ts      REST client and the persistent WebSocket client
  safety.ts         Risk rules and the two step approval gate
  plan.ts           Single use plan tokens
  audit.ts          Audit log
  backup.ts         Rollback store
  resources.ts      Automation and script config access and validation
  util.ts           Result helpers, diffing, secret redaction
  tools/            One file per group of tools
scripts/
  sync-manifest.mjs Keeps manifest.json in step with the real tool list
  bundle.mjs        Builds the .mcpb
test/
  mock-ha.mjs       A fake Home Assistant for tests
  smoke.mjs         The end to end test suite
```

## Licence

MIT. See `LICENSE`. This project is not affiliated with Nabu Casa or the Home Assistant project.
