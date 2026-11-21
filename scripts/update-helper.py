#!/usr/bin/env python3
"""Host companion for the owner's fixed check/update actions."""

import argparse
import datetime
import json
import os
from pathlib import Path
import re
import stat
import sys
import subprocess
import threading
import time
import uuid


OFFICIAL = re.compile(r"^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)5u8han/VidStream(?:\.git)?$")
REVISION = re.compile(r"^[a-f0-9]{40}$")


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


class Helper:
    def __init__(self, source, install, docker):
        self.source = Path(source).resolve()
        self.install = Path(install).resolve()
        self.compose = self.install / "compose.yaml"
        self.mailbox = self.install / ".vidstream-updater"
        self.docker = docker
        self.state_lock = threading.Lock()
        self.state = {"state": "idle", "message": "Ready to check for updates.", "currentRevision": None,
                      "targetRevision": None, "updatedAt": now()}
        self.stop = threading.Event()
        self.compose_args = [docker, "compose", "--project-name", "vidstream-starter",
                             "--project-directory", str(self.install),
                             "--file", str(self.compose)]

    def run(self, args, timeout=35):
        result = subprocess.run(args, cwd=self.source, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                timeout=timeout, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
        if result.returncode:
            raise RuntimeError("The update check could not complete. Check Git, Docker and the host helper log.")
        return result.stdout.strip()

    def git(self, *args):
        return self.run(["git", "-C", str(self.source), *args])

    def validate(self):
        if Path(self.git("rev-parse", "--show-toplevel")).resolve() != self.source:
            raise RuntimeError("Open Start-Here from the VidStream checkout.")
        if self.git("symbolic-ref", "--quiet", "--short", "HEAD") != "main":
            raise RuntimeError("Switch the host checkout to main before updating.")
        if not OFFICIAL.fullmatch(self.git("remote", "get-url", "origin")):
            raise RuntimeError("Updates need the official VidStream GitHub origin.")
        if self.git("status", "--porcelain", "--untracked-files=no"):
            raise RuntimeError("Save tracked source edits before updating.")
        if not self.compose.is_file() or self.compose.is_symlink():
            raise RuntimeError("Open Start-Here with the existing guided Compose file.")
        if self.run(self.compose_args + ["config", "--images", "stream"]) != "vidstream-starter:local":
            raise RuntimeError("This updater supports guided installations using vidstream-starter:local.")
        containers = self.run([self.docker, "ps", "-aq", "--filter", "label=com.docker.compose.project=vidstream-starter",
                               "--filter", "label=com.docker.compose.service=stream",
                               "--filter", "label=com.docker.compose.oneoff=False"]).splitlines()
        for container in containers:
            saved = self.run([self.docker, "inspect", "--format",
                              '{{index .Config.Labels "com.docker.compose.project.config_files"}}', container])
            if Path(saved).resolve() != self.compose:
                raise RuntimeError("The running installation uses a different Compose file. Open its original Start-Here.")

    def installed_revision(self):
        containers = self.run(self.compose_args + ["ps", "-q", "--status", "running", "stream"]).splitlines()
        if len(containers) != 1:
            return None
        revision = self.run([self.docker, "inspect", "--format",
                             '{{index .Config.Labels "org.opencontainers.image.revision"}}', containers[0]])
        return revision if REVISION.fullmatch(revision) else None

    def write(self, **changes):
        with self.state_lock:
            if changes:
                self.state.update(changes, updatedAt=now())
            output = {**self.state, "heartbeatAt": now()}
            temporary = self.mailbox / (".status-" + uuid.uuid4().hex)
            with open(temporary, "x", encoding="utf-8") as handle:
                json.dump(output, handle)
            os.replace(temporary, self.mailbox / "status.json")

    def heartbeat(self):
        while not self.stop.wait(5):
            self.write()

    def check(self, applying=False):
        self.validate()
        self.git("fetch", "--no-tags", "--no-recurse-submodules", "origin", "+refs/heads/main:refs/remotes/origin/main")
        current = self.git("rev-parse", "HEAD")
        target = self.git("rev-parse", "--verify", "refs/remotes/origin/main^{commit}")
        self.git("merge-base", "--is-ancestor", current, target)
        installed = self.installed_revision()
        current_version = installed == target
        state = "current" if current_version else "updating" if applying else "available"
        self.write(state=state, currentRevision=installed, checkedAt=now(),
                   targetRevision=target, message="VidStream is up to date." if current_version else
                   "An update is ready." if installed else "Rebuild once to identify this installation's running revision.")
        return current_version

    def update(self):
        if self.check(applying=True):
            return
        self.write(state="updating", message="Building and applying the update. Playback may briefly pause.")
        environment = {**os.environ, "VIDSTREAM_INSTALL_DIR": str(self.install), "VIDSTREAM_HELPER_CHILD": "1",
                       "GIT_TERMINAL_PROMPT": "0"}
        if os.name == "nt":
            command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                       str(self.source / "Start-Here.ps1"), "-UpdateOnly"]
        else:
            command = ["bash", str(self.source / "Start-Here.sh"), "--update-only"]
        with open(self.install / ".vidstream-update.log", "a", encoding="utf-8") as log:
            result = subprocess.run(command, cwd=self.source, env=environment, stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=subprocess.STDOUT, timeout=7200)
        if result.returncode:
            raise RuntimeError("The update did not finish. Open Start-Here for details or inspect .vidstream-update.log.")
        installed = self.installed_revision()
        deployed = self.git("rev-parse", "--verify", "refs/remotes/origin/main^{commit}")
        if installed != deployed:
            raise RuntimeError("The update finished without confirming the new running version. Check Start-Here.")
        self.write(state="completed", currentRevision=installed, targetRevision=deployed, message="Update complete. Reload VidStream.")

    def request(self):
        pending = self.mailbox / "request.json"
        try:
            if not stat.S_ISREG(pending.lstat().st_mode):
                try:
                    pending.unlink()
                except IsADirectoryError:
                    pass
                return None
            claimed = self.install / (".vidstream-request-" + uuid.uuid4().hex)
            os.replace(pending, claimed)
        except OSError:
            return None
        try:
            info = claimed.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > 4096 or abs(time.time() - info.st_mtime) > 60:
                return None
            with claimed.open("rb") as handle:
                data = json.loads(handle.read(4097).decode("utf-8"))
            if not isinstance(data, dict) or set(data) != {"id", "action"}:
                return None
            if data["action"] not in ("check", "update") or not isinstance(data["id"], str):
                return None
            if str(uuid.UUID(data["id"])) != data["id"]:
                return None
            return data
        except (ValueError, TypeError, OSError, RecursionError):
            return None
        finally:
            try:
                claimed.unlink(missing_ok=True)
            except IsADirectoryError:
                pass

    def serve(self):
        self.mailbox.mkdir(mode=0o700, exist_ok=True)
        if self.mailbox.is_symlink() or not self.mailbox.is_dir():
            raise RuntimeError("The updater folder must be a real directory.")
        lock = open(self.install / ".vidstream-update-helper.lock", "a+b")
        try:
            if os.name == "nt":
                import msvcrt
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            lock.close()
            return
        try:
            self.state["currentRevision"] = self.installed_revision()
        except Exception:
            pass
        self.write()
        threading.Thread(target=self.heartbeat, daemon=True).start()
        while True:
            data = self.request()
            if data:
                self.write(id=data["id"], state="checking", message="Checking GitHub for updates.")
                try:
                    self.update() if data["action"] == "update" else self.check()
                except Exception as error:
                    print("Update failed:", error, file=sys.stderr, flush=True)
                    message = str(error) if isinstance(error, RuntimeError) else "The host could not finish. Check .vidstream-update-helper.log."
                    self.write(state="failed", targetRevision=None, message=message)
            time.sleep(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--install", required=True)
    parser.add_argument("--docker", required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--detach", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    os.environ.update(DOCKER_HOST=args.endpoint, COMPOSE_DISABLE_ENV_FILE="1", COMPOSE_REMOVE_ORPHANS="0")
    for key in ("DOCKER_CONTEXT", "COMPOSE_ENV_FILES"):
        os.environ.pop(key, None)
    if args.detach:
        command = [sys.executable, os.path.abspath(__file__), "--source", args.source, "--install", args.install,
                   "--docker", args.docker, "--endpoint", args.endpoint]
        with open(Path(args.install) / ".vidstream-update-helper.log", "ab") as log:
            subprocess.Popen(command, cwd=args.source, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                             start_new_session=os.name != "nt", close_fds=True,
                             creationflags=subprocess.DETACHED_PROCESS if os.name == "nt" else 0)
    else:
        Helper(args.source, args.install, args.docker).serve()
