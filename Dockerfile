FROM ghcr.io/puppeteer/puppeteer:24

WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./
USER pptruser
RUN npm install

# Copy rest of app
COPY --chown=pptruser:pptruser . .

CMD ["node", "index.js"]