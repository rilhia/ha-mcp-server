# Changelog

## 0.2.1 (beta)

First public beta.

* 72 tools by default, 78 with the optional Supervisor group.
* Core: discovery, templates, service calls, automations, scripts, helpers, diagnostics, backups and rollback, audit log.
* Config toolset: dashboards, registries (areas, floors, labels, devices, entities, zones), scenes, blueprints, integrations, repairs.
* Insights toolset: home overview, problem finder, state change explainer, statistics, calendars, to-do lists, forecasts, camera snapshots, wait for state, grouped system log.
* Raw toolset: REST and WebSocket read and write tools.
* Optional Supervisor toolset (Home Assistant OS and Supervised only).
* Control only mode (`HA_CONTROL_ONLY`): read everything and switch everyday devices (lights, plugs, fans, blinds, media players), with no tools that edit automations, scripts, scenes, helpers, dashboards or settings.
* Safety: read only switch, two step approval with single use plan tokens, optional human approval prompt, never touch list, validation, backups, automatic rollback, audit log, secret redaction.
* Extensive plain language comments throughout the source.
* Known gaps: see "What has and has not been tested" in the README.
