#!/usr/bin/env bash
# Build one image that runs on both x86-64 and ARM64 (Raspberry Pi, Apple
# Silicon, ARM NAS/servers). See docs/DOCKER_HUB.md for publishing with CI.
#
#   scripts/build-multiarch.sh yourname/stream:latest --push
#
# This creates a local builder if needed and pushes the two architectures
# to the specified registry. The default Dockerfile leaves optional object
# recognition packages disabled. Cross-architecture builds require emulation
# support or a builder that has both architectures available.
set -euo pipefail
IMAGE="${1:?usage: $0 <registry/name:tag> [--push]}"
ACTION="${2:---push}"
docker buildx inspect stream-builder >/dev/null 2>&1 || docker buildx create --name stream-builder >/dev/null
docker buildx build \
  --builder stream-builder \
  --platform linux/amd64,linux/arm64 \
  --pull \
  -t "$IMAGE" "$ACTION" .
