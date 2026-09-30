#!/usr/bin/env python
"""Build ``foci/web/data/annotations.json`` for Foci Lab.

Attaches externally licensed gene annotations to the genes of the idr0010
53BP1 screen (``foci/web/data/genes.json``).  Sources (see foci/ANNOTATIONS.md
for licence evidence):

* ``telnet``  TelNet Additional file 1 (Braun et al. 2018), figshare, CC BY 4.0
* ``gwas``    NHGRI-EBI GWAS Catalog, telomere-length associations, EBI terms of use
* ``depmap``  DepMap 24Q4 CRISPRInferredCommonEssentials, figshare+, CC BY 4.0
* HGNC complete set (CC0) is used only as an identifier bridge
  (Entrez ID / symbol -> Ensembl gene ID); it is not an annotation source.

Usage::

    python scripts/build_foci_annotations.py                 # download if needed, build
    python scripts/build_foci_annotations.py --offline       # cache only, no network
    python scripts/build_foci_annotations.py --refresh       # re-download everything

The download cache lives in the system temp dir (never committed).  Given the
same cache the output is byte-for-byte deterministic (``built_utc`` is the
newest ``retrieved_utc`` in the cache manifest, not the wall clock).
"""
from __future__ import annotations

import argparse
import csv
import datetime as _dt
import hashlib
import io
import json
import re
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GENES_JSON = ROOT / "foci" / "web" / "data" / "genes.json"
OUT_JSON = ROOT / "foci" / "web" / "data" / "annotations.json"
DEFAULT_CACHE = Path(tempfile.gettempdir()) / "foci_annot_cache"

USER_AGENT = "FociLab-annotations/0.1 (+https://studylab.id/foci/; research use, polite)"
MAX_BYTES = 50 * 1024 * 1024
TIMEOUT_S = 60
GWAS_P_THRESHOLD = 5e-8
GWAS_EFO_ID = "OBA_0003784"  # "chromosome, telomeric region length" (telomere length)
LABEL_MAX = 24

URL_TELNET = "https://ndownloader.figshare.com/files/11503508"
URL_DEPMAP = "https://ndownloader.figshare.com/files/51064916"
URL_HGNC = "https://storage.googleapis.com/public-download-files/hgnc/tsv/tsv/hgnc_complete_set.txt"
URL_GWAS = (
    "https://www.ebi.ac.uk/gwas/rest/api/v2/associations?efo_id="
    + GWAS_EFO_ID
    + "&size=100&page="
)

CACHE_FILES = {
    "telnet": "telnet_moesm1.xlsx",
    "depmap": "depmap_essentials.csv",
    "hgnc": "hgnc_complete_set.txt",
    "gwas": "gwas_telomere_associations.json",
}

