"""Add researchers' BICyT records (CONICET's SIGEVA production) to the library.

Many papers CONICET researchers publish never reach CONICET Digital, so they
are not in the UNRN/ri-conicet dataset. This reads their public BICyT pages
(https://bicyt.conicet.gov.ar/fichas/produccion/<id>) into external.json,
which build.py imports with every full build and on its own with --external:

    uv run apps/api/library/bicyt.py 12599897 10734424 --pdf 12599897=paper.pdf
    uv run --with duckdb apps/api/library/build.py --external external.sql
    npx wrangler d1 execute benchy-library --remote --file external.sql

A PDF given with --pdf (the open-access copy, from the journal) is served by
the Worker from its LIBRARY_FILES KV namespace; upload it with the command
this prints. Without one, the
paper is kept with its abstract only.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import urllib.request
from pathlib import Path

EXTERNAL = Path(__file__).with_name("external.json")
FICHA = "https://bicyt.conicet.gov.ar/fichas/produccion/{id}"
TYPES = {"Artículo": "article", "Libro": "book", "Tesis": "thesis", "Capítulo de libro": "other"}


def lines_of(page: str) -> list[str]:
    page = re.sub(r"<script.*?</script>|<style.*?</style>|<head.*?</head>", " ", page, flags=re.S)
    text = html.unescape(re.sub(r"<[^>]+>", "\n", page))
    return [line.strip() for line in text.split("\n") if line.strip()]


def after(lines: list[str], label: str, start: int = 0) -> int:
    return lines.index(label, start) + 1


def person(name: str) -> str:
    """"CHAVEZ, MARTÍN NICOLÁS" → "Chavez, Martín Nicolás"; other casings are kept."""
    name = re.sub(r"\s+", " ", name).strip(" ;")
    return name.title() if name.isupper() else name


def parse(pid: int, page: str) -> dict:
    lines = lines_of(page)
    i = after(lines, "Producción CyT", lines.index("Resumen"))  # the record, past the nav
    title, kind = lines[i], lines[i + 1]
    authors, j = [], after(lines, "Autoría", i)
    while lines[j] != "Fecha":
        if lines[j] != ";":
            authors.append(person(lines[j]))
        j += 1
    year = lines[j + 1]
    journal = lines[after(lines, "Revista", j)].rstrip(", ")
    k = after(lines, "Revista", j) + 1
    extra = [lines[k]] if lines[k].startswith("vol.") else []
    if k + 1 < len(lines) and lines[k + 1].startswith("(pp."):
        extra.append(lines[k + 1].strip("()"))
    r = after(lines, "SIGEVA", k)
    # The abstract appears twice, cut and whole: keep the longest.
    abstract = max(lines[r : r + 2], key=len)
    subjects = []
    if "Palabras Clave" in lines:
        s = after(lines, "Palabras Clave")
        while s < len(lines) and lines[s].isupper() and len(subjects) < 20:
            subjects.append(lines[s])
            s += 1
    return {
        "id": pid,
        "origin": "bicyt",
        "url": FICHA.format(id=pid),
        "title": title,
        "creators": authors,
        "subjects": subjects,
        "description": abstract,
        "date": year,
        "year": int(year) if year.isdigit() else None,
        "type": TYPES.get(kind, "other"),
        "language": "spa",
        "publisher": ", ".join([journal, *extra]),
        "rights": "info:eu-repo/semantics/openAccess",
        "pdf": None,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", nargs="+", type=int)
    ap.add_argument("--pdf", action="append", default=[], metavar="ID=FILE", help="the paper's open-access PDF")
    ap.add_argument("--html-dir", type=Path, help="read <id>.html from here instead of fetching")
    args = ap.parse_args()
    pdfs = {int(k): Path(v) for k, v in (p.split("=", 1) for p in args.pdf)}

    records = {r["id"]: r for r in json.loads(EXTERNAL.read_text(encoding="utf-8"))} if EXTERNAL.exists() else {}
    for pid in args.ids:
        if args.html_dir:
            page = (args.html_dir / f"{pid}.html").read_text(encoding="utf-8")
        else:
            req = urllib.request.Request(FICHA.format(id=pid), headers={"User-Agent": "benchy-library"})
            page = urllib.request.urlopen(req, timeout=30).read().decode("utf-8")
        record = parse(pid, page)
        if pid in pdfs:
            record["pdf"] = f"files/bicyt/{pid}.pdf"
            print(f"npx wrangler kv key put bicyt/{pid}.pdf --path {pdfs[pid]} --binding LIBRARY_FILES --remote")
        elif records.get(pid, {}).get("pdf"):
            record["pdf"] = records[pid]["pdf"]
        records[pid] = record
        print(f"{pid}: {record['title']} ({record['year']}) · {'; '.join(record['creators'])}")
    EXTERNAL.write_text(json.dumps(sorted(records.values(), key=lambda r: r["id"]), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
