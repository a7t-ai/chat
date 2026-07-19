# a7t-chat — confined runtime. The SAME image runs locally (OrbStack) and on a VPS.
# Confinement: the container sees only what is mounted (./data). It reaches the host
# Jano + embed services via host.docker.internal (configured in compose.yml).

FROM oven/bun:1-alpine AS base
WORKDIR /app

# --- backend deps (cached layer) ---
FROM base AS deps
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# --- frontend build ---
FROM base AS web
COPY web/package.json web/bun.lock* ./web/
RUN cd web && bun install --frozen-lockfile
COPY web ./web
RUN cd web && bun run build

# --- runtime ---
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY --from=web /app/web/dist ./web/dist

# Inside the container the app binds 0.0.0.0; the host only publishes it on 127.0.0.1
# (see compose.yml port mapping), so LAN/internet still cannot reach it directly.
ENV BIND_HOST=0.0.0.0
EXPOSE 8787

CMD ["bun", "run", "src/server.ts"]
