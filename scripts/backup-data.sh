#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ $# -ne 2 ]]; then
  printf 'Usage: %s SOURCE_DATA_DIR OUTPUT_DIR (SQLite only)\n' "$0" >&2
  exit 2
fi
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
exec python3 "$script_dir/data_backup.py" backup "$1" "$2"
