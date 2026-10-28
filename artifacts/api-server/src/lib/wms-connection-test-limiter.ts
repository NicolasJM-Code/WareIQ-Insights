import { randomUUID } from "node:crypto";
import pg from "pg";

type TestKind = "connection" | "vpn";

type SiteLimit = {
  activeToken: string | null;
  activeUntil: number;
  nextConnectionAt: number;
  nextVpnAt: number;
};

export type WmsConnectionTestLimiterState = {
  sites: Record<string, SiteLimit>;
  starts: number[];
};

export interface WmsConnectionTestLimiterStore {
  withLockedState<T>(
    operation: (state: WmsConnectionTestLimiterState, now: number) => T,
  ): Promise<T>;
}

type LimiterLimits = {
  maxActiveTests?: number;
  maxTestStartsPerWindow?: number;
  maxSiteEntries?: number;
};

const COOLDOWN_MS = 10_000;
const AGGREGATE_WINDOW_MS = 10_000;
const ACTIVE_LEASE_MS = 60_000;
const MAX_ACTIVE_TESTS = 8;
const MAX_TEST_STARTS_PER_WINDOW = 20;
const MAX_SITE_ENTRIES = 128;
const STATE_ROW_ID = "global";

let sharedPool: pg.Pool | undefined;

function getPool(): pg.Pool {
  if (!process.env.DATABASE_URL) throw new Error("Shared connection-test storage is unavailable");
  sharedPool ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 3000,
    query_timeout: 4000,
    statement_timeout: 3000,
  });
  return sharedPool;
}

function parseState(value: unknown): WmsConnectionTestLimiterState {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid shared limiter state");
  const state = parsed as Partial<WmsConnectionTestLimiterState>;
  if (!state.sites || typeof state.sites !== "object" || Array.isArray(state.sites) ||
      !Array.isArray(state.starts) || state.starts.length > MAX_TEST_STARTS_PER_WINDOW) {
    throw new Error("Invalid shared limiter state");
  }
  const siteEntries = Object.entries(state.sites);
  if (siteEntries.length > MAX_SITE_ENTRIES || !state.starts.every(Number.isFinite)) {
    throw new Error("Invalid shared limiter state");
  }
  for (const [, site] of siteEntries) {
    if (!site || typeof site !== "object" ||
        !(site.activeToken === null || typeof site.activeToken === "string") ||
        !Number.isFinite(site.activeUntil) ||
        !Number.isFinite(site.nextConnectionAt) ||
        !Number.isFinite(site.nextVpnAt)) {
      throw new Error("Invalid shared limiter state");
    }
  }
  return state as WmsConnectionTestLimiterState;
}

function newState(): WmsConnectionTestLimiterState {
  return { sites: {}, starts: [] };
}

/** Shared PostgreSQL state. Any storage error rejects the acquisition. */
export class PostgresWmsConnectionTestLimiterStore implements WmsConnectionTestLimiterStore {
  constructor(private readonly pool?: pg.Pool) {}

  async withLockedState<T>(
    operation: (state: WmsConnectionTestLimiterState, now: number) => T,
  ): Promise<T> {
    const client = await (this.pool ?? getPool()).connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO wareiq_wms_connection_test_limiter (id, state)
         VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING`,
        [STATE_ROW_ID, JSON.stringify(newState())],
      );
      const result = await client.query<{ state: unknown; now_ms: number | string }>(
        `SELECT state, extract(epoch FROM clock_timestamp()) * 1000 AS now_ms
         FROM wareiq_wms_connection_test_limiter WHERE id = $1 FOR UPDATE`,
        [STATE_ROW_ID],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Shared connection-test storage is unavailable");
      const now = Number(row.now_ms);
      if (!Number.isFinite(now)) throw new Error("Shared connection-test storage is unavailable");
      const state = parseState(row.state);
      const output = operation(state, now);
      await client.query(
        "UPDATE wareiq_wms_connection_test_limiter SET state = $2::jsonb WHERE id = $1",
        [STATE_ROW_ID, JSON.stringify(state)],
      );
      await client.query("COMMIT");
      return output;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => { broken = true; });
      throw error;
    } finally {
      client.release(broken);
    }
  }
}

/**
 * Limits checks across all API instances using the same shared store.
 * Callers must authorize the request before acquiring a lease.
 */
export class WmsConnectionTestLimiter {
  constructor(
    private readonly store: WmsConnectionTestLimiterStore = new PostgresWmsConnectionTestLimiterStore(),
    private readonly limits: LimiterLimits = {},
  ) {}

  async acquire(siteKey: string, kind: TestKind): Promise<(() => Promise<void>) | undefined> {
    const token = randomUUID();
    const accepted = await this.store.withLockedState((state, now) => {
      state.starts = state.starts.filter((startedAt) => startedAt > now - AGGREGATE_WINDOW_MS);
      for (const [key, site] of Object.entries(state.sites)) {
        if (site.activeUntil <= now) {
          site.activeToken = null;
          site.activeUntil = 0;
        }
        if (!site.activeToken && site.nextConnectionAt <= now && site.nextVpnAt <= now) {
          delete state.sites[key];
        }
      }

      const activeCount = Object.values(state.sites)
        .filter((site) => site.activeToken !== null && site.activeUntil > now).length;
      if (activeCount >= (this.limits.maxActiveTests ?? MAX_ACTIVE_TESTS) ||
          state.starts.length >= (this.limits.maxTestStartsPerWindow ?? MAX_TEST_STARTS_PER_WINDOW)) {
        return false;
      }

      let site = state.sites[siteKey];
      if (!site) {
        if (Object.keys(state.sites).length >= (this.limits.maxSiteEntries ?? MAX_SITE_ENTRIES)) return false;
        site = { activeToken: null, activeUntil: 0, nextConnectionAt: 0, nextVpnAt: 0 };
        state.sites[siteKey] = site;
      }
      const nextAllowedAt = kind === "connection" ? site.nextConnectionAt : site.nextVpnAt;
      if (site.activeToken !== null || now < nextAllowedAt) return false;

      site.activeToken = token;
      site.activeUntil = now + ACTIVE_LEASE_MS;
      if (kind === "connection") site.nextConnectionAt = now + COOLDOWN_MS;
      else site.nextVpnAt = now + COOLDOWN_MS;
      state.starts.push(now);
      return true;
    });

    if (!accepted) return undefined;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await this.store.withLockedState((state) => {
        const site = state.sites[siteKey];
        if (site?.activeToken === token) {
          site.activeToken = null;
          site.activeUntil = 0;
        }
      });
    };
  }
}
