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

mkdir -p "$fixture_dir/certs"
fixture_gid="$(id -g)"
chmod 755 "$fixture_dir"
chmod 770 "$fixture_dir/certs"
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 2 \
  -keyout "$fixture_dir/certs/ca-key.pem" \
  -out "$fixture_dir/certs/ca.pem" \
  -subj "/CN=WareIQ disposable MySQL fixture CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
docker run --rm --user 999:999 --group-add "$fixture_gid" \
  --volume "$fixture_dir/certs:/certs" \
  --entrypoint openssl mysql:8.4 req -newkey rsa:2048 -sha256 -nodes \
  -keyout /certs/server-key.pem -out /certs/server.csr \
  -subj "/CN=mysql.fixture.test" 2>/dev/null
chmod 755 "$fixture_dir/certs"
printf '%s\n' \
  'subjectAltName=DNS:mysql.fixture.test' \
  'extendedKeyUsage=serverAuth' \
  'keyUsage=digitalSignature,keyEncipherment' \
  > "$fixture_dir/certs/server.ext"
openssl x509 -req -in "$fixture_dir/certs/server.csr" \
  -CA "$fixture_dir/certs/ca.pem" -CAkey "$fixture_dir/certs/ca-key.pem" \
  -CAcreateserial -out "$fixture_dir/certs/server-cert.pem" -days 2 -sha256 \
  -extfile "$fixture_dir/certs/server.ext" 2>/dev/null
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
  "${compose[@]}" logs mysql >&2 || true
  exit 1
fi
published_address="$("${compose[@]}" port mysql 3306 | head -n 1)"
fixture_port="${published_address##*:}"
if [[ ! "$fixture_port" =~ ^[0-9]+$ ]]; then
  echo "Could not determine the loopback-only fixture port." >&2
  exit 1
fi
container_id="$("${compose[@]}" ps -q mysql)"
ready=false
for _ in $(seq 1 120); do
  if docker logs "$container_id" 2>&1 | grep -q 'ready for connections.*port: 3306'; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  "${compose[@]}" logs mysql >&2 || true
  echo "Disposable MySQL fixture did not become ready within 120 seconds." >&2
  exit 1
fi

cd "$repo_root"
WMS_MYSQL_TLS_INTEGRATION=1 \
WMS_MYSQL_TLS_FIXTURE_DIR="$fixture_dir" \
WMS_MYSQL_TLS_FIXTURE_PORT="$fixture_port" \
  pnpm exec vitest run --config vitest.config.ts \
    artifacts/api-server/tests/wms-mysql.tls.integration.test.ts || {
      "${compose[@]}" logs mysql >&2 || true
      exit 1
    }
