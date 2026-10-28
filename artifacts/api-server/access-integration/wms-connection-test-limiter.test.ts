import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Pool } from "pg";
import {
  PostgresWmsConnectionTestLimiterStore,
  WmsConnectionTestLimiter,
} from "../src/lib/wms-connection-test-limiter";
import { PrivateDatabase } from "./database";

const database = new PrivateDatabase();
let firstPool: Pool;
let secondPool: Pool;
let firstWorker: WmsConnectionTestLimiter;
let secondWorker: WmsConnectionTestLimiter;
let firstStartLimitedWorker: WmsConnectionTestLimiter;
let secondStartLimitedWorker: WmsConnectionTestLimiter;

beforeAll(async () => {
  await database.start();
  firstPool = new Pool({
    connectionString: database.connectionString,
    password: "",
    max: 2,
    connectionTimeoutMillis: 2_000,
  });
  secondPool = new Pool({
    connectionString: database.connectionString,
    password: "",
    max: 2,
    connectionTimeoutMillis: 2_000,
  });
  firstWorker = new WmsConnectionTestLimiter(new PostgresWmsConnectionTestLimiterStore(firstPool), {
    maxActiveTests: 1,
  });
  secondWorker = new WmsConnectionTestLimiter(new PostgresWmsConnectionTestLimiterStore(secondPool), {
    maxActiveTests: 1,
  });
  firstStartLimitedWorker = new WmsConnectionTestLimiter(new PostgresWmsConnectionTestLimiterStore(firstPool), {
    maxTestStartsPerWindow: 1,
  });
  secondStartLimitedWorker = new WmsConnectionTestLimiter(new PostgresWmsConnectionTestLimiterStore(secondPool), {
    maxTestStartsPerWindow: 1,
  });
});

beforeEach(async () => {
  await database.pool.query("TRUNCATE wareiq_wms_connection_test_limiter");
});

afterAll(async () => {
  await Promise.all([firstPool?.end(), secondPool?.end()]);
  await database.stop();
});

it("serializes competing API instances through shared PostgreSQL state", async () => {
  const [first, second] = await Promise.all([
    firstWorker.acquire("client-a/site-a", "connection"),
    secondWorker.acquire("client-b/site-b", "vpn"),
  ]);

  expect(Number(Boolean(first)) + Number(Boolean(second))).toBe(1);
  const winner = first ?? second;
  expect(winner).toBeDefined();
  await winner!();
});

it("shares active and per-site cooldown state across independent database pools", async () => {
  const release = await firstWorker.acquire("client-a/site-a", "connection");
  expect(release).toBeDefined();
  expect(await secondWorker.acquire("client-a/site-a", "vpn")).toBeUndefined();

  await release!();
  expect(await secondWorker.acquire("client-a/site-a", "connection")).toBeUndefined();
});

it("shares the aggregate rolling start ceiling across independent database pools", async () => {
  const [first, second] = await Promise.all([
    firstStartLimitedWorker.acquire("client-a/site-a", "connection"),
    secondStartLimitedWorker.acquire("client-b/site-b", "vpn"),
  ]);

  expect(Number(Boolean(first)) + Number(Boolean(second))).toBe(1);
  const winner = first ?? second;
  expect(winner).toBeDefined();
  await winner!();
});
