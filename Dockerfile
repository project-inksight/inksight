FROM node:22-bookworm-slim

WORKDIR /app

# Install curl and ca-certificates for go2rtc & healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Ensure runtime directories exist
RUN mkdir -p /app/data /app/storage /app/bin

EXPOSE 3001 1984 8554

ENV NODE_ENV=production
ENV PORT=3001

CMD ["node", "dist/server/index.js"]

