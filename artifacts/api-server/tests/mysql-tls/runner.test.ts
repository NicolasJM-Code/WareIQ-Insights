import { expect, test } from "vitest";

test.skipIf(process.env.WMS_MYSQL_TLS_RUNNER_CHECK !== "1")(
  "the TLS fixture runner enables both integration suites",
  () => {
    expect(process.env.WMS_MYSQL_TLS_INTEGRATION).toBe("1");
    expect(process.env.WMS_OPENVPN_MYSQL_TLS_INTEGRATION).toBe("1");
    expect(process.env.WMS_MYSQL_TLS_FIXTURE_VERSION).toMatch(/^8\.(0|4)\.\d+/);
  },
);
