# Image khusus Puppeteer: Chromium + deps sudah tersedia
FROM ghcr.io/puppeteer/puppeteer:22.15.0

# Jalankan sebagai user non-root bawaan image
USER pptruser
WORKDIR /app

# Copy manifest & install deps (tanpa devDependencies)
COPY --chown=pptruser:pptruser package*.json ./
# gunakan npm install agar tidak ketat pada lockfile
RUN npm install --omit=dev

# Copy source code
COPY --chown=pptruser:pptruser . .

# Chromium sudah tersedia; tidak perlu download ulang
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

# (opsional, dokumentasi port healthcheck Koyeb)
EXPOSE 8000

CMD ["npm", "start"]
