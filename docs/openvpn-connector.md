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
WAREIQ_SITE_ID=<approved WareIQ warehouse UUID>
WAREIQ_CLIENT_ID=<the warehouse owner's WareIQ client UUID>
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
WMS_OPENVPN_SITES=<JSON array of site approvals, described below>
```

Each entry binds exactly one WareIQ site and client to a fixed connector and
SQL destination. For example (illustrative IDs only):

```json
[
  {
    "siteId": "11111111-1111-4111-8111-111111111111",
    "clientId": "22222222-2222-4222-8222-222222222222",
    "connectorUrl": "https://warehouse-one.example.com:8443",
    "tokenEnv": "WMS_WAREHOUSE_ONE_TOKEN",
    "passwordEnv": "WMS_WAREHOUSE_ONE_PASSWORD",
    "sqlCaEnv": "WMS_WAREHOUSE_ONE_SQL_CA",
    "host": "mysql.internal.example.com",
    "port": 3306,
    "database": "reporting",
    "username": "wareiq_readonly"
  }
]
```

Add one entry per warehouse and run a separately configured connector on each
warehouse's VPN-connected server. Each connector must have matching
`WAREIQ_SITE_ID`, `WAREIQ_CLIENT_ID`, target approvals and a **unique token**.
Private database addresses/hostnames may overlap across VPNs; site IDs must not.
Duplicate site IDs or reused tokens invalidate the registry.
`tokenEnv`, `passwordEnv`, optional `caEnv` and optional `sqlCaEnv` name server-only environment
settings beginning with `WMS_`; put the token and SQL password in Secrets, not
in the JSON, frontend, repository or chat. An optional `caEnv` names that
connector's private CA PEM setting; when specified it must exist.
An optional `sqlCaEnv` names the PEM CA bundle trusted for that warehouse's
MySQL certificate, not the connector HTTPS certificate. A configured SQL CA
reference must contain a nonblank value or SQL tests and reports fail with
`SQL_CA_NOT_CONFIGURED` before opening a tunnel. Invalid certificate contents
fail verified TLS; there is no trust fallback.
No registry values, secret names, URLs, tokens or passwords are returned to the browser.

Migration from the single-connector path requires explicit entries even for a
single warehouse. The old `WMS_OPENVPN_CONNECTOR_URL`, token and global MySQL
credentials are **not** used as a fallback in VPN mode. Roll out the connector
site/client headers and API registry together; old connectors must be upgraded.
Missing sites, client mismatches, invalid settings and outages fail closed.
Background outage monitoring uses separate persisted health records and locks for
each approved site. The Settings status refers only to its authorized selected
site; historical global connector health is not evidence of any site's health.

The URL must be a public DNS hostname, HTTPS, and an origin only: no credentials,
query, fragment or custom path. All DNS answers must be public; WareIQ pins the
resolved address and verifies the connector's TLS certificate against its
original DNS hostname. It follows no redirects.

If the connector uses an approved private certificate authority, store its PEM
certificate server-side in the setting named by that entry's `caEnv`. Verification is
never disabled. A private connector IP cannot be used from a Replit runtime
without its own route; this connector is the authenticated HTTPS ingress.

In VPN mode the registry's exact host, port, database and username approval and
site password replace the global MySQL destination/password settings. Direct
mode retains the settings in `docs/wms-mysql.md`. All target fields must match
on both sides. For private MySQL CAs, configure each entry's `sqlCaEnv` and store
only that warehouse's approved CA bundle in the named server secret. For example,
a second warehouse can use `WMS_WAREHOUSE_TWO_SQL_CA` with a different private CA,
even if its MySQL DNS hostname overlaps the first warehouse's.
SQL tests and live reports use the same site-specific trust and always verify
the original MySQL DNS hostname, including over the connector stream.
When `sqlCaEnv` is omitted, SQL uses system trust roots only.
VPN mode never inherits `WMS_MYSQL_CA_CERT`, another site's SQL CA, or the
connector's HTTPS `caEnv`. `WMS_MYSQL_CA_CERT` remains available in **direct mode
only**, with unchanged behavior. When migrating a private-CA VPN deployment,
move each warehouse's approved roots out of the shared bundle into its own
`sqlCaEnv` setting; do not copy a combined cross-warehouse bundle.
The browser cannot supply or override either CA reference, CA contents or TLS
verification settings.
The browser never receives either password or token.
The VPN-only check needs the four destination approvals and connector token, but
does not require a MySQL password yet. SQL credentials are required at the SQL step.

To verify SQL trust isolation without accessing a warehouse, run
`pnpm --filter @workspace/api-server run test:wms:mysql-tls`. The opt-in fixture
requires Docker Compose and OpenSSL, creates two loopback-only MySQL servers
with different temporary private CAs and a shared DNS identity, and checks
connection tests and mapped reports. It covers matching trust, swapped-site CA
rejection, omitted-CA rejection despite a global bundle, and hostname mismatch.
The connector HTTPS transport is replaced with local byte streams for this
fixture; it does not validate a real VPN or HTTPS connector. No WMS credentials
or warehouse databases are used, and generated certificates/data are removed.

Restart the API after configuration changes. Development and published services
must each have the intended settings. Existing direct-route
`WMS_PRIVATE_NETWORK_*` settings do not provision or replace this connector.

## 4. Test in WareIQ Settings

1. Select your assigned warehouse in the site selector, then **MySQL 8+**, and enter the approved DNS hostname, port, database and
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

Changing the selected site or connection fields, switching users, a configuration error or one minute
of elapsed time clears UI readiness. The UI check is not an authorization token:
the API and connector check again for **every SQL test and live report**.
Administrators must also have an active reporting membership, active client,
role and assignment to that active site to inspect its VPN configuration or
run connection tests. Platform administration alone does not grant a connection
to every warehouse. The server re-reads membership for each request and derives
the client ID itself; the browser sends only the selected site ID and untrusted
test fields, never connector destinations or secret references. Live reports
derive the approved destination from the same authorized client/site selection.
The connector also checks the VPN route every two seconds during a tunnel and
closes it on failure. It caps concurrent tunnels, connection time, idle time and
overall tunnel lifetime. It never accepts arbitrary proxy destinations.

Typical errors:

- `VPN_NOT_CONFIGURED`: missing/invalid connector URL or token.
- `VPN_SITE_REQUIRED`: the server operation has no authorized site scope.
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
