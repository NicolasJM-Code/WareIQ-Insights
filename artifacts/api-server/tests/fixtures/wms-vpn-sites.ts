import { vi } from "vitest";

export const vpnScope = { siteId: "11111111-1111-4111-8111-111111111111",
  clientId: "22222222-2222-4222-8222-222222222222" };
export const vpnSite = { ...vpnScope, connectorUrl: "https://gateway.example.test:8443",
  tokenEnv: "WMS_TEST_VPN_TOKEN", passwordEnv: "WMS_TEST_VPN_PASSWORD",
  host: "mysql.internal.example.test", port: 3306, database: "reporting", username: "reporter" };
export const vpnToken = "connector-test-only-".repeat(4);
export function configureVpnSite() {
  vi.stubEnv("WMS_OPENVPN_SITES", JSON.stringify([vpnSite]));
  vi.stubEnv(vpnSite.tokenEnv, vpnToken);
  vi.stubEnv(vpnSite.passwordEnv, "fixture");
}
