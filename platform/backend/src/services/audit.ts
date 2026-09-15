import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import type { AuditAction, AuditEntry } from '../types.js';

interface AuditRow {
  id: number | string;
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

export interface AuditInput {
  storeId?: string | null;
  actor?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface StoreOutcomes {
  created: number;
  ready: number;
  failed: number;
  deleted: number;
  rejected: number;
}

/**
 * Append-only audit trail. SQLite serves a single API replica; Postgres lets
 * any number of replicas share one log and one global create lock.
 */
export interface AuditLog {
  readonly backend: 'sqlite' | 'postgres' | 'memory';
  readonly persistent: boolean;
  init(): Promise<void>;
  /** Fire-and-forget: writes are ordered and never block the request path. */
  record(action: AuditAction, input: AuditInput): void;
  flush(): Promise<void>;
  list(query?: AuditQuery): Promise<AuditEntry[]>;
  countByAction(): Promise<Record<string, number>>;
  storeOutcomes(): Promise<StoreOutcomes>;
  recentProvisioningDurations(limit: number): Promise<number[]>;
  /** Serialises store creation across every replica sharing this log. */
  withGlobalLock<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const READY_ACTIONS = "('STORE_READY', 'STORE_RECOVERED')";
const OUTCOME_SQL = {
  created: "SELECT COUNT(DISTINCT store_id) AS total FROM audit_log WHERE action = 'STORE_CREATE_REQUESTED'",
  ready: `SELECT COUNT(DISTINCT store_id) AS total FROM audit_log WHERE action IN ${READY_ACTIONS}`,
  // Failed and never reached Ready afterwards (recovered stores count as ready).
  failed: `SELECT COUNT(DISTINCT store_id) AS total FROM audit_log
           WHERE action = 'STORE_FAILED' AND store_id IS NOT NULL
             AND store_id NOT IN (SELECT store_id FROM audit_log WHERE action IN ${READY_ACTIONS} AND store_id IS NOT NULL)`,
  deleted: "SELECT COUNT(DISTINCT store_id) AS total FROM audit_log WHERE action = 'STORE_DELETED'",
  // Rejected requests never get a store id, so these are request counts.
  rejected: "SELECT COUNT(*) AS total FROM audit_log WHERE action = 'STORE_CREATE_REJECTED'",
} as const;

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: Number(row.id),
    timestamp: row.timestamp,
    action: row.action as AuditAction,
    storeId: row.store_id,
    actor: row.actor,
    message: row.message,
    details: safeParse(row.details),
  };
}

function durationsFrom(rows: Array<{ details: string }>): number[] {
  return rows
    .map((row) => safeParse(row.details).durationSeconds)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 100, 1), 1000);
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

// ---------------------------------------------------------------------------

class SqliteAuditLog implements AuditLog {
  private readonly db: DatabaseSync;
  readonly backend: 'sqlite' | 'memory';
  readonly persistent: boolean;
  private readonly lock = new Mutex();

  constructor(
    dbPath: string,
    private readonly retention: number,
    log: (msg: string) => void,
  ) {
    let db: DatabaseSync;
    try {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
      this.backend = 'sqlite';
      this.persistent = true;
    } catch (err) {
      log(`audit: cannot open ${dbPath} (${(err as Error).message}); using in-memory store`);
      db = new DatabaseSync(':memory:');
      this.backend = 'memory';
      this.persistent = false;
    }
    this.db = db;
  }

  async init(): Promise<void> {
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

  record(action: AuditAction, input: AuditInput): void {
    const result = this.db
      .prepare('INSERT INTO audit_log (timestamp, action, store_id, actor, message, details) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        new Date().toISOString(),
        action,
        input.storeId ?? null,
        input.actor ?? 'system',
        input.message,
        JSON.stringify(input.details ?? {}),
      );
    const id = Number(result.lastInsertRowid);
    if (this.retention > 0 && id % 100 === 0) {
      this.db.prepare('DELETE FROM audit_log WHERE id <= ?').run(id - this.retention);
    }
  }

  async flush(): Promise<void> {}

  async list(query: AuditQuery = {}): Promise<AuditEntry[]> {
    const limit = clampLimit(query.limit);
    const rows = (
      query.storeId
        ? this.db.prepare('SELECT * FROM audit_log WHERE store_id = ? ORDER BY id DESC LIMIT ?').all(query.storeId, limit)
        : this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit)
    ) as unknown as AuditRow[];
    return rows.map(toEntry);
  }

  async countByAction(): Promise<Record<string, number>> {
    const rows = this.db.prepare('SELECT action, COUNT(*) AS total FROM audit_log GROUP BY action').all() as unknown as Array<{
      action: string;
      total: number;
    }>;
    return Object.fromEntries(rows.map((row) => [row.action, Number(row.total)]));
  }

