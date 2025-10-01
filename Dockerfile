FROM node:20-bullseye

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 8000
CMD ["npm", "start"]
