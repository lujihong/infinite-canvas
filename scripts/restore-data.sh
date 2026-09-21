#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s BACKUP_ARCHIVE NEW_TARGET_DIR\n' "$0" >&2
  exit 2
}

[[ $# -eq 2 ]] || usage
archive=$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")
target_parent=$(cd "$(dirname "$2")" 2>/dev/null && pwd -P) || { echo "restore parent does not exist" >&2; exit 1; }
target="$target_parent/$(basename "$2")"
[[ -f "$archive" ]] || { echo "backup archive does not exist" >&2; exit 1; }
[[ "$target" != "/" && "$target" != "$archive" ]] || { echo "refusing unsafe restore target" >&2; exit 1; }
[[ ! -e "$target" ]] || { echo "restore target must not already exist" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "sqlite3 is required" >&2; exit 1; }

stage=$(mktemp -d "$target_parent/.infinite-canvas-restore.XXXXXX")
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT

python3 - "$archive" "$stage" <<'PY'
import os
import posixpath
import shutil
import sys
import tarfile

archive, destination = sys.argv[1:]
seen = set()
with tarfile.open(archive, "r:gz") as bundle:
    members = bundle.getmembers()
    for member in members:
        name = member.name
        normalized = posixpath.normpath(name)
        if not name or name.startswith("/") or normalized == ".." or normalized.startswith("../"):
            raise SystemExit(f"unsafe archive path: {name!r}")
        if normalized == "." and not member.isdir():
            raise SystemExit(f"archive root entry must be a directory: {name!r}")
        if name in seen:
            raise SystemExit(f"duplicate archive path: {name!r}")
        seen.add(name)
        if not (member.isdir() or member.isreg()):
            raise SystemExit(f"unsupported archive entry: {name!r}")

    for member in members:
        relative = posixpath.normpath(member.name)
        output = os.path.join(destination, *relative.split("/"))
        if member.isdir():
            os.makedirs(output, mode=member.mode & 0o777, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(output), mode=0o700, exist_ok=True)
        source = bundle.extractfile(member)
        if source is None:
            raise SystemExit(f"cannot read archive entry: {member.name!r}")
        with source, open(output, "xb") as target_file:
            shutil.copyfileobj(source, target_file)
        os.chmod(output, member.mode & 0o777)
PY

[[ -f "$stage/data/infinite-canvas.db" ]] || { echo "restored SQLite database not found" >&2; exit 1; }
sqlite3 "$stage/data/infinite-canvas.db" 'PRAGMA integrity_check;' | grep -qx 'ok'
mv "$stage" "$target"
trap - EXIT
printf 'restored_target=%s\n' "$target"
