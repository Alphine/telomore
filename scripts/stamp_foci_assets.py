"""Cache-busting for the static Foci Lab site (run on the STAGED copy at deploy time, not on the repo).

The host serves .js with `Cache-Control: max-age=604800` (7 days) regardless of our .htaccess, so a
returning visitor could combine a fresh index.html with a stale app.js and get a broken page. Giving
every local script/stylesheet URL a content hash makes each release a new URL and defeats any cache:

1. `__DATA_VERSION__` placeholders inside .js files become a hash of the data JSON files
   (app.js appends it to its data requests, so stale cached data can never meet a newer app.js);
2. every local `src="x.js"` / `href="x.css"` in every .html gets `?v=<first 10 hex of sha256 of the file>`
   (computed AFTER step 1, so the hash matches the bytes that are served).

Idempotent: an existing `?v=...` is replaced. Remote URLs, absolute paths and fragments are left alone.

    python scripts/stamp_foci_assets.py <staged foci dir>
"""

from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

PLACEHOLDER = "__DATA_VERSION__"
REF = re.compile(r'''(?P<attr>\b(?:src|href))=(?P<q>["'])(?P<url>[^"']+?\.(?:js|css))(?:\?v=[0-9a-f]+)?(?P=q)''')


def _sha(data: bytes, n: int) -> str:
    return hashlib.sha256(data).hexdigest()[:n]


def data_version(root: Path) -> str:
    """Hash of every data JSON (sorted by relative path; path and bytes both contribute)."""
    h = hashlib.sha256()
    files = sorted(p for p in (root / "data").rglob("*.json")) if (root / "data").is_dir() else []
    for p in files:
        h.update(p.relative_to(root).as_posix().encode())
        h.update(b"\0")
        h.update(p.read_bytes())
        h.update(b"\0")
    return h.hexdigest()[:12]


def stamp(root: Path) -> dict:
    root = root.resolve()
    if not root.is_dir():
        raise SystemExit(f"not a directory: {root}")
    dv = data_version(root)
    replaced = 0
    for js in root.rglob("*.js"):
        text = js.read_bytes().decode("utf-8")
        if PLACEHOLDER in text:
            js.write_bytes(text.replace(PLACEHOLDER, dv).encode("utf-8"))
            replaced += 1
    stamped = 0
    for html in root.rglob("*.html"):
        src = html.read_bytes().decode("utf-8")

        def sub(m: re.Match) -> str:
            nonlocal stamped
            url = m.group("url")
            if re.match(r"^(?:[a-z][a-z0-9+.-]*:|//|/|#)", url, re.I):
                return m.group(0)                       # remote, protocol-relative, absolute or fragment
            target = (html.parent / url).resolve()
            try:
                target.relative_to(root)
            except ValueError:
                return m.group(0)                       # never hash files outside the staged site
            if not target.is_file():
                return m.group(0)
            stamped += 1
            return f'{m.group("attr")}={m.group("q")}{url}?v={_sha(target.read_bytes(), 10)}{m.group("q")}'

        out = REF.sub(sub, src)
        if out != src:
            html.write_bytes(out.encode("utf-8"))
    return {"data_version": dv, "js_files_with_placeholder": replaced, "references_stamped": stamped}


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1:
        print(__doc__)
        return 2
    info = stamp(Path(args[0]))
    print("stamped:", info)
    if info["references_stamped"] == 0:
        print("warning: no local script/stylesheet references found", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
