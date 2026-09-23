# Сборка и запуск «Ставки» одним образом: мини-приложение (Vite) + сервер (Node 24, TypeScript).
# Сборка укладывается в 5 минут без учёта загрузки базового образа (замер в README).
FROM node:24-bookworm-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY webapp/package.json webapp/
RUN npm ci --no-audit --no-fund
COPY server server
COPY webapp webapp
COPY packs packs
RUN npm run build -w webapp && npm run build -w server \
 && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7
ENV NODE_ENV=production
WORKDIR /app
# Сертификаты Минцифры: без них platform-api2.max.ru не открывается с чистой машины.
COPY server/certs/russian_trusted_root_ca.pem /usr/local/share/ca-certificates/russian_trusted_root_ca.crt
COPY server/certs/russian_trusted_sub_ca.pem  /usr/local/share/ca-certificates/russian_trusted_sub_ca.crt
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && update-ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/assets server/assets
COPY --from=build /app/server/certs server/certs
COPY --from=build /app/webapp/dist webapp/dist
COPY packs packs
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=8080 DATA_DIR=/data PACKS_DIR=/app/packs
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "server/dist/main.js"]
