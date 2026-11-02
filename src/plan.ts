// This file is the "plan token" machinery, which is the heart of the two step
// safety process for risky actions.
//
// The idea in plain English: when something risky is requested, we do NOT do it.
// We describe what would happen and hand back a ticket (the plan token). To
// actually go ahead, the caller has to come back with that exact ticket AND the
// exact same request. That stops a model from skipping the preview, from
// changing the request after you approved it, and from reusing an old approval.
import crypto from "node:crypto";

// A random secret generated fresh every time the server starts. Tokens are signed
// with it, so nobody can forge one. A side effect is that all tokens stop working
// when the server restarts, which is exactly what we want for a safety feature.
const SECRET = crypto.randomBytes(32);

// Tokens last ten minutes. Long enough to read a plan and say yes, short enough
// that a stale approval does not hang around.
const TTL_MS = 10 * 60 * 1000;

// Remembers tokens that were already used, mapped to when they expire. This is
// what makes a token single use. We only need to remember them until they would
// have expired anyway.
const used = new Map<string, number>();

// Every way a token can fail to be good. "ok" is the only one that lets us proceed.
export type TokenState = "ok" | "missing" | "invalid" | "expired" | "used";

// Works out the signature for a token. It mixes in the tool name, the expiry time
// and the arguments, so changing any of those produces a different signature and
// the token stops matching.
function mac(tool: string, argsKey: string, exp: number): string {
  return crypto.createHmac("sha256", SECRET).update(`${tool}|${exp}|${argsKey}`).digest("base64url").slice(0, 32);
}

/** Deterministic JSON with sorted keys, so the same request always yields the same key. */
// Why do we need this? Plain JSON.stringify keeps keys in insertion order, so
// {a:1,b:2} and {b:2,a:1} would give different strings even though they mean the
// same thing. We sort the keys so equal requests always produce equal text.
export function stableStringify(value: unknown): string {
  // Arrays keep their order (order matters in a list) but each item is normalised.
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      // Skip undefined values, because JSON would drop them too and we want the
      // preview and the confirmed call to compare equal.
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  // Plain numbers, strings, booleans and null. The "?? null" covers the odd
  // case where JSON.stringify returns undefined.
  return JSON.stringify(value) ?? "null";
}

/** A token bound to one tool and one exact set of arguments. It expires and works once. */
export function issuePlanToken(tool: string, argsKey: string, now = Date.now()): string {
  const exp = now + TTL_MS;
  // The token looks like "<expiry in base36>.<signature>". The expiry is in the
  // open so we can check it without a lookup, and the signature stops tampering.
  return `${exp.toString(36)}.${mac(tool, argsKey, exp)}`;
}

// Checks a token that came back from the caller. Order matters here: we check the
// cheap structural things first, then the signature, then expiry, then reuse.
export function verifyPlanToken(token: string | undefined, tool: string, argsKey: string, now = Date.now()): TokenState {
  if (!token) return "missing";
  const [expPart, sig] = token.split(".");
  const exp = Number.parseInt(expPart ?? "", 36);
  if (!sig || !Number.isFinite(exp)) return "invalid";
  // Recompute what the signature SHOULD be for this tool and these arguments.
  // If the caller changed the request since the preview, this will not match.
  const expected = Buffer.from(mac(tool, argsKey, exp));
  const given = Buffer.from(sig);
  // timingSafeEqual avoids leaking information through how long the comparison
  // takes. It also throws if lengths differ, hence the length check first.
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return "invalid";
  if (now > exp) return "expired";
  // Housekeeping: forget used tokens that have expired, so the map cannot grow forever.
  for (const [t, e] of used) if (e < now) used.delete(t);
  if (used.has(token)) return "used";
  return "ok";
}

// Called once an action has been approved and is about to run. After this, the
// same token is rejected as "used", so an approval can never be replayed.
export function consumePlanToken(token: string, now = Date.now()): void {
  const exp = Number.parseInt(token.split(".")[0] ?? "", 36);
  used.set(token, Number.isFinite(exp) ? exp : now + TTL_MS);
}
