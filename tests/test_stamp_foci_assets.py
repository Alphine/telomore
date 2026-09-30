"""scripts/stamp_foci_assets.py: cache-busting of the staged Foci Lab site."""

from __future__ import annotations

import hashlib
import importlib.util
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("stamp_foci_assets", ROOT / "scripts" / "stamp_foci_assets.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def site(tmp_path: Path) -> Path:
    (tmp_path / "data" / "downloads").mkdir(parents=True)
    (tmp_path / "data" / "genes.json").write_text('{"a":1}')
    (tmp_path / "data" / "downloads" / "manifest.json").write_text('{"files":[]}')
    (tmp_path / "data" / "downloads" / "foci_genes.csv").write_text("gene\nX\n")   # CSV must NOT affect the data version
    (tmp_path / "app.js").write_text('var DATA_VERSION = "__DATA_VERSION__"; fetch("data/genes.json");')
    (tmp_path / "lib.js").write_text("var lib=1;")
    (tmp_path / "style.css").write_text("body{}")
    (tmp_path / "index.html").write_text(
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">\n'
        '<link rel="stylesheet" href="style.css">\n<link rel="icon" href="favicon.svg">\n'
        '<script src="lib.js"></script><script src="app.js"></script>\n'
        '<script src="/abs.js"></script><script src="//cdn.example/x.js"></script><a href="#x">x</a>\n')
    return tmp_path


def sha10(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()[:10]


def test_stamps_local_assets_with_content_hash_and_leaves_the_rest(tmp_path):
    root = site(tmp_path)
    info = mod.stamp(root)
    html = (root / "index.html").read_text()
    assert f'href="style.css?v={sha10(root / "style.css")}"' in html
    assert f'src="lib.js?v={sha10(root / "lib.js")}"' in html
    assert f'src="app.js?v={sha10(root / "app.js")}"' in html          # hash of the file AFTER the placeholder was replaced
    assert 'href="https://fonts.googleapis.com/css2?family=X"' in html   # remote untouched
    assert 'src="/abs.js"' in html and 'src="//cdn.example/x.js"' in html and 'href="#x"' in html
    assert 'href="favicon.svg"' in html                                  # only .js/.css are stamped
    assert info["references_stamped"] == 3 and info["js_files_with_placeholder"] == 1


def test_data_version_replaces_placeholder_and_tracks_json_only(tmp_path):
    root = site(tmp_path)
    v = mod.data_version(root)
    (root / "data" / "downloads" / "foci_genes.csv").write_text("changed")
    assert mod.data_version(root) == v                                   # CSV downloads do not bust the data cache
    mod.stamp(root)
    assert f'var DATA_VERSION = "{v}"' in (root / "app.js").read_text()
    assert "__DATA_VERSION__" not in (root / "app.js").read_text()
    (root / "data" / "genes.json").write_text('{"a":2}')
    assert mod.data_version(root) != v                                   # a changed data file changes the version


def test_idempotent_and_replaces_existing_version_params(tmp_path):
    root = site(tmp_path)
    mod.stamp(root)
    first = (root / "index.html").read_text()
    mod.stamp(root)
    assert (root / "index.html").read_text() == first
    (root / "lib.js").write_text("var lib=2;")                           # new content -> new URL, old ?v= is replaced not stacked
    mod.stamp(root)
    html = (root / "index.html").read_text()
    assert html.count("lib.js?v=") == 1 and f"lib.js?v={sha10(root / 'lib.js')}" in html
    assert not re.search(r"\?v=[0-9a-f]+\?v=", html)


def test_missing_and_out_of_tree_references_are_left_alone(tmp_path):
    root = site(tmp_path / "site")
    outside = tmp_path / "secret.js"
    outside.write_text("x")
    (root / "extra.html").write_text('<script src="nope.js"></script><script src="../secret.js"></script>')
    mod.stamp(root)
    assert (root / "extra.html").read_text() == '<script src="nope.js"></script><script src="../secret.js"></script>'


def test_real_site_references_resolve():
    """Every local .js/.css the real pages load exists, so stamping will cover them all."""
    web = ROOT / "foci" / "web"
    for html in web.glob("*.html"):
        for m in mod.REF.finditer(html.read_text(encoding="utf-8")):
            url = m.group("url")
            if re.match(r"^(?:[a-z][a-z0-9+.-]*:|//|/|#)", url, re.I):
                continue
            assert (web / url).is_file(), f"{html.name} references missing {url}"
