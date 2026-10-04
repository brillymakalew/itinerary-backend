# syntax=docker/dockerfile:1

# ---- Build: compile TypeScript with dev dependencies ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts skips ffmpeg-static's binary download; the runtime uses Debian's ffmpeg.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- Runtime: production dependencies, compiled JS, ffmpeg and yt-dlp ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3030 \
    DATA_DIR=/app/data \
    FFMPEG_BIN=/usr/bin/ffmpeg \
    YTDLP_BIN=/opt/yt-dlp/bin/yt-dlp \
    YTDLP_JS_RUNTIME=node
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# yt-dlp downloads TikTok, Instagram and YouTube videos for analysis. It lives in its own
# virtualenv owned by the app user so it can update itself at start-up (see the entrypoint).
RUN python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default,curl-cffi]" \
    && chown -R node:node /opt/yt-dlp
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/vibi-entrypoint.sh
# Video uploads land here; owned by the unprivileged user the server runs as.
RUN chmod 755 /usr/local/bin/vibi-entrypoint.sh && mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3030
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3030) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["vibi-entrypoint.sh"]
CMD ["node", "dist/index.js"]
