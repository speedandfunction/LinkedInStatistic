// Top-level comments scraper for linkedin-stats-gather-metrics step 10.3.
// Writes to `weeks[WEEK].comments` (the array of comment entries — distinct
// from `metrics.comments`, which is the analytics-reported total count).
//
// This file is the canonical scrape body. The agent MUST pass its contents
// verbatim to mcp__playwright__browser_evaluate as the `function` argument
// — no edits, no improvisation. Strip the leading "//" comment block first;
// keep the arrow function exactly as written.
//
// Output shape: an array (length 0..200) where EVERY entry has EXACTLY these
// seven keys, in this order:
//   { author_name, author_url, author_headline, comment_urn, text, reactions,
//     replies_count }
//
// Do not add further keys (no `time_text`, no `profile_url`, no `author`, no
// `name`). Do not rename keys.
//
// 2026-08-19 — REWRITTEN for LinkedIn's post-page obfuscation. Every semantic
// class this file used to rely on is gone: no `article.comments-comment-entity`
// (no `article` elements at all), no `.comments-comment-meta__*`, no
// `.comments-replies-list`. The failure was SILENT — the selectors simply
// matched nothing, so all 50 post files recorded `comments: []` in week
// 2026-08-17 where the week before held 85 comments, and the run still exited
// 0. Two anchors replace them, both verified live 2026-08-19:
//
//   * `div[id^="replaceableComment_urn:li:comment:"]` — the repeating comment
//     unit. Its id CARRIES THE FULL COMMENT URN, which is strictly better than
//     what came before: the old markup had no URN at all on most cards, which
//     is where `COMMENTS_UNDATED` came from. A reply is the same kind of node
//     NESTED inside its parent's node, so top-level means "no comment-unit
//     ancestor" — there is no separate replies container any more.
//   * `button[aria-label^="View more options for"]` — the per-comment control
//     menu, used only as a secondary way to recognize a unit.
//
// The pre-2026-08 selectors are kept as a fallback: LinkedIn rolls these
// migrations out gradually, and an A/B bucket still serving the old markup
// must keep working.

