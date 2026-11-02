FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8380

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8380
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8380/api/config >/dev/null || exit 1
CMD ["node", "server/index.js"]
