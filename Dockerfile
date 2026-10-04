FROM node:24-alpine

WORKDIR /app

# The mail libraries are pure JS, so there is nothing to compile for arm64.
COPY package.json package-lock.json ./
# --omit=optional: valibot names typescript as an optional peer, which would
# otherwise ship the compiler (~30 MB) in the image. --ignore-scripts: the
# only script is `prepare` (git hooks, dev-only); the runtime deps are pure JS.
RUN npm ci --omit=dev --omit=optional --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

# The database (start date + category hints) lives in the data volume; an
# old config.json there is imported into it once.
ENV NODE_ENV=production \
    DB_PATH=/app/data/zen-autotag.sqlite \
    CONFIG_PATH=/app/data/config.json \
    HEARTBEAT_FILE=/tmp/alive

# uid 1000, so files in a bind-mounted data dir belong to the host user.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]

# The loop touches HEARTBEAT_FILE at least once a minute; a scan can take a
# few. Older than 10 minutes means the process is stuck.
HEALTHCHECK --interval=1m --timeout=5s --start-period=1m --retries=3 \
  CMD find "$HEARTBEAT_FILE" -mmin -10 | grep -q .

ENTRYPOINT ["node", "src/main.ts"]
