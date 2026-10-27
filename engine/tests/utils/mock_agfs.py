import shutil
import threading
import time
import uuid
from pathlib import Path
from unittest.mock import MagicMock

from openviking.pyagfs import AGFSNotFoundError


class MockLocalAGFS:
    """
    A mock implementation of the AGFS binding client that operates on a local
    directory. Useful for tests where running the real RAGFS binding is not
    feasible or desired.
    """

    def __init__(self, config=None, root_path=None):
        self.config = config
        self.root = Path(root_path) if root_path else Path("/tmp/viking_data")
        self.root.mkdir(parents=True, exist_ok=True)
        self._pathlocks_guard = threading.Condition()
        self._pathlock_refs = {}
        self._pathlock_handoffs = set()

    def _resolve(self, path):
        if str(path).startswith("viking://"):
            path = str(path).replace("viking://", "")
        if str(path).startswith("/"):
            path = str(path)[1:]
        return self.root / path

    def exists(self, path, ctx=None):
        return self._resolve(path).exists()

    def mkdir(self, path, ctx=None, parents=True, exist_ok=True):
        self._resolve(path).mkdir(parents=parents, exist_ok=exist_ok)

    def ls(self, path, ctx=None, **kwargs):
        """List test entries with the same sorting and pagination contract as RagFS."""
        p = self._resolve(path)
        if not p.exists():
            return []
        res = []
        for item in p.iterdir():
            res.append(
                {
                    "name": item.name,
                    "isDir": item.is_dir(),  # Note: JS style camelCase for some APIs
                    "type": "directory" if item.is_dir() else "file",
                    "size": item.stat().st_size if item.is_file() else 0,
                    "mtime": item.stat().st_mtime,
                    "uri": f"viking://{path}/{item.name}".replace("//", "/"),
                }
            )
        sort_by = kwargs.get("sort_by")
        reverse = kwargs.get("sort_order", "asc") == "desc"
        if sort_by:
            key = (
                (lambda entry: (str(entry["name"]).lower(), str(entry["name"])))
                if sort_by == "name"
                else (
                    lambda entry: (
                        entry["mtime"],
                        str(entry["name"]).lower(),
                        str(entry["name"]),
                    )
                )
            )
            directories = sorted(
                (entry for entry in res if entry["isDir"]), key=key, reverse=reverse
            )
            files = sorted((entry for entry in res if not entry["isDir"]), key=key, reverse=reverse)
            res = directories + files
        offset = kwargs.get("offset", 0)
        limit = kwargs.get("limit")
        return res[offset:] if limit is None else res[offset : offset + limit]

    def tree_directory(
        self,
        path,
        show_hidden=False,
        node_limit=None,
        level_limit=None,
        offset=0,
        sort_by=None,
        sort_order="asc",
        directories_only=False,
        ctx=None,
    ):
        root = self._resolve(path)
        if not root.exists():
            raise AGFSNotFoundError(path)
        result = []
        for item in root.rglob("*"):
            rel = item.relative_to(root)
            if not show_hidden and any(part.startswith(".") for part in rel.parts):
                continue
            if level_limit is not None and len(rel.parts) > level_limit:
                continue
            if directories_only and not item.is_dir():
                continue
            result.append(
                {
                    "path": f"{path.rstrip('/')}/{rel.as_posix()}",
                    "rel_path": rel.as_posix(),
                    "name": item.name,
                    "is_dir": item.is_dir(),
                    "isDir": item.is_dir(),
                    "size": item.stat().st_size,
                    "mtime": item.stat().st_mtime,
                }
            )
        for entry in result:
            entry["info"] = {
                "name": entry["name"],
                "isDir": entry["isDir"],
                "size": entry["size"],
                "mode": "755" if entry["isDir"] else "644",
                "modTime": entry["mtime"],
            }
        result.sort(key=lambda entry: entry["path"], reverse=sort_order == "desc")
        return result[offset:] if node_limit is None else result[offset : offset + node_limit]

    def glob_directory(
        self,
        path,
        pattern,
        show_hidden=False,
        page_size=None,
        level_limit=None,
        continuation_token=None,
        ctx=None,
    ):
        del ctx
        root = self._resolve(path)
        matches = []
        for item in sorted(root.glob(pattern)):
            relative = item.relative_to(root)
            if not show_hidden and any(part.startswith(".") for part in relative.parts):
                continue
            if level_limit is not None and len(relative.parts) > level_limit:
                continue
            matches.append(
                {
                    "path": f"{str(path).rstrip('/')}/{relative.as_posix()}",
                    "rel_path": relative.as_posix(),
                    "name": item.name,
                    "is_dir": item.is_dir(),
                }
            )

        start = int(continuation_token or 0)
        end = len(matches) if not page_size else start + page_size
        return {
            "entries": matches[start:end],
            "next_token": str(end) if end < len(matches) else None,
        }

    def writeto(self, path, content, ctx=None, **kwargs):
        p = self._resolve(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, str):
            p.write_text(content, encoding="utf-8")
        else:
            p.write_bytes(content)
        return str(p)

    def write(self, path, content, ctx=None, **kwargs):
        return self.writeto(path, content, ctx, **kwargs)

    def write_file(self, path, content, ctx=None, **kwargs):
        return self.writeto(path, content, ctx, **kwargs)

    def read_file(self, path, ctx=None, **kwargs):
        p = self._resolve(path)
        if not p.exists():
            raise AGFSNotFoundError(path)
        return p.read_bytes()

    def read(self, path, ctx=None, **kwargs):
        return self.read_file(path, ctx, **kwargs)

    def cat(self, path, ctx=None, **kwargs):
        return self.read_file(path, ctx, **kwargs)

    def rm(self, path, recursive=False, ctx=None):
        p = self._resolve(path)
        if p.exists():
            if p.is_dir():
                if recursive:
                    shutil.rmtree(p)
                else:
                    p.rmdir()
            else:
                p.unlink()

    def delete_temp(self, path, ctx=None):
        self.rm(path, recursive=True, ctx=ctx)

    def mv(self, src, dst, ctx=None):
        s = self._resolve(src)
        d = self._resolve(dst)
        d.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(s), str(d))

    def stat(self, path, ctx=None):
        p = self._resolve(path)
        if not p.exists():
            raise AGFSNotFoundError(path)
        s = p.stat()
        return {
            "size": s.st_size,
            "mtime": s.st_mtime,
            "isDir": p.is_dir(),
            "is_dir": p.is_dir(),
        }

    def bind_request_context(self, ctx):
        return MagicMock(__enter__=lambda x: None, __exit__=lambda x, y, z: None)

    @staticmethod
    def _lock_conflicts(left, right):
        a, b = left["path"].rstrip("/"), right["path"].rstrip("/")
        return (
            a == b
            or (left["kind"] == "tree" and b.startswith(a + "/"))
            or (right["kind"] == "tree" and a.startswith(b + "/"))
        )

    def pathlock_acquire_batch(self, ctx, requests, timeout_secs=0.0, owner_lease_ref=None):
        del ctx
        requests = [dict(item) for item in requests]
        if not requests or any(
            not item.get("path", "").startswith("/") or item.get("kind") not in {"tree", "exact"}
            for item in requests
        ):
            raise ValueError("Expected absolute paths and tree/exact lock kinds")
        with self._pathlocks_guard:
            owner = (
                self._owned_lease(owner_lease_ref)["owner_id"]
                if owner_lease_ref
                else str(uuid.uuid4())
            )
            deadline = time.monotonic() + timeout_secs
            while any(
                lease["owner_id"] != owner and self._lock_conflicts(a, b)
                for lease in self._pathlock_refs.values()
                for a in requests
                for b in lease["covered_paths"]
            ):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(f"timed out acquiring test path lock: {requests}")
                self._pathlocks_guard.wait(remaining)
            lease = {
                "lease_ref": str(uuid.uuid4()),
                "ownership_ref": str(uuid.uuid4()),
                "owner_id": owner,
                "lock_paths": [item["path"] for item in requests],
                "covered_paths": requests,
                "owned": True,
            }
            self._pathlock_refs[lease["lease_ref"]] = dict(lease)
            return lease

    def pathlock_acquire_tree(self, ctx, path, timeout_secs=0.0, owner_lease_ref=None):
        return self.pathlock_acquire_batch(
            ctx, [{"path": path, "kind": "tree"}], timeout_secs, owner_lease_ref
        )

    def pathlock_acquire_exact(self, ctx, path, timeout_secs=0.0, owner_lease_ref=None):
        return self.pathlock_acquire_batch(
            ctx, [{"path": path, "kind": "exact"}], timeout_secs, owner_lease_ref
        )

    def _owned_lease(self, ref):
        lease = self._pathlock_refs.get(ref["lease_ref"])
        if (
            not lease
            or lease["ownership_ref"] != ref.get("ownership_ref")
            or ref["lease_ref"] in self._pathlock_handoffs
        ):
            raise ValueError("Invalid pathlock ownership capability")
        return lease

    def pathlock_as_borrowed(self, ctx, ref):
        del ctx
        lease = dict(self._owned_lease(ref))
        lease.pop("ownership_ref")
        lease["owned"] = False
        return lease

    def pathlock_to_handoff(self, ctx, ref):
        return self.pathlock_as_borrowed(ctx, ref)

    def pathlock_handoff(self, ctx, ref):
        del ctx
        self._owned_lease(ref)
        self._pathlock_handoffs.add(ref["lease_ref"])

    def pathlock_adopt(self, ctx, ref):
        del ctx
        lease_ref = ref.get("lease_ref")
        if lease_ref is None:
            owner = ref.get("owner_id", ref.get("handle_id"))
            lease_ref = next(
                (key for key, val in self._pathlock_refs.items() if val["owner_id"] == owner), None
            )
        lease = self._pathlock_refs.get(lease_ref)
        if not lease or lease_ref not in self._pathlock_handoffs:
            raise ValueError("Pathlock handoff unavailable or already adopted")
        if (
            ref.get("covered_paths", lease["covered_paths"]) != lease["covered_paths"]
            or ref.get("lock_paths") != lease["lock_paths"]
        ):
            raise ValueError("Pathlock handoff coverage does not match")
        self._pathlock_handoffs.remove(lease_ref)
        del self._pathlock_refs[lease_ref]
        lease = dict(lease, lease_ref=str(uuid.uuid4()), ownership_ref=str(uuid.uuid4()))
        self._pathlock_refs[lease["lease_ref"]] = lease
        return dict(lease)

    def pathlock_release(self, ctx, owned_lease_ref):
        del ctx
        with self._pathlocks_guard:
            self._owned_lease(owned_lease_ref)
            del self._pathlock_refs[owned_lease_ref["lease_ref"]]
            self._pathlocks_guard.notify_all()
