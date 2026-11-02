# Home Assistant MCP Server (beta)

> **This is a beta, version 0.2.1.** It works well against a real Home Assistant 2026.10 instance, but some write paths have not been tried on real hardware (see [What has and has not been tested](#what-has-and-has-not-been-tested)). Please start in read only mode, keep backups of your Home Assistant, and report anything odd as a GitHub issue.

A Model Context Protocol (MCP) server that lets an AI assistant look at, understand and (if you allow it) change your Home Assistant. It has 72 tools by default (44 of them in read only mode, 45 in control only mode, and 78 with the optional Supervisor group switched on), covering entities, areas, history, automations, scripts, helpers, dashboards, scenes, blueprints, integrations, repairs, diagnostics and a raw API escape hatch.

It works with any MCP client that can launch a local program over stdio, for example Claude Desktop and LM Studio.

## Contents

1. [Tested with](#tested-with)
2. [Read this first: read only mode](#read-this-first-read-only-mode)
3. [What it can do](#what-it-can-do)
4. [Install in Claude Desktop](#install-in-claude-desktop)
5. [Explode the MCPB and run it by hand](#explode-the-mcpb-and-run-it-by-hand)
6. [Use it with LM Studio](#use-it-with-lm-studio)
7. [Configuration reference](#configuration-reference)
8. [How the settings work together](#how-the-settings-work-together)
9. [How to use it](#how-to-use-it)
10. [The tools, one by one](#the-tools-one-by-one)
11. [Safety model](#safety-model)
12. [What has and has not been tested](#what-has-and-has-not-been-tested)
13. [Build from source](#build-from-source)
14. [Troubleshooting](#troubleshooting)
15. [Project layout](#project-layout)
16. [Licence](#licence)

## Tested with

Home Assistant 2026.10.1 (Container install, Docker). Other versions are untested, so older releases may behave differently.

## Read this first: read only mode

There is one switch that matters more than all the others: **read only mode** (`HA_READ_ONLY=true`, or the "Read only mode" checkbox in Claude Desktop).

With it on, every tool that could change anything is not registered at all. The model cannot call them because they do not exist. It can still look at everything.

My advice: **install it, leave read only on, and explore for a while.** Only turn it off when you know what you want to do with it.

### Control only mode: switch things on and off, nothing else

If read only is too strict, there is a middle setting called **control only mode** (`HA_CONTROL_ONLY=true`, or the "Control only mode" checkbox in Claude Desktop). It is meant for everyday use by a basic user.

| | Read only | Control only | Full (neither set) |
| --- | --- | --- | --- |
| Look at everything | yes | yes | yes |
| Switch lights, plugs, fans, blinds and media players | no | **yes** | yes |
| Create, edit or delete automations, scripts, scenes and helpers | no | no | yes |
| Change dashboards, areas, labels, devices or integrations | no | no | yes |
| Restart or stop Home Assistant | no | no | yes |
| Locks, alarms and heating | no | no | yes, with approval |
| Raw API write tools | no | no | yes, with approval |
| Tools available | 44 | 45 | 72 |

In control only mode, every tool that can edit or break something is not registered, exactly as in read only mode. The one writing tool left is `call_service`, and it is limited to these everyday domains: `light`, `switch`, `fan`, `cover`, `media_player`, `humidifier`, `vacuum`, `remote`, `button`, `number`, `select`, `scene` (activating only), `input_boolean`, `input_button`, `input_number` and `input_select` (values only).

Anything else is refused outright, with no approval route. That includes locks, alarm panels, climate, scripts, automations, notifications, restarting Home Assistant, and services that change how things are set up (reload, create, delete, apply, and editing dropdown options). Targeting by label is also refused. The generic `homeassistant.turn_on`, `turn_off` and `toggle` are allowed, but only for named entities in the everyday domains.

Calls that are allowed but risky, such as switching a washing machine plug or a whole area at once, still go through the normal two step approval. The never touch list still applies. If you tick both read only and control only, **read only wins**.

This is the recommended mode once you have finished exploring in read only mode and you just want to say "turn off the kitchen light".

### A serious warning for LM Studio and other local models

The safeguards in this server (preview first, single use plan tokens, the never touch list, backups) are good, but they rely on the model following instructions and on the client showing you what is going on. Claude is trained to respect those instructions. Many local models are not reliable at this. They can misread a plan, repeat a confirmation call on their own, invent entity names, or get talked into things by text they find inside your Home Assistant (an entity name, a calendar entry, a log line).

If you use this with LM Studio or any local model:

* **Keep `HA_READ_ONLY=true`.** Treat it as the normal way to run it. If you want it to switch lights and plugs, use `HA_CONTROL_ONLY=true` instead, which still blocks every change to automations, scripts and settings.
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
2. Open Claude Desktop, go to Settings, then Extensions, and drag the file in (or double click it). You can also double click the file in Finder or File Explorer.
3. The extension appears as **Home Assistant (full control)**. Click **Install** and fill in the settings form. Every field is explained below.
4. Make sure the extension is switched **Enabled**, then start a new chat and ask: "Check you can reach Home Assistant."

Claude Desktop shows the server's log if something goes wrong. The first log line tells you which URL it is using and how long the token is (never the token itself).

### Every setting in the Claude Desktop form

The form has 13 settings, in this order. Only the first two are required. Everything else is optional. The last column is the name the same setting has in LM Studio's `mcp.json`, described in [Use it with LM Studio](#use-it-with-lm-studio).

| # | Setting in the form | Default | LM Studio `env` name |
| --- | --- | --- | --- |
| 1 | Home Assistant URL | none, required | `HA_URL` |
| 2 | Long-lived access token | none, required | `HA_TOKEN` |
| 3 | Read only mode | off | `HA_READ_ONLY` |
| 4 | Control only mode | off | `HA_CONTROL_ONLY` |
| 5 | Allow self signed certificates | off | `HA_INSECURE_TLS` |
| 6 | Extra high risk entities | empty | `HA_HIGH_RISK_ENTITIES` |
| 7 | Never touch entities | empty | `HA_NEVER_TOUCH` |
| 8 | Require an approval prompt for high risk actions | off | `HA_REQUIRE_APPROVAL_PROMPT` |
| 9 | Dashboards, registries, scenes, blueprints and integrations | on | `HA_ENABLE_CONFIG` |
| 10 | Insight tools | on | `HA_ENABLE_INSIGHTS` |
| 11 | Raw API tools | on | `HA_ENABLE_RAW` |
| 12 | Supervisor tools | off | `HA_ENABLE_SUPERVISOR` |
| 13 | Entities expected to be unavailable | empty | `HA_IGNORE_UNAVAILABLE` |

**1. Home Assistant URL (required).** The address of your Home Assistant, including the port, for example `http://192.168.1.50:8123` or `http://homeassistant.local:8123`. A trailing slash is removed for you, and if you leave off `http://` it is added. If you change this later, the new address takes effect after Claude Desktop restarts the extension. Use the IP address if `homeassistant.local` does not work from your computer.

**2. Long-lived access token (required).** In Home Assistant, click your name at the bottom left to open your profile, open the **Security** tab, scroll to the bottom and click **Create token**. Give it a name such as `Claude MCP`, and copy it straight away because Home Assistant only shows it once. Claude Desktop stores it in your operating system keychain, not in a plain file. Quotes, a pasted `Bearer ` prefix and stray spaces or line breaks are removed for you. Make a token just for this extension so you can revoke it separately.

**3. Read only mode.** Only tools that cannot change anything are available. Claude can look at everything but cannot change a thing. **Recommended for a first try**, and not ticked by default, so tick it yourself. When on, 44 tools are available.

**4. Control only mode.** For everyday use. Claude can read everything and switch lights, plugs, fans, blinds, media players and similar devices, but cannot change automations, scripts, scenes, helpers, dashboards or settings, and cannot control locks, alarms or heating. 45 tools are available. It is ignored if Read only mode is ticked. Full details are in [Control only mode](#control-only-mode-switch-things-on-and-off-nothing-else).

**5. Allow self signed certificates.** Skips certificate checking. Only needed if your Home Assistant address starts with `https://` and uses a self-signed certificate, and only on a network you trust. Leave it off for plain `http://` addresses, where it does nothing.

**6. Extra high risk entities.** A comma separated list of entity id patterns that should **always need approval** before being changed, for example `switch.workshop_*, light.pool_pump`. A `*` matches anything. Case does not matter. This adds to the built in rules (locks, alarms, heating, garage doors and so on) and never loosens them.

**7. Never touch entities.** A comma separated list of entity id patterns that this server must **never change, even with approval**, for example `lock.front_door, alarm_control_panel.*, cover.garage_*`. This also covers entities reached through an area or device, and automations that reference them cannot be saved. It is the best protection for anything you could not bear to have changed, so use it, especially for garage doors and gates in control only mode.

**8. Require an approval prompt for high risk actions.** When on, a high risk action only runs if Claude can show you an approval prompt and you accept it. A client that cannot show prompts is refused. Leave it off if you are happy with Claude's normal preview and confirm step. Turn it on for extra safety with Claude Desktop. Do not turn it on for LM Studio unless you know it supports prompts.

**9. Dashboards, registries, scenes, blueprints and integrations.** On by default. Tools to manage dashboards, areas, floors, labels, devices, entities, zones, scenes, blueprints, integrations and repairs. Switch it off to give Claude fewer tools. The read tools in this group go with it.

**10. Insight tools.** On by default. The home overview, problem finder, state change explainer, statistics, calendar, to-do list, forecast, camera snapshot, wait for state and system log tools. All of them are read tools.

**11. Raw API tools.** On by default. Generic tools that can call any REST or WebSocket endpoint, for anything the other tools do not cover. Writes through them still need the two step approval, but they are the most powerful and least guarded tools here. Switch them off if you want a tighter setup.

**12. Supervisor tools.** Off by default. Add-ons, Home Assistant backups and host information. They **only work on Home Assistant OS or Supervised installs**. On Docker or Core installs there is no Supervisor, so leave this off.

**13. Entities expected to be unavailable.** A comma separated list of entity id patterns that the problem finder and the home overview should **not** report as unavailable, for example `light.*, switch.garage_*`. Useful if you have devices that are often switched off at the wall. It only affects reporting, not what Claude can do.

### Suggested settings for Claude Desktop

| What you want | Settings to tick |
| --- | --- |
| Look around safely (start here) | Read only mode on, everything else as it came |
| Everyday control | Control only mode on. Fill in **Never touch entities** with your locks, alarms and garage doors. |
| Full control for a specific job | Read only and Control only both off. Fill in **Never touch entities**. Consider turning Raw API tools off. |

How these combine is explained in [How the settings work together](#how-the-settings-work-together).

### Changing settings later

Open Claude Desktop, go to Settings, then Extensions, choose **Home Assistant (full control)** and open its settings (the button is usually labelled **Configure**). Change what you need, save, and restart the extension (or Claude Desktop) if it does not restart itself. Mode changes only take effect when the server restarts, so a quick check is to ask Claude how many Home Assistant tools it has, or to look at the first lines of the extension log, which say `READ ONLY mode`, `CONTROL ONLY mode`, or neither.

## Explode the MCPB and run it by hand

An `.mcpb` file is just a zip file with a different name. Inside is a `manifest.json` and the compiled server with all its dependencies. Claude Desktop opens it for you, but any other client (LM Studio, for example) needs you to open it yourself and point the client at the files. This section shows how, step by step.

### Step 1: Make sure Node.js is installed

The server is a Node.js program. You need **Node.js 18.17 or newer**.

```bash
node --version
```

If you see `v18.17.0` or higher, you are fine. If the command is not found, or the version is older, install the current LTS version from https://nodejs.org and open a new terminal.

Now find out **exactly where Node lives**, because you will need that path later:

```bash
which node          # macOS and Linux
where node          # Windows
```

Write down the answer. Typical results are `/opt/homebrew/bin/node` (Mac with Homebrew), `/usr/local/bin/node`, or `C:\Program Files\nodejs\node.exe` (Windows).

### Step 2: Choose a permanent folder

Pick a folder where the server can live **permanently**. LM Studio will launch it from there every time, so do not use Downloads or the Desktop, and do not move it later without updating the config. Good choices:

| System | Suggested folder |
| --- | --- |
| macOS | `/Users/yourname/mcp-servers/home-assistant` |
| Linux | `/home/yourname/mcp-servers/home-assistant` |
| Windows | `C:\mcp-servers\home-assistant` |

Create it:

```bash
# macOS and Linux
mkdir -p ~/mcp-servers/home-assistant
```

```powershell
# Windows PowerShell
mkdir C:\mcp-servers\home-assistant
```

### Step 3: Unpack the .mcpb into that folder

Download `home-assistant-mcp-0.2.1.mcpb` from the GitHub release page. Then use **one** of these methods.

**Method A: the MCPB tool (any system with Node)**

```bash
npx @anthropic-ai/mcpb unpack ~/Downloads/home-assistant-mcp-0.2.1.mcpb ~/mcp-servers/home-assistant
```

**Method B: unzip (macOS and Linux)**

```bash
unzip ~/Downloads/home-assistant-mcp-0.2.1.mcpb -d ~/mcp-servers/home-assistant
```

**Method C: Windows**

1. Copy `home-assistant-mcp-0.2.1.mcpb` somewhere handy.
2. Rename it to `home-assistant-mcp-0.2.1.zip`. (If you cannot see the `.mcpb` ending, turn on "File name extensions" in the File Explorer View menu.)
3. Right click it, choose **Extract All**, and pick `C:\mcp-servers\home-assistant`.

### Step 4: Check the result

The folder should now contain these items directly inside it, not inside an extra subfolder:

```
home-assistant/
  manifest.json        what the bundle is and which settings it takes
  package.json
  README.md
  LICENSE
  dist/
    index.js           the server itself. This is the file LM Studio will run.
  node_modules/        the dependencies, already installed
```

If you see `home-assistant/home-assistant-mcp-0.2.1/dist/index.js` or similar, the files went into an extra folder. Either move them up one level, or just use the longer path in the later steps. What matters is that you know the full path to `dist/index.js`.

There is **no `npm install` step**. Everything is already in the bundle.

Work out the full path to `dist/index.js` and write it down. On a Mac or Linux you can print it with:

```bash
cd ~/mcp-servers/home-assistant
echo "$(pwd)/dist/index.js"
```

### Step 5: Create a Home Assistant access token

Make a token just for this server, so you can revoke it separately without affecting anything else.

1. In Home Assistant, click your name at the bottom left of the sidebar to open your profile.
2. Open the **Security** tab.
3. Scroll to the very bottom, to **Long-lived access tokens**, and click **Create token**.
4. Name it something like `MCP server (LM Studio)`.
5. **Copy the token immediately.** Home Assistant only shows it once.

### Step 6: Try it from a terminal first

This checks that Node, the files, your address and your token all work, before LM Studio is involved. Use your own values.

macOS and Linux:

```bash
cd ~/mcp-servers/home-assistant
HA_URL="http://192.168.1.50:8123" HA_TOKEN="paste_token_here" HA_READ_ONLY="true" node dist/index.js
```

Windows PowerShell:

```powershell
cd C:\mcp-servers\home-assistant
$env:HA_URL="http://192.168.1.50:8123"
$env:HA_TOKEN="paste_token_here"
$env:HA_READ_ONLY="true"
node dist/index.js
```

You should see lines like these (they appear on the error stream, which is normal):

```
[ha-mcp] using HA_URL=http://192.168.1.50:8123 (websocket ws://192.168.1.50:8123/api/websocket), token length 183
[ha-mcp] v0.2.1 ready with 44 tools for http://192.168.1.50:8123 (READ ONLY mode)
[ha-mcp] connected to Home Assistant 2026.10.1 (Home)
```

Then it sits there silently. That is correct: it is waiting for an MCP client to talk to it. Press **Ctrl+C** to stop it.

If the third line says `WARNING: cannot reach Home Assistant`, or you see a 401 error, fix that now using the [Troubleshooting](#troubleshooting) section before going on.

## Use it with LM Studio

LM Studio (version 0.3.17 or later) can run local MCP servers. Please read the [warning above](#a-serious-warning-for-lm-studio-and-other-local-models) first. **Keep `HA_READ_ONLY` set to `"true"`.**

You need to have done the steps in the previous section, so that you have:

* the full path to `node`
* the full path to `dist/index.js`
* your Home Assistant address
* your long-lived access token

### Step 1: Open LM Studio's MCP config file

1. In LM Studio, open a chat.
2. Open the **Program** tab in the right hand sidebar (the plug icon).
3. Click **Install**, then **Edit mcp.json**.

This opens `mcp.json` in LM Studio's built in editor. The file lives here if you want to find it yourself:

| System | Location |
| --- | --- |
| macOS and Linux | `~/.lmstudio/mcp.json` |
| Windows | `%USERPROFILE%\.lmstudio\mcp.json` |

A fresh file contains `{ "mcpServers": {} }`.

### Step 2: Choose a mode and add the server

First decide how much the model is allowed to do. There are three choices, and they only differ in two `env` lines.

| Mode | `HA_READ_ONLY` | `HA_CONTROL_ONLY` | What the model can do | Tools you will see |
| --- | --- | --- | --- | --- |
| **A. Read only** (start here) | `"true"` | leave out | Look at everything. Change nothing. | 44 |
| **B. Control only** (everyday use) | `"false"` | `"true"` | Look at everything and switch lights, plugs, fans, blinds and media players. Cannot edit automations, scripts, scenes, helpers, dashboards or settings. | 45 |
| **C. Full** (rarely, with care) | `"false"` | leave out | Everything, with approval for risky actions. | 72 |

For the full detail of how these combine with the other settings, see [How the settings work together](#how-the-settings-work-together).

Put an entry for the server inside `mcpServers`. The examples below are mode A, the **safe starting configuration**. Replace the four values marked with angle brackets. The next sections show how to change it for modes B and C.

```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "<FULL PATH TO NODE>",
      "args": ["<FULL PATH TO dist/index.js>"],
      "env": {
        "HA_URL": "<YOUR HOME ASSISTANT ADDRESS>",
        "HA_TOKEN": "<YOUR TOKEN>",
        "HA_READ_ONLY": "true",
        "HA_NEVER_TOUCH": "lock.*,alarm_control_panel.*,cover.garage_*,cover.gate_*",
        "HA_ENABLE_RAW": "false"
      }
    }
  }
}
```

Here is the same thing filled in, for a Mac with Homebrew Node:

```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/yourname/mcp-servers/home-assistant/dist/index.js"],
      "env": {
        "HA_URL": "http://192.168.1.50:8123",
        "HA_TOKEN": "eyJhbGciOi...your_long_token...",
        "HA_READ_ONLY": "true",
        "HA_NEVER_TOUCH": "lock.*,alarm_control_panel.*,cover.garage_*,cover.gate_*",
        "HA_ENABLE_RAW": "false"
      }
    }
  }
}
```

And for Windows (note the forward slashes, which work everywhere and avoid escaping problems):

```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["C:/mcp-servers/home-assistant/dist/index.js"],
      "env": {
        "HA_URL": "http://192.168.1.50:8123",
        "HA_TOKEN": "eyJhbGciOi...your_long_token...",
        "HA_READ_ONLY": "true",
        "HA_NEVER_TOUCH": "lock.*,alarm_control_panel.*,cover.garage_*,cover.gate_*",
        "HA_ENABLE_RAW": "false"
      }
    }
  }
}
```

If the file already has other servers in it, add `"home-assistant": { ... }` alongside them, with a comma between entries. Do not paste a second `"mcpServers"` block.

### Rules for the JSON file

JSON is strict, and one mistake stops the whole file loading.

* **Every value is a string in double quotes**, including the true and false ones. Write `"HA_READ_ONLY": "true"`, never `true` without the quotes.
* No comments, and no comma after the last item in a block.
* Use straight quotes `"`, not curly quotes from a word processor.
* Lists, such as `HA_NEVER_TOUCH`, are **one string with the items separated by commas**. Do not use a JSON array.
* On Windows, use forward slashes in paths, or double every backslash (`C:\\mcp-servers\\...`).
* **Use the full path to Node in `command`.** On a Mac in particular, LM Studio is launched from the Dock and does not see the PATH from your terminal, so a bare `"node"` often fails with "spawn node ENOENT". The full path from `which node` avoids that. If you use nvm, use the full path it printed, for example `/Users/yourname/.nvm/versions/node/v20.11.0/bin/node`, and update it if you change Node versions.

### Step 3: Save and switch it on

1. Save the file (Cmd+S or Ctrl+S).
2. LM Studio reloads its MCP servers. In the Program tab you should see `home-assistant` with a toggle.
3. Switch the toggle on for the chat you want to use it in. Click the server to see its tools. In read only mode you should see **44 tools** (45 in control only mode). If you see 72 you are not in a restricted mode, so stop and check `HA_READ_ONLY` and `HA_CONTROL_ONLY`.
4. Choose a model that supports **tool use** (LM Studio marks these with a hammer icon).
5. Ask: "Check you can reach Home Assistant." The first time a tool is called, LM Studio asks you to approve the call. Read what it wants to do, and approve.

### Every setting you can put in `env`

This list matches the Claude Desktop form one to one. Each form setting has an `env` name, shown in the [table of Claude Desktop settings](#every-setting-in-the-claude-desktop-form). In LM Studio you write the names yourself, every value is a string in quotes, and the on and off settings are `"true"` and `"false"`. For the pattern settings (`HA_NEVER_TOUCH`, `HA_HIGH_RISK_ENTITIES`, `HA_IGNORE_UNAVAILABLE`), write one string with commas between patterns. A `*` matches anything, and case does not matter. Five settings are not in the Claude Desktop form (`HA_HIGH_RISK_DOMAINS`, `HA_BACKUP_DIR`, `HA_AUDIT_LOG`, `HA_TIMEOUT_MS` and `HA_MAX_OUTPUT_CHARS`), but you can use them in a manual setup like this one.

All of these are optional apart from `HA_URL` and `HA_TOKEN`. Every value must be a string. The mode settings (`HA_READ_ONLY` and `HA_CONTROL_ONLY`) decide which tools exist, and the rest decide how a risky call is handled. [How the settings work together](#how-the-settings-work-together) explains the order they are applied in.

| Name | Example value | What it does | Default if left out |
| --- | --- | --- | --- |
| `HA_URL` | `"http://192.168.1.50:8123"` | Your Home Assistant address. Include the port. A trailing slash is removed for you. **Required.** | none |
| `HA_TOKEN` | `"eyJhbGciOi..."` | Your long-lived access token. **Required.** | none |
| `HA_READ_ONLY` | `"true"` | `"true"` removes every tool that could change anything. **Always set this explicitly.** | **`false`, meaning writes are ON if you leave it out** |
| `HA_CONTROL_ONLY` | `"true"` | Lets the model switch lights, plugs, fans, blinds and media players, but removes every tool that edits automations, scripts, helpers, dashboards, scenes or settings. Ignored when `HA_READ_ONLY` is `"true"`. | `"false"` |
| `HA_NEVER_TOUCH` | `"lock.*,alarm_control_panel.*"` | Entities that can never be changed, even with approval. `*` matches anything. | empty |
| `HA_HIGH_RISK_ENTITIES` | `"switch.workshop_*,light.garage_*"` | Extra entities that always need the two step approval. | empty |
| `HA_HIGH_RISK_DOMAINS` | `"vacuum,media_player"` | Extra service domains to treat as high risk. | empty |
| `HA_REQUIRE_APPROVAL_PROMPT` | `"true"` | Makes a human approval prompt mandatory for risky actions. If the client cannot show one, the action is refused. | `"false"` |
| `HA_ENABLE_CONFIG` | `"false"` | Turns off the dashboards, registries, scenes, blueprints and integrations tools. | `"true"` |
| `HA_ENABLE_INSIGHTS` | `"false"` | Turns off the overview, problem finder, statistics, calendar and similar tools. | `"true"` |
| `HA_ENABLE_RAW` | `"false"` | Turns off the four raw API tools. **Recommended for local models.** | `"true"` |
| `HA_ENABLE_SUPERVISOR` | `"true"` | Adds the add-on and host tools. Only for Home Assistant OS or Supervised. | `"false"` |
| `HA_IGNORE_UNAVAILABLE` | `"sensor.old_*,switch.spare_*"` | Entities `find_problems` and the overview should not report as unavailable. | empty |
| `HA_INSECURE_TLS` | `"true"` | Skips certificate checks. Only for an `https://` address with a self-signed certificate. | `"false"` |
| `HA_BACKUP_DIR` | `"/Users/yourname/ha-backups"` | Where rollback copies are saved. | `~/.ha-mcp-server/backups` |
| `HA_AUDIT_LOG` | `"/Users/yourname/ha-audit.jsonl"` | Where the audit log is written. | `audit.jsonl` beside the backups folder |
| `HA_TIMEOUT_MS` | `"30000"` | How long to wait for Home Assistant before giving up, in milliseconds. | `"30000"` |
| `HA_MAX_OUTPUT_CHARS` | `"40000"` | The largest single tool reply, in characters. Lower it for models with small context windows. | `"40000"` |

Boolean settings accept `"true"`, `"1"`, `"yes"` or `"on"` as yes. Anything else counts as no.

### Mode B: everyday control (switch things on and off, nothing else)

Once you are happy with read only mode and want the model to control lights, plugs and so on, use control only mode. Compared with mode A, there are only two changes: `HA_READ_ONLY` becomes `"false"` and `HA_CONTROL_ONLY` is added.

```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/yourname/mcp-servers/home-assistant/dist/index.js"],
      "env": {
        "HA_URL": "http://192.168.1.50:8123",
        "HA_TOKEN": "eyJhbGciOi...your_long_token...",
        "HA_READ_ONLY": "false",
        "HA_CONTROL_ONLY": "true",
        "HA_NEVER_TOUCH": "lock.*,alarm_control_panel.*,cover.garage_*,cover.gate_*",
        "HA_ENABLE_RAW": "false"
      }
    }
  }
}
```

What to expect:

* In the Program tab you should see **45 tools**. If you see 72, the setting has not taken effect. If you see 44, read only is still on.
* The server log says `(CONTROL ONLY mode)`.
* The model can read everything and switch lights, plugs, fans, blinds and media players. It cannot edit automations, scripts, scenes, helpers, dashboards or settings. Those tools do not exist.
* Locks, alarms, heating, notifications and restarting Home Assistant are refused, not just gated.
* Allowed but risky calls, such as a washing machine plug or a whole area at once, need the two step approval. Do not add `HA_REQUIRE_APPROVAL_PROMPT` here unless LM Studio supports approval prompts, or those calls will be refused.
* Keep the `HA_NEVER_TOUCH` line. Control only mode does not exclude covers (so blinds work), which means garage doors and gates rely on the approval step and the never touch list for protection.
* If you set `HA_READ_ONLY` to `"true"` as well, **read only wins** and you are back to 44 tools.

Try it with something harmless: "Turn on the desk lamp, then turn it off again." Then try something it should refuse, such as "Create an automation that turns on the hall light at sunset". It should say that it cannot, because the tool is not available.

### Mode C: full access (be careful)

Remove `HA_CONTROL_ONLY` (or set it to `"false"`) and set `HA_READ_ONLY` to `"false"`. See [Turning full writes on](#turning-full-writes-on-be-careful) below for the rules.

### Switching between modes

Edit `mcp.json`, save, then switch the server off and on again in the Program tab. The mode is only read when the server starts. A quick check after every change: count the tools (44, 45 or 72).

### A complete example with every setting

This is for reference. It is **not** a recommended setup, since several values are the defaults. Delete the lines you do not need.

```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/yourname/mcp-servers/home-assistant/dist/index.js"],
      "env": {
        "HA_URL": "http://192.168.1.50:8123",
        "HA_TOKEN": "eyJhbGciOi...your_long_token...",
        "HA_READ_ONLY": "true",
        "HA_NEVER_TOUCH": "lock.*,alarm_control_panel.*,cover.garage_*,cover.gate_*",
        "HA_HIGH_RISK_ENTITIES": "switch.workshop_*",
        "HA_HIGH_RISK_DOMAINS": "vacuum",
        "HA_CONTROL_ONLY": "false",
        "HA_REQUIRE_APPROVAL_PROMPT": "false",
        "HA_ENABLE_CONFIG": "true",
        "HA_ENABLE_INSIGHTS": "true",
        "HA_ENABLE_RAW": "false",
        "HA_ENABLE_SUPERVISOR": "false",
        "HA_IGNORE_UNAVAILABLE": "sensor.old_*",
        "HA_INSECURE_TLS": "false",
        "HA_BACKUP_DIR": "/Users/yourname/.ha-mcp-server/backups",
        "HA_AUDIT_LOG": "/Users/yourname/.ha-mcp-server/audit.jsonl",
        "HA_TIMEOUT_MS": "30000",
        "HA_MAX_OUTPUT_CHARS": "20000"
      }
    }
  }
}
```

### Getting the best results from a local model

* **Pick a model that is good at tool calling.** Small models often choose the wrong tool, invent entity names or give up. Larger instruction-tuned models do much better.
* **Give the model a big context window.** The server describes up to 72 tools, which takes a lot of space before you even ask a question. Set a context length of at least 16,000 tokens in LM Studio, and more if you can.
* **Reduce the number of tools.** Fewer tools means fewer mistakes. A good small setup is read only with `HA_ENABLE_RAW` and `HA_ENABLE_CONFIG` both `"false"`. That leaves the discovery, insights, automation reading and system tools.
* **Lower `HA_MAX_OUTPUT_CHARS`** (for example to `"15000"`) if the model loses track in long answers.
* **Ask specific questions.** "What is the temperature in the office?" works better than "How is my house?"

### Turning full writes on (be careful)

For everyday switching, use control only mode above. Only go further if you really need the model to create or edit automations, scripts, scenes, dashboards or settings. If so, follow all of these rules.

1. Take a full Home Assistant backup first (Settings, System, Backups).
2. Fill in `HA_NEVER_TOUCH` with every lock, alarm, garage door, gate, oven, heater or anything else you could not bear to have changed.
3. Keep `HA_ENABLE_RAW` as `"false"`.
4. Change `HA_READ_ONLY` to `"false"` and make sure `HA_CONTROL_ONLY` is not `"true"`, save, and restart the server (switch it off and on in the Program tab).
5. Check the tool count has gone up to the 72 range, then try one harmless thing, such as turning a single lamp on and off.
6. Read every plan the model shows you before agreeing to it. Do not let a local model approve its own plans.
7. When the job is done, set `HA_READ_ONLY` back to `"true"`.

### Notes

* The token is stored as plain text in `mcp.json`. Anyone who can read that file can control your Home Assistant. Keep the file private, never post it online (including screenshots, forum posts and issues), and create a token just for this so you can delete it from Home Assistant at any time.
* If Home Assistant is on a different machine, the address must be reachable from the computer running LM Studio. Test by opening the address in a browser on that computer.
* The backups and audit log go in a hidden `.ha-mcp-server` folder in your home folder unless you change them.
* To **update** to a newer version, unpack the new `.mcpb` over the same folder (or into a new one and change the path in `mcp.json`), then switch the server off and on.
* To **remove** it, delete the `home-assistant` entry from `mcp.json`, delete the folder, and delete the token in Home Assistant.

### If something does not work in LM Studio

| What you see | Likely cause and fix |
| --- | --- |
| The server will not start, or `spawn node ENOENT` | `command` is wrong. Use the full path to Node from `which node`. |
| `Cannot find module` and a path | The `args` path is wrong. Check that `dist/index.js` really exists at that path. |
| `configuration error: HA_URL is not set` | The `env` block is missing or misspelled. |
| `401 Unauthorized` | Token is wrong, was deleted, or came from a different Home Assistant. Make a new one. |
| `Cannot reach Home Assistant` | Wrong address or port, or a firewall. Test the address in a browser. |
| The file will not save, or shows red marks | A JSON mistake such as a missing comma, a curly quote, or a trailing comma. |
| 72 tools appear when you expected 44 or 45 | `HA_READ_ONLY` is not `"true"` (or `HA_CONTROL_ONLY` is not `"true"`). If you left both out, full writes are on. |
| The model ignores the tools or answers wildly | The model does not support tool use well. Try a larger model or fewer tools. |

Other MCP clients (Cursor, Cline, Continue and so on) use the same idea: a `command` of `node` (preferably the full path), an `args` entry that points at `dist/index.js`, and the settings as `env` values.

## Configuration reference

These are environment variables. In Claude Desktop most are tick boxes and text boxes in the extension settings.

| Variable | Required | Meaning |
| --- | --- | --- |
| `HA_URL` | yes | Home Assistant address, for example `http://192.168.1.50:8123` |
| `HA_TOKEN` | yes | Long-lived access token |
| `HA_READ_ONLY` | no | `true` registers only read only tools. **Recommended.** If you leave it out, writes are ON. This is also the default in the Claude Desktop form, so tick it yourself. |
| `HA_CONTROL_ONLY` | no | `true` allows switching everyday devices (lights, plugs, fans, blinds, media players) but registers no tool that edits automations, scripts, helpers, dashboards, scenes or settings. Ignored if `HA_READ_ONLY` is `true`. |
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

## How the settings work together

Two things are decided, in this order. First, **which tools exist** when the server starts. Then, for each call to `call_service`, **what is allowed to happen**.

### 1. Which tools exist

| `HA_READ_ONLY` | `HA_CONTROL_ONLY` | Result | Tools |
| --- | --- | --- | --- |
| `true` | anything | Read tools only. Read only wins, so control only is ignored. | 44 |
| `false` or not set | `true` | Read tools plus `call_service` limited to everyday devices. | 45 |
| `false` or not set | `false` or not set | Everything. | 72 |

Note that **leaving `HA_READ_ONLY` out means writes are on.** Always set the mode you want explicitly.

The `HA_ENABLE_*` switches then remove whole groups of tools from whichever list you ended up with.

* `HA_ENABLE_RAW=false` removes the raw API tools. In the two restricted modes only the two raw read tools are affected.
* `HA_ENABLE_CONFIG=false` removes dashboards, registries, scenes, blueprints and integrations.
* `HA_ENABLE_INSIGHTS=false` removes the overview, problem finder, statistics and similar tools.
* `HA_ENABLE_SUPERVISOR=true` adds the add-on and host tools. In the restricted modes only their read tools appear.

None of the `HA_ENABLE_*` switches can bring a writing tool back in read only or control only mode.

### 2. What happens when `call_service` is used

This applies in control only mode and in full mode. Each call goes through these checks in order, and the first one that says no stops it.

1. **Does the service exist, with all its required fields?** If not, an error comes back.
2. **Control only allow list** (control only mode only). Anything outside the everyday device domains is refused outright. There is no way to confirm past this.
3. **Risk assessment.** The built in rules decide whether the call is low or high risk, together with your `HA_HIGH_RISK_ENTITIES` and `HA_HIGH_RISK_DOMAINS`. These settings can only make things stricter. They never loosen anything, and they cannot widen the control only allow list. Adding `media_player` to `HA_HIGH_RISK_DOMAINS` makes those calls need approval, and does not block them.
4. **Never touch list** (`HA_NEVER_TOUCH`). If any entity the call would affect matches, it is refused outright. That includes entities reached through an area or device target.
5. **Approval gate.** Low risk calls run straight away. High risk calls need a preview first, then the same call with `confirm: true`, `dry_run: false` and the plan token. If `HA_REQUIRE_APPROVAL_PROMPT=true`, a human approval prompt is also required, and a client that cannot show one is refused.

### What that means in practice

| Settings | Switch the kitchen light | Switch a washing machine plug | Unlock a door | Edit an automation |
| --- | --- | --- | --- | --- |
| `HA_READ_ONLY=true` | no tool | no tool | no tool | no tool |
| `HA_CONTROL_ONLY=true` | runs | needs approval | refused (not allowed) | no tool |
| `HA_CONTROL_ONLY=true` and `HA_REQUIRE_APPROVAL_PROMPT=true` | runs | refused unless the client can show a prompt | refused (not allowed) | no tool |
| Neither mode, `HA_NEVER_TOUCH=lock.*` | runs | needs approval | refused (never touch) | needs approval |
| Neither mode, nothing else set | runs | needs approval | needs approval | needs approval |

### Which settings to use

* **Just exploring:** `HA_READ_ONLY=true`.
* **Everyday switching for a basic user:** `HA_READ_ONLY=false`, `HA_CONTROL_ONLY=true`, and `HA_NEVER_TOUCH` listing your locks, alarms, garage doors and gates. Control only mode does not exclude covers, so the garage door and gates are protected by the approval step and by the never touch list.
* **Building and editing automations, scripts and dashboards:** both modes off. Do this deliberately, for a short job, and preferably with Claude rather than a local model.
* **LM Studio or any local model:** avoid `HA_REQUIRE_APPROVAL_PROMPT` unless you know your client supports prompts. If it does not, every risky call is refused. That is safe, but it can look like the server is broken.
* Settings such as `HA_URL`, `HA_TOKEN`, `HA_TIMEOUT_MS` and `HA_MAX_OUTPUT_CHARS` do not interact with any of the above.

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

In read only mode, anything that is not marked **read** does not exist. In control only mode the same is true, except for `call_service`, which is limited to everyday devices.


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
* **Control only mode.** Described near the top. Like read only mode it works by not registering the tools, and `call_service` is restricted to an allow list of everyday device domains.
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
git clone https://github.com/rilhia/ha-mcp-server.git
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
