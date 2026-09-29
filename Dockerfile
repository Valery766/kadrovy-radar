# Сборка и запуск «Ставки» одним образом: мини-приложение (Vite) + сервер (Node 24, TypeScript).
# Сборка укладывается в 5 минут без учёта загрузки базового образа (замер в README).
FROM node:24-bookworm-slim AS build
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

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# Node already trusts public CAs. Add the bundled public MAX chain without
# requiring apt mirrors or disabling TLS verification.
ENV NODE_EXTRA_CA_CERTS=/app/server/certs/russian_trusted_bundle.pem
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/assets server/assets
COPY --from=build /app/server/certs server/certs
COPY --from=build /app/webapp/dist webapp/dist
COPY packs packs
RUN chmod 644 /app/server/certs/*.pem \
 && mkdir -p /data && chown node:node /data
USER node
ENV PORT=8080 DATA_DIR=/data PACKS_DIR=/app/packs
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/dist/main.js"]