SOURCE_META = {
    "telnet": {
        "name": "TelNet telomere-maintenance genes (pan-cancer supplement)",
        "url": "https://doi.org/10.6084/m9.figshare.6289682.v1",
        "licence": "CC BY 4.0",
        "licence_url": "https://creativecommons.org/licenses/by/4.0/",
        "version": "Additional file 1, figshare 6289682 v1 (2018-05-18)",
        "attribution": (
            "Braun DM, Chung I, Kepper N, Deeg KI, Rippe K. TelNet - a database for human "
            "and yeast genes involved in telomere maintenance. BMC Genetics 2018, "
            "doi:10.1186/s12863-018-0617-8 (Additional file 1)."
        ),
        "caveat": (
            "Only the 132 genes flagged 'in TelNet' in the article's pan-cancer supplement "
            "(Table S1) are used, not the full 2000+ gene TelNet database (its website is "
            "no longer served). Score 1-10 is the TelNet telomere-maintenance significance "
            "score; it is curated literature evidence, not a result of this screen."
        ),
    },
    "gwas": {
        "name": "GWAS Catalog: human telomere length",
        "url": "https://www.ebi.ac.uk/gwas/efotraits/" + GWAS_EFO_ID,
        "licence": "EMBL-EBI Terms of Use (open reuse, attribution expected)",
        "licence_url": "https://www.ebi.ac.uk/about/terms-of-use/",
        "version": "GWAS Catalog REST API v2, trait " + GWAS_EFO_ID,
        "attribution": (
            "NHGRI-EBI GWAS Catalog (https://www.ebi.ac.uk/gwas/); study accession and PubMed "
            "ID given per gene. Cite the current GWAS Catalog publication listed at "
            "https://www.ebi.ac.uk/gwas/docs/about and the original studies."
        ),
        "caveat": (
            "A GWAS locus-to-gene mapping is an association of a lead variant with telomere "
            "length, NOT a causal gene assignment: mapped genes are the gene overlapping the "
            "variant or, for intergenic variants, the flanking genes. Only associations with "
            "p <= 5e-8 are kept. Genes are joined by gene symbol (the API returns no Ensembl IDs)."
        ),
    },
    "depmap": {
        "name": "DepMap common-essential genes (CRISPR, 24Q4)",
        "url": "https://doi.org/10.25452/figshare.plus.27993248.v1",
        "licence": "CC BY 4.0",
        "licence_url": "https://creativecommons.org/licenses/by/4.0/",
        "version": "DepMap 24Q4 Public, CRISPRInferredCommonEssentials.csv",
        "attribution": (
            "DepMap, Broad (2024). DepMap 24Q4 Public. Figshare+. "
            "doi:10.25452/figshare.plus.27993248.v1"
        ),
        "caveat": (
            "Common-essential means most cancer cell lines need the gene for proliferation in "
            "CRISPR knockout screens; siRNA knockdown of such genes may reduce cell numbers "
            "and confound per-cell foci readouts. It says nothing about telomeres by itself."
        ),
    },
}
SOURCE_ORDER = ["telnet", "gwas", "depmap"]
HGNC_ATTRIBUTION = (
    "Identifiers bridged via the HGNC complete set (CC0; genenames.org, Seal et al. NAR 2023)."
)


# --------------------------------------------------------------------------- utils
def utc_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def norm_symbol(sym) -> str:
    """Normalise a gene symbol: NFKC, drop zero-width/control chars, trim, upper-case."""
    if sym is None:
        return ""
    s = unicodedata.normalize("NFKC", str(sym))
    s = "".join(ch for ch in s if unicodedata.category(ch) not in ("Cf", "Cc") or ch in " ")
    return s.strip().upper()


_ENSG_RE = re.compile(r"ENSG\d{6,}", re.I)


def split_ensembl(value) -> list[str]:
    """Return unique Ensembl gene ids from a cell that may hold several ids, with versions."""
    if value is None:
        return []
    out: list[str] = []
    for m in _ENSG_RE.finditer(str(value)):
        gid = m.group(0).upper()
        if gid not in out:
            out.append(gid)
    return out


_DATE_MANGLED = re.compile(
    r"^(\d{1,2}-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-\d{1,2})$",
    re.I,
)


def is_excel_date_symbol(sym: str) -> bool:
    """Spreadsheet-mangled symbols such as SEPT1 -> '1-Sep' cannot be trusted."""
    return bool(_DATE_MANGLED.match(str(sym).strip()))


class FetchError(RuntimeError):
    pass


