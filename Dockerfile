FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production MULTIUSER_DATA_DIR=/app/data
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY lib ./lib
COPY service ./service
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 8200
CMD ["node","service/api.mjs"]
