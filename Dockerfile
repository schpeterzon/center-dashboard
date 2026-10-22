# Private dashboard server. See README → "Run it privately" and SECURITY.md.
#   docker build -t jarvis-dashboard .
#   docker run -d -p 127.0.0.1:8787:8787 -v jarvis-data:/data --name jarvis jarvis-dashboard
FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN node tools/build.mjs && node tools/check.mjs

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 JARVIS_DATA=/data
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/src/catalog.mjs ./src/catalog.mjs
COPY --from=build /app/package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "server/index.mjs"]
