#!/usr/bin/env python3
"""Build a MONTHLY ICP-geography trend from per-month Visitors XLS exports.

Why separate from parse-page-xls.py: LinkedIn's demographic sheets carry NO
date column — one export yields a single aggregate distribution for its whole
range. To get a monthly geography trend you must export ONE range per month.
This reads a directory of files named YYYY-MM.xls (each a Visitors export whose
Time range was that calendar month) and classifies each month's Location sheet
into ICP buckets via geo_classify.

Going forward the pipeline appends one month per run; for the initial backfill
the months were exported by hand.

Usage: python3 geo-monthly.py <xls-dir> <out.json>
"""
import sys, os, json, glob
import xlrd
from geo_classify import classify_rows


def build(xls_dir):
    out = {}
    for f in sorted(glob.glob(os.path.join(xls_dir, "20??-??.xls"))):
        month = os.path.basename(f)[:7]
        sh = xlrd.open_workbook(f).sheet_by_name("Location")
        rows = [(sh.cell_value(r, 0), sh.cell_value(r, 1)) for r in range(1, sh.nrows)]
        c = classify_rows(rows)
        out[month] = {
            "us": c["buckets"]["US"], "team": c["buckets"]["TEAM"],
            "anti": c["buckets"]["ANTI"], "other": c["buckets"]["OTHER"],
            "icp_pct": c["icp_pct"], "anti_pct": c["anti_pct"], "total": c["total"],
        }
    return out


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: geo-monthly.py <xls-dir> <out.json>", file=sys.stderr); sys.exit(2)
    data = build(sys.argv[1])
    os.makedirs(os.path.dirname(sys.argv[2]) or ".", exist_ok=True)
    json.dump({"months": data}, open(sys.argv[2], "w"), indent=2)
    print("wrote", sys.argv[2], "months:", ", ".join(data), file=sys.stderr)
