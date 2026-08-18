#!/usr/bin/env bash
# Per-boot service reconciliation for alphavector-core.
# Idempotent, tolerates restarts, and returns once services are ready.
set -uo pipefail

# The Alpine/unshare tenant computer needs unprivileged user namespaces.
# Harmless where already permitted; best-effort so start never fails on a locked-down host.
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 >/dev/null 2>&1 || true
sudo sysctl -w kernel.unprivileged_userns_clone=1 >/dev/null 2>&1 || true

# PostgreSQL is the only business truth (DEC-005). Start the local cluster (idempotent).
sudo pg_ctlcluster 16 main start >/dev/null 2>&1 || true

# Wait for readiness before touching roles.
for _ in $(seq 1 30); do
  if sudo -u postgres pg_isready -q; then break; fi
  sleep 1
done

# Ensure the dev role and database exist (matches the DATABASE_URL baked into the image).
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='av'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE av LOGIN PASSWORD 'av';"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='av'" | grep -q 1 \
  || sudo -u postgres createdb -O av av

echo "postgres ready on postgres://av:av@127.0.0.1:5432/av"
