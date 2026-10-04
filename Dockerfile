FROM node:24-alpine

WORKDIR /app

# The mail libraries are pure JS, so there is nothing to compile for arm64.
COPY package.json package-lock.json ./
# --omit=optional: valibot names typescript as an optional peer, which would
# otherwise ship the compiler (~30 MB) in the image.
RUN npm ci --omit=dev --omit=optional

COPY tsconfig.json ./
COPY src ./src

# config.json (start date + category hints) lives in the data volume.
ENV NODE_ENV=production \
    CONFIG_PATH=/app/data/config.json

VOLUME ["/app/data"]

ENTRYPOINT ["node", "src/main.ts"]
