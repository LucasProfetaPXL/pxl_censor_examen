FROM node:22-alpine
RUN apk add --no-cache curl
WORKDIR /app

# Kopieer de package bestanden om de dependencies te installeren
COPY package*.json ./
RUN npm install --only=production

# Kopieer de server code
COPY server.js .

# Gebruik een non-root user voor security (eis in veel PROD omgevingen)
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
USER nodejs

EXPOSE 8080

CMD ["node", "server.js"]