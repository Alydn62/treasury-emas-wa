# Image khusus Puppeteer: Chromium + deps sudah ada
FROM ghcr.io/puppeteer/puppeteer:22.15.0

# Jalankan sebagai user non-root bawaan image
USER pptruser
WORKDIR /app

# Copy manifest & install deps (tanpa devDependencies)
COPY --chown=pptruser:pptruser package*.json ./
# GANTI: gunakan npm install agar tidak ketat pada lockfile lama
RUN npm install --omit=dev

# Copy source code
COPY --chown=pptruser:pptruser . .

# Chromium sudah tersedia; skip download
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

CMD ["npm", "start"]
