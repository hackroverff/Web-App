FROM node:22-alpine

# The app needs Node >= 22.5 for `node:sqlite` (see package.json engines). No build step,
# no bundler: `public/` is the app and `server/` is the API.
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# PORT is what `server/config.js` listens on; DATA_DIR is the one writable place that must
# survive a restart — mount a volume there, or the store forgets its orders on redeploy.
ENV NODE_ENV=production \
    PORT=4173 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

VOLUME /data
EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.js"]