  async storeOutcomes(): Promise<StoreOutcomes> {
    const scalar = (sql: string): number => Number((this.db.prepare(sql).get() as { total?: number } | undefined)?.total ?? 0);
    return {
      created: scalar(OUTCOME_SQL.created),
      ready: scalar(OUTCOME_SQL.ready),
      failed: scalar(OUTCOME_SQL.failed),
      deleted: scalar(OUTCOME_SQL.deleted),
      rejected: scalar(OUTCOME_SQL.rejected),
    };
  }

  async recentProvisioningDurations(limit: number): Promise<number[]> {
    const rows = this.db
      .prepare("SELECT details FROM audit_log WHERE action = 'STORE_READY' ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as Array<{ details: string }>;
    return durationsFrom(rows);
  }

  withGlobalLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock.run(fn);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------

/** Arbitrary constant key for pg_advisory_lock around store creation. */
const CREATE_LOCK_KEY = 727_001;

class PostgresAuditLog implements AuditLog {
  readonly backend = 'postgres' as const;
  readonly persistent = true;
  // Connection settings come from the standard PGHOST/PGUSER/PGPASSWORD/PGDATABASE env vars.
  private readonly pool = new pg.Pool({ max: 5, idleTimeoutMillis: 30_000 });
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly retention: number,
    private readonly log: (msg: string) => void,
  ) {
    this.pool.on('error', (err) => this.log(`audit: postgres pool error: ${err.message}`));
  }

  async init(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS audit_log (
            id        BIGSERIAL PRIMARY KEY,
            timestamp TEXT NOT NULL,
            action    TEXT NOT NULL,
            store_id  TEXT,
            actor     TEXT NOT NULL,
            message   TEXT NOT NULL,
            details   TEXT NOT NULL DEFAULT '{}'
          );
          CREATE INDEX IF NOT EXISTS idx_audit_store ON audit_log (store_id, id);
          CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action, id);
        `);
        return;
      } catch (err) {
        if (attempt >= 30) throw err;
        this.log(`audit: waiting for postgres (${(err as Error).message})`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  record(action: AuditAction, input: AuditInput): void {
    this.writes = this.writes
      .then(async () => {
        const result = await this.pool.query<{ id: string }>(
          'INSERT INTO audit_log (timestamp, action, store_id, actor, message, details) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [new Date().toISOString(), action, input.storeId ?? null, input.actor ?? 'system', input.message, JSON.stringify(input.details ?? {})],
        );
        const id = Number(result.rows[0]?.id ?? 0);
        if (this.retention > 0 && id % 100 === 0) {
          await this.pool.query('DELETE FROM audit_log WHERE id <= $1', [id - this.retention]);
        }
      })
      .catch((err: Error) => this.log(`audit: failed to record ${action}: ${err.message}`));
  }

  flush(): Promise<void> {
    return this.writes;
  }

  async list(query: AuditQuery = {}): Promise<AuditEntry[]> {
    await this.flush();
    const limit = clampLimit(query.limit);
    const result = query.storeId
      ? await this.pool.query<AuditRow>('SELECT * FROM audit_log WHERE store_id = $1 ORDER BY id DESC LIMIT $2', [query.storeId, limit])
      : await this.pool.query<AuditRow>('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1', [limit]);
    return result.rows.map(toEntry);
  }

  async countByAction(): Promise<Record<string, number>> {
    const result = await this.pool.query<{ action: string; total: string }>(
      'SELECT action, COUNT(*) AS total FROM audit_log GROUP BY action',
    );
    return Object.fromEntries(result.rows.map((row) => [row.action, Number(row.total)]));
  }

  async storeOutcomes(): Promise<StoreOutcomes> {
    const scalar = async (sql: string): Promise<number> =>
      Number((await this.pool.query<{ total: string }>(sql)).rows[0]?.total ?? 0);
    const [created, ready, failed, deleted, rejected] = await Promise.all([
      scalar(OUTCOME_SQL.created),
      scalar(OUTCOME_SQL.ready),
      scalar(OUTCOME_SQL.failed),
      scalar(OUTCOME_SQL.deleted),
      scalar(OUTCOME_SQL.rejected),
    ]);
    return { created, ready, failed, deleted, rejected };
  }

  async recentProvisioningDurations(limit: number): Promise<number[]> {
    const result = await this.pool.query<{ details: string }>(
      "SELECT details FROM audit_log WHERE action = 'STORE_READY' ORDER BY id DESC LIMIT $1",
      [limit],
    );
    return durationsFrom(result.rows);
  }

  async withGlobalLock<T>(fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [CREATE_LOCK_KEY]);
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [CREATE_LOCK_KEY]).catch(() => undefined);
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.flush();
    await this.pool.end();
  }
}

export function createAuditLog(
  options: { backend: string; sqlitePath: string; retention: number },
  log: (msg: string) => void,
): AuditLog {
  if (options.backend === 'postgres') return new PostgresAuditLog(options.retention, log);
  return new SqliteAuditLog(options.sqlitePath, options.retention, log);
}

function safeParse(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
