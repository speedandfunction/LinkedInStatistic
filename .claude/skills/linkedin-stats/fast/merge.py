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
import re
import sys
import tempfile
from urllib.parse import quote


_SURROGATES = re.compile(r"[\ud800-\udfff]")


def strip_surrogates(obj):
    """Drop lone surrogates before writing.

    A UTF-16 slice on the Node side can split an emoji and leave half of it
    ("\\ud83d"). json.dump would then die with UnicodeEncodeError and take the
    whole phase down. Callers are fixed to slice by code point; this is the
    backstop so one malformed post can never abort a scrape again.
    """
    if isinstance(obj, str):
        return _SURROGATES.sub("", obj) if _SURROGATES.search(obj) else obj
    if isinstance(obj, dict):
        return {k: strip_surrogates(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [strip_surrogates(v) for v in obj]
    return obj


def write_atomic(path, data):
    data = strip_surrogates(data)
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


def merge_week_people(p):
    """Attach the week's reactor / commenter ROSTERS to post files and to the
    outbound-comments file.

    engagement.json holds the events; these lists are the projection of them
    onto the corpus, so a post file describes on its own who engaged with it in
    a given week. Both sides are lists of canonical profile URLs, each
    resolving to a file under dashboards/profiles/.

    Read-modify-write, not part of the snapshot: the metrics phase writes
    weeks[WEEK] BEFORE the people phase runs.

    Three rules earn their keep here:

      * None means NOT MEASURED, [] means measured-and-nobody. The people phase
        harvests commenters for every post but opens the reaction overlay only
        for its selected targets, so writing [] for an unscanned post would
        assert "nobody reacted", which is a lie.
      * UNION, never overwrite — the same reason events are append-only. A
        partial re-read of a lazily-paged dialog must not shrink a good list.
      * A missing weeks[WEEK] is CREATED, carrying no metrics/demographics/
        comments. A --phases=people run has no metrics phase to create it, and
        losing a scanned target's roster would be worse. Consumers key on the
        ABSENCE of `metrics` to skip such an entry (see
        .github/scripts/build-stats-json.mjs).

    A person LinkedIn showed but that could not be given a profile URL is NOT
    recorded here. There is no "and N others we could not name" counter: the
    scraper fails the run instead, and the revalidation session decides whether
    it was a genuinely private member or a parser that stopped finding links
    (upstream, 2026-08-19). In practice it has never happened — 12 of 12 resolved
    on the first real corpus — so a non-zero count means something broke.

    Payload:
      week            "YYYY-MM-DD"
      comments_path   outbound comments file (optional if `comments` is empty)
      posts[]         {path, reactors|None, commenters|None}
      comments[]      {comment_urn, reactors|None, commenters|None}
    """
    week = p["week"]
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(week)):
        raise SystemExit(f"SCRAPE_BAD_SHAPE: week is not a date: {week!r}")
    now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    POST_REQUIRED = {"path", "reactors", "commenters"}
    COMMENT_REQUIRED = {"comment_urn", "reactors", "commenters"}
    SIDES = ("reactors", "commenters")

    def check(row, required, label):
        missing = required - set(row.keys())
        if missing:
            raise SystemExit(
                f"SCRAPE_BAD_SHAPE: {label} missing fields {sorted(missing)}")
        for side in SIDES:
            urls = row[side]
            if urls is None:
                continue
            if not isinstance(urls, list) or any(
                    not isinstance(u, str) or not u.strip() for u in urls):
                raise SystemExit(f"SCRAPE_BAD_SHAPE: {label} {side} is not a list of urls")

    incoming_posts = p.get("posts", [])
    incoming_comments = p.get("comments", [])
    for row in incoming_posts:
        check(row, POST_REQUIRED, f"post row {row.get('path')}")
    for row in incoming_comments:
        check(row, COMMENT_REQUIRED, f"comment row {row.get('comment_urn')}")

    counts = {"reactors": 0, "commenters": 0}

    def apply_roster(entry, row):
        for side in SIDES:
            if row[side] is None:
                continue
            merged = sorted(set(entry.get(side) or []) | set(row[side]))
            entry[side] = merged
            counts[side] += len(merged)
            # Legacy shape: these counters were stored until 2026-08-19. They
            # are a defect signal now, not data — drop them on touch.
            entry.pop(f"{side}_unresolved", None)

    def week_entry(weeks):
        if week not in weeks:
            weeks[week] = {"snapshot_at": now_iso, "people_only": True}
            return weeks[week], True
        return weeks[week], False

    posts_updated = 0
    comments_updated = 0
    weeks_created = 0
    missing = 0

    by_path = {}
    for row in incoming_posts:
        by_path.setdefault(row["path"], []).append(row)
    for post_path, rows in by_path.items():
        try:
            with open(post_path) as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            missing += len(rows)
            continue
        entry, created = week_entry(data.setdefault("weeks", {}))
        weeks_created += 1 if created else 0
        for row in rows:
            apply_roster(entry, row)
        write_atomic(post_path, data)
        posts_updated += 1

    if incoming_comments:
        comments_path = p["comments_path"]
        try:
            with open(comments_path) as f:
                cdata = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            cdata = None
        if cdata is None:
            missing += len(incoming_comments)
        else:
            comments = cdata.setdefault("comments", {})
            for row in incoming_comments:
                entry = comments.get(row["comment_urn"])
                if entry is None:
                    # The comments phase has not discovered it yet.
                    missing += 1
                    continue
                wentry, created = week_entry(entry.setdefault("weeks", {}))
                weeks_created += 1 if created else 0
                apply_roster(wentry, row)
                comments_updated += 1
            write_atomic(comments_path, cdata)

    print(f"POSTS_UPDATED={posts_updated} COMMENTS_UPDATED={comments_updated} "
          f"WEEKS_CREATED={weeks_created} MISSING={missing} "
          f"REACTOR_URLS={counts['reactors']} COMMENTER_URLS={counts['commenters']}")


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
    elif mode == "week_people":
        merge_week_people(payload)
    else:
        raise SystemExit(f"unknown mode: {mode}")


if __name__ == "__main__":
    main()
