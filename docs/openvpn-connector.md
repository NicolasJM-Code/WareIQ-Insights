# OpenVPN first, then MySQL

WareIQ supports **WareIQ API → HTTPS connector → existing OpenVPN route → MySQL**.
It does not run an OpenVPN client in Replit or upload/store OpenVPN profiles.
The connector runs on your existing **Linux OpenVPN-connected server**.
This path currently supports MySQL; PostgreSQL retains its existing direct path.

The current direct path is unchanged until an owner explicitly selects
`WMS_MYSQL_CONNECTION_PATH=openvpn`. Do not select it until the connector is
installed: all MySQL tests and live reports will then require it. Missing or
invalid connector configuration fails closed; no direct fallback is attempted.

## 1. Prepare the VPN-connected server

Requirements: Linux, Node.js 22+, `iproute2` (`ip` command), an already running
OpenVPN client/tunnel, and a DNS hostname with a valid TLS certificate for the
connector. No Node packages are needed.

- Confirm the private MySQL destination routes through the VPN interface:
  `ip -j route get <private-database-ip>`. Its `dev` must be the configured VPN
  interface, for example `tun0`. The interface must have an IPv4 address.
- This connector intentionally supports a **single pinned RFC1918 IPv4 target**.
  The database's certificate hostname must resolve on this server exclusively
  to that pinned private IP. Split DNS belongs on this VPN-connected server;
  WareIQ in Replit does not need to resolve the private database hostname.
- MySQL must support verified TLS, including a certificate matching that
  hostname. The gateway TLS certificate and the MySQL certificate are separate.
- Allow inbound HTTPS on the connector port (8443 by default), and VPN-side
  access to the configured MySQL port. Do not expose MySQL publicly.
- Run the connector as a dedicated unprivileged OS user. OpenVPN itself is
  installed, authenticated and supervised separately by your server administrator.

Copy `connectors/openvpn/server.mjs` and `policy.mjs` together to a directory such
as `/opt/wareiq/openvpn/`.

## 2. Configure the connector outside Replit

Use your server's secure service environment, not source code or chat:

```text
WAREIQ_CONNECTOR_PORT=8443
WAREIQ_CONNECTOR_TLS_CERT_FILE=/etc/wareiq/tls/fullchain.pem
WAREIQ_CONNECTOR_TLS_KEY_FILE=/etc/wareiq/tls/privkey.pem
WAREIQ_CONNECTOR_TOKEN=<a cryptographically random shared secret, at least 32 characters>
WAREIQ_VPN_INTERFACE=tun0
WAREIQ_DB_HOST=mysql.internal.example.com
WAREIQ_DB_ADDRESS=10.40.0.10
WAREIQ_DB_PORT=3306
WAREIQ_DB_DATABASE=reporting
WAREIQ_DB_USERNAME=wareiq_readonly
```

Substitute your approved database details; the values above are illustrative.
The connector does **not** receive a MySQL password in its environment.
Generate the shared token securely on your server (for example with
`openssl rand -hex 32`); never paste it into chat or commit it.
Store the environment file with mode `0600`, owned by root. Give the service
user read access to the TLS key through a restricted group/file permission.

Start with `node /opt/wareiq/openvpn/server.mjs`, with the secure environment
already supplied. For ongoing use, configure your OS service manager. Example:

```ini
[Unit]
Description=WareIQ OpenVPN MySQL connector
After=network-online.target
Wants=network-online.target

[Service]
User=wareiq-connector
Group=wareiq-connector
EnvironmentFile=/etc/wareiq/connector.env
ExecStart=/usr/bin/node /opt/wareiq/openvpn/server.mjs
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=multi-user.target
```

Adapt the Node path and OpenVPN service ordering to your server. The connector
needs no network-administration privileges. Renew certificates and restart the
connector when they change. Protect the HTTPS service with your existing
firewall/monitoring. If using a reverse proxy, it must explicitly support
authenticated HTTP CONNECT; a normal HTTP-only proxy is insufficient.

## 3. Configure WareIQ securely

An owner adds these server-only settings to the API service:

```text
WMS_MYSQL_CONNECTION_PATH=openvpn
WMS_OPENVPN_CONNECTOR_URL=https://connector.example.com:8443
WMS_OPENVPN_CONNECTOR_TOKEN=<the same shared token, stored as a secret>
```

The URL must be a public DNS hostname, HTTPS, and an origin only: no credentials,
query, fragment or custom path. All DNS answers must be public; WareIQ pins the
resolved address and verifies the connector's TLS certificate against its
original DNS hostname. It follows no redirects.

If the connector uses an approved private certificate authority, store its PEM
certificate server-side as `WMS_OPENVPN_CONNECTOR_CA_CERT`. Verification is
never disabled. A private connector IP cannot be used from a Replit runtime
without its own route; this connector is the authenticated HTTPS ingress.

