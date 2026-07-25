#!/bin/sh
# Install rclone for the current build architecture (linux/amd64 | linux/arm64).
set -eu

ARCH="${TARGETARCH:-$(uname -m)}"
case "$ARCH" in
  amd64|x86_64) RCLONE_ARCH="amd64" ;;
  arm64|aarch64) RCLONE_ARCH="arm64" ;;
  arm|arm/v7|armv7l) RCLONE_ARCH="arm" ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

URL="https://downloads.rclone.org/rclone-current-linux-${RCLONE_ARCH}.zip"
echo "Installing rclone (${RCLONE_ARCH}) from ${URL}"
curl -fsSL "$URL" -o /tmp/rclone.zip
unzip -j /tmp/rclone.zip -d /tmp/rclone
mv /tmp/rclone/rclone /usr/local/bin/rclone
chmod +x /usr/local/bin/rclone
rm -rf /tmp/rclone /tmp/rclone.zip
rclone version
