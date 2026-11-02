// Builds a self contained .mcpb bundle: compiled code, manifest and production dependencies only.
// Usage: npm run bundle
// Builds the .mcpb file, which is just a zip with a manifest inside. The steps are:
//   1. Compile the TypeScript.
//   2. Refresh the tool list in manifest.json.
//   3. Copy only what is needed into a temporary 'stage' folder (compiled code, the
//      manifest, package files, README and licence). Source maps are left out.
//   4. Install the production dependencies INTO the stage folder, so the bundle
//      works on a computer that has no node_modules of its own.
//   5. Validate the manifest, then pack it into home-assistant-mcp-<version>.mcpb.
// Usage: npm run bundle
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, ".bundle");
// A small wrapper that runs a shell command and shows its output.
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: "inherit" });

console.log("1/5 Building TypeScript");
run("npm run build");

console.log("2/5 Syncing manifest tool list");
run("node scripts/sync-manifest.mjs");

console.log("3/5 Staging files");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
// Copy the compiled code, skipping the .map debugging files to keep the bundle small.
fs.cpSync(path.join(root, "dist"), path.join(stage, "dist"), {
  recursive: true,
  filter: (src) => !src.endsWith(".map"),
});
for (const f of ["manifest.json", "package.json", "package-lock.json", "README.md", "LICENSE"]) {
  if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(stage, f));
}

console.log("4/5 Installing production dependencies into the bundle");
// 'npm ci' installs exactly what the lock file says, which makes the bundle reproducible. '--omit=dev' leaves out test and build tools.
run("npm ci --omit=dev --no-audit --no-fund", stage);

console.log("5/5 Validating and packing");
run("npx mcpb validate manifest.json", stage);
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const out = path.join(root, `home-assistant-mcp-${version}.mcpb`);
fs.rmSync(out, { force: true });
run(`npx mcpb pack "${stage}" "${out}"`);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`\nCreated ${out}`);
