# Gunakan basis Debian agar paket Chromium tersedia
FROM node:20-bullseye

# Pastikan tzdata non-interaktif
ENV DEBIAN_FRONTEND=noninteractive

# Install Chromium + deps & fonts untuk render QR dan WhatsApp Web
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libavif13 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libwayland-client0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    xdg-utils \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Set path Chromium di Debian
ENV CHROMIUM_PATH=/usr/bin/chromium

# Workdir & copy files
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Env umum untuk puppeteer di container
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

# Jalankan bot
CMD ["npm", "start"]
