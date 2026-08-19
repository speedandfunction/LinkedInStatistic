// Canonical scrape body for linkedin-stats-gather-comments-out.
//
// Pass the arrow function below VERBATIM (from `() => {` through the closing
// `}`) to mcp__playwright__browser_evaluate. Do not edit selectors, key
// names, ordering, or thresholds. Improvising the shape has burned this
// agent before — that is why this file exists separately from the spec.
//
// Persistent per-tab state lives on window.__lisSeen (Map<urn, ms>). Each
// call returns ONLY items newly visible since the last call (prevents the
// agent's conversation context from filling up with cumulative DOM dumps on
// long backfills).
//
// Return shape (LITERAL — no alternatives):
//   {
//     newItems: [
//       {
//         comment_urn:         "urn:li:comment:(activity:X,Y)",
//         commented_at_ms:     <int>,
//         verb:                "commented" | "replied",
//         text:                <string, capped at 2000 chars>,
//         comment_author_name: <string>,
//         comment_author_url:  <string, normalized origin+pathname>,
//         post_urn:            "urn:li:activity:Z",
//         post_url:            "https://www.linkedin.com/feed/update/urn:li:activity:Z/",
//         post_author_name:    <string>,
//         post_author_url:     <string, normalized origin+pathname>,
//         reactions:           <int>,
//         replies_count:       <int>,
//         impressions:         <int>
//       },
//       ...
//     ],
//     totalSeen:    <int, cumulative across all calls in this tab>,
//     oldestEverMs: <int | null, min commented_at_ms across totalSeen>
//   }
//
// Every newItems entry MUST contain EXACTLY these 13 fields, in this order.
// No `parent_*`. No `permalink`. No `commented_at` (the ms version is what
// the merge code converts to ISO). Permalink is computed in Python, not
// here. If the scraper produces a different shape your run is broken —
// return { newItems: [], totalSeen: 0, oldestEverMs: null } rather than
// write a malformed entry.

(PROFILE_FRAG) => {

  if (!window.__lisSeen) window.__lisSeen = new Map();
  const seen = window.__lisSeen;

  const normHref = (href) => {
    if (!href) return '';
    try {
      const u = new URL(href, 'https://www.linkedin.com');
      return u.origin + u.pathname;
    } catch { return href; }
  };

  const firstLine = (s) => (s || '').trim().split('\n')[0].trim();

  const lists = Array.from(document.querySelectorAll('ul'));
  const feed = lists.find(ul => Array.from(ul.children).some(li =>
    li.tagName === 'LI' && li.querySelector('[data-urn^="urn:li:activity"]')
  ));
  if (!feed) return { newItems: [], totalSeen: seen.size, oldestEverMs: null };

  const newItems = [];
  for (const li of feed.querySelectorAll(':scope > li')) {
    const postEl = li.querySelector('div[data-urn^="urn:li:activity"]');
    if (!postEl) continue;
    const postUrn = postEl.getAttribute('data-urn') || '';

    // Post author block — BEM-modified .update-components-actor__container
    // (NOT bare .update-components-actor — that selector matches nothing).
    // The post-card variants on /recent-activity/comments/ as of 2026-06-12:
    //   .update-components-actor__container          → wrapper DIV
    //   .update-components-actor__meta-link          → A with href+text
    //   .update-components-actor__title              → SPAN with author name
    const ac = postEl.querySelector('.update-components-actor__container');
    const metaLink = ac?.querySelector('.update-components-actor__meta-link');
    const fbLink = ac?.querySelector('a[href*="/in/"], a[href*="/company/"]');
    const postAuthorUrl = normHref((metaLink || fbLink)?.getAttribute('href') || '');
    const titleEl = ac?.querySelector('.update-components-actor__title');
    const postAuthorName = firstLine(titleEl?.innerText || metaLink?.innerText || '');

    // Verb: "commented on this" vs "replied to X's comment on this".
    const headerText = (li.innerText || '').slice(0, 300);
    const verb = /replied to [^']+?'s comment on this/i.test(headerText) ? 'replied' : 'commented';

    const articles = Array.from(li.querySelectorAll('article.comments-comment-entity[data-id^="urn:li:comment:"]'));
    for (const a of articles) {
      const dataId = a.getAttribute('data-id') || '';
      if (seen.has(dataId)) continue;

      // Comment author block — .comments-comment-meta__container.
      //   .comments-comment-meta__description-container → A with href
      //   .comments-comment-meta__description            → H3 like "the owner Ovchynnikov\n   • You"
      // The author URL is the SINGLE source of truth for "the owner authored this".
      // A bare `a[href*=PROFILE_FRAG]` probe over the whole article would also
      // match @-mentions of the owner inside someone else's comment.
      const cm = a.querySelector('.comments-comment-meta__container');
      const descLink = cm?.querySelector('.comments-comment-meta__description-container');
      const descEl   = cm?.querySelector('.comments-comment-meta__description');
      const commentAuthorUrl  = normHref(descLink?.getAttribute('href') || '');
      if (!commentAuthorUrl.includes(PROFILE_FRAG)) continue;
      const commentAuthorName = firstLine(descEl?.innerText || descLink?.innerText || '');

      const m = dataId.match(/urn:li:comment:\(activity:\d+,(\d+)\)/);
      if (!m) continue;
      let commentedAtMs = null;
      try { commentedAtMs = Number(BigInt(m[1]) >> 22n); } catch {}
      if (!commentedAtMs) continue;

      const textEl = Array.from(a.querySelectorAll('.comments-comment-item__main-content'))
        .find(el => !el.closest('.comments-replies-list, .comments-comment-replies'));
      let text = (textEl?.innerText || '').trim();
      if (text.length > 2000) text = text.slice(0, 2000);

      const reactEl = Array.from(a.querySelectorAll('.comments-comment-social-bar__reactions-count--cr'))
        .find(el => !el.closest('.comments-replies-list, .comments-comment-replies'));
      const repliesEl = Array.from(a.querySelectorAll('.comments-comment-social-bar__replies-count--cr'))
        .find(el => !el.closest('.comments-replies-list, .comments-comment-replies'));
      const impEl = Array.from(a.querySelectorAll('.comments-comment-social-bar__impressions-count'))
        .find(el => !el.closest('.comments-replies-list, .comments-comment-replies'));
      const parseInt0 = (s) => {
        const mm = (s || '').replace(/,/g, '').match(/\d+/);
        return mm ? parseInt(mm[0], 10) : 0;
      };

      const item = {
        comment_urn:         dataId,
        commented_at_ms:     commentedAtMs,
        verb,
        text,
        comment_author_name: commentAuthorName,
        comment_author_url:  commentAuthorUrl,
        post_urn:            postUrn,
        post_url:            postUrn ? `https://www.linkedin.com/feed/update/${postUrn}/` : '',
        post_author_name:    postAuthorName,
        post_author_url:     postAuthorUrl,
        reactions:           parseInt0(reactEl?.textContent),
        replies_count:       parseInt0(repliesEl?.textContent),
        impressions:         parseInt0(impEl?.textContent),
      };
      seen.set(dataId, commentedAtMs);
      newItems.push(item);
    }
  }

  let oldestEverMs = null;
  for (const ms of seen.values()) {
    if (oldestEverMs === null || ms < oldestEverMs) oldestEverMs = ms;
  }

  return { newItems, totalSeen: seen.size, oldestEverMs };
}
