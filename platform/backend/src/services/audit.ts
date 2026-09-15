import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AuditAction, AuditEntry } from '../types.js';

interface AuditRow {
  id: number;
  timestamp: string;
  action: string;
  store_id: string | null;
  actor: string;
  message: string;
  details: string;
}

export interface AuditQuery {
  limit?: number;
  storeId?: string;
}

/**
 * Append-only audit trail persisted in SQLite. Falls back to an in-memory
 * database when the configured path is not writable so the API still starts.
 */
export class AuditLog {
  private readonly db: DatabaseSync;
  readonly persistent: boolean;

  constructor(
    dbPath: string,
    private readonly retention: number,
    private readonly log: (msg: string) => void = () => {},
  ) {
    let db: DatabaseSync;
    let persistent = true;
    try {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
    } catch (err) {
      this.log(`audit: cannot open ${dbPath} (${(err as Error).message}); using in-memory store`);
      db = new DatabaseSync(':memory:');
      persistent = false;
    }
    this.db = db;
    this.persistent = persistent;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        action    TEXT NOT NULL,
        store_id  TEXT,
        actor     TEXT NOT NULL,
        message   TEXT NOT NULL,
        details   TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_audit_store ON audit_log (store_id, id);
    `);
  }

  record(
    action: AuditAction,
    input: { storeId?: string | null; actor?: string; message: string; details?: Record<string, unknown> },
  ): AuditEntry {
    const timestamp = new Date().toISOString();
    const actor = input.actor ?? 'system';
    const details = input.details ?? {};
    const result = this.db
      .prepare('INSERT INTO audit_log (timestamp, action, store_id, actor, message, details) VALUES (?, ?, ?, ?, ?, ?)')
      .run(timestamp, action, input.storeId ?? null, actor, input.message, JSON.stringify(details));
    const id = Number(result.lastInsertRowid);
    if (this.retention > 0 && id % 100 === 0) {
      this.db.prepare('DELETE FROM audit_log WHERE id <= ?').run(id - this.retention);
    }
    return { id, timestamp, action, storeId: input.storeId ?? null, actor, message: input.message, details };
  }

  list(query: AuditQuery = {}): AuditEntry[] {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
    const rows = (
      query.storeId
        ? this.db.prepare('SELECT * FROM audit_log WHERE store_id = ? ORDER BY id DESC LIMIT ?').all(query.storeId, limit)
        : this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit)
    ) as unknown as AuditRow[];
    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      action: row.action as AuditAction,
      storeId: row.store_id,
      actor: row.actor,
      message: row.message,
      details: safeParse(row.details),
    }));
  }

  /** Event totals per action, for metrics. */
  countByAction(): Record<string, number> {
    const rows = this.db.prepare('SELECT action, COUNT(*) AS total FROM audit_log GROUP BY action').all() as unknown as Array<{
      action: string;
      total: number;
    }>;
    return Object.fromEntries(rows.map((row) => [row.action, Number(row.total)]));
  }

  /** Provisioning durations (seconds) recorded on STORE_READY events, newest first. */
  recentProvisioningDurations(limit: number): number[] {
    const rows = this.db
      .prepare("SELECT details FROM audit_log WHERE action = 'STORE_READY' ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as Array<{ details: string }>;
    return rows
      .map((row) => safeParse(row.details).durationSeconds)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  }

  close(): void {
    this.db.close();
  }
}

function safeParse(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
