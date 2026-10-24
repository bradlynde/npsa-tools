"""
CSV formula-injection guard for spreadsheets we hand to people.

Names, titles, phones and organisation names come straight from scraped web
pages. A cell that starts with = + - @ (or a tab / carriage return) is run as a
formula when the CSV is opened in Excel, Sheets or Numbers. Prefixing such a
cell with a single quote makes the spreadsheet show it as plain text.

Apply this only to CSVs that leave the pipeline (the final compiled CSV and the
download route), not to the per-county CSVs the pipeline reads back in.
"""

import csv
import io

import pandas as pd

FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def escape_formula(value):
    """Return value with a leading ' if it would start a spreadsheet formula.

    Non-strings (numbers, None, NaN) are returned unchanged. Already-escaped
    values start with ' and are left alone, so this is safe to apply twice.
    """
    if isinstance(value, str) and value.startswith(FORMULA_PREFIXES):
        return "'" + value
    return value


def escape_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """Return a copy of df with every string cell passed through escape_formula."""
    out = df.copy()
    for col in out.columns:
        # map every column: pandas 3 stores text as "str", not object, dtype
        out[col] = out[col].map(escape_formula)
    return out


def escape_csv_text(csv_text: str) -> str:
    """Re-write CSV text with every cell passed through escape_formula.

    Used when serving CSVs that may have been written before this guard existed.
    """
    reader = csv.reader(io.StringIO(csv_text, newline=""))
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    for row in reader:
        writer.writerow([escape_formula(cell) for cell in row])
    return buf.getvalue()
