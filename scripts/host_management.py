"""Host-side operations for the guided installation. Only approved media trees are browsable."""

import argparse
from contextlib import contextmanager
import csv
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


def within(child, parent):
    return child == parent or parent in child.parents


def safe_root(folder, install, source):
    home = Path.home().resolve()
    system = [Path(os.environ[k]).resolve() for k in ("WINDIR", "ProgramData", "ProgramFiles", "ProgramFiles(x86)") if os.environ.get(k)] if os.name == "nt" else [
        Path(p) for p in ("/dev", "/etc", "/run", "/proc", "/sys", "/root", "/private", "/var/run", "/usr", "/bin", "/sbin", "/boot", "/System", "/Library", "/Applications")]
    return (folder.is_absolute() and folder != Path(folder.anchor) and not within(home, folder)
            and not any(part.startswith(".") for part in folder.parts[1:])
            and not any(within(folder, p) or within(p, folder) for p in system)
            and not any(within(p, folder) or (within(folder, p) and p != home and not within(folder, p / "media"))
                        for p in [source, install])
            and not within(folder, install / "vidstream-local"))


@contextmanager
def edit_lock(install):
    lock = install / ".vidstream-edit.lock"
    try:
        if os.name == "nt":
            handle = lock.open("xb")
        else:
            lock.mkdir(mode=0o700)
    except FileExistsError:
        raise RuntimeError("Another Start-Here or installation action is in progress. Try again when it finishes.") from None
    try:
        yield
    finally:
        if os.name == "nt":
            handle.close()
            lock.unlink()
        else:
            lock.rmdir()


def read_roots(install):
    file = install / ".vidstream-media-roots.json"
    if not file.exists():
        return []
    if file.is_symlink() or not file.is_file() or file.stat().st_size > 262144:
        raise RuntimeError("The host's folder permissions file is invalid. Check it on the host.")
    roots = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(roots, list) or not all(isinstance(r, str) and Path(r).is_absolute() for r in roots):
        raise RuntimeError("The host's folder permissions file is invalid.")
    return [Path(r) for r in roots]


def private_file(install, content):
    with tempfile.NamedTemporaryFile(prefix=".compose-host-", dir=install, delete=False) as draft:
        try:
            draft.write(content)
            draft.flush()
            os.fsync(draft.fileno())
        except BaseException:
            draft.close()
            os.unlink(draft.name)
            raise
        return Path(draft.name)


def approve(install, source, folder):
    folder = folder.resolve(strict=True)
    if not folder.is_dir() or not safe_root(folder, install, source):
        raise RuntimeError("Choose a dedicated media directory outside the installation, separate from your home and system folders.")
    with edit_lock(install):
        roots = sorted(set([*read_roots(install), folder]))
        draft = private_file(install, json.dumps(list(map(str, roots))).encode())
        try:
            os.replace(draft, install / ".vidstream-media-roots.json")
        finally:
            draft.unlink(missing_ok=True)