Keep the normal exact MySQL approval and password settings described in
`docs/wms-mysql.md`. Host, port, database and username must match on both sides.
If MySQL uses a private CA, `WMS_MYSQL_CA_CERT` is separate from the connector CA.
The browser never receives either password or token.
The VPN-only check needs the four destination approvals and connector token, but
does not require a MySQL password yet. SQL credentials are required at the SQL step.

Restart the API after configuration changes. Development and published services
must each have the intended settings. Existing direct-route
`WMS_PRIVATE_NETWORK_*` settings do not provision or replace this connector.

## 4. Test in WareIQ Settings

1. Select **MySQL 8+** and enter the approved DNS hostname, port, database and
   reporting username.
2. Click **Check VPN connection**. The authenticated connector must confirm its
   VPN interface, actual kernel route and TCP reachability of the pinned database
   port. This probe sends no SQL commands, TLS handshake or credentials and does
   not attempt a SQL login.
3. Click **Test SQL connection**. WareIQ rechecks the VPN, then opens an
   authenticated HTTPS CONNECT tunnel. MySQL negotiates its own end-to-end
   verified TLS inside the tunnel before sending credentials.
4. A successful SQL result confirms authentication, read-only privilege checks
   and reporting-view access. Normal report mappings and client/site permissions
   still apply.

Changing connection fields, switching users, a configuration error or one minute
of elapsed time clears UI readiness. The UI check is not an authorization token:
the API and connector check again for **every SQL test and live report**.
The connector also checks the VPN route every two seconds during a tunnel and
closes it on failure. It caps concurrent tunnels, connection time, idle time and
overall tunnel lifetime. It never accepts arbitrary proxy destinations.

Typical errors:

- `VPN_NOT_CONFIGURED`: missing/invalid connector URL or token.
- `VPN_NOT_ENABLED`: server still selects the direct path.
- `VPN_NOT_READY`: connector TLS/authentication/destination approval failed,
  connector unreachable, VPN interface missing, private DNS mismatch, or database
  route uses the wrong interface. No SQL was started.
- SQL authentication/TLS/read-only errors after VPN success refer to MySQL,
  not to OpenVPN. Check the separate database settings.

Do not log Authorization headers, service environment values, VPN profiles or
SQL passwords. To rotate the shared token, update both services securely;
mismatched tokens deny access. To intentionally return to the old direct route,
an owner must explicitly set `WMS_MYSQL_CONNECTION_PATH=direct` and restart.

## Background health monitoring and administrator alerts

When OpenVPN mode is enabled, the API checks the **server-approved** MySQL
destination at startup and every minute, without sending a password or attempting
a SQL login. The authenticated status endpoint verifies the VPN interface, kernel
route, private DNS and TCP reachability. It does not prove SQL authentication,
database permissions, reporting-view availability or query success.

Two consecutive failed checks open an outage and queue one email per unrestricted,
verified-primary-email platform administrator. A single transient failure sends
no email. Sustained failures do not send repeated outage emails. The first
successful check after an outage queues a recovery notice. Monitoring errors do
not count as reachability failures or recovery, and break the consecutive-failure
sequence. Administrator lookup or queue failures roll back the transition and
retry next time. Accounts that lose administrator access before delivery do not
receive these notices.

State and notifications are committed together to the application PostgreSQL
database; never to WMS. Apply the normal application schema update
(`pnpm --filter @workspace/db run push`, also in post-merge setup) before starting
the API with monitoring enabled. Missing tables or application-database outages
show **Unknown**, never a successful connection. Configured destination changes
start a new monitoring baseline. Direct mode disables monitoring and sends no
recovery notice for the old VPN route.

Settings polls the monitoring status separately from the manual VPN test.
Results older than 150 seconds, incomplete configuration, directory failures or
monitoring-storage errors show **Unknown**. A manual successful check does not
clear a background outage or prove that SQL works.

Checks do not overlap within a process; a PostgreSQL transaction advisory lock
and persisted next-check time coordinate API instances and restarts. Gateway DNS
has a five-second deadline and HTTPS has an eight-second deadline. Connector
readiness calls share in-flight work and return failure after 8.5 seconds; TCP
probes close their socket after two seconds. Monitor database operations and
administrator discovery also have deadlines and a small dedicated connection
pool. If a dependency ignores its deadline, the monitor reports unknown instead
of launching more overlapping work.

Email uses the existing durable Resend outbox, delivery retries and idempotency
keys. Failed deliveries appear in administrator email-delivery history alongside
access emails. Monitoring is only active while an API instance is running; it
cannot send email if all instances are stopped. For continuous coverage, run a
continuously available API instance and retain independent external monitoring
of the connector and API. No connector token, SQL credential, VPN profile or
raw provider error is included in health logs, status responses or notices.
