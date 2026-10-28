#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../../.." && pwd)"
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/wareiq-mysql-tls.XXXXXX")"
project_name="wareiq-mysql-tls-$$"
compose=(docker compose --project-name "$project_name" -f "$script_dir/compose.yaml")

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$fixture_dir"
}
trap cleanup EXIT INT TERM

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is required for the isolated MySQL TLS fixture." >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "OpenSSL is required to generate temporary fixture certificates." >&2
  exit 1
fi

fixture_gid="$(id -g)"
chmod 755 "$fixture_dir"
for certs in "$fixture_dir/certs" "$fixture_dir/certs-second"; do
mkdir -p "$certs"
chmod 770 "$certs"
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 2 \
  -keyout "$certs/ca-key.pem" \
  -out "$certs/ca.pem" \
  -subj "/CN=WareIQ disposable MySQL $(basename "$certs") CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
docker run --rm --user 999:999 --group-add "$fixture_gid" \
  --volume "$certs:/certs" \
  --entrypoint openssl mysql:8.4 req -newkey rsa:2048 -sha256 -nodes \
  -keyout /certs/server-key.pem -out /certs/server.csr \
  -subj "/CN=mysql.fixture.test" 2>/dev/null
chmod 755 "$certs"
printf '%s\n' \
  'subjectAltName=DNS:mysql.fixture.test' \
  'extendedKeyUsage=serverAuth' \
  'keyUsage=digitalSignature,keyEncipherment' \
  > "$certs/server.ext"
openssl x509 -req -in "$certs/server.csr" \
  -CA "$certs/ca.pem" -CAkey "$certs/ca-key.pem" \
  -CAcreateserial -out "$certs/server-cert.pem" -days 2 -sha256 \
  -extfile "$certs/server.ext" 2>/dev/null
chmod 644 "$certs/server-cert.pem" "$certs/ca.pem"
done
connector_certs="$fixture_dir/connector-certs"
mkdir -p "$connector_certs"
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 2 \
  -keyout "$connector_certs/ca-key.pem" \
  -out "$connector_certs/ca.pem" \
  -subj "/CN=WareIQ disposable connector HTTPS CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout "$connector_certs/server-key.pem" \
  -out "$connector_certs/server.csr" \
  -subj "/CN=connector.fixture.test" 2>/dev/null
printf '%s\n' \
  'subjectAltName=DNS:connector.fixture.test' \
  'extendedKeyUsage=serverAuth' \
  'keyUsage=digitalSignature,keyEncipherment' \
  > "$connector_certs/server.ext"
openssl x509 -req -in "$connector_certs/server.csr" \
  -CA "$connector_certs/ca.pem" -CAkey "$connector_certs/ca-key.pem" \
  -CAcreateserial -out "$connector_certs/server-cert.pem" -days 2 -sha256 \
  -extfile "$connector_certs/server.ext" 2>/dev/null
chmod 644 "$connector_certs/ca.pem" "$connector_certs/server-cert.pem"
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 2 \
  -keyout "$fixture_dir/certs/untrusted-ca-key.pem" \
  -out "$fixture_dir/certs/untrusted-ca.pem" \
  -subj "/CN=WareIQ unrelated disposable MySQL CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
chmod 644 "$fixture_dir/certs/server-cert.pem" "$fixture_dir/certs/ca.pem" \
  "$fixture_dir/certs/untrusted-ca.pem"

export WMS_MYSQL_TLS_FIXTURE_DIR="$fixture_dir"
if ! "${compose[@]}" up --detach; then
  "${compose[@]}" logs >&2 || true
  exit 1
fi
for service in mysql mysql-second; do
published_address="$("${compose[@]}" port "$service" 3306 | head -n 1)"
port="${published_address##*:}"
if [[ ! "$port" =~ ^[0-9]+$ ]]; then
  echo "Could not determine the loopback-only fixture port." >&2
  exit 1
fi
if [[ "$service" == mysql ]]; then fixture_port="$port"; else second_fixture_port="$port"; fi
container_id="$("${compose[@]}" ps -q "$service")"
ready=false
for _ in $(seq 1 120); do
  if docker logs "$container_id" 2>&1 | grep -q 'ready for connections.*port: 3306'; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  "${compose[@]}" logs "$service" >&2 || true
  echo "Disposable MySQL fixture did not become ready within 120 seconds." >&2
  exit 1
fi
done

cd "$repo_root"
WMS_MYSQL_TLS_INTEGRATION=1 \
WMS_OPENVPN_MYSQL_TLS_INTEGRATION=1 \
WMS_MYSQL_TLS_FIXTURE_DIR="$fixture_dir" \
WMS_MYSQL_TLS_FIXTURE_PORT="$fixture_port" \
WMS_MYSQL_TLS_SECOND_FIXTURE_PORT="$second_fixture_port" \
  pnpm exec vitest run --config vitest.config.ts \
    artifacts/api-server/tests/wms-mysql.tls.integration.test.ts \
    artifacts/api-server/tests/wms-openvpn-mysql.tls.integration.test.ts || {
      "${compose[@]}" logs >&2 || true
      exit 1
    }
