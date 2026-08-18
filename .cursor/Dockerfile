# Cloud Agent base image for alphavector-core.
# Stable system dependencies live here; repository dependencies are refreshed in install.sh.
#
# Why these packages:
#   - postgresql: PostgreSQL is the only business truth (DEC-005); the test suite
#     and product boot fail closed without DATABASE_URL.
#   - xvfb / x11-xserver-utils (xsetroot) / x11-utils (xmessage) / x11-apps / x11vnc /
#     scrot: the per-agent desktop is a real Xvfb display, labeled, optionally VNC'd,
#     and screenshotted with scrot (src/computer/desktop.ts).
#   - iproute2 (ip) / iptables: the tenant computer's pack egress is a real network
#     namespace + filter, not a JSON file (src/computer/egress.ts).
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
# Local dev cluster connection string. Not a secret. Product boot and Vitest both
# require DATABASE_URL; baking it here makes it available to every shell.
ENV DATABASE_URL=postgres://av:av@127.0.0.1:5432/av

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg sudo procps \
      postgresql postgresql-contrib \
      xvfb x11-xserver-utils x11-utils x11-apps x11vnc scrot \
      iproute2 iptables \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# The default 'ubuntu' user runs the agent. The namespace computer's egress path
# enters a privileged netns via `sudo ip netns exec ...`, so it needs passwordless sudo.
RUN usermod -aG sudo ubuntu \
 && printf 'ubuntu ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/90-ubuntu \
 && chmod 440 /etc/sudoers.d/90-ubuntu

USER ubuntu
WORKDIR /home/ubuntu
