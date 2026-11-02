# Changelog

## 0.2.1 (beta)

First public beta.

* 42 tools by default, in read only mode. Ticking Allow controlling devices gives 43, Allow editing setup on its own gives 67, and both give 68. The four raw API tools are off by default and bring those to 44, 45, 69 and 72 when switched on. The optional Supervisor group adds up to 6 more.
* Core: discovery, templates, service calls, automations, scripts, helpers, diagnostics, backups and rollback, audit log.
* Config toolset: dashboards, registries (areas, floors, labels, devices, entities, zones), scenes, blueprints, integrations, repairs.
* Insights toolset: home overview, problem finder, state change explainer, statistics, calendars, to-do lists, forecasts, camera snapshots, wait for state, grouped system log.
* Raw toolset (off by default): REST and WebSocket read and write tools.
* Optional Supervisor toolset (Home Assistant OS and Supervised only).
* Allow controlling devices (`HA_ALLOW_CONTROL`): read everything and operate everyday devices (lights, plugs, fans, blinds, media players and helpers), with no tools that edit automations, scripts, scenes, helpers, dashboards or settings.
* Allow editing setup (`HA_ALLOW_EDIT`): change automations, scripts, scenes, helpers, dashboards, registries and settings, with approval. On its own it cannot operate devices. Ticking both boxes gives full access. The README has a full section on the access settings and how they interact.
* Safe by default. With nothing configured the server starts in read only mode. Access is two independent opt-in settings, both off by default: `HA_ALLOW_CONTROL` (operate devices) and `HA_ALLOW_EDIT` (change automations, scripts, helpers, dashboards and settings). Each adds its own ability, and both together give full access. The raw write tools need both. The approval prompt requirement is on, and the raw and Supervisor tools are off.
* When a request is blocked by a setting, the assistant is told why and which setting to change. A briefing is sent when the server connects, and refusal messages include the fix.
* Safety: read only by default, two step approval with single use plan tokens, optional human approval prompt, never touch list, validation, backups, automatic rollback, audit log, secret redaction.
* Token errors show the token length and a short SHA-256 fingerprint, so a cut-off or mistyped token is easy to spot without revealing it.
* Extensive plain language comments throughout the source.
* Known gaps: see "What has and has not been tested" in the README.
