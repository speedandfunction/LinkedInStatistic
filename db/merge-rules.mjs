// How a batch is folded before it is sent.
//
// INSERT ... ON CONFLICT DO UPDATE cannot touch the same row twice ("cannot
// affect row a second time"), so any batch that lands through a DO UPDATE has to
// be folded first. The direction of the fold is the part that is easy to get
// wrong: merge.py is FIRST-wins for everything it freezes, and last-wins only
// for the fields it explicitly overwrites. Folding everything last-wins would
// re-date engagements and unfreeze first_scanned_week — the two rules the fold
// exists to protect.
//
// Ground truth, taken by running merge.py on a payload with a duplicated entry
// (see db/test-merge-rules.mjs, which replays exactly this):
//
//   people  [{key:in/x, name:N, headline:GOOD}, {key:in/x, name:'', headline:''}]
//           -> name N, headline GOOD          (first record seeds; empty never overwrites)
//   events  [{E1, reaction, u1, 2026-01-05, backfill}, {E1, comment, u2, 2030-01-07}]
//           -> reaction, u1, 2026-01-05, backfill=true          (merge.py:271-273)
//   targets [{T1, week 2026-01-05, count 3}, {T1, week 2030-01-07, count 99}]
//           -> first_scanned_week 2026-01-05, last 2030-01-07, count 99 (merge.py:311-322)

// Last-wins. For rows that came out of a JSON object, where the key is unique
// anyway and the order is the file's own.
export function fold(rows, keyOf) {
  const seen = new Map();
  for (const r of rows) seen.set(keyOf(r), r);
  return [...seen.values()];
}

// merge.py:243-262. The first sighting seeds the record; later sightings
// overwrite name / profile_url / headline only when they are non-empty
// (`if item[field] and item[field] != entry.get(field)`), and nothing else.
export function foldPeople(rows) {
  const seen = new Map();
  for (const r of rows) {
    const prev = seen.get(r.key);
    if (!prev) { seen.set(r.key, { ...r }); continue; }
    for (const f of ["name", "profile_url", "headline"]) if (r[f]) prev[f] = r[f];
  }
  return [...seen.values()];
}

// merge.py:311-322. The first sighting sets first_scanned_week; later ones move
// last_scanned_week and reactor_count and leave the first week alone.
export function foldTargets(rows) {
  const seen = new Map();
  for (const r of rows) {
    const prev = seen.get(r.target_id);
    if (!prev) { seen.set(r.target_id, { ...r }); continue; }
    prev.last_scanned_week = r.last_scanned_week;
    prev.reactor_count = r.reactor_count;
  }
  return [...seen.values()];
}

// Engagement events are deliberately NOT here. They are not folded at all:
// ON CONFLICT DO NOTHING keeps the first row of a duplicate pair inside one
// statement, which is merge.py:271-273 exactly. Folding them last-wins would
// re-date the engagement.
