FROM node:22-alpine
RUN apk add --no-cache curl
RUN apk add --no-cache postgresql-client
WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN chmod +x /app/init.sh
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
RUN chown -R nodejs:nodejs /app
USER nodejs

EXPOSE 8000

CMD ["node", "server.js"]