def http_get(url: str, dest: Path, retries: int = 3) -> dict:
    """Download ``url`` to ``dest`` atomically. Raises FetchError on any failure."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                status = getattr(resp, "status", 200)
                if status != 200:
                    raise FetchError(f"HTTP {status} for {url}")
                declared = resp.headers.get("Content-Length")
                if declared and int(declared) > MAX_BYTES:
                    raise FetchError(f"{url}: {declared} bytes exceeds cap {MAX_BYTES}")
                total = 0
                with open(part, "wb") as fh:
                    while True:
                        chunk = resp.read(1 << 16)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > MAX_BYTES:
                            raise FetchError(f"{url}: download exceeds cap {MAX_BYTES}")
                        fh.write(chunk)
                if declared and total != int(declared):
                    raise FetchError(f"{url}: partial download ({total} of {declared} bytes)")
                part.replace(dest)
                return {"last_modified": resp.headers.get("Last-Modified", ""), "bytes": total}
        except (urllib.error.URLError, TimeoutError, OSError, FetchError, ValueError) as exc:
            last = exc
            if part.exists():
                part.unlink()
            if attempt < retries:
                time.sleep(2.0 * attempt)
    raise FetchError(f"failed to download {url}: {last}")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ------------------------------------------------------------------------ xlsx reader
_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def _col_index(ref: str) -> int:
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group():
        n = n * 26 + ord(ch) - 64
    return n - 1


def read_xlsx_rows(data: bytes, sheet_index: int = 0) -> list[dict[int, str]]:
    """Minimal stdlib .xlsx reader: rows as {column_index: text} (empty cells omitted)."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        sst: list[str] = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.findall("m:si", _NS):
                sst.append("".join(t.text or "" for t in si.iter("{%s}t" % _NS["m"])))
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        rid_target = {r.get("Id"): r.get("Target") for r in rels}
        sheets = wb.find("m:sheets", _NS).findall("m:sheet", _NS)
        rid = sheets[sheet_index].get(
            "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
        )
        target = rid_target[rid].lstrip("/")
        path = target if target.startswith("xl/") else "xl/" + target
        root = ET.fromstring(z.read(path))
    rows: list[dict[int, str]] = []
    for row in root.iter("{%s}row" % _NS["m"]):
        d: dict[int, str] = {}
        for c in row.findall("m:c", _NS):
            t = c.get("t")
            if t == "inlineStr":
                text = "".join(x.text or "" for x in c.iter("{%s}t" % _NS["m"]))
            else:
                v = c.find("m:v", _NS)
                if v is None or v.text is None:
                    continue
                text = sst[int(v.text)] if t == "s" else v.text
            if text != "":
                d[_col_index(c.get("r"))] = text
        rows.append(d)
    return rows


# --------------------------------------------------------------------------- parsers
def _clean(s) -> str:
    return re.sub(r"\s+", " ", str(s)).strip() if s is not None else ""


def parse_telnet(data: bytes) -> list[dict]:
    """Rows of Additional file 1 flagged 'in TelNet' = yes. Column positions are read
    from the header row, so re-ordered columns still parse."""
    rows = read_xlsx_rows(data)
    header_i = None
    for i, r in enumerate(rows):
        if _clean(r.get(0)).lower() == "gene symbol":
            header_i = i
            break
    if header_i is None:
        raise ValueError("TelNet table: header row 'Gene symbol' not found")
    header = {_clean(v).lower(): k for k, v in rows[header_i].items()}
    sub = {_clean(v).lower(): k for k, v in (rows[header_i + 1] if header_i + 1 < len(rows) else {}).items()}

    def col(name, table=header):
        return table.get(name)

    need = ["gene symbol", "gene id", "in telnet", "telnet score"]
    for n in need:
        if col(n) is None:
            raise ValueError(f"TelNet table: column {n!r} missing")
    c_sym, c_id, c_in, c_score = (col(n) for n in need)
    c_rho = next((k for h, k in header.items() if h.startswith("correlation coefficient")), None)
    c_func = col("tm function")
    c_sig = col("tm significance")
    c_alt, c_tel, c_pred = col("alt", sub), col("telomerase-mediated", sub), col("predicted tmm", sub)
    out: list[dict] = []
    for r in rows[header_i + 1:]:
        if _clean(r.get(c_in)).lower() != "yes":
            continue
        sym = _clean(r.get(c_sym))
        if not sym or is_excel_date_symbol(sym):
            continue
        try:
            score = int(float(r.get(c_score, "")))
        except ValueError:
            continue
        entrez = _clean(r.get(c_id))
        rec = {
            "symbol": sym,
            "entrez": entrez if entrez.isdigit() else "",
            "score": score,
            "significance": _clean(r.get(c_sig)),
            "functions": _clean(r.get(c_func)).rstrip("; ").strip(),
            "alt": _clean(r.get(c_alt)),
            "telomerase": _clean(r.get(c_tel)),
            "predicted_tmm": _clean(r.get(c_pred)),
        }
        if c_rho is not None:
            try:
                rec["rho"] = float(r.get(c_rho))
            except (TypeError, ValueError):
                pass
        out.append(rec)
    return out


