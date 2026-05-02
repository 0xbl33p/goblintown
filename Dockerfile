# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app

# better-sqlite3 needs a toolchain to compile from source
RUN apk add --no-cache python3 make g++ git

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY site ./site

RUN npm run build && npm prune --omit=dev

# --- runtime stage ---
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    GOBLINTOWN_NO_BANNER=1 \
    PORT=7777 \
    GOBLINTOWN_STORAGE=sqlite

# Persistent Warren lives here — mount a volume to keep it across deploys
ENV GOBLINTOWN_HOME=/data
RUN mkdir -p /data && addgroup -S goblin && adduser -S goblin -G goblin && chown -R goblin:goblin /data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/site ./site
COPY --from=build /app/package.json ./package.json

USER goblin
EXPOSE 7777
VOLUME ["/data"]

# Initialise a Warren on first boot, then serve.
# OPENAI_API_KEY must be passed in via env (-e) or your platform's secret store.
CMD ["sh", "-c", "cd /data && (test -f warren.json || node /app/dist/cli.js init) && node /app/dist/cli.js serve --port ${PORT:-7777} --host 0.0.0.0"]
