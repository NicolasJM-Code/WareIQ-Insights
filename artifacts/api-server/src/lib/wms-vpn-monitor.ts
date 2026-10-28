import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { clerkClient } from "@clerk/express";
import { configuredMysqlReportInput } from "./wms-connection";
import { checkOpenVpn, getWmsNetworkConfig } from "./wms-openvpn";
import { ConnectionFailure } from "./wms-connection-error";
import { appRole, verifiedPrimaryEmail } from "./access-policy";
import { logger } from "./logger";
import { advanceVpnHealth, initialVpnHealth, singleFlightMonitor, type VpnHealthState, type VpnObservation } from "./wms-vpn-health";

// A separate, small pool bounds monitor resource use independently of requests.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL, max: 2,
  connectionTimeoutMillis: 3000, query_timeout: 4000, statement_timeout: 3000,
  idle_in_transaction_session_timeout: 45_000,
});
pool.on("error", () => monitorError());
let monitoringError = false;
function monitorError() {
  monitoringError = true;
  logger.warn({ event: "wms_vpn_monitor_unknown" }, "Warehouse VPN monitoring status is unknown");
}
function configuration() {
  const config = getWmsNetworkConfig();
  if (config.path !== "openvpn") return null;
  if (!config.configured) throw new Error("Monitor configuration unavailable");
  const input = configuredMysqlReportInput();
  if (!input) throw new Error("Monitor destination unavailable");
  const key = createHash("sha256").update(JSON.stringify([
    process.env.WMS_OPENVPN_CONNECTOR_URL, input.host, input.port, input.database, input.username,
  ])).digest("hex");
  return { input, key };
}
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Monitor deadline exceeded")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

/** Paginated, bounded directory lookup. Incomplete lookup queues nothing and
 * rolls back the transition, so it can be retried without losing recipients. */
let directoryWork: ReturnType<typeof listVpnAdministrators> | undefined;
export function vpnAdministrators() {
  // A timed-out SDK request may still be running. Reuse it rather than spawning
  // another directory walk on every tick.
  directoryWork ??= listVpnAdministrators().finally(() => { directoryWork = undefined; });
  return directoryWork;
}
async function listVpnAdministrators() {
  const recipients: { id: string; email: string }[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await clerkClient.users.getUserList({ limit: 100, offset });
    for (const user of page.data) {
      if (appRole(user.publicMetadata.role) !== "admin" || user.banned || user.locked || !verifiedPrimaryEmail(user)) continue;
      const email = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)!;
      recipients.push({ id: user.id, email: email.emailAddress });
    }
    if (offset + page.data.length >= page.totalCount) {
      if (!recipients.length) throw new Error("No notification recipients available");
      return recipients;
    }
  }
  throw new Error("Administrator directory exceeded monitoring bound");
}

export async function checkWarehouseVpnHealth(): Promise<void> {
  const config = configuration();
  if (!config) return;
  const client = await pool.connect();
  let broken = false;
  client.on("error", monitorError);
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(88417391) AS locked");
    if (!lock.rows[0]?.locked) { await client.query("ROLLBACK"); return; }
    const previous = await client.query<{ config_key: string; state: VpnHealthState; due: boolean }>(
      "SELECT config_key, state, next_check_at <= now() AS due FROM wareiq_wms_vpn_health WHERE id = 'warehouse-openvpn'",
    );
    const row = previous.rows[0];
    if (row?.config_key === config.key && !row.due) { await client.query("ROLLBACK"); return; }
    let observation: VpnObservation;
    try { await checkOpenVpn(config.input); observation = "healthy"; }
    catch (error) {
      // Transport timeout/refusal and explicit connector rejection are unavailable.
      // Programmer/configuration/monitoring failures are never evidence of health.
      observation = error instanceof ConnectionFailure && error.code === "VPN_NOT_READY" ? "unavailable" : "unknown";
    }
    const { state, notice } = advanceVpnHealth(
      row?.config_key === config.key ? row.state : initialVpnHealth(), observation, new Date().toISOString(), randomUUID(),
    );
    if (notice) {
      const recipients = await within(vpnAdministrators(), 8000);
      await client.query(`INSERT INTO wareiq_access_notifications (id, recipient, role_name, kind, target_id)
        SELECT id, email, 'Warehouse VPN', $2, target
        FROM jsonb_to_recordset($1::jsonb) AS recipients(id text, email text, target text)`,
      [JSON.stringify(recipients.map((recipient) => ({ id: randomUUID(), email: recipient.email, target: recipient.id }))), notice]);
    }
    await client.query(`INSERT INTO wareiq_wms_vpn_health (id, config_key, state, next_check_at)
      VALUES ('warehouse-openvpn', $1, $2::jsonb, now() + interval '60 seconds')
      ON CONFLICT (id) DO UPDATE SET config_key = excluded.config_key, state = excluded.state, next_check_at = excluded.next_check_at`,
    [config.key, JSON.stringify(state)]);
    await client.query("COMMIT");
    monitoringError = observation === "unknown";
  } catch {
    monitoringError = true;
    await client.query("ROLLBACK").catch(() => { broken = true; });
    throw new Error("Warehouse monitor unavailable");
  } finally {
    client.removeListener("error", monitorError);
    client.release(broken);
  }
}

export async function warehouseVpnHealth(): Promise<{
  status: "healthy" | "unavailable" | "unknown" | "disabled"; checkedAt: string | null;
}> {
  try {
    const config = configuration();
    if (!config) return { status: "disabled", checkedAt: null };
    if (monitoringError) return { status: "unknown", checkedAt: null };
    const { rows } = await pool.query<{ state: VpnHealthState }>(
      "SELECT state FROM wareiq_wms_vpn_health WHERE id = 'warehouse-openvpn' AND config_key = $1", [config.key],
    );
    const state = rows[0]?.state;
    if (!state?.checkedAt || Date.now() - Date.parse(state.checkedAt) > 150_000 ||
        !Number.isFinite(Date.parse(state.checkedAt))) return { status: "unknown", checkedAt: state?.checkedAt ?? null };
    return { status: state.observation, checkedAt: state.checkedAt };
  } catch { return { status: "unknown", checkedAt: null }; }
}

let started = false;
export function startWarehouseVpnMonitor() {
  if (started) return;
  started = true;
  const tick = singleFlightMonitor(checkWarehouseVpnHealth, monitorError);
  void tick();
  setInterval(() => { void tick(); }, 60_000).unref();
}
