# Zah Hood Central
#
# Debian slim rather than Alpine: Node 24 ships node:sqlite in core so there
# is nothing to compile, and the Litestream release binary is built against
# glibc.
FROM node:24-slim

ARG LITESTREAM_VERSION=0.5.17

# Litestream streams the SQLite file to object storage, which is what makes
# this survive on a host whose disk is wiped on every restart.
RUN apt-get update  && apt-get install -y --no-install-recommends ca-certificates curl  && curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz"       | tar -xz -C /usr/local/bin litestream  && litestream version  && apt-get purge -y --auto-remove curl  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so this layer caches between code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# The database lives on a volume or is restored from the replica, never baked
# into the image.
ENV NODE_ENV=production     PORT=8080     DB_PATH=/data/zahhood.db     TRUST_PROXY=1

# Railway mounts persistent volumes after the image is created. Those mounts
# arrive root-owned, so the entrypoint needs to start as root long enough to
# normalize the mount before dropping the application process to `node`.
RUN mkdir -p /data && chown -R node:node /data /app

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