_DEPMAP_RE = re.compile(r"^\s*(?P<sym>\S+)\s*\((?P<id>\d+)\)\s*$")


def parse_depmap(text: str) -> list[dict]:
    """CRISPRInferredCommonEssentials.csv: header 'Essentials', rows 'SYMBOL (EntrezID)'."""
    out: list[dict] = []
    seen = set()
    for i, line in enumerate(text.splitlines()):
        line = line.strip().strip('"')
        if not line or (i == 0 and line.lower() == "essentials"):
            continue
        m = _DEPMAP_RE.match(line)
        if not m:
            continue
        key = (m.group("sym"), m.group("id"))
        if key in seen:
            continue
        seen.add(key)
        out.append({"symbol": m.group("sym"), "entrez": m.group("id")})
    return out


def _p_value(rec: dict):
    p = rec.get("p_value")
    if p is None and rec.get("pvalue_mantissa") is not None and rec.get("pvalue_exponent") is not None:
        p = float(rec["pvalue_mantissa"]) * 10.0 ** int(rec["pvalue_exponent"])
    try:
        return float(p) if p is not None else None
    except (TypeError, ValueError):
        return None


def parse_gwas(records: list[dict], threshold: float = GWAS_P_THRESHOLD) -> list[dict]:
    """One row per (association, mapped gene). Keeps only the telomere-length trait
    and genome-wide-significant associations; duplicated association ids are dropped."""
    out: list[dict] = []
    seen = set()
    for a in records:
        traits = {t.get("efo_id") for t in a.get("efo_traits", []) or []}
        if GWAS_EFO_ID not in traits:
            continue
        p = _p_value(a)
        if p is None or p > threshold:
            continue
        aid = a.get("association_id")
        for g in a.get("mapped_genes") or []:
            g = _clean(g)
            if not g:
                continue
            key = (aid, norm_symbol(g))
            if aid is not None and key in seen:
                continue
            seen.add(key)
            out.append(
                {
                    "symbol": g,
                    "p": p,
                    "accession": a.get("accession_id") or "",
                    "pmid": str(a.get("pubmed_id") or ""),
                    "author": _clean(a.get("first_author")),
                    "assoc_id": aid,
                }
            )
    return out


class Hgnc:
    """Identifier bridge: Entrez ID / approved symbol / previous symbol -> Ensembl gene id."""

    def __init__(self, rows: list[dict]):
        self.by_entrez: dict[str, dict] = {}
        self.by_symbol: dict[str, dict] = {}
        self.by_ensembl: dict[str, dict] = {}
        prev: dict[str, list[dict]] = {}
        for r in rows:
            if r.get("status") != "Approved":
                continue
            if (r.get("locus_type") or "").strip().lower() == "readthrough":
                continue  # readthrough transcripts share loci with their parents; never join on them
            row = {
                "symbol": r["symbol"],
                "ensembl": (split_ensembl(r.get("ensembl_gene_id")) or [None])[0],
                "prev": [norm_symbol(p) for p in re.split(r"[|,]", r.get("prev_symbol", "") or "") if p.strip()],
            }
            if r.get("entrez_id"):
                self.by_entrez[r["entrez_id"].strip()] = row
            self.by_symbol[norm_symbol(r["symbol"])] = row
            if row["ensembl"]:
                self.by_ensembl.setdefault(row["ensembl"], row)
            for p in row["prev"]:
                prev.setdefault(p, []).append(row)
        # previous symbols are only usable when they point to exactly one gene
        self.by_prev = {p: v[0] for p, v in prev.items() if len(v) == 1}


def parse_hgnc(text: str) -> Hgnc:
    reader = csv.DictReader(io.StringIO(text), delimiter="\t")
    return Hgnc(list(reader))


