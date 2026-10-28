import { createConnection } from "node:net";
import { readConfig } from "../../../../connectors/openvpn/policy.mjs";
import { createConnector } from "../../../../connectors/openvpn/server.mjs";

export async function startOpenVpnFixture({ certFile, keyFile, mysqlPort }) {
  const token = "disposable-openvpn-fixture-token-".repeat(2);
  const env = {
    WAREIQ_SITE_ID: "11111111-1111-4111-8111-111111111111",
    WAREIQ_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
    WAREIQ_CONNECTOR_TOKEN: token,
    WAREIQ_CONNECTOR_TLS_CERT_FILE: certFile,
    WAREIQ_CONNECTOR_TLS_KEY_FILE: keyFile,
    WAREIQ_VPN_INTERFACE: "fixture0",
    WAREIQ_DB_HOST: "mysql.fixture.test",
    WAREIQ_DB_ADDRESS: "10.40.0.10",
    WAREIQ_DB_PORT: "3306",
    WAREIQ_DB_DATABASE: "reporting",
    WAREIQ_DB_USERNAME: "fixture_reader",
  };
  const connector = createConnector(readConfig(env), {
    // Exercise the real connector's authenticated HTTPS and CONNECT handling,
    // but route its pinned private target to the disposable local MySQL port.
    checkRoute: async () => {},
    connect: ({ host, port }) => {
      if (host !== "10.40.0.10" || port !== 3306)
        throw new Error("Connector fixture received an unexpected destination.");
      return createConnection({ host: "127.0.0.1", port: mysqlPort });
    },
  });
  const sockets = new Set();
  connector.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    connector.once("error", reject);
    connector.listen(0, "127.0.0.1", resolve);
  });
  return {
    token,
    port: connector.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => connector.close(resolve));
    },
  };
}
