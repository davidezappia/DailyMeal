FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/dailymeal.db TZ=Europe/Rome
RUN apk add --no-cache tzdata && mkdir /data && chown node:node /data
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
USER node
EXPOSE 3000
VOLUME /data
HEALTHCHECK --interval=1m --timeout=5s CMD wget -qO- http://localhost:3000/api/signup-open || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
