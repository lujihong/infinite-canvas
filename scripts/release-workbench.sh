#!/usr/bin/env bash
set -euo pipefail
: "${WORKBENCH_PROJECT:?Set a unique WORKBENCH_PROJECT}"
: "${WORKBENCH_IMAGE:?Set a verified local image tag, ID or digest}"
: "${WORKBENCH_DATA_DIR:?Set an explicit data directory}"
: "${WORKBENCH_CPUS:?Set calibrated CPU limit}"
: "${WORKBENCH_MEM_LIMIT:?Set calibrated memory limit}"
: "${WORKBENCH_PIDS_LIMIT:?Set calibrated PID limit}"
case "${1:-}" in check|up) ;; *) printf 'Usage: %s check|up\n' "$0" >&2; exit 2 ;; esac
case "$WORKBENCH_IMAGE" in *:latest|*:latest@*) printf 'Refusing latest image\n' >&2; exit 1 ;; esac
if [[ ! "$WORKBENCH_PROJECT" =~ ^[a-z0-9][a-z0-9_-]+$ ]]; then printf 'Invalid project name\n' >&2; exit 1; fi
root=$(cd "$(dirname "$0")/.." && pwd -P)
# Resolve tags to the local content-addressed image before Compose can start a container.
WORKBENCH_IMAGE=$(docker image inspect --format '{{.Id}}' "$WORKBENCH_IMAGE")
[[ "$WORKBENCH_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]] || { printf 'Invalid image ID\n' >&2; exit 1; }
export WORKBENCH_IMAGE
compose=(docker compose -p "$WORKBENCH_PROJECT" -f "$root/docker-compose.release.yml")
"${compose[@]}" config --quiet
if [[ "$1" == check ]]; then printf 'release_config=PASS image=%s\n' "$WORKBENCH_IMAGE"; exit 0; fi
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 180
