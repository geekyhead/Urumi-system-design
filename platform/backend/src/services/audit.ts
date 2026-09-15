import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import pg from 'pg';
import type { AuditAction, AuditEntry, StoreOutcomes } from '../types.js';
import { Mutex, errorMessage, sleep, tryParseJson } from '../util.js';

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

/**
 * Append-only audit trail. SQLite serves a single API replica; Postgres lets
 * any number of replicas share one log and one global store-mutation lock.
 */
export interface AuditLog {
  readonly backend: 'sqlite' | 'postgres' | 'memory';
  init(): Promise<void>;
  /** Fire-and-forget: writes are ordered and never block the request path. */
  record(action: AuditAction, input: AuditInput): void;
  list(query?: AuditQuery): Promise<AuditEntry[]>;
  countByAction(): Promise<Record<string, number>>;
  storeOutcomes(): Promise<StoreOutcomes>;
  recentProvisioningDurations(limit: number): Promise<number[]>;
  /** Serialises store creation and domain changes across every replica sharing this log. */
  withGlobalLock<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const SCHEMA_COLUMNS = `
  timestamp TEXT NOT NULL,
  action    TEXT NOT NULL,
  store_id  TEXT,
  actor     TEXT NOT NULL,
  message   TEXT NOT NULL,
  details   TEXT NOT NULL DEFAULT '{}'`;

const INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_audit_store ON audit_log (store_id, id);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action, id);`;

const READY_ACTIONS = "('STORE_READY', 'STORE_RECOVERED')";

/**
 * Lifetime outcomes in one table scan. Each store counts once; a store that
 * failed and later recovered counts as ready; rejected requests have no store id.
 */
const OUTCOMES_SQL = `
  SELECT
    COUNT(DISTINCT CASE WHEN action = 'STORE_CREATE_REQUESTED' THEN store_id END) AS created,
    COUNT(DISTINCT CASE WHEN action IN ${READY_ACTIONS} THEN store_id END) AS ready,
    COUNT(DISTINCT CASE WHEN action = 'STORE_FAILED' AND store_id NOT IN
      (SELECT store_id FROM audit_log WHERE action IN ${READY_ACTIONS} AND store_id IS NOT NULL) THEN store_id END) AS failed,
    COUNT(DISTINCT CASE WHEN action = 'STORE_DELETED' THEN store_id END) AS deleted,
    COALESCE(SUM(CASE WHEN action = 'STORE_CREATE_REJECTED' THEN 1 ELSE 0 END), 0) AS rejected
  FROM audit_log`;

const COUNT_BY_ACTION_SQL = 'SELECT action, COUNT(*) AS total FROM audit_log GROUP BY action';

type OutcomeRow = Record<keyof StoreOutcomes, number | string | null>;

function toOutcomes(row: OutcomeRow | undefined): StoreOutcomes {
  const n = (value: number | string | null | undefined) => Number(value ?? 0);
  return { created: n(row?.created), ready: n(row?.ready), failed: n(row?.failed), deleted: n(row?.deleted), rejected: n(row?.rejected) };
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: Number(row.id),
    timestamp: row.timestamp,
    action: row.action as AuditAction,
    storeId: row.store_id,
    actor: row.actor,
    message: row.message,
    details: asObject(tryParseJson(row.details)),
  };
}

function durationsFrom(rows: Array<{ details: string }>): number[] {
  return rows
    .map((row) => asObject(tryParseJson(row.details)).durationSeconds)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 100, 1), 1000);
}

// ---------------------------------------------------------------------------

class SqliteAuditLog implements AuditLog {
  readonly backend: 'sqlite' | 'memory';
  private readonly db: DatabaseSync;
  private readonly lock = new Mutex();
  private statements!: {
    insert: StatementSync;
    prune: StatementSync;
    listAll: StatementSync;
    listStore: StatementSync;
    countByAction: StatementSync;
    outcomes: StatementSync;
    durations: StatementSync;
  };

  constructor(
    dbPath: string,
    private readonly retention: number,
    log: (msg: string) => void,
  ) {
    try {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      this.db = new DatabaseSync(dbPath);
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.backend = 'sqlite';
    } catch (err) {
      log(`audit: cannot open ${dbPath} (${errorMessage(err)}); using in-memory store`);
      this.db = new DatabaseSync(':memory:');
      this.backend = 'memory';
    }
  }

  async init(): Promise<void> {
    this.db.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ${SCHEMA_COLUMNS});${INDEXES}`);
    // Prepared once and reused; audit writes and dashboard polling hit these constantly.
    this.statements = {
      insert: this.db.prepare(
        'INSERT INTO audit_log (timestamp, action, store_id, actor, message, details) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      prune: this.db.prepare('DELETE FROM audit_log WHERE id <= ?'),
      listAll: this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?'),
      listStore: this.db.prepare('SELECT * FROM audit_log WHERE store_id = ? ORDER BY id DESC LIMIT ?'),
      countByAction: this.db.prepare(COUNT_BY_ACTION_SQL),
      outcomes: this.db.prepare(OUTCOMES_SQL),
      durations: this.db.prepare("SELECT details FROM audit_log WHERE action = 'STORE_READY' ORDER BY id DESC LIMIT ?"),
    };
  }

  record(action: AuditAction, input: AuditInput): void {
    const result = this.statements.insert.run(
      new Date().toISOString(),
      action,
      input.storeId ?? null,
      input.actor ?? 'system',
      input.message,
      JSON.stringify(input.details ?? {}),
    );
    const id = Number(result.lastInsertRowid);
    if (this.retention > 0 && id % 100 === 0) this.statements.prune.run(id - this.retention);
  }

  async list(query: AuditQuery = {}): Promise<AuditEntry[]> {
    const limit = clampLimit(query.limit);
    const rows = query.storeId ? this.statements.listStore.all(query.storeId, limit) : this.statements.listAll.all(limit);
    return (rows as unknown as AuditRow[]).map(toEntry);
  }

  async countByAction(): Promise<Record<string, number>> {
    const rows = this.statements.countByAction.all() as unknown as Array<{ action: string; total: number }>;
    return Object.fromEntries(rows.map((row) => [row.action, Number(row.total)]));
  }

  async storeOutcomes(): Promise<StoreOutcomes> {
    return toOutcomes(this.statements.outcomes.get() as unknown as OutcomeRow | undefined);
  }

  async recentProvisioningDurations(limit: number): Promise<number[]> {
    return durationsFrom(this.statements.durations.all(limit) as unknown as Array<{ details: string }>);
  }

  withGlobalLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock.run(fn);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------

