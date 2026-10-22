#!/bin/sh
# Starts as root only to make sure the data folder (a bind mount, created by Docker as root) is writable,
# then drops to the unprivileged "meshmap" user.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$MESHMAP_DATA_DIR"
  chown meshmap:meshmap "$MESHMAP_DATA_DIR"
  exec setpriv --reuid=meshmap --regid=meshmap --init-groups "$@"
fi
exec "$@"
