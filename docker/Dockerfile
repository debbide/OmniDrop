# syntax=docker/dockerfile:1
# Single OmniDrop image: API + Worker + Web (nginx). Pair with Redis in compose.
FROM node:20-bookworm-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# ---------- deps (all workspace packages needed for api/worker/web) ----------
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY packages/crypto/package.json packages/crypto/
COPY packages/db/package.json packages/db/
COPY packages/remote-fs/package.json packages/remote-fs/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile=false

# ---------- build ----------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm --filter @omnidrop/shared build \
 && pnpm --filter @omnidrop/crypto build \
 && pnpm --filter @omnidrop/db build \
 && pnpm --filter @omnidrop/remote-fs build \
 && pnpm --filter @omnidrop/api build \
 && pnpm --filter @omnidrop/worker build \
 && pnpm --filter @omnidrop/web build

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    API_PORT=3000 \
    RCLONE_PATH=rclone

ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip nginx \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

COPY docker/install-rclone.sh /tmp/install-rclone.sh
RUN chmod +x /tmp/install-rclone.sh \
  && TARGETARCH=${TARGETARCH} /tmp/install-rclone.sh \
  && rm /tmp/install-rclone.sh

# App (monorepo layout for workspace resolution)
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages /app/packages
COPY --from=build /app/apps/api /app/apps/api
COPY --from=build /app/apps/worker /app/apps/worker
COPY --from=build /app/apps/web/dist /app/apps/web/dist

# Nginx: static UI + reverse proxy /api → local API
COPY docker/nginx-all-in-one.conf /etc/nginx/conf.d/default.conf
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
  && mkdir -p /data/db /data/tmp /data/artifacts /var/log/nginx \
  && ln -sf /dev/stdout /var/log/nginx/access.log \
  && ln -sf /dev/stderr /var/log/nginx/error.log

EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=8 \
  CMD curl -fsS http://127.0.0.1/api/v1/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
