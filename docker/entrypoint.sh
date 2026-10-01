#!/bin/sh
# Boot sequence for Zah Hood Central.
#
#   1. If replication is configured and there is no local database yet,
#      restore the newest copy from object storage.
#   2. Run the server under Litestream so every write is streamed out.
#
# With no REPLICA_URL set the app still runs, just without durability - which
# is fine locally and on a host that gives you a real disk.
set -e

: "${DB_PATH:=/data/zahhood.db}"
mkdir -p "$(dirname "$DB_PATH")"

# A Railway volume is mounted after the image's filesystem permissions have
# been applied and is root-owned by default. Keep the server unprivileged,
# but let the entrypoint fix the mount before handing off to node.
if [ "$(id -u)" -eq 0 ]; then
  chown -R node:node "$(dirname "$DB_PATH")"
fi

run_server() {
  if [ "$(id -u)" -eq 0 ]; then
    exec su -s /bin/sh node -c "exec node src/server.js"
  fi
  exec node src/server.js
}

if [ -z "${REPLICA_URL:-}" ]; then
  echo "[boot] REPLICA_URL not set - starting without replication."
  echo "[boot] The database is NOT durable on a host with an ephemeral disk."
  run_server
fi

echo "[boot] replication target: ${REPLICA_URL%%\?*}"

if [ -f "$DB_PATH" ]; then
  echo "[boot] local database already present, skipping restore."
else
  echo "[boot] no local database - restoring from the replica..."
  litestream restore -if-replica-exists -config /app/litestream.yml "$DB_PATH"
  if [ -f "$DB_PATH" ]; then
    echo "[boot] restore complete."
  else
    echo "[boot] nothing to restore - this looks like a first run. Starting fresh."
  fi
fi

if [ "$(id -u)" -eq 0 ] && [ -f "$DB_PATH" ]; then
  chown node:node "$DB_PATH"
fi

echo "[boot] starting server under litestream replicate"
if [ "$(id -u)" -eq 0 ]; then
  exec litestream replicate -config /app/litestream.yml -exec "su -s /bin/sh node -c 'exec node src/server.js'"
fi
exec litestream replicate -config /app/litestream.yml -exec "node src/server.js"
