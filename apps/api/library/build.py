"""Build the paper library's D1 import from the CONICET metadata snapshot.

    uv run --with duckdb apps/api/library/build.py metadata.parquet library.sql
    npx wrangler d1 execute benchy-library --remote --file library.sql

The snapshot is UNRN/ri-conicet's data/metadata.parquet on Hugging Face
(https://huggingface.co/datasets/UNRN/ri-conicet/resolve/main/data/metadata.parquet).
By default the output replaces the whole library. With --since, it only
carries records fetched after that moment (the dataset grows in incremental
commits): each is deleted and inserted again, and records the repository
deleted are only deleted. The full-text index is written next to every insert
and delete (see schema.sql).
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import duckdb

SCHEMA = Path(__file__).with_name("schema.sql")
# D1 refuses statements over 100 KB; rows are grouped below that.
MAX_STATEMENT = 90_000
MAX_DESCRIPTION = 12_000
TYPES = {
    "info:eu-repo/semantics/article": "article",
    "info:ar-repo/semantics/artículo": "article",
    "info:eu-repo/semantics/doctoralThesis": "thesis",
    "info:eu-repo/semantics/book": "book",
    "dataset": "dataset",
}
COLUMNS = "id, title, creators, subjects, description, date, year, type, language, publisher, rights, pdf"
INDEXED = "title, creators, subjects, description"
META = """INSERT OR REPLACE INTO library_meta (key, value) SELECT 'papers', count(*) FROM papers;
INSERT OR REPLACE INTO library_meta (key, value) SELECT 'with_pdf', count(pdf) FROM papers;
INSERT OR REPLACE INTO library_meta (key, value) VALUES ('snapshot', {snapshot});
"""


def sql_text(value: str | None) -> str:
    if value is None:
        return "NULL"
    return "'" + value.replace("'", "''") + "'"


def row_values(r: dict) -> str:
    date = (r["date"] or "").strip()
    year = int(date[:4]) if re.match(r"^\d{4}", date) else None
    description = (r["description"] or "").strip()
    if len(description) > MAX_DESCRIPTION:
        description = description[:MAX_DESCRIPTION].rsplit(" ", 1)[0] + " …"
    values = [
        str(int(r["item_id"])),
        sql_text((r["title"] or "").strip() or "(sin título)"),
        sql_text(json.dumps([c for c in (r["creators"] or []) if c], ensure_ascii=False)),
        sql_text(json.dumps([s for s in (r["subjects"] or []) if s], ensure_ascii=False)),
        sql_text(description),
        sql_text(date),
        "NULL" if year is None else str(year),
        sql_text(TYPES.get(r["type"] or "", "other")),
        sql_text(r["language"] or ""),
        sql_text(r["publisher"] or ""),
        sql_text(r["rights"] or ""),
        sql_text(r["pdf"]),
    ]
    return "(" + ", ".join(values) + ")"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("parquet", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--since", help="only records fetched after this ISO timestamp (an incremental refresh)")
    args = ap.parse_args()

    con = duckdb.connect()
    where = "true"
    params: list = []
    if args.since:
        where = "fetched_at > ?::timestamptz"
        params = [args.since]
    rows = con.execute(
        f"""select item_id, title, creators, subjects, description, date, type, language,
                   publisher, rights, pdf, coalesce(deleted, false) as deleted
            from read_parquet(?) where {where} order by try_cast(item_id as bigint)""",
        [str(args.parquet), *params],
    )
    names = [d[0] for d in rows.description]

    written = deleted = 0
    with args.out.open("w", encoding="utf-8") as out:
        if not args.since:
            out.write("DROP TABLE IF EXISTS papers_fts;\nDROP TABLE IF EXISTS papers;\nDROP TABLE IF EXISTS library_meta;\n")
        out.write(SCHEMA.read_text(encoding="utf-8") + "\n")
        batch: list[str] = []
        ids: list[int] = []
        size = 0

        def flush() -> None:
            nonlocal batch, ids, size
            if batch:
                out.write(f"INSERT INTO papers ({COLUMNS}) VALUES\n" + ",\n".join(batch) + ";\n")
                out.write(
                    f"INSERT INTO papers_fts(rowid, {INDEXED}) SELECT id, {INDEXED} FROM papers "
                    f"WHERE id IN ({','.join(map(str, ids))});\n"
                )
            batch, ids, size = [], [], 0

        while chunk := rows.fetchmany(5000):
            for raw in chunk:
                r = dict(zip(names, raw))
                pid = int(r["item_id"])
                if args.since:
                    out.write(
                        f"INSERT INTO papers_fts(papers_fts, rowid, {INDEXED}) "
                        f"SELECT 'delete', id, {INDEXED} FROM papers WHERE id = {pid};\n"
                        f"DELETE FROM papers WHERE id = {pid};\n"
                    )
                if r["deleted"]:
                    deleted += 1
                    continue
                values = row_values(r)
                if size + len(values.encode()) > MAX_STATEMENT:
                    flush()
                batch.append(values)
                ids.append(pid)
                size += len(values.encode()) + 2
                written += 1
        flush()
        snapshot = con.execute("select max(fetched_at)::date::varchar from read_parquet(?)", [str(args.parquet)]).fetchone()[0]
        out.write(META.replace("{snapshot}", sql_text(snapshot)))
    print(f"{args.out}: {written} papers" + (f", {deleted} deleted" if deleted else ""))


if __name__ == "__main__":
    main()
