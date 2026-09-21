#!/usr/bin/env python3
"""Run with python3 -B scripts/test_data_backup.py; all fixtures are temporary."""
import datetime
import io
import importlib.util
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("data_backup", SCRIPTS / "data_backup.py")
if SPEC is None or SPEC.loader is None:
    raise ImportError("could not load adjacent data_backup.py")
subject = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(subject)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.old_umask = os.umask(0o077)
        self.tmp = tempfile.TemporaryDirectory(prefix="sqlite-backup-test-")
        self.root = Path(self.tmp.name)
        self.source = self.root / "source's data"
        self.source.mkdir()
        self.output = self.root / "output's archives"
        self.target = self.root / "restored's data"
        with sqlite3.connect(self.source / subject.DB) as conn:
            conn.execute("CREATE TABLE records (value TEXT)")
            conn.execute("INSERT INTO records VALUES ('initial')")

    def tearDown(self):
        self.tmp.cleanup()
        os.umask(self.old_umask)

    def shell(self, script, *args, success=True):
        result = subprocess.run(["bash", str(SCRIPTS / script), *map(str, args)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stderr)
        return result

    def archive(self):
        return subject.backup(self.source, self.output)

    def values(self, target):
        with sqlite3.connect(target / "data" / subject.DB) as conn:
            return conn.execute("SELECT value FROM records ORDER BY rowid").fetchall()

    def assert_clean_failure(self, archive):
        with self.assertRaises((ValueError, OSError, sqlite3.Error,
                                tarfile.TarError, EOFError)):
            subject.restore(archive, self.target)
        self.assertFalse(os.path.lexists(self.target))
        self.assertFalse(list(self.root.glob(".infinite-canvas-restore-*")))

    def crafted(self, entries):
        archive = self.root / "crafted.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            for name, kind, content in entries:
                item = tarfile.TarInfo(name)
                item.type = kind
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    item.linkname = "../../outside"
                if kind == tarfile.REGTYPE:
                    item.size = len(content)
                    bundle.addfile(item, io.BytesIO(content))
                else:
                    bundle.addfile(item)
        return archive

    def base_entries(self):
        return [("data", tarfile.DIRTYPE, b""),
                ("data/" + subject.DB, tarfile.REGTYPE,
                 (self.source / subject.DB).read_bytes()),
                ("MANIFEST", tarfile.REGTYPE, b"backend=sqlite\n")]

    def test_roundtrip_media_quoted_paths_permissions_and_exclusions(self):
        for path in ("photos/2026/original/image.bin", "arbitrary/nested/video.mov",
                     "logs/hidden", "nested/logs/hidden", "a.log", "nested/a.pid",
                     subject.DB + "-journal", "nested/a.log"):
            file = self.source / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b"" if path == subject.DB + "-journal" else b"media-content")
        result = self.shell("backup-data.sh", self.source, self.output)
        archive = Path(result.stdout.strip().split("=", 1)[1])
        self.shell("restore-data.sh", archive, self.target)
        self.assertEqual(self.values(self.target), [("initial",)])
        for path in ("photos/2026/original/image.bin", "arbitrary/nested/video.mov"):
            self.assertEqual((self.target / "data" / path).read_bytes(), b"media-content")
        with tarfile.open(archive) as bundle:
            names = bundle.getnames()
        self.assertFalse(any(subject.excluded(part) for name in names
                             for part in name.split("/")))
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o700)
        self.assertFalse(list(self.output.glob(".infinite-canvas-backup-*")))

    def test_wal_committed_rows(self):
        conn = sqlite3.connect(self.source / subject.DB)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA wal_autocheckpoint=0")
            conn.execute("INSERT INTO records VALUES ('committed WAL')")
            conn.commit()
            self.assertGreater((self.source / (subject.DB + "-wal")).stat().st_size, 0)
            archive = self.archive()
            subject.restore(archive, self.target)
            self.assertEqual(self.values(self.target), [("initial",), ("committed WAL",)])
            with tarfile.open(archive) as bundle:
                self.assertFalse(any(n.endswith(("-wal", "-shm")) for n in bundle.getnames()))
        finally:
            conn.close()

    def test_two_backups_same_second(self):
        fixed = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
        with mock.patch.object(subject.datetime, "datetime") as clock:
            clock.now.return_value = fixed
            first, second = self.archive(), self.archive()
        self.assertNotEqual(first, second)
        self.assertTrue(first.is_file() and second.is_file())
        self.assertIn("20260101T000000Z", first.name)
        self.assertIn("20260101T000000Z", second.name)

    def test_backup_name_collision_never_overwrites(self):
        fixed = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
        with mock.patch.object(subject.datetime, "datetime") as clock, \
                mock.patch.object(subject.uuid, "uuid4") as unique:
            clock.now.return_value = fixed
            unique.return_value.hex = "collision"
            archive = self.archive()
            original = archive.read_bytes()
            with self.assertRaises(FileExistsError):
                self.archive()
            self.assertEqual(archive.read_bytes(), original)
        self.assertFalse(list(self.output.glob(".infinite-canvas-backup-*")))

    def test_existing_target_and_dangling_symlink(self):
        archive = self.archive()
        self.target.mkdir()
        (self.target / "keep").write_text("keep")
        self.shell("restore-data.sh", archive, self.target, success=False)
        self.assertEqual(list(self.target.iterdir()), [self.target / "keep"])
        dangling = self.root / "dangling"
        dangling.symlink_to(self.root / "missing")
        with self.assertRaises(ValueError):
            subject.restore(archive, dangling)
        self.assertTrue(dangling.is_symlink())

    def test_concurrent_target_appearance_does_not_nest_or_overwrite(self):
        archive = self.archive()
        real_publish = subject.publish_directory
        def race(stage, target):
            target.mkdir()
            real_publish(stage, target)
        with mock.patch.object(subject, "publish_directory", side_effect=race):
            with self.assertRaises(OSError):
                subject.restore(archive, self.target)
        self.assertEqual(list(self.target.iterdir()), [])
        self.assertFalse(list(self.root.glob(".infinite-canvas-restore-*")))

    def test_malicious_paths_and_normalized_duplicates(self):
        for name in ("/absolute", "../outside", "data/../outside",
                     "data/a/../../outside", "other/file", "MANIFEST/file",
                     "C:/outside", "data\\..\\outside"):
            with self.subTest(name=name):
                self.assert_clean_failure(self.crafted(
                    self.base_entries() + [(name, tarfile.REGTYPE, b"bad")]))
        for duplicate in ("data/./infinite-canvas.db", "./data//infinite-canvas.db",
                          "data/infinite-canvas.db"):
            with self.subTest(duplicate=duplicate):
                self.assert_clean_failure(self.crafted(
                    self.base_entries() + [(duplicate, tarfile.REGTYPE, b"bad")]))

    def test_links_and_special_archive_entries(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE,
                     tarfile.BLKTYPE, tarfile.FIFOTYPE):
            with self.subTest(kind=kind):
                self.assert_clean_failure(self.crafted(
                    self.base_entries() + [("data/evil", kind, b"")]))

    def test_source_symlinks_and_specials_rejected_even_when_excluded(self):
        bad = self.source / "bad.log"
        bad.symlink_to(self.source / subject.DB)
        with self.assertRaises(ValueError):
            self.archive()
        bad.unlink()
        os.mkfifo(bad)
        with self.assertRaises(ValueError):
            self.archive()
        self.assertFalse(list(self.output.iterdir()))

    def test_root_and_output_inside_source_rejected(self):
        for source, output in ((Path("/"), self.output), (self.source, self.source),
                               (self.source, self.source / "inside")):
            with self.subTest(source=source, output=output):
                with self.assertRaises(ValueError):
                    subject.backup(source, output)
        self.assertFalse((self.source / "inside").exists())
        alias = self.root / "alias"
        alias.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(ValueError):
            subject.backup(self.source, alias / "inside")

    def test_corrupt_database_backup_and_restore_cleanup(self):
        (self.source / subject.DB).write_bytes(b"not a database")
        with self.assertRaises((sqlite3.Error, ValueError)):
            self.archive()
        self.assertFalse(list(self.output.iterdir()))
        self.assert_clean_failure(self.crafted(self.base_entries()))

    def test_empty_database_rejected(self):
        (self.source / subject.DB).write_bytes(b"")
        with self.assertRaises(ValueError):
            self.archive()
        self.assertFalse(list(self.output.iterdir()))
        self.assert_clean_failure(self.crafted(self.base_entries()))

    def test_missing_database_or_manifest(self):
        entries = self.base_entries()
        self.assert_clean_failure(self.crafted([entries[0], entries[2]]))
        self.assert_clean_failure(self.crafted(entries[:2]))

    def test_disk_budget_failure_cleans_stage(self):
        archive = self.archive()
        usage = shutil.disk_usage(self.root)
        with mock.patch.object(subject.shutil, "disk_usage",
                               return_value=usage._replace(free=subject.RESERVE + 1)):
            self.assert_clean_failure(archive)

    def test_truncated_gzip_rejected(self):
        archive = self.archive()
        archive.write_bytes(archive.read_bytes()[:-8])
        self.assert_clean_failure(archive)

    def test_failure_before_publish_cleans_backup(self):
        with mock.patch.object(subject, "read_archive", side_effect=ValueError("injected")):
            with self.assertRaises(ValueError):
                self.archive()
        self.assertFalse(list(self.output.iterdir()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
