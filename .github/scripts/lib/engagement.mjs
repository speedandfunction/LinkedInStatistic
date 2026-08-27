// Engagement scoring — ported VERBATIM from .github/scripts/build-stats-json.mjs
// so the company-page engagement sections are computed by the exact same math
// as Peter's personal dashboard. Same inputs (a raw engagement.json event log,
// scoring.json weights, vip-people.md list) produce the same three sections:
//   engagement_score_totals  (last_week + all_time rows)
//   engagement_score_weeks   (weekly timeseries, zero-filled)
//   engagement_people        (per-engager rows, richest first)
//
// Scores are DERIVED here, never stored: engagement.json holds raw immutable
// events; weights + the hand-curated 4x VIP list apply at build time. See
// fast/people.mjs for the "backfill / attributed_week" dating rules.

import { readFileSync } from 'node:fs';

const DEFAULT_WEIGHTS = {
  normal: { reaction: 1, comment: 5 },
  icp: { reaction: 2, comment: 10 },
  vip: { reaction: 4, comment: 20 },
};

function readScoring(file) {
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    return { weights: { ...DEFAULT_WEIGHTS, ...(cfg.weights ?? {}) }, precedence: cfg.precedence ?? 'max' };
  } catch { return { weights: DEFAULT_WEIGHTS, precedence: 'max' }; }
}

// One `- https://www.linkedin.com/in/<slug>` bullet per person. Fenced/inline
// code stripped first so the file's own format example is not parsed as a VIP.
function readVipKeys(file) {
  try {
    const md = readFileSync(file, 'utf8')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`\n]*`/g, '');
    const keys = new Set();
    for (const line of md.split('\n')) {
      if (!/^\s*[-*]\s/.test(line)) continue;
      for (const m of line.matchAll(/https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\/in\/([A-Za-z0-9\-_%.]+)/gi)) {
        const slug = m[1].replace(/\/+$/, '');
        if (/[a-z0-9]/i.test(slug)) keys.add(`in/${slug.toLowerCase()}`);
      }
    }
    return keys;
  } catch { return new Set(); }
}

function zeroFillWeeks(rows, zeroFor) {
  if (!rows.length) return rows;
  const byWeek = new Map(rows.map((r) => [r.week, r]));
  const weeks = rows.map((r) => r.week).sort();
  const out = [];
  const end = Date.parse(`${weeks[weeks.length - 1]}T00:00:00Z`);
  for (let t = Date.parse(`${weeks[0]}T00:00:00Z`); t <= end; t += 7 * 86400000) {
    const week = new Date(t).toISOString().slice(0, 10);
    out.push(byWeek.get(week) ?? zeroFor(week));
  }
  return out;
}

const EMPTY_TOTALS = {
  scope: '', week: '',
  score: 0, score_normal: 0, score_icp: 0, score_vip: 0,
  reactions: 0, comments: 0, people: 0,
  reactions_icp: 0, comments_icp: 0, people_icp: 0,
  reactions_non_icp: 0, comments_non_icp: 0,
  icp_reaction_pct: 0, icp_comment_pct: 0, icp_engagement_pct: 0,
};

