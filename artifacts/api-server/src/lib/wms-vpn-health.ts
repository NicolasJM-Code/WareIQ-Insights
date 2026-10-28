/** Pure, credential-free state machine. Unknown is not evidence of recovery. */
export type VpnObservation = "healthy" | "unavailable" | "unknown";
export type VpnHealthState = {
  observation: VpnObservation;
  failures: number;
  outageId: string | null;
  checkedAt: string | null;
};
export const initialVpnHealth = (): VpnHealthState => ({
  observation: "unknown", failures: 0, outageId: null, checkedAt: null,
});
export function advanceVpnHealth(
  previous: VpnHealthState, observation: VpnObservation, now: string, eventId: string,
): { state: VpnHealthState; notice: "vpn_outage" | "vpn_recovery" | null } {
  const state = { ...previous, observation, checkedAt: now,
    failures: observation === "unavailable" ? Math.min(previous.failures + 1, 2) : 0 };
  let notice: "vpn_outage" | "vpn_recovery" | null = null;
  if (state.failures >= 2 && !state.outageId) {
    state.outageId = eventId;
    notice = "vpn_outage";
  } else if (observation === "healthy" && state.outageId) {
    state.outageId = null;
    notice = "vpn_recovery";
  }
  return { state, notice };
}

/** No overlap even when a dependency ignores its deadline: keep the gate until
 * the underlying work settles, while exposing unknown to readers immediately. */
export function singleFlightMonitor(work: () => Promise<void>, onError: () => void, timeoutMs = 45_000) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    const timer = setTimeout(onError, timeoutMs);
    try { await work(); } catch { onError(); }
    finally { clearTimeout(timer); running = false; }
  };
}
