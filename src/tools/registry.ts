// Every tool in this server is registered through this file. Think of it as the
// single doorway that all tools walk through, which is useful because it means the
// important cross cutting behaviour lives in ONE place instead of being copied into
// dozens of tools:
//   * read only mode (tools that can change things are simply not registered)
//   * tool hints that tell the client which tools are safe
//   * the extra plan_token parameter on risky tools
//   * running each tool inside the per call context the safety gate needs
//   * error handling, secret scrubbing and the audit log
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuditLog } from "../audit.js";
import type { BackupStore } from "../backup.js";
import type { Config } from "../config.js";
import { callStore } from "../context.js";
import type { HAClient } from "../ha-client.js";
import { stableStringify } from "../plan.js";
import { ImageOutcome, ToolOutcome, fail, ok, redactText } from "../util.js";

// The bundle of shared things handed to every tool: the Home Assistant client, the settings, the backup store and the audit log.
export interface ToolContext {
  ha: HAClient;
  cfg: Config;
  backups: BackupStore;
  audit: AuditLog;
}

// The four risk labels a tool can have:
//   read    - never changes anything, always available
//   low     - changes something but with little impact
//   dynamic - risk depends on the exact call (the safety gate decides each time)
//   high    - always treated as high risk
/**
 * Risk classification used for registration and MCP annotations.
 * read: never mutates. low: mutates, low impact. dynamic: classified per call (high risk is gated). high: always gated.
 */
export type ToolRisk = "read" | "low" | "dynamic" | "high";

// Everything needed to describe a tool: its name, the text the model reads, its risk label, the accepted arguments (as a zod shape), and the function that does the work.
export interface ToolDef<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  risk: ToolRisk;
  shape: S;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
}

/** Names of every tool registered in this process, used by tests and diagnostics. */
// A running list of the tools that actually got registered. The startup log prints the count, and the tests use the list.
export const registeredToolNames: string[] = [];

// Does nothing at runtime. It exists only so TypeScript can check that each tool definition has the right shape.
export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>) {
  return def;
}

// The three parameters that belong to the approval process rather than to the
// request itself. We leave them out when working out whether two calls are 'the same
// request', so the preview and the confirmed call match.
const GATE_KEYS = ["confirm", "dry_run", "plan_token"];

// Prepares arguments for the audit log. The plan token is removed (it is a
// credential of sorts), secrets are scrubbed, and anything very long is cut down so
// one giant request cannot bloat the log.
function auditArgs(args: Record<string, unknown>): unknown {
  const { plan_token: _t, ...rest } = args;
  const text = redactText(JSON.stringify(rest) ?? "{}");
  if (text.length <= 4000) return JSON.parse(text);
  return { _truncated: true, preview: text.slice(0, 2000) };
}

// The main function. Read the very first line carefully: if read only mode is on and
// the tool is anything other than 'read', we return immediately and the tool never
// exists. The model cannot call a tool it was never told about. That is why read
// only mode is so reliable.
/** Register a tool. In read-only mode every tool that can mutate Home Assistant is skipped. */
export function registerTool<S extends z.ZodRawShape>(server: McpServer, ctx: ToolContext, def: ToolDef<S>): void {
  if (ctx.cfg.readOnly && def.risk !== "read") return;
  registeredToolNames.push(def.name);

  // Risky tools get an extra optional 'plan_token' parameter added to their schema, so
  // the model knows it exists and can pass it back on the confirmed call.
  const gated = def.risk === "dynamic" || def.risk === "high";
  const shape: z.ZodRawShape = gated
    ? {
        ...def.shape,
        plan_token: z
          .string()
          .optional()
          .describe(
            "Single use token returned by the preview call for this exact request. Required together with confirm true and dry_run false when the action is high risk. Never invent one."
          ),
      }
    : def.shape;

  // This is the actual registration with the MCP SDK, including the hints (readOnlyHint, destructiveHint) that clients can use to decide whether to ask for permission.
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: shape,
      annotations: {
        title: def.title,
        readOnlyHint: def.risk === "read",
        destructiveHint: def.risk === "high" || def.risk === "dynamic",
        idempotentHint: def.risk === "read",
        openWorldHint: false,
      },
    },
    (async (args: any) => {
      // Everything from here is the code that runs on every single tool call.
      const started = Date.now();
      // The 'fingerprint' of this request, without the approval fields. The plan token is tied to this fingerprint.
      const argsKey = stableStringify(
        Object.fromEntries(Object.entries(args ?? {}).filter(([k]) => !GATE_KEYS.includes(k)))
      );
      let result;
      let data: any;
      let isError = false;
      try {
        // Run the tool's real handler inside the per call context, so the safety gate can see which tool and arguments it is dealing with.
        const out = await callStore.run(
          { tool: def.name, argsKey, planToken: args?.plan_token, server, approval: ctx.cfg.approval },
          () => def.handler(args, ctx)
        );
        // A camera picture goes back as a proper image block (plus a caption) so the model can look at it.
        if (out instanceof ImageOutcome) {
          data = { status: "ok", image: out.mimeType };
          result = {
            content: [
              { type: "image", data: out.base64, mimeType: out.mimeType },
              { type: "text", text: out.caption },
            ],
          };
        } else {
          data = out instanceof ToolOutcome ? out.data : out;
          isError = out instanceof ToolOutcome ? out.isError : false;
          result = ok(data, ctx.cfg.maxOutputChars, isError);
        }
      } catch (err) {
        // Errors are logged to stderr (never stdout, which is reserved for the MCP conversation) and returned to the model as a readable error.
        console.error(`[ha-mcp] tool ${def.name} failed: ${(err as Error).message}`);
        isError = true;
        data = { status: "error", message: (err as Error).message };
        result = fail(err);
      }
      // Only tools that can change something are written to the audit diary. Read calls would just be noise.
      if (def.risk !== "read") {
        ctx.audit.record({
          ts: new Date().toISOString(),
          tool: def.name,
          risk: def.risk,
          status: typeof data?.status === "string" ? data.status : isError ? "error" : "ok",
          executed: typeof data?.executed === "boolean" ? data.executed : null,
          is_error: isError,
          ms: Date.now() - started,
          args: auditArgs(args ?? {}),
        });
      }
      return result;
    }) as any
  );
}
