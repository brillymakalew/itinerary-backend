#!/bin/sh
# TikTok, Instagram and YouTube change often and yt-dlp follows them with frequent releases, so
# the container picks up the latest yt-dlp each time it starts. Set YTDLP_AUTO_UPDATE=false to
# keep the version baked into the image.
set -e

if [ "${YTDLP_AUTO_UPDATE:-true}" = "true" ]; then
  echo "[vibi] Updating yt-dlp…"
  if timeout 120 /opt/yt-dlp/bin/pip install --quiet --no-cache-dir --upgrade "yt-dlp[default,curl-cffi]"; then
    echo "[vibi] yt-dlp $(/opt/yt-dlp/bin/yt-dlp --version)"
  else
    echo "[vibi] yt-dlp update skipped (offline or slow); using $(/opt/yt-dlp/bin/yt-dlp --version)"
  fi
fi

exec "$@"
