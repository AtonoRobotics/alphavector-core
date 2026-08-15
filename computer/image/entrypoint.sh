#!/usr/bin/env bash
set -euo pipefail

mkdir -p /tenant/home /tenant/tools /tenant/browser-profiles /tenant/state /tmp/av-desktops
chown -R tenant:avdisk /tenant
chmod 0770 /tenant /tenant/home /tenant/tools /tenant/browser-profiles /tenant/state

if [[ -x /opt/av-computer/bin/apply-egress ]]; then
  /opt/av-computer/bin/apply-egress || true
fi

# Keep the machine up. Desktops are started per-agent by the host.
exec sleep infinity
