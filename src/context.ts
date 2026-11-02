// Okay, so this tiny file solves a slightly annoying problem.
//
// Every tool in this server is a separate function, and every one of them might
// need to pass through the safety gate (see safety.ts). The gate needs to know
// a few things about the call that is happening right now: which tool it is, the
// exact arguments, whether the caller supplied a plan token, and which MCP server
// object to use if we want to pop up an approval question for the human.
//
// We could thread all of that through every function as extra parameters, but that
// would be noisy and easy to forget. Instead we use AsyncLocalStorage, which is
// basically "a variable that is scoped to one chain of async calls". The tool
// registry (tools/registry.ts) sets it just before running a tool's handler, and
// the safety gate reads it. Two tool calls running at the same time each see
// their own copy, so they can never get mixed up.
import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Per tool call context, so the safety gate can see the exact request without every tool passing it along. */
export interface CallContext {
  // The tool name, for example "call_service". A plan token is tied to this.
  tool: string;
  /** Stable serialisation of the arguments, excluding confirm, dry_run and plan_token. */
  // We leave those three out on purpose. The preview call and the confirmed call
  // differ in exactly those fields, but we want them to count as "the same request".
  argsKey: string;
  // Whatever token the caller handed us, if any. We check it later in the gate.
  planToken?: string;
  // Needed if we want to ask the human a question through the MCP client.
  server: McpServer;
  /** auto: ask the human through MCP elicitation when the client supports it. elicit: require it. */
  approval: "auto" | "elicit";
}

// The one shared store. If you call callStore.getStore() outside of a tool call
// you get undefined, which the gate treats as a bug and refuses to proceed.
export const callStore = new AsyncLocalStorage<CallContext>();
