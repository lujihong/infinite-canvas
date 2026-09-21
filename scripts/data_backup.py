#!/usr/bin/env python3
"""Private, local SQLite backups; not a PostgreSQL backup tool."""
import ctypes
import datetime
import gzip
import os
from pathlib import Path, PureWindowsPath
import shutil
import sqlite3
import stat
import sys
import tarfile
import tempfile
import uuid

DB = "infinite-canvas.db"
RESERVE = 16 * 1024 * 1024
MAX_MEMBERS = 100000
NOFOLLOW = os.O_NOFOLLOW


def require_absent(path):
    if os.path.lexists(path):
        raise ValueError(f"target must not already exist: {path}")


def readonly_db(path):
    with path.open("rb") as handle:
        if handle.read(16) != b"SQLite format 3\x00":
            raise ValueError("invalid or empty SQLite database")
    return sqlite3.connect(path.as_uri() + "?mode=ro", timeout=10)


def check_db(path):
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"SQLite database missing: {path}")
    connection = readonly_db(path)
    try:
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("SQLite integrity_check failed")
    finally:
        connection.close()


def excluded(name):
    return (name == "logs" or name.endswith((".log", ".pid"))
            or name in {DB + suffix for suffix in ("-wal", "-shm", "-journal")})


def copy_tree(source_fd, destination, skip=False, root=True):
    # Inspect even excluded trees: no links or special files are accepted.
    for name in os.listdir(source_fd):
        info = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
        omit = skip or excluded(name) or (root and name == DB)
        output = destination / name
        if stat.S_ISDIR(info.st_mode):
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW,
                         dir_fd=source_fd)
            try:
                if not omit:
                    output.mkdir(mode=0o700)
                copy_tree(fd, output, omit, root=False)
            finally:
                os.close(fd)
        elif stat.S_ISREG(info.st_mode):
            if not omit:
                fd = os.open(name, os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK,
                             dir_fd=source_fd)
                with os.fdopen(fd, "rb") as src:
                    if not stat.S_ISREG(os.fstat(src.fileno()).st_mode):
                        raise ValueError(f"source changed type: {name}")
                    with output.open("xb") as dst:
                        shutil.copyfileobj(src, dst, 1024 * 1024)
        else:
            raise ValueError(f"links/special source files are forbidden: {name}")


def normalized_member(member):
    name = member.name
    parts = name.split("/")
    if (not name or len(name) > 4096 or name.startswith("/")
            or ".." in parts or "\\" in name or PureWindowsPath(name).drive):
        raise ValueError(f"unsafe archive path: {name!r}")
    clean = "/".join(p for p in parts if p not in ("", "."))
    if not (member.isdir() or member.isreg()) or member.issparse():
        raise ValueError(f"links/special/sparse archive entry: {name!r}")
    if not (clean == "MANIFEST" and member.isreg()
            or clean == "data" and member.isdir()
            or clean.startswith("data/")):
        raise ValueError(f"unexpected archive entry: {name!r}")
    if member.size < 0 or (member.isdir() and member.size != 0):
        raise ValueError("invalid member size")
    return clean


def read_archive(archive, destination=None):
    seen = set()
    budget = (max(0, shutil.disk_usage(destination).free - RESERVE)
              if destination is not None else None)
    used = 0
    # Stream instead of trusting tar headers or loading an unbounded member list.
    with archive.open("rb") as raw, gzip.GzipFile(fileobj=raw) as compressed:
        with tarfile.open(fileobj=compressed, mode="r|") as bundle:
            for member in bundle:
                name = normalized_member(member)
                if name in seen:
                    raise ValueError(f"duplicate normalized archive path: {name}")
                seen.add(name)
                if len(seen) > MAX_MEMBERS:
                    raise ValueError("too many archive members")
                # Include blocks for implicit parent directories, conservatively.
                charge = ((member.size + 4095) // 4096 + len(name.split("/"))) * 4096
                used += charge
                if destination is not None and budget is not None and (used > budget or
                        charge > max(0, shutil.disk_usage(destination).free - RESERVE)):
                    raise ValueError("archive exceeds available disk budget")
                output = destination / name if destination is not None else None
                if member.isdir():
                    if output is not None:
                        output.mkdir(mode=0o700, parents=True, exist_ok=True)
                    continue
                if output is not None:
                    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                source = bundle.extractfile(member)
                if source is None:
                    raise ValueError(f"unreadable archive member: {name}")
                target = output.open("xb") if output is not None else None
                try:
                    remaining = member.size
                    while remaining:
                        block = source.read(min(1024 * 1024, remaining))
                        if not block:
                            raise ValueError("truncated archive member")
                        if target is not None:
                            target.write(block)
                        remaining -= len(block)
                finally:
                    source.close()
                    if target is not None:
                        target.close()
        # Validate the gzip trailer/CRC too (tar stops at its end marker).
        while compressed.read(1024 * 1024):
            pass
    if not {"MANIFEST", "data/" + DB}.issubset(seen):
        raise ValueError("archive must contain MANIFEST and data/" + DB)


def publish_directory(source, target):
    # A check followed by rename/mv is racy, even for an empty existing target.
    # Use the OS's atomic no-replace rename, and fail closed elsewhere.
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        args = [os.fsencode(source), os.fsencode(target), 4]  # RENAME_EXCL
    elif sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        rename = libc.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                           ctypes.c_char_p, ctypes.c_uint]
        args = [-100, os.fsencode(source), -100, os.fsencode(target), 1]
    else:
        raise OSError("atomic no-replace directory rename unavailable")
    rename.restype = ctypes.c_int
    if rename(*args) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(target))