// Build the three engagement sections. `nowIso` is injectable so the result is
// deterministic under snapshot tests / workflow resume (defaults to real clock).
export function buildEngagement({ engagementFile, scoringFile, vipFile, nowIso = null }) {
  const scoring = readScoring(scoringFile);
  const vipKeys = readVipKeys(vipFile);

  const tiersFor = (person, key) => {
    const t = ['normal'];
    if (person?.icp?.verdict === true) t.push('icp');
    if (vipKeys.has(key)) t.push('vip');
    return t;
  };
  const pointsFor = (tiers, kind) => {
    const vals = tiers.map((t) => scoring.weights[t]?.[kind] ?? 0);
    if (scoring.precedence === 'max') return Math.max(...vals);
    return vals[vals.length - 1];
  };

  const engagement_score_weeks = [];
  const engagement_score_totals = [];
  const engagement_people = [];
  try {
    const eng = JSON.parse(readFileSync(engagementFile, 'utf8'));
    const peopleMap = eng.people ?? {};
    const events = Object.values(eng.events ?? {});

    const currentWeekMonday = (() => {
      const d = nowIso ? new Date(nowIso) : new Date();
      const day = (d.getUTCDay() + 6) % 7;
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day))
        .toISOString().slice(0, 10);
    })();
    const weeksPresent = [...new Set(events.map((e) => e.attributed_week).filter(Boolean))].sort();
    const lastWeek = [...weeksPresent].reverse().find((w) => w < currentWeekMonday) ?? null;

    const weekAgg = new Map();
    const personAgg = new Map();
    const totals = {
      all_time: { ...EMPTY_TOTALS, scope: 'all_time' },
      last_week: { ...EMPTY_TOTALS, scope: 'last_week' },
    };
    const allTimePeople = new Set();
    const lastWeekPeople = new Set();
    const allTimeIcpPeople = new Set();
    const lastWeekIcpPeople = new Set();

    for (const ev of events) {
      const key = ev.person_key;
      const person = peopleMap[key];
      const tiers = tiersFor(person, key);
      const tier = tiers[tiers.length - 1];
      const kind = ev.kind === 'comment' ? 'comment' : 'reaction';
      const pts = pointsFor(tiers, kind);
      const bucket = `score_${tier}`;
      const isIcp = person?.icp?.verdict === true;
      const countField = kind === 'comment' ? 'comments' : 'reactions';
      const icpCountField = `${countField}_icp`;

      const prow = personAgg.get(key) ?? {
        person_key: key,
        name: person?.name ?? key,
        headline: person?.headline ?? '',
        profile_url: person?.profile_url ?? '',
        tier,
        is_icp: isIcp,
        reactions: 0, comments: 0, score: 0, score_last_week: 0,
      };
      prow.tier = tier;
      prow.is_icp = isIcp;
      prow[countField] += 1;
      prow.score += pts;

      totals.all_time.score += pts;
      totals.all_time[bucket] += pts;
      totals.all_time[countField] += 1;
      allTimePeople.add(key);
      if (isIcp) { totals.all_time[icpCountField] += 1; allTimeIcpPeople.add(key); }

      if (ev.attributed_week && !ev.backfill) {
        const w = ev.attributed_week;
        const row = weekAgg.get(w) ?? {
          week: w, score: 0, score_normal: 0, score_icp: 0, score_vip: 0, reactions: 0, comments: 0,
        };
        row.score += pts;
        row[bucket] += pts;
        row[kind === 'comment' ? 'comments' : 'reactions'] += 1;
        weekAgg.set(w, row);

        if (w === lastWeek) {
          prow.score_last_week += pts;
          totals.last_week.score += pts;
          totals.last_week[bucket] += pts;
          totals.last_week[countField] += 1;
          lastWeekPeople.add(key);
          if (isIcp) { totals.last_week[icpCountField] += 1; lastWeekIcpPeople.add(key); }
        }
      }
      personAgg.set(key, prow);
    }

    totals.all_time.people = allTimePeople.size;
    totals.last_week.people = lastWeekPeople.size;
    totals.all_time.people_icp = allTimeIcpPeople.size;
    totals.last_week.people_icp = lastWeekIcpPeople.size;
    totals.last_week.week = lastWeek ?? '';
    totals.all_time.week = '';

    const pct = (n, d) => (d > 0 ? Math.round((1000 * n) / d) / 10 : 0);
    for (const t of [totals.last_week, totals.all_time]) {
      t.reactions_non_icp = t.reactions - t.reactions_icp;
      t.comments_non_icp = t.comments - t.comments_icp;
      t.icp_reaction_pct = pct(t.reactions_icp, t.reactions);
      t.icp_comment_pct = pct(t.comments_icp, t.comments);
      t.icp_engagement_pct = pct(t.reactions_icp + t.comments_icp, t.reactions + t.comments);
    }

    engagement_score_weeks.push(...zeroFillWeeks(
      [...weekAgg.values()].sort((a, b) => a.week.localeCompare(b.week)),
      (week) => ({ week, score: 0, score_normal: 0, score_icp: 0, score_vip: 0, reactions: 0, comments: 0 }),
    ));
    engagement_score_totals.push(totals.last_week, totals.all_time);
    engagement_people.push(...[...personAgg.values()].sort((a, b) => b.score - a.score));
  } catch { /* engagement.json optional until the people phase has run once */ }

  // Always emit both total rows so the score tiles read "0" not "No data".
  if (!engagement_score_totals.length) {
    for (const scope of ['last_week', 'all_time']) engagement_score_totals.push({ ...EMPTY_TOTALS, scope });
  }

  return { engagement_score_totals, engagement_score_weeks, engagement_people, vip_count: vipKeys.size };
}
