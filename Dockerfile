# Squirrel — headless sunucu imajı (arayüz tarayıcıdan, veri SDK'lardan gelir).
#   docker build -t squirrel .
#   docker run -d --name squirrel -p 4590:4590 -v squirrel-data:/data squirrel
FROM node:22-alpine

WORKDIR /srv/squirrel
COPY package.json ./
COPY app ./app

ENV SQUIRREL_HOST=0.0.0.0 \
    SQUIRREL_PORT=4590 \
    SQUIRREL_DATA_DIR=/data

VOLUME /data
EXPOSE 4590

USER node
CMD ["node", "app/server.mjs"]
