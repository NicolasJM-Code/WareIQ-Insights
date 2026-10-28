# MySQL reporting setup

For **OpenVPN first, then MySQL**, see [the connector setup](openvpn-connector.md).
That path uses your existing Linux VPN-connected server; it does not start a
VPN inside Replit.

Settings → Database connection now offers PostgreSQL (the unchanged default)
and MySQL 8+. MySQL can execute approved report mappings against server-approved
views. Connection testing remains metadata-only. The application's own
PostgreSQL database is unchanged and is not used for warehouse report data.

## Configure a MySQL destination

An authorized owner must supply server-side credentials through Replit Secrets,
separately in each environment. Never paste passwords into chat or the browser.
No existing PostgreSQL credential is reused.

Use `WMS_MYSQL_DATABASE_URL` containing a matching `mysql://` URL, or
`WMS_MYSQL_PASSWORD` together with all four non-secret approval settings:

- `WMS_MYSQL_APPROVED_HOST`
- `WMS_MYSQL_APPROVED_PORT`
- `WMS_MYSQL_APPROVED_DATABASE`
- `WMS_MYSQL_APPROVED_USERNAME`

If any explicit approval setting is present, all four are required, even when
a URL is available. All form fields must match that approval. A URL used as the
password source must also match the form fields. Partial or mismatched settings
fail before DNS lookup or connection creation.

Select **MySQL 8+** in Settings, enter the approved hostname, port (normally
3306), database and reporting username, then select **Test connection**. The
schema follows the database name automatically. Connection values are not saved
in the browser; only existing report preferences are saved by Save preferences.
Copy configuration includes the engine and excludes username/password. A
successful probe does not enable reports unless the server mapping below is
also configured.

## Approve reporting views

Set `WMS_MYSQL_REPORT_MAPPINGS` as a server-side JSON secret/config value. The
object keys are report IDs from the server's report catalog, or
`own:<section>:<dataset>` for personal reports. Values name a view, its
client/site filter columns, and the explicit output-field-to-view-column
allowlist:

```json
{
  "inventory-1": {
    "view": "v_stock_on_hand",
    "clientColumn": "client_code",
    "siteColumn": "site_code",
    "columns": {
      "sku": "sku",
      "name": "product_name",
      "onHand": "on_hand",
      "available": "available"
    }
  },
  "own:inventory:stock": {
    "view": "v_stock_on_hand",
    "clientColumn": "client_code",
    "siteColumn": "site_code",
    "columns": {
      "sku": "sku",
      "name": "product_name",
      "wh": "site_code",
      "onHand": "on_hand",
      "available": "available"
    }
  }
}
```

This example is illustrative: replace names with the real reporting view
columns and only include reports that are approved. The `clientColumn` values
must match the WareIQ client's company number; `siteColumn` values must match
the selected WareIQ site's source ID in the WMS. Both filters are mandatory on
every query, and a missing client number or site source mapping prevents a run.
Mapping keys and SQL identifiers are validated; request bodies cannot supply
SQL, view names, columns, or mappings. For personal reports, the selected
fields must be included in the mapping for that section and dataset.

Only mapped reports can run. Results are returned to the signed-in user in the
report run panel, with at most 500 rows. Existing sample report tables remain
separate and are still labeled as sample data.

## Requirements and boundaries

- Use a DNS hostname matching the database's TLS certificate.
  Numeric IP hosts are rejected for MySQL so that hostname verification is
  explicit. Public DNS addresses are accepted by default. Existing private VPN
  routes can use the owner-approved `WMS_PRIVATE_NETWORK_ENABLED` and
  `WMS_PRIVATE_NETWORK_CIDRS` policy described in `docs/wareiq-access.md`.
  All DNS answers must be public or all must fall inside the approved private
  CIDRs. This feature does not create a VPN, route or static egress IP.
- TLS certificate and hostname verification are mandatory. For a private CA,
  configure `WMS_MYSQL_CA_CERT` securely on the server. Do not disable TLS.
- Use a dedicated account with SELECT and SHOW VIEW on approved reporting views.
  The probe fails closed on active roles, role grants, write/elevated/dynamic
  privileges, grant options and unrecognized grant formats. It does not expand
  roles. This intentionally excludes accounts whose effective permissions
  cannot be established by these conservative checks.
- The connection probe begins a read-only transaction, checks
  CURRENT_ROLE/SHOW GRANTS and `information_schema` metadata, and rolls back.
  It does not read warehouse rows.
- Each report run repeats the read-only role/grant checks, then selects only
  configured columns from one configured view. Client company number and site
  source ID are bound as values in every query. A fixed 15-second execution
  timeout and 500-row cap apply. No arbitrary user SQL is accepted.
- The approved hostname resolves to pinned policy-approved addresses before credentials
  are sent. Connection timeout is 8 seconds; each metadata query has a maximum
  15-second timeout. The socket is destroyed on success and failure.
- Existing administrator authorization, same-origin protections and rate
  limiting apply to both engines. Raw driver errors, secrets and grants are
  never returned or logged.

## Verification

Isolated checks use fake drivers and synthetic credentials; they do not contact
the configured WMS or a real MySQL server:

```
pnpm exec vitest run --config vitest.config.ts artifacts/api-server/tests/wms-mysql.test.ts artifacts/wareiq/tests/settings-mysql.test.tsx
pnpm --filter @workspace/scripts exec tsx --test ../artifacts/api-server/src/lib/wms-connection.test.ts
```

A live MySQL report run has not been verified. It requires an approved
reachable server, views containing the approved client/site keys, a read-only
account, secure credentials, and mappings tested against the real view schema.
An opt-in isolated integration harness provisions a disposable MySQL 8.4
container, creates temporary CA/server certificates and synthetic users/views,
then removes the container and certificates when the run ends. It binds the
fixture database only to `127.0.0.1`; it does not read or use configured WMS
credentials or connect to a configured destination. Docker with Compose and
OpenSSL are required. Run it from the repository root:

```
pnpm --filter @workspace/api-server run test:wms:mysql-tls
```

The suite checks a trusted CA and matching hostname, an unrelated CA, hostname
mismatch, authentication failure, read-only grants, rejected write grants and
active roles, a database without views, and cleanup after a stalled handshake.
Its generated keys, certificates and database data are temporary. The regular
test suite does not start Docker or enable this integration suite. This
integration verifies connection setup and metadata access only; it does not
exercise mapped report execution against a live WMS.
