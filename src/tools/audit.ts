// get_audit_log simply lets Claude (or you, by asking) read back the diary of
// changes this server has made or refused. It is the answer to 'what did you do?'.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, registerTool, type ToolContext } from "./registry.js";

// A read only tool. It never modifies the log.
const getAuditLog = defineTool({
  name: "get_audit_log",
  title: "Get audit log",
  description:
    "Recent calls to tools that can change Home Assistant, newest first, including previews and rejections. Each entry records the tool, status, whether anything was executed and the arguments (credentials removed).",
  risk: "read",
  shape: {
    limit: z.number().int().min(1).max(200).default(25).describe("How many entries to return."),
    tool: z.string().optional().describe("Only entries for this tool."),
    executed_only: z.boolean().default(false).describe("Only calls that actually changed something."),
  },
  // We also return the file path so the user knows where the full record lives on their machine.
  handler: async ({ limit, tool, executed_only }, ctx) => ({
    file: ctx.audit.file,
    entries: ctx.audit.recent(limit, { tool, executed_only }),
  }),
});

// Adds the tool to the server.
export function registerAuditTools(server: McpServer, ctx: ToolContext): void {
  registerTool(server, ctx, getAuditLog as any);
}