# ------------------------------------------------------------------------- screen + join
class Screen:
    """Genes of the screen with Ensembl ids (several allowed) and symbols."""

    def __init__(self, columns: list[str], rows: list[list]):
        gi, ei = columns.index("gene"), columns.index("ensembl")
        self.ensembl: set[str] = set()
        self.by_symbol: dict[str, set[str]] = {}
        for r in rows:
            ids = split_ensembl(r[ei])
            self.ensembl.update(ids)
            sym = norm_symbol(r[gi])
            if sym and ids:
                self.by_symbol.setdefault(sym, set()).update(ids)

    def unique_symbol(self, sym: str):
        ids = self.by_symbol.get(norm_symbol(sym))
        if ids and len(ids) == 1:
            return next(iter(ids))
        return None


class Resolver:
    """Resolve a source gene to a screen Ensembl id.

    Order: (1) Entrez ID -> HGNC -> Ensembl id present in the screen ("ensembl");
    (2) symbol fallback ("symbol"): approved symbol / unique previous symbol -> HGNC
    Ensembl id in the screen, else the symbol (or HGNC symbol/previous symbols) found
    unambiguously among the screen's own symbols.
    """

    def __init__(self, screen: Screen, hgnc: Hgnc):
        self.screen, self.hgnc = screen, hgnc

    def _conflicts(self, gid: str, row, name: str) -> bool:
        """True when the screen's Ensembl id belongs, in HGNC, to a different gene than the
        one we are resolving (the screen's symbol/id pairing then cannot be trusted)."""
        owner = self.hgnc.by_ensembl.get(gid)
        if owner is None:
            return False
        if row is not None:
            return owner is not row
        return norm_symbol(owner["symbol"]) != name and name not in owner["prev"]

    def resolve(self, symbol: str, entrez: str = "", ensembl=None):
        for gid in split_ensembl(ensembl):
            if gid in self.screen.ensembl:
                return gid, "ensembl"
        row = self.hgnc.by_entrez.get(str(entrez).strip()) if entrez else None
        if row and row["ensembl"] in self.screen.ensembl:
            return row["ensembl"], "ensembl"
        s = norm_symbol(symbol)
        if row is None and s:
            row = self.hgnc.by_symbol.get(s) or self.hgnc.by_prev.get(s)
            if row and row["ensembl"] in self.screen.ensembl:
                return row["ensembl"], "symbol"
        names: list[str] = []
        if row:
            names.append(norm_symbol(row["symbol"]))
            # a previous symbol that is now the approved symbol of another gene is reused, not a synonym
            names += [p for p in row["prev"] if p not in self.hgnc.by_symbol]
        if s:
            names.append(s)
        for n in names:
            gid = self.screen.unique_symbol(n)
            if gid and not self._conflicts(gid, row, n):
                return gid, "symbol"
        return None


def _gene_key(rec: dict) -> str:
    return "E:" + rec["entrez"] if rec.get("entrez") else "S:" + norm_symbol(rec["symbol"])


def join_records(records: list[dict], resolver: Resolver):
    """-> (by_ensg: {ensg: {"method": "ensembl"|"symbol", "recs": [...]}}, n_source_genes)."""
    by: dict[str, dict] = {}
    keys = set()
    for rec in records:
        keys.add(_gene_key(rec))
        hit = resolver.resolve(rec["symbol"], rec.get("entrez", ""), rec.get("ensembl"))
        if not hit:
            continue
        gid, method = hit
        slot = by.setdefault(gid, {"method": method, "recs": []})
        if method == "ensembl":
            slot["method"] = "ensembl"
        slot["recs"].append(rec)
    return by, len(keys)


# ---------------------------------------------------------------------- annotation text
def _fit(label: str) -> str:
    return label if len(label) <= LABEL_MAX else label[: LABEL_MAX - 1].rstrip() + "…"


def _sym_note(method: str) -> str:
    return " Matched by gene symbol, not by Ensembl ID." if method == "symbol" else ""


def _finish(entry: dict, method: str) -> dict:
    if method == "symbol":
        entry["match"] = "symbol"
    return entry


