FROM node:20-alpine
WORKDIR /app
COPY matchsync-engine/package*.json ./
RUN npm install --omit=dev
COPY matchsync-engine/ .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
