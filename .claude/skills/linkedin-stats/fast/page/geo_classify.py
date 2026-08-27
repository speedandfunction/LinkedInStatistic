#!/usr/bin/env python3
"""Classify LinkedIn location strings into ICP geography buckets.

S&F ICP = US customers. Buckets:
  US            -> ICP     (the target market)
  Ukraine       -> TEAM    (S&F is UA-based; internal network, not a customer signal)
  India / China -> ANTI    (explicitly off-ICP)
  everything else -> OTHER (off-target market)

LinkedIn convention: US metros carry NO country suffix ("Greater Boston",
"San Francisco Bay Area"); international locations end with ", <Country>".
So: a location with no trailing country is treated as US.

Pure functions — no I/O. Imported by parse-page-xls.py.
"""

COUNTRY_BUCKET = {
    "ukraine": "TEAM",
    "india": "ANTI",
    "china": "ANTI",
}
BUCKETS = ("US", "TEAM", "ANTI", "OTHER")


def country_of(loc: str) -> str:
    """Best-effort country from a LinkedIn location string."""
    parts = [p.strip() for p in str(loc).split(",") if p.strip()]
    if len(parts) <= 1:
        return "United States"  # US convention: metro with no country suffix
    return parts[-1]             # trailing token is the country (doubled tails collapse to same value)


def bucket_of(loc: str) -> str:
    c = country_of(loc).lower()
    if c in ("united states", "usa", "us"):
        return "US"
    return COUNTRY_BUCKET.get(c, "OTHER")


def classify_rows(rows):
    """rows: iterable of (location, count). Returns {buckets, countries, total, icp_pct, anti_pct}."""
    buckets = {b: 0 for b in BUCKETS}
    countries = {}
    for loc, n in rows:
        if not isinstance(n, (int, float)):
            continue
        buckets[bucket_of(loc)] += n
        c = country_of(loc)
        countries[c] = countries.get(c, 0) + n
    total = sum(buckets.values())
    return {
        "buckets": {b: round(buckets[b]) for b in BUCKETS},
        "total": round(total),
        "icp_pct": round(100 * buckets["US"] / total, 1) if total else 0.0,
        "anti_pct": round(100 * buckets["ANTI"] / total, 1) if total else 0.0,
        "countries": dict(sorted(countries.items(), key=lambda x: -x[1])),
    }
