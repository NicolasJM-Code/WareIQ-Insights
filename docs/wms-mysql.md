# MySQL connection testing

Settings → Database connection now offers PostgreSQL (the unchanged default)
and MySQL 8+. This adds a metadata-only connectivity probe, not a database
migration or live reporting adapter. Existing reports still use sample data.
The application's own PostgreSQL database is not changed.

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
Copy configuration includes the engine and excludes username/password.

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
- The probe begins a read-only transaction, checks CURRENT_ROLE/SHOW GRANTS and
  information_schema metadata, and rolls back. No warehouse records or
  user-supplied SQL are read or executed.
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

A live MySQL connection has not been verified. That requires an approved
reachable server, reporting views, a read-only account and securely configured
MySQL credentials.
