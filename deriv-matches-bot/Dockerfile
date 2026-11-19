FROM node:20-alpine
WORKDIR /app
COPY server.js ./server.js
COPY public ./public
ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.js"]
