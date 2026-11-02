// Grab bag of small helpers that almost every tool uses: how we shape
// results for the MCP client, how we scrub secrets out of anything we return, how we
// compare two pieces of config, and a few string helpers.
import { HAError } from "./ha-client.js";

// This is the shape the MCP SDK expects back from a tool: a list of content blocks,
// plus an optional isError flag. We only ever send text blocks from here (images are
// handled separately in tools/registry.ts).
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

// Normally a tool just returns its data and we assume success, and if it throws we
// report an error. Sometimes a tool wants to say "this did not work, but here is
// useful detail about why" without throwing. Wrapping the data in a ToolOutcome with
// isError set to true lets it do that.
/** Wraps handler output so a tool can mark a response as an error without throwing. */
export class ToolOutcome {
  constructor(
    public readonly data: unknown,
    public readonly isError = false
  ) {}
}

// Camera snapshots are the only users of this. The registry turns it into an MCP
// image content block so the model can actually look at the picture.
/** A tool result that carries an image, such as a camera snapshot. */
export class ImageOutcome {
  constructor(
    public readonly base64: string,
    public readonly mimeType: string,
    public readonly caption: string
  ) {}
}

// Cuts text down to a maximum length and tells the reader that it was cut. This
// stops one enormous response (a huge log, say) from filling the model's whole
// context window. The message says how much was dropped so it can ask for less.
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [truncated ${text.length - max} characters. Narrow the request or lower the limit.]`;
}

// Exact secret strings we know about, mainly the access token. Kept in a Set so the
// same value added twice is only stored once.
const secrets = new Set<string>();

// We ignore anything shorter than 8 characters. A very short "secret" such as "on"
// would otherwise get blanked out of ordinary text everywhere and make output
// unreadable.
/** Register an exact secret value (such as the access token) that must never appear in any output. */
export function addSecret(value: string): void {
  if (value.length >= 8) secrets.add(value);
}

// This runs on everything before it leaves the server. It does four things in order:
//  1. Blank out any exact secret we registered (the real token).
//  2. Blank out anything that looks like a JWT (long-lived tokens are JWTs).
//  3. Blank out "Bearer xxxx" strings.
//  4. Blank out URL style parameters like ?token=... or access_token=...
// It is a belt and braces approach, because the cost of missing one is a leaked key.
/** Remove tokens and credentials from text before it reaches the model or the audit log. */
export function redactText(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[REDACTED]");
  out = out.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]");
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [REDACTED]");
  out = out.replace(/\b(access_token|token|authSig|api_key|apikey)=([A-Za-z0-9._~%-]{8,})/gi, "$1=[REDACTED]");
  return out;
}

// Key names that suggest the value is a secret. Used by redactKeys below when we
// show things like entity attributes, where a camera might carry an access_token.
const SENSITIVE_KEY = /(token|password|passwd|secret|api_?key|authorization|webhook_id)/i;

// It walks through nested objects and arrays and replaces the VALUE of any key whose
// name looks sensitive. The warning in the comment is important: only use this for
// things we are displaying. Never run it on a config we are about to save back to
// Home Assistant, or we would overwrite real values with the word REDACTED.
/** Replace the values of sensitive looking keys. Used for read-only views, never for configs that get written back. */
export function redactKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactKeys) as unknown as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) && typeof v === "string" ? "[REDACTED]" : redactKeys(v),
      ])
    ) as T;
  }
  return value;
}

// Builds a normal successful tool reply. Strings are sent as they are, everything
// else is pretty printed as JSON so it is easy to read. Secrets are scrubbed and the
// length is capped. (The odd "text ?? 'null'" covers the case where JSON.stringify
// returns undefined, for example when the data is undefined.)
export function ok(data: unknown, maxChars: number, isError = false): ToolResult {
  const text = redactText(typeof data === "string" ? data : JSON.stringify(data, null, 2));
  return {
    content: [{ type: "text", text: truncateText(text ?? "null", maxChars) }],
    ...(isError ? { isError: true } : {}),
  };
}

// Builds an error reply from whatever was thrown. Errors from Home Assistant carry
// an error code which we tack on the end, because it often says exactly what is
// wrong. We scrub secrets here too, since an error message can contain a URL.
export function fail(err: unknown, maxChars = 8000): ToolResult {
  let message: string;
  if (err instanceof HAError) {
    message = err.message;
    if (err.code) message += ` (code: ${err.code})`;
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return {
    content: [{ type: "text", text: truncateText(redactText(`Error: ${message}`), maxChars) }],
    isError: true,
  };
}

// One difference found between two versions of some config. Used to show the human
// a clear "this is what will change" list before a risky edit.
export interface Change {
  path: string;
  before: unknown;
  after: unknown;
}

// True for plain objects only, not arrays and not null. (In JavaScript arrays and
// null both report themselves as objects, which trips people up, so we check).
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Compares two JSON values and lists every place they differ. If both sides are
// objects we look at each key, if both are arrays we compare item by item, and
// otherwise we record a single before/after pair. The first line is a shortcut: if
// they serialise identically there is nothing to report.
/** Structural diff between two JSON values, returning one entry per differing leaf or subtree. */
export function diffObjects(a: unknown, b: unknown, path = ""): Change[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const out: Change[] = [];
    for (const k of keys) out.push(...diffObjects(a[k], b[k], path ? `${path}.${k}` : k));
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: Change[] = [];
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) out.push(...diffObjects(a[i], b[i], `${path}[${i}]`));
    return out;
  }
  return [{ path: path || "(root)", before: a, after: b }];
}

// Turns the list of changes into short readable lines such as
// 'views[0].title: "Home" -> "House"'. Long values are shortened and the list is
// capped, with a note about how many more there were.
export function describeChanges(changes: Change[], limit = 40): string[] {
  const short = (v: unknown) => {
    if (v === undefined) return "(not set)";
    const s = JSON.stringify(v);
    return s.length > 120 ? `${s.slice(0, 117)}...` : s;
  };
  const lines = changes.slice(0, limit).map((c) => `${c.path}: ${short(c.before)} -> ${short(c.after)}`);
  if (changes.length > limit) lines.push(`... and ${changes.length - limit} more changes`);
  return lines;
}

// Converts a simple wildcard pattern like "light.kitchen_*" into a regular
// expression. '*' matches any run of characters and '?' matches exactly one. We
// escape everything else so a dot in an entity id means a literal dot. Matching is
// case insensitive.
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

// Home Assistant often lets a field be either a single value or a list. This
// normalises both into a list so the calling code only has one case to handle.
export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// Turns a name like "Café Lights!" into "cafe_lights", the style Home Assistant
// uses for ids. The normalize step splits accented letters into the plain letter
// plus a separate accent mark, and the first replace then strips those marks.
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Returns the part before the dot in an entity id. For "light.kitchen" that is
// "light".
export function domainOf(entityId: string): string {
  return entityId.split(".")[0] ?? "";
}

// Gets a readable message out of anything that was thrown, since JavaScript lets
// you throw things that are not Error objects.
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
