// Safety net number one: before this server overwrites or deletes anything that
// matters (an automation, a dashboard, a scene, a registry entry and so on) it
// takes a copy of the old version and keeps it here.
//
// We keep each copy in two places. Memory is fast and always works. Disk survives
// a restart. If the disk write fails for any reason we carry on regardless,
// because the in-memory copy and the receipt we hand back are still good enough
// to undo the change during this session.
import fs from "node:fs";
import path from "node:path";

// What we store for each backup.
export interface BackupRecord {
  // Unique name, built from the time plus what was backed up.
  backup_id: string;
  /** automation, script, or helper:<type> */
  kind: string;
  item_id: string;
  created_at: string;
  // A short note about why it was taken, like "before save_dashboard".
  reason: string;
  // The actual old configuration. This is the thing you restore from.
  config: unknown;
}

// What we hand back to the caller. It is the "rollback receipt" you see in tool
// results. It includes the whole previous config so that even if the file on
// disk is lost, whoever called the tool still has what they need to undo it.
export interface BackupReceipt {
  backup_id: string;
  kind: string;
  item_id: string;
  created_at: string;
  /** Absolute path of the on-disk copy, or null if the disk write failed (the in-memory copy still exists). */
  path: string | null;
  /** The full previous configuration, returned so the caller holds a rollback receipt even without disk access. */
  previous_config: unknown;
}

// Turns any string into something safe to use in a filename. Anything that is
// not a letter, number, dot, dash or underscore becomes an underscore, and we cap
// the length so we never hit filesystem name limits.
function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80);
}

/** Stores rollback copies of configuration in memory and, best effort, on disk. */
export class BackupStore {
  private memory = new Map<string, BackupRecord>();

  constructor(private readonly dir: string) {}

  // Takes a backup and returns the receipt.
  save(kind: string, itemId: string, config: unknown, reason: string): BackupReceipt {
    const created = new Date();
    // The id starts with the timestamp so the files sort in time order. We swap
    // the colons and dots because they are awkward (or illegal) in filenames.
    const backup_id = `${created.toISOString().replace(/[:.]/g, "-")}_${safe(kind)}_${safe(itemId)}`;
    const record: BackupRecord = {
      backup_id,
      kind,
      item_id: itemId,
      created_at: created.toISOString(),
      reason,
      config,
    };
    // Memory first. This cannot really fail.
    this.memory.set(backup_id, record);
    let filePath: string | null = null;
    // Now the disk copy, on a best effort basis.
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      filePath = path.join(this.dir, `${backup_id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
    } catch (err) {
      console.error(`[ha-mcp] could not write backup to disk: ${(err as Error).message}`);
      filePath = null;
    }
    return {
      backup_id,
      kind,
      item_id: itemId,
      created_at: record.created_at,
      path: filePath,
      previous_config: config,
    };
  }

  // Finds a backup by id. Memory is checked first, then the disk, which is how
  // a backup taken before a restart can still be restored afterwards.
  load(backupId: string): BackupRecord | null {
    const cached = this.memory.get(backupId);
    if (cached) return cached;
    try {
      const file = path.join(this.dir, `${safe(backupId)}.json`);
      // The id may contain characters that safe() would change, so also try it raw.
      for (const candidate of [file, path.join(this.dir, `${backupId}.json`)]) {
        // Security check: make sure the file really sits directly inside our
        // backup folder. This stops someone passing an id like "../../etc/passwd"
        // and getting us to read a file we should not.
        if (path.dirname(path.resolve(candidate)) !== path.resolve(this.dir)) continue;
        if (fs.existsSync(candidate)) {
          return JSON.parse(fs.readFileSync(candidate, "utf8")) as BackupRecord;
        }
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  // Lists backups, newest first, without including the (possibly big) config
  // itself. That keeps the listing small enough to read.
  list(filter: { kind?: string; item_id?: string } = {}, limit = 25): Omit<BackupRecord, "config">[] {
    // Start with what is in memory, then add anything extra found on disk.
    const records = new Map<string, BackupRecord>(this.memory);
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.endsWith(".json")) continue;
        const id = f.slice(0, -5);
        if (records.has(id)) continue;
        try {
          records.set(id, JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as BackupRecord);
        } catch {
          /* skip unreadable file */
        }
      }
    } catch {
      /* directory may not exist yet */
    }
    return [...records.values()]
      .filter((r) => (!filter.kind || r.kind === filter.kind) && (!filter.item_id || r.item_id === filter.item_id))
      // ISO timestamps sort correctly as plain strings, so localeCompare is enough.
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      // Drop the config from each result. "_config" is just a throwaway name.
      .map(({ config: _config, ...rest }) => rest);
  }
}
