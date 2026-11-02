// The audit log is a simple diary of everything this server was asked to do that
// could change something. If you ever wonder "what did the AI actually do to my
// house last night?", this is where you look (or ask Claude to call get_audit_log).
//
// It is deliberately boring: one JSON object per line, appended to a file. No
// database, no cleverness. Boring means it is hard to break.
import fs from "node:fs";
import path from "node:path";

// One line in the diary.
export interface AuditEntry {
  // When it happened, in ISO format.
  ts: string;
  // Which tool was called.
  tool: string;
  // How risky that tool is: low, dynamic or high.
  risk: string;
  // What came of it, for example "executed", "saved", or "confirmation_required".
  status: string;
  // true if something really changed, false if it was only a preview or refusal,
  // null if we cannot tell.
  executed: boolean | null;
  is_error: boolean;
  // How long the call took, in milliseconds.
  ms: number;
  // The arguments, with secrets already stripped out before we get here.
  args: unknown;
}

// When the file grows past 5 MB we move it aside and start a fresh one, so the
// log can never quietly eat your disk.
const MAX_BYTES = 5 * 1024 * 1024;

/** Append only JSONL record of every call to a tool that can change something. */
export class AuditLog {
  constructor(public readonly file: string) {}

  record(entry: AuditEntry): void {
    // Everything here is wrapped in try/catch because a problem with the diary
    // must never stop the actual tool from working. Worst case we log to stderr.
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      try {
        // Rotate: if the current file is too big, rename it to audit.jsonl.1.
        // That overwrites the previous rotated copy, so we keep at most two files.
        if (fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, `${this.file}.1`);
      } catch {
        /* no file yet */
      }
      // The trailing newline is what makes it JSONL (one entry per line).
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (err) {
      console.error(`[ha-mcp] could not write audit log: ${(err as Error).message}`);
    }
  }

  // Reads the newest entries first. We walk the file backwards so that asking for
  // "the last 10" does not need to parse the whole thing.
  recent(limit: number, filter: { tool?: string; executed_only?: boolean } = {}): AuditEntry[] {
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    } catch {
      // No file means nothing has been logged yet, which is fine.
      return [];
    }
    const out: AuditEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const e = JSON.parse(lines[i]) as AuditEntry;
        if (filter.tool && e.tool !== filter.tool) continue;
        if (filter.executed_only && e.executed !== true) continue;
        out.push(e);
      } catch {
        /* skip a damaged line */
      }
    }
    return out;
  }
}
