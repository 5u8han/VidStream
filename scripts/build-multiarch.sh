#!/usr/bin/env bash
# Build one image that runs on both x86-64 and ARM64 (Raspberry Pi, Apple
# Silicon, ARM NAS/servers). You only need this to *publish* a single
# multi-arch image; on any one machine, `docker compose up -d --build`
# already builds natively for that machine's architecture.
#
#   scripts/build-multiarch.sh yourname/stream:latest --push
#
# (A multi-platform build can't be loaded into the local image store, so
# it has to be pushed to a registry. Building the arm64 half on an x86
# machine runs under QEMU emulation and is slow, mostly because of the
# PyTorch install -- pass ENABLE_OBJECT_DETECTION=false to skip it.)
set -euo pipefail
IMAGE="${1:?usage: $0 <registry/name:tag> [--push]}"
ACTION="${2:---push}"
docker buildx inspect stream-builder >/dev/null 2>&1 || docker buildx create --name stream-builder >/dev/null
docker buildx build \
  --builder stream-builder \
  --platform linux/amd64,linux/arm64 \
  --build-arg ENABLE_OBJECT_DETECTION="${ENABLE_OBJECT_DETECTION:-true}" \
  -t "$IMAGE" "$ACTION" .