/** Arbitrary constant key for pg_advisory_lock around store mutations (create, domains). */
const STORE_MUTATION_LOCK_KEY = 727_001;

class PostgresAuditLog implements AuditLog {
  readonly backend = 'postgres' as const;
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
        await this.pool.query(`CREATE TABLE IF NOT EXISTS audit_log (id BIGSERIAL PRIMARY KEY, ${SCHEMA_COLUMNS});${INDEXES}`);
        return;
      } catch (err) {
        if (attempt >= 30) throw err;
        this.log(`audit: waiting for postgres (${errorMessage(err)})`);
        await sleep(2000);
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
      .catch((err: unknown) => this.log(`audit: failed to record ${action}: ${errorMessage(err)}`));
  }

  async list(query: AuditQuery = {}): Promise<AuditEntry[]> {
    await this.writes;
    const limit = clampLimit(query.limit);
    const result = query.storeId
      ? await this.pool.query<AuditRow>('SELECT * FROM audit_log WHERE store_id = $1 ORDER BY id DESC LIMIT $2', [query.storeId, limit])
      : await this.pool.query<AuditRow>('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1', [limit]);
    return result.rows.map(toEntry);
  }

  async countByAction(): Promise<Record<string, number>> {
    const result = await this.pool.query<{ action: string; total: string }>(COUNT_BY_ACTION_SQL);
    return Object.fromEntries(result.rows.map((row) => [row.action, Number(row.total)]));
  }

  async storeOutcomes(): Promise<StoreOutcomes> {
    return toOutcomes((await this.pool.query<OutcomeRow>(OUTCOMES_SQL)).rows[0]);
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
      await client.query('SELECT pg_advisory_lock($1)', [STORE_MUTATION_LOCK_KEY]);
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [STORE_MUTATION_LOCK_KEY]).catch(() => undefined);
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.writes;
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