def backup(source, output):
    source, output = Path(source).absolute(), Path(output).absolute()
    if source.is_symlink():
        raise ValueError("source must not be a symlink")
    source = source.resolve(strict=True)
    output = output.resolve()
    if source == Path("/") or output == source or source in output.parents:
        raise ValueError("unsafe source/output directory")
    if not source.is_dir():
        raise ValueError("source must be a directory")
    database = source / DB
    if not database.is_file() or database.is_symlink():
        raise ValueError("SQLite database missing or symlinked")
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive = output / f"infinite-canvas-data-{stamp}-{uuid.uuid4().hex}.tar.gz"
    with tempfile.TemporaryDirectory(prefix=".infinite-canvas-backup-", dir=output) as tmp:
        stage = Path(tmp)
        data = stage / "data"
        data.mkdir(mode=0o700)
        source_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
        try:
            copy_tree(source_fd, data)
        finally:
            os.close(source_fd)
        src = readonly_db(database)
        try:
            dst = sqlite3.connect(data / DB)
            try:
                src.backup(dst)
                # The snapshot must be self-contained, including for WAL sources.
                dst.execute("PRAGMA journal_mode=DELETE").fetchone()
            finally:
                dst.close()
        finally:
            src.close()
        check_db(data / DB)
        (stage / "MANIFEST").write_text(
            f"format=1\nbackend=sqlite\nsource={source}\ncreated_utc={stamp}\n",
            encoding="utf-8")
        temporary = stage / "archive.tar.gz"
        with tarfile.open(temporary, "w:gz") as bundle:
            bundle.add(data, arcname="data",
                       filter=lambda entry: None if excluded(Path(entry.name).name) else entry)
            bundle.add(stage / "MANIFEST", arcname="MANIFEST")
        read_archive(temporary)
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        # Hard-link publication is atomic and never overwrites an existing name.
        os.link(temporary, archive)
    return archive


def restore(archive, target):
    archive = Path(archive).absolute()
    if archive.is_symlink() or not archive.is_file():
        raise ValueError("archive must be a regular file")
    target = Path(target).absolute()
    require_absent(target)
    target = target.parent.resolve(strict=True) / target.name
    require_absent(target)
    with tempfile.TemporaryDirectory(prefix=".infinite-canvas-restore-",
                                     dir=target.parent) as tmp:
        stage = Path(tmp)
        read_archive(archive, stage)
        check_db(stage / "data" / DB)
        publish_directory(stage, target)
    return target


def main(argv):
    os.umask(0o077)
    if len(argv) != 4 or argv[1] not in {"backup", "restore"}:
        print("Usage: data_backup.py backup SOURCE_DATA_DIR OUTPUT_DIR\n"
              "       data_backup.py restore ARCHIVE NEW_TARGET_DIR\n"
              "SQLite only; not a production PostgreSQL backup.", file=sys.stderr)
        return 2
    try:
        if argv[1] == "backup":
            print(f"backup={backup(argv[2], argv[3])}")
        else:
            print(f"restored_target={restore(argv[2], argv[3])}")
    except (OSError, ValueError, sqlite3.Error, tarfile.TarError, EOFError) as error:
        print(f"{argv[1]} failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
