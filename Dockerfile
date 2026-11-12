# Debian-based (not Alpine) starting here: PyTorch's official pip
# wheels target glibc, not musl, so the object-detection stack below
# needs a glibc base to install reliably. ffmpeg/imagemagick/tesseract/
# opencv are all readily apt-installable on Debian too, so this doesn't
# cost anything for the rest of the stack.
FROM node:24.22.3-bookworm-slim

# The server runs directly with Node and has no runtime npm packages.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      "/opt/yarn-v${YARN_VERSION}" \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg

# ffmpeg/imagemagick: photo & video derivatives.
# python3-opencv + python3-numpy: face/cat presence detection (uses
# OpenCV's own bundled Haar cascades -- no separate model download).
# tesseract-ocr: text extraction for search.
# libheif and the ImageMagick extra delegate support iPhone HEIC/HEIF photos.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg imagemagick libimage-exiftool-perl tzdata zip ldap-utils ca-certificates \
    python3 python3-opencv python3-numpy \
    tesseract-ocr tesseract-ocr-eng \
    libheif1 libmagickcore-6.q16-6-extra \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Optional AI stack. The default build is intentionally light and fast.
# To enable model downloads from the admin dashboard:
#   STREAM_AI_STACK=true docker compose -f docker-compose.yml build stream
# Default CPU; for Linux x86_64 hosts with NVIDIA GPU passthrough:
#   STREAM_AI_STACK=true STREAM_AI_ACCELERATOR=cuda docker compose -f docker-compose.yml -f docker-compose.gpu.yml build
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
# Bounds Node's own heap; child-process (ffmpeg/opencv/torch) memory is
# separate and is instead capped at the container level -- see the
# mem_limit in docker-compose.yml.
ENV NODE_OPTIONS=--max-old-space-size=512

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