def annotate_telnet(slot: dict) -> dict:
    rec = max(slot["recs"], key=lambda r: (r["score"], r["symbol"]))
    parts = [f"TelNet telomere-maintenance score {rec['score']} (scale 1-10)"]
    if rec["significance"]:
        parts.append(f"evidence: {rec['significance']}")
    if rec["functions"]:
        parts.append(f"function: {rec['functions']}")
    bits = [f"{n}: {rec[k]}" for n, k in (("ALT", "alt"), ("telomerase", "telomerase"), ("predicted TMM", "predicted_tmm")) if rec.get(k)]
    if bits:
        parts.append("; ".join(bits))
    detail = ". ".join(parts) + "." + _sym_note(slot["method"])
    return _finish(
        {"label": _fit(f"TelNet score {rec['score']}"), "detail": detail,
         "url": "https://doi.org/10.1186/s12863-018-0617-8"},
        slot["method"],
    )


def annotate_gwas(slot: dict) -> dict:
    recs = slot["recs"]
    n = len({r["assoc_id"] if r["assoc_id"] is not None else (r["accession"], r["p"]) for r in recs})
    studies = sorted({r["accession"] for r in recs if r["accession"]})
    best = min(recs, key=lambda r: (r["p"], r["accession"], r["symbol"]))
    who = ", ".join(x for x in (best["accession"], f"PMID {best['pmid']}" if best["pmid"] else "", best["author"]) if x)
    label = "Telomere-length GWAS" + (f" x{n}" if n > 1 else "")
    detail = (
        f"Mapped gene at {n} genome-wide-significant telomere-length association"
        f"{'s' if n != 1 else ''} in {len(studies)} stud{'ies' if len(studies) != 1 else 'y'}; "
        f"best p={best['p']:.1e} ({who}). Locus association, not a causal gene assignment."
        + _sym_note(slot["method"])
    )
    sym = urllib.parse.quote(best["symbol"], safe="")
    return _finish(
        {"label": _fit(label), "detail": detail, "url": "https://www.ebi.ac.uk/gwas/genes/" + sym},
        slot["method"],
    )


def annotate_depmap(slot: dict) -> dict:
    detail = (
        "Common-essential in DepMap 24Q4 CRISPR knockout screens (most cell lines depend on it); "
        "siRNA knockdown may reduce cell numbers." + _sym_note(slot["method"])
    )
    return _finish(
        {"label": _fit("DepMap common-essential"), "detail": detail,
         "url": "https://doi.org/10.25452/figshare.plus.27993248.v1"},
        slot["method"],
    )


ANNOTATORS = {"telnet": annotate_telnet, "gwas": annotate_gwas, "depmap": annotate_depmap}


# ------------------------------------------------------------------------------ cache
def ensure_cache(cache: Path, offline: bool, refresh: bool, log=print) -> dict:
    cache.mkdir(parents=True, exist_ok=True)
    mpath = cache / "manifest.json"
    manifest = json.loads(mpath.read_text(encoding="utf-8")) if mpath.exists() else {}
    for key, fname in CACHE_FILES.items():
        path = cache / fname
        have = path.exists() and key in manifest and sha256_file(path) == manifest[key].get("sha256")
        if have and not refresh:
            continue
        if offline:
            raise FetchError(f"offline mode: {fname} not in cache {cache}")
        log(f"downloading {key} ...")
        if key == "gwas":
            info = fetch_gwas(path)
            url = URL_GWAS + "N"
        else:
            url = {"telnet": URL_TELNET, "depmap": URL_DEPMAP, "hgnc": URL_HGNC}[key]
            info = http_get(url, path)
        manifest[key] = {
            "url": url,
            "retrieved_utc": utc_now(),
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
            "last_modified": info.get("last_modified", ""),
        }
        mpath.write_text(json.dumps(manifest, indent=1, sort_keys=True), encoding="utf-8")
    return manifest


