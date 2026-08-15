FROM debian:bookworm-slim

LABEL org.opencontainers.image.title="AV Dev computer"
LABEL llc.alphavector.dev/bundle="llc.alphavector.dev"
LABEL llc.alphavector.dev/component="computer"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    AV_TENANT_ID="" \
    AV_EGRESS_HOSTS=""

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      coreutils \
      curl \
      findutils \
      fluxbox \
      fonts-dejavu-core \
      git \
      iproute2 \
      iptables \
      novnc \
      openssl \
      python3 \
      python3-pil \
      scrot \
      websockify \
      x11-apps \
      x11-xserver-utils \
      x11vnc \
      xdotool \
      xvfb \
      chromium \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --home /tenant/home --shell /bin/bash --uid 1100 tenant \
    && useradd --system --home /opt/av-computer --shell /usr/sbin/nologin --uid 1101 agent \
    && useradd --system --home /opt/av-computer --shell /usr/sbin/nologin --uid 1102 desktop \
    && groupadd --system avdisk \
    && usermod -aG avdisk tenant \
    && usermod -aG avdisk agent \
    && usermod -aG avdisk desktop

COPY bin/ /opt/av-computer/bin/
COPY entrypoint.sh /opt/av-computer/entrypoint.sh
RUN chmod 0755 /opt/av-computer/entrypoint.sh /opt/av-computer/bin/*

VOLUME ["/tenant"]
WORKDIR /tenant/home
EXPOSE 5900 6080

ENTRYPOINT ["/opt/av-computer/entrypoint.sh"]
