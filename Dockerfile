FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Install production dependencies first so Docker layer caching kicks in.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY openapi.yaml ./

# SQLite database + uploaded files live here; mounted as a volume in compose.
ENV DATA_DIR=/data PORT=3000
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/index.js"]
