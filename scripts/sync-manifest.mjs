// Writes the live tool list of the built server into manifest.json so the two never drift apart.
// Usage: npm run build && node scripts/sync-manifest.mjs [--check]
// Why this script exists: the .mcpb manifest has to list every tool, and it is very
// easy to add a tool in the code and forget to add it to the manifest. So instead of
// writing the list by hand, this script STARTS the real server, asks it what tools it
// has, and writes that list into manifest.json. It also copies the version number
// from package.json so the two can never disagree.
//
// Run it with --check (the test suite does this) to just verify the manifest is up
// to date without changing it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// If --check was passed we only compare, we do not write.
const check = process.argv.includes("--check");

// We launch the compiled server exactly like a real MCP client would. We switch the
// raw API tools ON and both restricted modes OFF here, even though the real defaults
// are the other way round, so that the manifest lists every tool the bundle can offer. The address
// and token are dummies: tool registration does not need a working Home Assistant,
// so this works offline.
const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(root, "dist", "index.js")],
  env: { ...process.env, HA_URL: "http://127.0.0.1:1", HA_TOKEN: "manifest-sync", HA_ENABLE_RAW: "true", HA_ALLOW_CONTROL: "true", HA_ALLOW_EDIT: "true" },
  stderr: "ignore",
});
const client = new Client({ name: "manifest-sync", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

// The manifest only needs a one sentence description, so we keep the text up to the first full stop.
const live = tools.map((t) => ({
  name: t.name,
  description: (t.description ?? "").split(/(?<=\.)\s/)[0].trim(),
}));

const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

// Check mode: compare tool names, and fail with a helpful message if they differ.
if (check) {
  const a = JSON.stringify(manifest.tools.map((t) => t.name));
  const b = JSON.stringify(live.map((t) => t.name));
  if (a !== b) {
    console.error("manifest.json tools are out of date. Run: node scripts/sync-manifest.mjs");
    process.exit(1);
  }
  console.log(`manifest.json lists all ${live.length} tools.`);
} else {
  manifest.tools = live;
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  manifest.version = pkg.version;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`manifest.json updated with ${live.length} tools (version ${manifest.version}).`);
}
