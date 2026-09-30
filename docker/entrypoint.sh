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

if [ -z "${REPLICA_URL:-}" ]; then
  echo "[boot] REPLICA_URL not set - starting without replication."
  echo "[boot] The database is NOT durable on a host with an ephemeral disk."
  exec node src/server.js
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

echo "[boot] starting server under litestream replicate"
exec litestream replicate -config /app/litestream.yml -exec "node src/server.js"
