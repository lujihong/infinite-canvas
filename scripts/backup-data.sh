#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s SOURCE_DATA_DIR OUTPUT_DIR\n' "$0" >&2
  exit 2
}

[[ $# -eq 2 ]] || usage
source_dir=$(cd "$1" 2>/dev/null && pwd -P) || { echo "source data directory does not exist" >&2; exit 1; }
output_dir=$(mkdir -p "$2" && cd "$2" && pwd -P)
[[ "$source_dir" != "/" && "$source_dir" != "$output_dir" ]] || { echo "refusing unsafe source/output directory" >&2; exit 1; }
case "$output_dir/" in
  "$source_dir"/*) echo "backup output must not be inside source data directory" >&2; exit 1 ;;
esac
[[ -f "$source_dir/infinite-canvas.db" ]] || { echo "SQLite database infinite-canvas.db not found" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "sqlite3 is required" >&2; exit 1; }
command -v tar >/dev/null || { echo "tar is required" >&2; exit 1; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
stage=$(mktemp -d "$output_dir/.infinite-canvas-backup.XXXXXX")
archive="$output_dir/infinite-canvas-data-$stamp.tar.gz"
tmp_archive=$(mktemp "$output_dir/.infinite-canvas-data.XXXXXX.tar.gz")
cleanup() { rm -rf "$stage" "$tmp_archive"; }
trap cleanup EXIT
mkdir -p "$stage/data"

sqlite3 "$source_dir/infinite-canvas.db" ".backup '$stage/data/infinite-canvas.db'"
(
  cd "$source_dir"
  tar \
    --exclude='./infinite-canvas.db' \
    --exclude='./infinite-canvas.db-wal' \
    --exclude='./infinite-canvas.db-shm' \
    --exclude='./logs' \
    --exclude='./*.log' \
    --exclude='./*.pid' \
    -cf - .
) | tar -xf - -C "$stage/data"
sqlite3 "$stage/data/infinite-canvas.db" 'PRAGMA integrity_check;' | grep -qx 'ok'
printf 'source=%s\ncreated_utc=%s\n' "$source_dir" "$stamp" > "$stage/MANIFEST"
tar -czf "$tmp_archive" -C "$stage" .
tar -tzf "$tmp_archive" >/dev/null
mv -f "$tmp_archive" "$archive"
printf 'backup=%s\n' "$archive"