() => {
  const UNIT = 'div[id^="replaceableComment_urn:li:comment:"]';

  const parseInt0 = (s) => {
    const m = (s || '').replace(/,/g, '').match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  };
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const abs = (href) => {
    if (!href) return '';
    try {
      const u = new URL(href, 'https://www.linkedin.com');
      return u.origin + u.pathname.replace(/\/+$/, '');
    } catch { return ''; }
  };

  // ---------------------------------------------------------------- current
  const units = Array.from(document.querySelectorAll(UNIT));
  if (units.length) {
    const topLevel = units.filter((u) => !u.parentElement?.closest(UNIT));
    const out = [];
    for (const u of topLevel.slice(0, 200)) {
      // Strip nested replies before reading any text, so a reply's body and
      // its author never leak into the parent comment.
      const nested = Array.from(u.querySelectorAll(UNIT));
      const inNested = (el) => nested.some((n) => n !== el && n.contains(el));

      const rawId = u.getAttribute('id') || u.getAttribute('componentkey') || '';
      const m = rawId.match(/urn:li:comment:\((?:urn:li:)?(?:activity:)?(\d+),(\d+)\)/);
      // Normalized to the `(activity:<post>,<comment>)` form every consumer
      // already parses — the DOM now spells it `(urn:li:activity:...)`.
      const comment_urn = m ? `urn:li:comment:(activity:${m[1]},${m[2]})` : '';

      const linkEl = Array.from(u.querySelectorAll('a[href*="/in/"], a[href*="/company/"]'))
        .find((a) => !inNested(a));
      const author_url = abs(linkEl?.getAttribute('href'));

      // The actor block renders as "<Name> <badges> <degree> <Name> • <degree>
      // <Headline>". The name is the anchor's first line; the headline is the
      // line after the "Name • degree" line.
      const lines = clean(linkEl?.innerText).length
        ? (linkEl.innerText || '').split('\n').map(clean).filter(Boolean)
        : [];
      let author_name = lines[0] || '';
      // Drop trailing status suffixes LinkedIn appends to the display name.
      author_name = author_name.replace(/,\s*(Open to work|Hiring|Verified)\s*$/i, '').trim();
      let author_headline = '';
      const dotIdx = lines.findIndex((l) => /\s•\s/.test(l));
      if (dotIdx >= 0 && lines[dotIdx + 1]) author_headline = lines[dotIdx + 1];
      if (!author_headline) {
        const rest = lines.slice(1).find((l) => l !== author_name && !/^(1st|2nd|3rd|\d+(st|nd|rd|th)\+?|Verified Profile|Following|You)$/i.test(l) && !/\s•\s/.test(l));
        author_headline = rest || '';
      }
      author_headline = author_headline.slice(0, 400);

      // Body: everything in the unit that is not the actor block, the social
      // bar, or a nested reply. The unit's own innerText minus the anchor's
      // text is the drift-resistant read.
      let text = '';
      {
        const own = (u.innerText || '');
        const actor = (linkEl?.innerText || '');
        let body = actor && own.startsWith(actor) ? own.slice(actor.length) : own;
        for (const n of nested) {
          const nt = n.innerText || '';
          if (nt && body.includes(nt)) body = body.replace(nt, '');
        }
        text = body
          .split('\n').map((l) => l.trim())
          .filter((l) => l && !/^(Like|Reply|Reply privately|…\s*more|\(edited\)|Load more comments|See more)$/i.test(l))
          // the relative timestamp line ("2w", "3d", "1mo")
          .filter((l) => !/^\d+\s*(s|m|h|d|w|mo|yr)$/i.test(l))
          .join('\n').trim();
        if (text.length > 2000) text = text.slice(0, 2000);
      }

      // Social bar counts. No semantic class survives, so read the reaction
      // count off the likers link and the reply count off the replies toggle.
      const socialText = Array.from(u.querySelectorAll('a, button'))
        .filter((e) => !inNested(e))
        .map((e) => `${e.getAttribute('aria-label') || ''}|${clean(e.innerText)}`);
      const reactions = (() => {
        for (const s of socialText) {
          const mm = s.match(/(\d[\d,]*)\s*(?:reactions?|likes?)\b/i);
          if (mm) return parseInt0(mm[1]);
        }
        return 0;
      })();
      const replies_count = (() => {
        for (const s of socialText) {
          const mm = s.match(/(\d[\d,]*)\s*(?:replies|reply)\b/i);
          if (mm) return parseInt0(mm[1]);
        }
        return nested.filter((n) => !n.parentElement?.closest(UNIT) === false).length;
      })();

      if (!author_name && !author_url && !text) continue;
      out.push({
        author_name, author_url, author_headline, comment_urn,
        text, reactions, replies_count,
      });
    }
    return out;
  }

  // --------------------------------------------------------------- fallback
  // Pre-2026-08 markup, kept for A/B buckets still serving it.
  const isTopLevel = (el) =>
    el && !el.closest('.comments-replies-list, .comments-comment-replies');
  const articles = Array.from(document.querySelectorAll('article.comments-comment-entity'))
    .filter(isTopLevel);

  const out = [];
  for (const a of articles.slice(0, 200)) {
    const nameEl = a.querySelector('.comments-comment-meta__description-title');
    const linkEl =
      a.querySelector('a.comments-comment-meta__description-container') ||
      a.querySelector('a.comments-comment-meta__image-link');
    const textEl = Array.from(
      a.querySelectorAll('.comments-comment-item__main-content')
    ).find(isTopLevel);
    const reactEl = Array.from(
      a.querySelectorAll('.comments-comment-social-bar__reactions-count--cr')
    ).find(isTopLevel);
    const repliesEl = Array.from(
      a.querySelectorAll('.comments-comment-social-bar__replies-count--cr')
    ).find(isTopLevel);

    const author_url = abs(linkEl?.getAttribute('href'));
    const author_name = (nameEl?.textContent || '').trim();
    const headlineEl =
      a.querySelector('.comments-comment-meta__description-subtitle') ||
      a.querySelector('[class*="comments-comment-meta__description-subtitle"]');
    const author_headline = clean(headlineEl?.textContent).slice(0, 400);

    const rawUrn = a.getAttribute('data-id') || a.getAttribute('data-urn') || '';
    const comment_urn = /^urn:li:comment:\(/.test(rawUrn) ? rawUrn : '';

    let text = (textEl?.innerText || '').trim();
    if (text.length > 2000) text = text.slice(0, 2000);
    if (!author_name && !author_url && !text) continue;

    out.push({
      author_name,
      author_url,
      author_headline,
      comment_urn,
      text,
      reactions:     parseInt0(reactEl?.textContent),
      replies_count: parseInt0(repliesEl?.textContent),
    });
  }
  return out;
}
