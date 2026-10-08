#!/bin/sh
# Railway (and most volume-capable platforms) mounts a volume as root:root over the
# directory the image prepared. The image runs as the unprivileged `factory` user, which
# is right, but that user cannot chown a root-owned mount, so the service would refuse to
# start against a ledger it cannot write.
#
# This entrypoint resolves that WITHOUT running the service as root: if the container
# starts as root, it fixes ownership of the data directory and then drops to `factory`
# before executing the real command. The service therefore always runs unprivileged, and
# the only code that ever runs as root is these four lines.
#
# If the container is not started as root, this is a plain exec: nothing is chowned and
# nothing is escalated. A deployment that already runs as `factory` against a writable
# volume is unaffected.
set -eu

DATA_DIR="${FACTORY_DATA_DIR:-/var/lib/software-factory}"

if [ "$(id -u)" = "0" ]; then
  # `mkdir -p` so a fresh volume works, and `|| true` so a read-only subpath cannot
  # abort the container before the service has logged why it will refuse to serve.
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  chown -R factory:factory "$DATA_DIR" 2>/dev/null || true
  exec setpriv --reuid=factory --regid=factory --clear-groups "$@"
fi

exec "$@"
