FROM node:20-bookworm-slim

# better-sqlite3 may need to compile from source if no prebuilt binary
# matches; install only the toolchain it needs in builder image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
