# Zah Hood Central
# Node 24 ships node:sqlite in core, so there is nothing to compile.
FROM node:24-alpine

WORKDIR /app

# Install dependencies first so this layer caches between code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# The database lives on the mounted volume, not in the image.
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/zahhood.db \
    TRUST_PROXY=1

EXPOSE 8080

# Run as the unprivileged user the base image already provides.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

CMD ["node", "src/server.js"]