def fetch_gwas(dest: Path) -> dict:
    """Paginate the v2 associations endpoint (100 per page, 0.6 s apart) into one JSON."""
    records: list[dict] = []
    page, total_pages, total = 0, 1, None
    tmp_dir = dest.parent
    while page < total_pages:
        part = tmp_dir / f"gwas_page_{page}.part"
        http_get(URL_GWAS + str(page), part)
        try:
            d = json.loads(part.read_text(encoding="utf-8"))
        finally:
            part.unlink(missing_ok=True)
        total_pages = int(d["page"]["totalPages"])
        total = d["page"].get("totalElements")
        for a in d.get("_embedded", {}).get("associations", []):
            records.append({k: a.get(k) for k in (
                "association_id", "accession_id", "pubmed_id", "first_author", "p_value",
                "pvalue_mantissa", "pvalue_exponent", "mapped_genes", "efo_traits", "reported_trait")})
        page += 1
        time.sleep(0.6)
    if total is not None and len(records) != int(total):
        raise FetchError(f"GWAS: got {len(records)} records, API says {total}")
    dest.write_text(json.dumps({"efo_id": GWAS_EFO_ID, "total": total, "records": records},
                               sort_keys=True), encoding="utf-8")
    return {"last_modified": ""}


# ------------------------------------------------------------------------------ build
def build(cache: Path, genes_path: Path = GENES_JSON) -> dict:
    manifest = json.loads((cache / "manifest.json").read_text(encoding="utf-8"))
    genes = json.loads(genes_path.read_text(encoding="utf-8"))
    screen = Screen(genes["columns"], genes["rows"])
    hgnc = parse_hgnc((cache / CACHE_FILES["hgnc"]).read_text(encoding="utf-8"))
    resolver = Resolver(screen, hgnc)

    raw = {
        "telnet": parse_telnet((cache / CACHE_FILES["telnet"]).read_bytes()),
        "depmap": parse_depmap((cache / CACHE_FILES["depmap"]).read_text(encoding="utf-8")),
        "gwas": parse_gwas(json.loads((cache / CACHE_FILES["gwas"]).read_text(encoding="utf-8"))["records"]),
    }
    return assemble(raw, resolver, manifest)


def assemble(raw: dict, resolver: Resolver, manifest: dict) -> dict:
    hgnc_date = (manifest.get("hgnc") or {}).get("retrieved_utc", "")[:10]
    sources, by_ensembl, match = [], {}, {}
    for sid in SOURCE_ORDER:
        meta = dict(SOURCE_META[sid])
        meta["id"] = sid
        meta["retrieved_utc"] = manifest[sid]["retrieved_utc"]
        meta["attribution"] += " " + HGNC_ATTRIBUTION.replace("(CC0;", f"(CC0, retrieved {hgnc_date};")
        sources.append(meta)
        slots, n_src = join_records(raw[sid], resolver)
        n_e = 0
        for gid, slot in slots.items():
            by_ensembl.setdefault(gid, {})[sid] = ANNOTATORS[sid](slot)
            n_e += slot["method"] == "ensembl"
        match[sid] = {
            "screen_genes_matched": len(slots),
            "of": n_src,
            "by_ensembl": n_e,
            "by_symbol": len(slots) - n_e,
        }
    built = max(m["retrieved_utc"] for m in manifest.values())
    return {"version": 1, "built_utc": built, "sources": sources,
            "by_ensembl": by_ensembl, "match": match}


def dumps(doc: dict) -> str:
    return json.dumps(doc, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    ap.add_argument("--out", type=Path, default=OUT_JSON)
    ap.add_argument("--genes", type=Path, default=GENES_JSON)
    ap.add_argument("--offline", action="store_true", help="use the cache only; never touch the network")
    ap.add_argument("--refresh", action="store_true", help="re-download all sources")
    args = ap.parse_args(argv)
    try:
        ensure_cache(args.cache, args.offline, args.refresh)
    except FetchError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    doc = build(args.cache, args.genes)
    text = dumps(doc)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    print(f"wrote {args.out} ({len(text.encode('utf-8'))} bytes)")
    for sid in SOURCE_ORDER:
        print(sid, doc["match"][sid])
    return 0


if __name__ == "__main__":
    sys.exit(main())
