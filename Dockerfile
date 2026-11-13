FROM node:24.22.3-bookworm-slim

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      "/opt/yarn-v${YARN_VERSION}" \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg imagemagick libimage-exiftool-perl tzdata zip ldap-utils ca-certificates \
    python3 python3-opencv python3-numpy \
    tesseract-ocr tesseract-ocr-eng \
    libheif1 libmagickcore-6.q16-6-extra \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG INSTALL_AI_STACK=false
ARG AI_ACCELERATOR=cpu
RUN if [ "$INSTALL_AI_STACK" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends python3-pip && \
      rm -rf /var/lib/apt/lists/* && \
      pip install --no-cache-dir --break-system-packages "typing_extensions>=4.10.0" filelock && \
      if [ "$AI_ACCELERATOR" = "cuda" ]; then \
        pip install --no-cache-dir --break-system-packages torch --index-url https://download.pytorch.org/whl/cu128; \
      else \
        pip install --no-cache-dir --break-system-packages torch --index-url https://download.pytorch.org/whl/cpu; \
      fi && \
      pip install --no-cache-dir --break-system-packages ultralytics; \
    fi

COPY package.json package-lock.json server.js LICENSE ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /media/original /app/.cache

ENV MEDIA_DIR=/media/original
ENV CACHE_DIR=/app/.cache
ENV PORT=4000
ENV HOST=0.0.0.0
ENV VIDSTREAM_DOCKER=1
ENV NODE_OPTIONS=--max-old-space-size=512

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
