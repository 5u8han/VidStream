#!/usr/bin/env bash
set -euo pipefail
IMAGE="${1:?usage: $0 <registry/name:tag> [--push]}"
ACTION="${2:---push}"
docker buildx inspect stream-builder >/dev/null 2>&1 || docker buildx create --name stream-builder >/dev/null
docker buildx build \
  --builder stream-builder \
  --platform linux/amd64,linux/arm64 \
  --pull \
  -t "$IMAGE" "$ACTION" .
