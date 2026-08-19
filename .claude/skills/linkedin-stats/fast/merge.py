#!/usr/bin/env python3
"""File merge helper for the fast scrape path.

All dashboards/li-stats/*.json writes go through THIS script, not Node.
Rationale (verified empirically): Python json.load -> json.dump(indent=2,
ensure_ascii=False) round-trips every existing file byte-for-byte, while
Node JSON.stringify rewrites historical float lexemes (50.0 -> 50), churning
diffs. The merge bodies below are ported verbatim from the agent specs:
  - post:     linkedin-stats-gather-metrics.md step 12
  - account:  linkedin-stats-gather-account.md step 5 (made atomic)
  - comments: linkedin-stats-gather-comments-out.md step 4
  - engagement: the `people` phase of scrape-weekly.mjs (who engaged, not how many)

stdin: one JSON payload {"mode": "post"|"account"|"comments"|"engagement", ...}
stdout: KEY=VALUE result lines. Exit 0 on success, 1 on failure.
"""
import datetime
import json
import os
import sys
import tempfile
from urllib.parse import quote


def write_atomic(path, data):
    dir_ = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".fast-merge.", suffix=".json", dir=dir_)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def ms_to_iso(ms):
    return datetime.datetime.fromtimestamp(
        ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_file(p):
    """Dump a freshly-discovered post record. Refuses to overwrite."""
    path = p["path"]
    if os.path.exists(path):
        raise SystemExit(f"refusing to overwrite existing file: {path}")
    write_atomic(path, p["record"])
    print("WRITTEN=1")


def merge_post(p):
    path, week, snapshot = p["path"], p["week"], p["snapshot"]
    with open(path) as f:
        data = json.load(f)
    text = p.get("post_text")
    if text and not data.get("text"):
        data["text"] = text
    data.setdefault("weeks", {})[week] = snapshot
    write_atomic(path, data)
    print("MERGED=1")


def merge_account(p):
    path, week, snapshot = p["path"], p["week"], p["snapshot"]
    try:
        with open(path) as f:
            data = json.load(f)
    except FileNotFoundError:
        data = {"weeks": {}}
    data.setdefault("weeks", {})[week] = snapshot
    write_atomic(path, data)
    print("MERGED=1")


def merge_comments(p):
    path, week = p["path"], p["week"]
    snapshot_cutoff_ms = p["snapshot_cutoff_ms"]
    incoming = p["incoming"]
    now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def build_permalink(post_urn, comment_urn):
        return f"https://www.linkedin.com/feed/update/{post_urn}/?commentUrn={quote(comment_urn, safe='')}"

    REQUIRED = {"comment_urn", "commented_at_ms", "verb", "text",
                "comment_author_name", "comment_author_url",
                "post_urn", "post_url",
                "post_author_name", "post_author_url",
                "reactions", "replies_count", "impressions"}
    for item in incoming:
        missing = REQUIRED - set(item.keys())
        if missing:
            raise SystemExit(
                f"SCRAPE_BAD_SHAPE: item missing fields {sorted(missing)}: {item.get('comment_urn')}")

    try:
        with open(path) as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
    except FileNotFoundError:
        data = {}
    comments = data.setdefault("comments", {})

    new_count = 0
    snapshotted_count = 0
    for item in incoming:
        urn = item["comment_urn"]
        if urn not in comments:
            comments[urn] = {
                "comment_urn":         urn,
                "commented_at":        ms_to_iso(item["commented_at_ms"]),
                "verb":                item["verb"],
                "text":                item["text"],
                "comment_author_name": item["comment_author_name"],
                "comment_author_url":  item["comment_author_url"],
                "post_urn":            item["post_urn"],
                "post_url":            item["post_url"],
                "post_author_name":    item["post_author_name"],
                "post_author_url":     item["post_author_url"],
                "permalink":           build_permalink(item["post_urn"], urn),
                "weeks":               {},
            }
            new_count += 1
        entry = comments[urn]
        if item["commented_at_ms"] >= snapshot_cutoff_ms:
            entry.setdefault("weeks", {})[week] = {
                "snapshot_at":   now_iso,
                "reactions":     item["reactions"],
                "replies_count": item["replies_count"],
                "impressions":   item["impressions"],
            }
            snapshotted_count += 1

    def _ms(entry):
        iso = entry.get("commented_at", "")
        try:
            d = datetime.datetime.strptime(iso.replace("Z", "+0000"), "%Y-%m-%dT%H:%M:%S%z")
            return int(d.timestamp() * 1000)
        except Exception:
            return 0

    sorted_pairs = sorted(comments.items(), key=lambda kv: _ms(kv[1]), reverse=True)
    data["comments"] = dict(sorted_pairs)
    write_atomic(path, data)
    print(f"NEW={new_count} SNAPSHOTTED={snapshotted_count}")


def merge_engagement(p):
    """Merge the people registry + engagement event log.

    Shape: {"people": {<person_key>: {...}}, "events": {<event_id>: {...}},
            "targets": {<target_id>: {...}}}.

    `targets` records which posts/comments have ever had their reactor list
    read. It is what makes the reaction delta honest: a target absent from this
    map has never been scanned, so its reactors are a baseline (backfill), not
    a week's worth of new reactions.

    Events are IMMUTABLE and append-only: an event id that already exists is
    never rewritten, so a re-run of the people phase (or a killed run replayed)
    cannot re-date or duplicate an engagement. People, by contrast, are updated
    in place — a person's display name and headline drift over time, and the
    headline is what the ICP classifier reads.

    Payload keys (all optional except path):
      path           target file
      people[]       {key, name, profile_url, headline}
      events[]       {event_id, kind, target_type, target_urn, target_url,
                      person_key, occurred_at_ms|None, attributed_week|None,
                      backfill, text?}
      icp_verdicts[] {key, verdict, reason, model, headline_hash}
      targets[]      {target_id, target_type, target_urn, target_url, week,
                      reactor_count}
    """
    path = p["path"]
    now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    PERSON_REQUIRED = {"key", "name", "profile_url", "headline"}
    TARGET_REQUIRED = {"target_id", "target_type", "target_urn", "target_url",
                       "week", "reactor_count"}
    EVENT_REQUIRED = {"event_id", "kind", "target_type", "target_urn", "target_url",
                      "person_key", "occurred_at_ms", "attributed_week", "backfill"}
    VERDICT_REQUIRED = {"key", "verdict", "reason", "model", "headline_hash"}

    incoming_people = p.get("people", [])
    incoming_events = p.get("events", [])
    incoming_verdicts = p.get("icp_verdicts", [])
    incoming_targets = p.get("targets", [])

    for item, required, label in (
        *((i, PERSON_REQUIRED, "person") for i in incoming_people),
        *((i, EVENT_REQUIRED, "event") for i in incoming_events),
        *((i, VERDICT_REQUIRED, "icp_verdict") for i in incoming_verdicts),
        *((i, TARGET_REQUIRED, "target") for i in incoming_targets),
    ):
        missing = required - set(item.keys())
        if missing:
            raise SystemExit(
                f"SCRAPE_BAD_SHAPE: {label} missing fields {sorted(missing)}: "
                f"{item.get('key') or item.get('event_id')}")

    try:
        with open(path) as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
    except FileNotFoundError:
        data = {}
    people = data.setdefault("people", {})
    events = data.setdefault("events", {})
    targets = data.setdefault("targets", {})

    people_new = people_updated = 0
    for item in incoming_people:
        key = item["key"]
        entry = people.get(key)
        if entry is None:
            people[key] = {
                "key":              key,
                "name":             item["name"],
                "profile_url":      item["profile_url"],
                "headline":         item["headline"],
                "headline_seen_at": now_iso,
                "first_seen_at":    now_iso,
                "icp": {"verdict": None, "reason": None, "model": None,
                        "classified_at": None, "headline_hash": None},
            }
            people_new += 1
            continue
        changed = False
        # Never overwrite a known value with an empty one: a reactor overlay
        # sometimes renders without the headline, and losing it would force a
        # needless re-classification.
        for field in ("name", "profile_url", "headline"):
            if item[field] and item[field] != entry.get(field):
                entry[field] = item[field]
                changed = True
                if field == "headline":
                    entry["headline_seen_at"] = now_iso
        if changed:
            people_updated += 1

    events_new = 0
    for item in incoming_events:
        event_id = item["event_id"]
        if event_id in events:
            continue
        record = {
            "event_id":        event_id,
            "kind":            item["kind"],
            "target_type":     item["target_type"],
            "target_urn":      item["target_urn"],
            "target_url":      item["target_url"],
            "person_key":      item["person_key"],
            "occurred_at":     ms_to_iso(item["occurred_at_ms"]) if item["occurred_at_ms"] else None,
            "attributed_week": item["attributed_week"],
            "backfill":        bool(item["backfill"]),
            "first_seen_at":   now_iso,
        }
        if item.get("text"):
            record["text"] = item["text"]
        events[event_id] = record
        events_new += 1

    icp_set = 0
    for item in incoming_verdicts:
        entry = people.get(item["key"])
        if entry is None:
            continue
        entry["icp"] = {
            "verdict":       item["verdict"],
            "reason":        item["reason"],
            "model":         item["model"],
            "classified_at": now_iso,
            "headline_hash": item["headline_hash"],
        }
        icp_set += 1

    targets_new = 0
    for item in incoming_targets:
        tid = item["target_id"]
        entry = targets.get(tid)
        if entry is None:
            targets[tid] = {
                "target_id":          tid,
                "target_type":        item["target_type"],
                "target_urn":         item["target_urn"],
                "target_url":         item["target_url"],
                "first_scanned_week": item["week"],
                "last_scanned_week":  item["week"],
                "reactor_count":      item["reactor_count"],
            }
            targets_new += 1
        else:
            entry["last_scanned_week"] = item["week"]
            entry["reactor_count"] = item["reactor_count"]

    # Deterministic key order keeps diffs to the rows that actually changed.
    data["people"] = dict(sorted(people.items()))
    data["events"] = dict(sorted(events.items()))
    data["targets"] = dict(sorted(targets.items()))
    write_atomic(path, data)
    print(f"PEOPLE_NEW={people_new} PEOPLE_UPDATED={people_updated} "
          f"EVENTS_NEW={events_new} ICP_SET={icp_set} TARGETS_NEW={targets_new}")


def main():
    payload = json.load(sys.stdin)
    mode = payload["mode"]
    if mode == "newfile":
        new_file(payload)
    elif mode == "post":
        merge_post(payload)
    elif mode == "account":
        merge_account(payload)
    elif mode == "comments":
        merge_comments(payload)
    elif mode == "engagement":
        merge_engagement(payload)
    else:
        raise SystemExit(f"unknown mode: {mode}")


if __name__ == "__main__":
    main()
