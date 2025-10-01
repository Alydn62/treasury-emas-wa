# Image khusus Puppeteer: sudah ada Chromium + semua dependensi
FROM ghcr.io/puppeteer/puppeteer:22.15.0

# Jalankan sebagai user non-root bawaan image
USER pptruser

WORKDIR /app

# Copy package & install deps (tanpa devDependencies)
COPY --chown=pptruser:pptruser package*.json ./
RUN npm ci --omit=dev

# Copy source code
COPY --chown=pptruser:pptruser . .

# Chromium sudah tersedia di image → tak perlu download ulang
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

# Start
CMD ["npm", "start"]
