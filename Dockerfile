# Debian-based (not Alpine) starting here: PyTorch's official pip
# wheels target glibc, not musl, so the object-detection stack below
# needs a glibc base to install reliably. ffmpeg/imagemagick/tesseract/
# opencv are all readily apt-installable on Debian too, so this doesn't
# cost anything for the rest of the stack.
FROM node:22-bookworm-slim

# ffmpeg/imagemagick: photo & video derivatives.
# python3-opencv + python3-numpy: face/cat presence detection (uses
# OpenCV's own bundled Haar cascades -- no separate model download).
# tesseract-ocr: text extraction for search.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg imagemagick tzdata zip ldap-utils \
    python3 python3-opencv python3-numpy python3-pip \
    tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

# HEIC/HEIF (iPhone photos) needs ImageMagick's "extra" delegate library
# and libheif. Debian only pulls those in as *recommended* packages, which
# --no-install-recommends above skips -- so request them explicitly. The
# `|| true` is deliberate: if a package name differs on your Debian
# release, the build continues and HEIC files simply show up in the
# app's "failed" list with a clear error rather than breaking the build.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libheif1 libmagickcore-6.q16-6-extra \
    && rm -rf /var/lib/apt/lists/* || true

WORKDIR /app

# General object detection (person/animals/vehicles/furniture/food/...,
# 80 COCO classes) via YOLOv8n -- a real, modern, multi-class detector,
# layered on top of (not instead of) the Haar-cascade face/cat presence
# check. This is the heavy, optional half of detection: CPU-only
# PyTorch + ultralytics add real image size and per-item processing
# time, so it's behind a build arg you can turn off:
#   docker build --build-arg ENABLE_OBJECT_DETECTION=false .
# The model weights download once, at build time, into this layer --
# the running container never needs network access for this. COPY
# below (which brings in the actual app source, including
# lib/vision/object_worker.py that loads this file) happens *after*,
# and only overwrites files that exist in the source tree, so this
# downloaded weight file survives it.
ARG ENABLE_OBJECT_DETECTION=true
RUN if [ "$ENABLE_OBJECT_DETECTION" = "true" ]; then \
      pip install --no-cache-dir --break-system-packages "typing_extensions>=4.10.0" filelock && \
      pip install --no-cache-dir --break-system-packages \
        torch --index-url https://download.pytorch.org/whl/cpu && \
      pip install --no-cache-dir --break-system-packages ultralytics && \
      mkdir -p /app/lib/vision && \
      cd /app/lib/vision && python3 -c "from ultralytics import YOLO; YOLO('yolov8n.pt')" ; \
    fi

COPY . .

RUN mkdir -p /media/original /app/.cache

ENV MEDIA_DIR=/media/original
ENV CACHE_DIR=/app/.cache
ENV PORT=4000
ENV HOST=0.0.0.0
# Bounds Node's own heap; child-process (ffmpeg/opencv/torch) memory is
# separate and is instead capped at the container level -- see the
# mem_limit in docker-compose.yml.
ENV NODE_OPTIONS=--max-old-space-size=512

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
