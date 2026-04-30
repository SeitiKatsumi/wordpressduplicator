FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache \
    bash \
    docker-cli \
    mysql-client \
    openssh-client \
    openssl \
    python3 \
    py3-pip \
    tar \
    gzip \
  && npm install -g caprover

COPY ui ./ui
COPY package.json server.mjs wizard.py wizard_runner.py wordpress-duplicator.sh README.md ./
COPY docs ./docs

RUN npm install --omit=dev

ENV NODE_ENV=production
ENV PORT=3000
ENV WORDPRESS_DUPLICATOR_DATA_DIR=/data

RUN mkdir -p /data /app/.ssh \
  && chmod 700 /app/.ssh \
  && chmod +x /app/wordpress-duplicator.sh /app/wizard.py /app/wizard_runner.py

WORKDIR /app

EXPOSE 3000

CMD ["npm", "start"]
