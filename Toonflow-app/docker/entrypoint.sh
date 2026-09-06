#!/bin/sh
set -e

# On first run the bind-mounted data volume is empty.
# Copy the bundled app data (web, serve, models, etc.) into the volume
# so the server can find its static assets and built files.
# User-generated content (oss/) accumulates on subsequent runs.
if [ ! -f /app/data/.initialized ]; then
  echo "[entrypoint] First run: initialising data volume from bundle..."
  cp -rn /app/data.bundle/. /app/data/
  touch /app/data/.initialized
  echo "[entrypoint] Data volume initialised."
fi

exec "$@"