class Management:
    status_file = "host-status.json"
    request_file = "host-request.json"
    lock_file = ".vidstream-host-helper.lock"
    max_request = 256 * 1024
    actions = {"inspect", "browse", "save", "apply", "stop", "migrate"}

    def __init__(self, *args):
        super().__init__(*args)
        self.state = {"job": None}
        self.snapshot = None
        self.wake_at = None

    def valid_request(self, data):
        return (isinstance(data.get("action"), str) and data["action"] in self.actions
                and set(data) <= {"id", "action", "path", "offset", "folders", "revision", "deployment", "resumeMinutes"})

    def supports_image(self, image):
        return image == "vidstream-starter:local" or bool(re.fullmatch(r"(?:docker\.io/)?5u8han/vidstream(?::[\w.-]+|@sha256:[0-9a-f]{64})?", image))

    def editor(self, image, option, content):
        mount = io.StringIO()
        csv.writer(mount, lineterminator="").writerow(["type=bind", "source=" + str(self.source / "scripts" / "setup-compose.js"),
                                                       "target=/tmp/vidstream-compose.js", "readonly"])
        command = [self.docker, "run", "--rm", "--pull", "never", "--network", "none", "--read-only",
                   "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL", "-i", "--mount", mount.getvalue(),
                   "--entrypoint", "node", image, "/tmp/vidstream-compose.js", option]
        result = subprocess.run(command, input=content, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40)
        if result.returncode:
            messages = result.stderr.decode(errors="replace").splitlines()
            error = next((s for s in messages if s.startswith("VidStream setup: ")), None)
            raise RuntimeError(error[:400] if error else "The Compose editor could not run. Check the host helper log and Docker image.")
        return result.stdout

    def document(self):
        if self.compose.is_symlink() or not self.compose.is_file() or self.compose.stat().st_size > 1024 * 1024:
            raise RuntimeError("Select the private compose.yaml generated by Start-Here.")
        return self.compose.read_bytes()

    def inspect(self):
        raw = self.document()
        revision = hashlib.sha256(raw).hexdigest()
        if not self.snapshot or self.snapshot["revision"] != revision:
            self.validate_install()
            image = self.run(self.compose_args + ["config", "--images", "stream"])
            model = json.loads(self.editor(image, "--host-inspect", raw))
            self.snapshot = dict(model, revision=revision, image=image)
        return self.snapshot

    def roots(self, model):
        roots = [*read_roots(self.install), *(Path(m["path"]) for m in model["folders"])]
        allowed = []
        for root in roots:
            resolved = root.resolve()
            if root == resolved and safe_root(resolved, self.install, self.source) and resolved not in allowed:
                allowed.append(resolved)
        return allowed

    def directory(self, value, roots):
        if not isinstance(value, str) or not value or len(value) > 4096 or any(ord(c) < 32 for c in value):
            raise ValueError("Choose a directory from the host picker.")
        path = Path(value)
        if not path.is_absolute() or any(p.startswith(".") for p in path.parts[1:]) or not any(within(path, r) for r in roots):
            raise ValueError("This directory is outside the host's approved media folders.")
        resolved = path.resolve(strict=True)
        if resolved != path or not resolved.is_dir() or not any(within(resolved, r) for r in roots):
            raise ValueError("Choose an existing folder directly under an approved media tree.")
        return resolved

    def browse(self, data, model):
        path = self.directory(data.get("path"), self.roots(model))
        offset = data.get("offset", 0)
        if type(offset) is not int or not 0 <= offset <= 10000000:
            raise ValueError("Invalid directory page.")
        with os.scandir(path) as entries:
            names = sorted((e.name for e in entries if not e.name.startswith(".") and
                            not e.is_symlink() and e.is_dir(follow_symlinks=False) and
                            not any(ord(c) < 32 for c in e.name)),
                           key=lambda name: (name.casefold(), name))
        end = offset + 100
        return {"path": str(path), "folders": [{"path": str(path / n), "name": n} for n in names[offset:end]],
                "nextOffset": end if end < len(names) else None}

    def save(self, data):
        folders = data.get("folders")
        deployment = data.get("deployment")
        if (not isinstance(folders, list) or not 1 <= len(folders) <= 256 or
                not all(isinstance(f, str) and 0 < len(f) <= 4096 for f in folders) or
                not isinstance(deployment, dict) or not {"port", "bind", "host", "swap", "memory"} <= set(deployment)):
            raise ValueError("Choose at least one folder and complete the memory and access fields.")
        with edit_lock(self.install):
            self.validate_install()
            model = self.inspect()
            if data.get("revision") != model["revision"]:
                raise ValueError("The saved Compose file changed. Refresh settings before saving again.")
            existing = {f["path"] for f in model["folders"]}
            roots = self.roots(model)
            checked = [f if f in existing else str(self.directory(f, roots)) for f in folders]
            role = self.live_role()
            raw = self.document()
            if hashlib.sha256(raw).hexdigest() != model["revision"]:
                raise ValueError("The Compose file changed. Reload the installation settings.")
            payload = {"compose": raw.decode(), "folders": checked, "role": role, "deployment": deployment,
                       "storageDirectory": str(self.install / "vidstream-local")}
            updated = self.editor(model["image"], "--host-edit", json.dumps(payload).encode())
            draft = private_file(self.install, updated)
            try:
                self.run([*self.compose_args[:-1], str(draft), "config", "--quiet"])
                if self.document() != raw:
                    raise ValueError("The saved settings were edited on the host. Reload them before continuing.")
                os.replace(draft, self.compose)
            finally:
                draft.unlink(missing_ok=True)
            saved = self.inspect()
            return {"revision": saved["revision"], "url": saved["deployment"]["url"], "folders": saved["folders"],
                    "roots": [{"path": str(root), "name": root.name} for root in self.roots(saved)]}

    def live_role(self):
        script = ('fetch("http://127.0.0.1:4000/health",{signal:AbortSignal.timeout(3000)})'
                  '.then(r=>r.json()).then(v=>{if(!v.ok)throw Error(); console.log(v.role)})'
                  '.catch(()=>process.exitCode=1)')
        role = self.run(self.compose_args + ["exec", "-T", "stream", "node", "-e", script])
        if role not in ("node", "server"):
            raise RuntimeError("The running node role could not be confirmed.")
        return role

    def apply(self, restart=True):
        with edit_lock(self.install):
            self.validate_install()
            if not restart and self.run(self.compose_args + ["ps", "-q", "--status", "running", "stream"]):
                return False
            model = self.inspect()
            for folder in model["folders"]:
                source = Path(folder["path"])
                if source.resolve(strict=True) != source or not source.is_dir():
                    raise RuntimeError("A configured source disappeared or now resolves through a link. Restore its mount before applying.")
            options = ["--force-recreate"] if restart else []
            self.run(self.compose_args + ["up", "-d", "--no-deps", "--pull", "never", "--no-build", *options, "stream"], timeout=900)
            return True

    def lifecycle(self, flag, job_id):
        options = {"stop": ("--stop-only", "-StopOnly"), "migrate": ("--prepare-move", "-PrepareMove")}
        unix, windows = options[flag]
        if os.name == "nt":
            command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
                       str(self.source / "Start-Here.ps1"), windows]
        else:
            command = ["bash", str(self.source / "Start-Here.sh"), unix]
        env = {**os.environ, "VIDSTREAM_INSTALL_DIR": str(self.install), "VIDSTREAM_HELPER_CHILD": "1"}
        with open(self.install / ".vidstream-host-actions.log", "ab") as log:
            def record(state):
                stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
                log.write(f"{stamp} {flag} {job_id} {state}\n".encode())
                log.flush()
            record("STARTED")
            try:
                result = subprocess.run(command, cwd=self.source, env=env, stdin=subprocess.DEVNULL,
                                        stdout=log, stderr=subprocess.STDOUT)
            except OSError:
                record("FAILED TO START")
                raise
            record("FAILED" if result.returncode else ("READY TO COPY" if flag == "migrate" else "STOPPED"))
        if result.returncode:
            raise RuntimeError("The host action could not finish. Inspect .vidstream-host-actions.log on the host.")

    def dispatch(self, data):
        action = data["action"]
        model = self.inspect()
        if action == "inspect":
            result = {k: model[k] for k in ("revision", "role", "storage", "folders", "deployment")}
            result["role"] = self.live_role()
            result["roots"] = [{"path": str(r), "name": r.name} for r in self.roots(model)]
            return result, "Installation settings loaded."
        if action == "browse":
            return self.browse(data, model), "Folders loaded."
        if action == "save":
            return self.save(data), "Saved to compose.yaml. Apply when you are ready."
        if action == "apply":
            self.apply()
            self.wake_at = None
            return {"url": model["deployment"]["url"]}, "Saved settings applied."
        self.validate_install()
        if action == "stop":
            delay = data.get("resumeMinutes", 0)
            if type(delay) is not int or not 0 <= delay <= 1440:
                raise ValueError("Choose a restart delay between 0 and 1440 minutes.")
            self.lifecycle("stop", data["id"])
            self.wake_at = time.monotonic() + delay * 60 if delay else None
            return {}, "VidStream stopped." if not delay else "VidStream stopped. The host has scheduled its restart."
        if action == "migrate":
            self.wake_at = None
            self.lifecycle("migrate", data["id"])
            return {}, "Ready to move. Copy compose.yaml and vidstream-local from the stopped host; remap your source media separately."
        raise ValueError("Unknown host action.")

    def perform(self, data):
        job = {"id": data["id"], "action": data["action"]}
        self.write(job={**job, "state": "running", "message": "Working on the VidStream host."})
        try:
            result, message = self.dispatch(data)
            self.write(job={**job, "state": "done", "message": message, "result": result})
        except Exception as error:
            print("Host action failed:", repr(error), flush=True)
            message = str(error)[:400] if isinstance(error, (ValueError, RuntimeError)) else "The host could not finish. Check folder access and the host helper log."
            self.write(job={**job, "state": "failed", "message": message})

    def tick(self):
        if self.wake_at is None or time.monotonic() < self.wake_at:
            return
        self.wake_at = None
        job = self.state.get("job") or {}
        try:
            started = self.apply(restart=False)
            message = "VidStream restarted at the scheduled time." if started else "VidStream was already running at the scheduled time."
            self.write(job={**job, "state": "done", "message": message})
        except Exception as error:
            print("Scheduled restart failed:", repr(error), flush=True)
            self.write(job={**job, "state": "failed", "message": "The scheduled start failed. Open Start-Here on the host."})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--approve", required=True, type=Path)
    parser.add_argument("--install", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        approve(args.install.resolve(strict=True), Path(__file__).resolve().parents[1], args.approve)
    except (RuntimeError, OSError, ValueError) as error:
        parser.exit(1, str(error) + "\n")
