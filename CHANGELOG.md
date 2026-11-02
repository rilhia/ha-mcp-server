# Changelog

## 0.2.1 (beta)

First public beta.

* 68 tools by default (42 in read only mode, 43 in control only mode). The four raw API tools are off by default, bringing the total to 72 when switched on, and 78 with the optional Supervisor group as well.
* Core: discovery, templates, service calls, automations, scripts, helpers, diagnostics, backups and rollback, audit log.
* Config toolset: dashboards, registries (areas, floors, labels, devices, entities, zones), scenes, blueprints, integrations, repairs.
* Insights toolset: home overview, problem finder, state change explainer, statistics, calendars, to-do lists, forecasts, camera snapshots, wait for state, grouped system log.
* Raw toolset (off by default): REST and WebSocket read and write tools.
* Optional Supervisor toolset (Home Assistant OS and Supervised only).
* Control only level (`HA_ACCESS_MODE` set to `control_only`): read everything and switch everyday devices (lights, plugs, fans, blinds, media players), with no tools that edit automations, scripts, scenes, helpers, dashboards or settings.
* Safe by default. With nothing configured the server starts in read only mode. The access level defaults to `read_only`, the approval prompt requirement is on, and the raw and Supervisor tools are off. One setting, `HA_ACCESS_MODE` (`read_only`, `control_only` or `full`), picks the mode, so contradictory combinations cannot be chosen. An unrecognised value falls back to `read_only`.
* When a request is blocked by a setting, the assistant is told why and which setting to change. A briefing is sent when the server connects, and refusal messages include the fix.
* Safety: read only level, two step approval with single use plan tokens, optional human approval prompt, never touch list, validation, backups, automatic rollback, audit log, secret redaction.
* Extensive plain language comments throughout the source.
* Known gaps: see "What has and has not been tested" in the README.
