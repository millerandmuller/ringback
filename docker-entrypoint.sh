#!/bin/sh
# Materialize the Vonage private key from a base64 secret (never baked into the image),
# make sure the SQLite directory exists, then start the server.
set -e

KEY_PATH="${VONAGE_PRIVATE_KEY_PATH:-/app/private.key}"
if [ -n "$VONAGE_PRIVATE_KEY_B64" ] && [ ! -f "$KEY_PATH" ]; then
  echo "$VONAGE_PRIVATE_KEY_B64" | base64 -d > "$KEY_PATH"
  chmod 600 "$KEY_PATH"
fi

DB_PATH="${DATABASE_PATH:-./ringback.db}"
mkdir -p "$(dirname "$DB_PATH")"

exec "$@"
