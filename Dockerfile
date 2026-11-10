# Runtime image: the app has no npm dependencies, so nothing is installed.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/feedback.db

WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public

# The database and uploaded files live in a volume and survive container restarts.
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/demo-users > /dev/null || exit 1

CMD ["node", "server.js"]
