# The Instant relay. Built by relay/deploy.sh, which bundles src/ (and the
# shared billing code in functions/src) into dist/relay.mjs first.
FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist ./dist

ENV NODE_ENV=production
# Cloud Run sets PORT (8080 by default); main.ts reads it.
EXPOSE 8080

CMD ["node", "dist/relay.mjs"]
