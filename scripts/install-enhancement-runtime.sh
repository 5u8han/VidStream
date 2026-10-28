#!/bin/sh
set -eu
# Pinned upstream executables. Weights are downloaded separately from Settings.
if [ "$(dpkg --print-architecture)" != amd64 ]; then
  echo 'Bundled AI enhancement tools require Linux amd64. Standard CPU smoothing works on ARM; build upstream NCNN tools for native ARM AI support.' >&2
  exit 1
fi
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl unzip libvulkan1 libgomp1
mkdir -p /tmp/stream-enhancement-runtime
cd /tmp/stream-enhancement-runtime
curl -fsSL --retry 3 -o rife.zip https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-ubuntu.zip
curl -fsSL --retry 3 -o esrgan.zip https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip
printf '%s\n' '1e2c7ee7fa7daa326542d50622f0afedc80cf6f1858bda411d16385ffa5cdf68  rife.zip' 'e5aa6eb131234b87c0c51f82b89390f5e3e642b7b70f2b9bbe95b6a285a40c96  esrgan.zip' | sha256sum -c -
unzip -p rife.zip rife-ncnn-vulkan-20221029-ubuntu/rife-ncnn-vulkan > /usr/local/bin/rife-ncnn-vulkan
unzip -p esrgan.zip realesrgan-ncnn-vulkan > /usr/local/bin/realesrgan-ncnn-vulkan
chmod 755 /usr/local/bin/rife-ncnn-vulkan /usr/local/bin/realesrgan-ncnn-vulkan
cd /
rm -rf /tmp/stream-enhancement-runtime /var/lib/apt/lists/*
