# pandas_table_tools (v2 prep)

This is a standalone Python helper script to work with **CSV** and **Excel (.xlsx/.xlsm)** using `pandas`.

It is **not wired** to the PA app yet — it’s here as v2 scaffolding for imports/exports and data cleanup.

## Install (one-off)

From `pa-v1/`:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r scripts/requirements-pandas.txt
```

## Quick examples

Inspect a CSV:

```bash
python3 scripts/pandas_table_tools.py inspect path/to/file.csv --head 10
```

Convert CSV → XLSX:

```bash
python3 scripts/pandas_table_tools.py convert inbox.csv inbox.xlsx --out-sheet Inbox
```

Export PA list JSONL → CSV/XLSX:

```bash
python3 scripts/pandas_table_tools.py pa-export --list-id inbox --output /tmp/inbox.xlsx
```

Import CSV/XLSX → JSONL (schema-aware):

```bash
python3 scripts/pandas_table_tools.py pa-import --list-id inbox --input /tmp/inbox.xlsx --output /tmp/inbox.import.jsonl --dry-run
```

## Notes

- Supported input/output: `.csv`, `.xlsx`, `.xlsm`
- Excel support requires `openpyxl` (included in `scripts/requirements-pandas.txt`).
- When writing Excel, if a `color` column exists and contains `#RRGGBB`, the script tints the entire row to match.
- `pa-import` writes to the `--output` file you specify and **does not** modify `data/lists/*.jsonl` automatically.
