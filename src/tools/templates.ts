// render_template lets the model ask Home Assistant to evaluate a Jinja template.
// That is surprisingly powerful for reading, because one template can summarise
// hundreds of entities in a single call, for example 'which lights are on?'. It is
// classified read only because templates can look at state but cannot change it.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, registerTool, type ToolContext } from "./registry.js";

// The tool definition. 'read' risk means it is available even in read only mode.
const renderTemplate = defineTool({
  name: "render_template",
  title: "Render a Jinja2 template",
  description:
    "Evaluate a Home Assistant Jinja2 template on the server through POST /api/template. Useful for computing across many entities at once, for example {{ states.light | selectattr('state','eq','on') | map(attribute='entity_id') | list }}, or for testing a template before putting it in an automation. Templates are read-only and cannot change state.",
  risk: "read",
  shape: {
    template: z.string().min(1).describe("The Jinja2 template string."),
    variables: z.record(z.string(), z.any()).optional().describe("Optional variables made available to the template."),
  },
  // If the template has a mistake, Home Assistant answers with an error. We treat that
  // as a normal result and hand the message back, because 'your template is wrong,
  // here is why' is exactly what someone writing a template wants to see.
  handler: async ({ template, variables }, ctx) => {
    try {
      const rendered = await ctx.ha.renderTemplate(template, variables);
      return { rendered };
    } catch (err) {
      // Template errors are the useful answer here, not a transport failure.
      return { rendered: null, error: (err as Error).message };
    }
  },
});

// Adds the tool to the server.
export function registerTemplateTools(server: McpServer, ctx: ToolContext): void {
  registerTool(server, ctx, renderTemplate as any);
}
