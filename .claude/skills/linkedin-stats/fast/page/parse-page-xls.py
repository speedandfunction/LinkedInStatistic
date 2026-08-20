#!/usr/bin/env python3
"""Parse LinkedIn Company Page admin-analytics XLS exports into a monthly JSON.

Input: a directory holding the three .xls files exported from the Page admin
analytics (Visitors / Followers / Content-"updates"), named exactly:
    visitors.xls  followers.xls  content.xls
Each is an old-style BIFF .xls (OLE2) — read with xlrd, NOT openpyxl.

Output: <out> JSON with per-month counters for the last N months plus a single
12-month demographic snapshot for visitors and followers. Page views and post
impressions are additive across days; LinkedIn reports "unique visitors" as the
SUM of daily uniques, so summing daily uniques reproduces its own number (this
was verified against the on-screen highlight: Jul 19-Aug 17 -> 569 / 225).

The column names below are LinkedIn's own export headers (verified 2026-08).
If LinkedIn renames a column the KeyError names it — do not guess a fallback.

Usage:
    python3 parse-page-xls.py <xls-dir> <out.json> [--months=6]
"""
import sys, os, json, datetime, collections
import xlrd


def _date(v):
    try:
        return datetime.datetime.strptime(str(v), "%m/%d/%Y").date()
    except ValueError:
        return None


def _monthly(sheet, colmap, hdr_row):
    """Sum the mapped columns per YYYY-MM. colmap: {out_key: exact header}."""
    hdr = [sheet.cell_value(hdr_row, c) for c in range(sheet.ncols)]
    idx = {}
    for out_key, header in colmap.items():
        if header not in hdr:
            raise KeyError(f"column '{header}' missing; headers were {hdr}")
        idx[out_key] = hdr.index(header)
    out = collections.OrderedDict()
    for r in range(hdr_row + 1, sheet.nrows):
        d = _date(sheet.cell_value(r, 0))
        if not d:
            continue
        key = f"{d.year}-{d.month:02d}"
        row = out.setdefault(key, {k: 0 for k in colmap})
        for out_key, ci in idx.items():
            v = sheet.cell_value(r, ci)
            row[out_key] += v if isinstance(v, (int, float)) else 0
    return out


def _demo(path, sheet_name, topn=8):
    wb = xlrd.open_workbook(path)
    sh = wb.sheet_by_name(sheet_name)
    rows = [(sh.cell_value(r, 0), sh.cell_value(r, 1)) for r in range(1, sh.nrows)]
    rows.sort(key=lambda x: -(x[1] if isinstance(x[1], (int, float)) else 0))
    return [[n, int(v)] for n, v in rows[:topn] if isinstance(v, (int, float))]


def last_months(n):
    today = datetime.date.today()
    out = []
    y, m = today.year, today.month
    for _ in range(n):
        out.append(f"{y}-{m:02d}")
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return list(reversed(out))


def parse(xls_dir, months):
    vis = xlrd.open_workbook(os.path.join(xls_dir, "visitors.xls"))
    fol = xlrd.open_workbook(os.path.join(xls_dir, "followers.xls"))
    con = xlrd.open_workbook(os.path.join(xls_dir, "content.xls"))

    vmo = _monthly(vis.sheet_by_name("Visitor metrics"), {
        "page_views": "Total page views (total)",
        "unique_visitors": "Total unique visitors (total)",
    }, hdr_row=0)
    fmo = _monthly(fol.sheet_by_name("New followers"), {
        "new_followers": "Total followers",
    }, hdr_row=0)
    cmo = _monthly(con.sheet_by_name("Metrics"), {
        "post_impressions": "Impressions (total)",
        "post_reactions": "Reactions (total)",
        "post_comments": "Comments (total)",
        "post_reposts": "Reposts (total)",
        "post_clicks": "Clicks (total)",
    }, hdr_row=1)  # Content "Metrics" sheet has a note in row 0, headers in row 1

    wanted = last_months(months)
    out_months = collections.OrderedDict()
    for mk in wanted:
        row = {}
        for src in (vmo, fmo, cmo):
            for k, v in src.get(mk, {}).items():
                row[k] = round(v)
        # fill zeros for any metric a month never saw
        for k in ("page_views", "unique_visitors", "new_followers",
                  "post_impressions", "post_reactions", "post_comments",
                  "post_reposts", "post_clicks"):
            row.setdefault(k, 0)
        out_months[mk] = row

    demo_sheets = ["Seniority", "Job function", "Industry", "Company size", "Location"]
    return {
        "source": "linkedin-page-admin-analytics-xls",
        "generated_at": datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
        "months": out_months,
        "visitor_demographics": {s: _demo(os.path.join(xls_dir, "visitors.xls"), s) for s in demo_sheets},
        "follower_demographics": {s: _demo(os.path.join(xls_dir, "followers.xls"), s) for s in demo_sheets},
    }


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = dict(a[2:].split("=", 1) for a in sys.argv[1:] if a.startswith("--") and "=" in a)
    if len(args) < 2:
        print("usage: parse-page-xls.py <xls-dir> <out.json> [--months=6]", file=sys.stderr)
        sys.exit(2)
    xls_dir, out = args[0], args[1]
    months = int(opts.get("months", "6"))
    data = parse(xls_dir, months)
    out_dir = os.path.dirname(out)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(out, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    f_months = ", ".join(data["months"].keys())
    print(f"wrote {out} — months: {f_months}", file=sys.stderr)


if __name__ == "__main__":
    main()
