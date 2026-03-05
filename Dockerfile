FROM ghcr.io/puppeteer/puppeteer:24

WORKDIR /app

USER pptruser

COPY --chown=pptruser:pptruser package*.json ./
RUN npm ci --omit=dev

COPY --chown=pptruser:pptruser . .

HEALTHCHECK --interval=15m --timeout=30s --retries=3 \
  CMD pgrep -f "node index.js" || exit 1

CMD ["node", "index.js"]
