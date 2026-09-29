#!/usr/bin/env node
// Відкрити сторінки людей, які взаємодіяли з постами автора, і записати те, що
// звідти видно, у схему `enrich` у Postgres. Нічого не пише в репозиторій.
//
//   LI_DSN=<li_writer> LI_AUTHOR=andy node enrich-profiles.mjs --max=20
//   ... --dry-run          # показати чергу й нікого не відкривати
//   ... --gap=60,180       # пауза між сторінками, секунди (дефолт саме такий)
//
// ЧОМУ ТАК ОБЕРЕЖНО. Це акаунт живої людини, і кожен перегляд профілю ВИДНО
// тому, кого переглянули («Енді дивився ваш профіль»). LinkedIn не публікує
// лімітів, там поведінкові моделі, тож ризик знижують не числа, а форма: мало,
// поволі, тільки ті, хто сам до нас прийшов, і повний стоп на першому сигналі.
//
// Черга — за інформаційним виграшем (домовлено 2026-09-29):
//   1) підпису немає взагалі   — ми не знаємо про людину нічого;
//   2) підпис без слів про роль — рубрика сказала б «ні» помилково;
//   3) роль є, компанії немає  — не перевірити сегмент і граф адвокатів;
//   4) решта                    — лише якщо залишився бюджет.
// Усередині групи — свіжіша взаємодія першою. Наші автори виключені.
//
// Денний ліміт і правило «не частіше ніж раз на 90 днів» рахуються з таблиці
// enrich.visit, а не з локального файлу: файл можна видалити й порушити ліміт,
// не помітивши.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { parseProfile } from './profile-parse.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..');
const REPO = path.resolve(SKILL, '..', '..', '..');
const require = createRequire(path.join(REPO, 'db/'));
const pg = require('pg');
const { pgConfig, resolveDsn } = await import(new URL('../../../../db/pg-config.mjs', import.meta.url).href);

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`)); if (i < 0) return d; const a = argv[i]; return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const AUTHOR = String(arg('author', process.env.LI_AUTHOR || '')).trim();
const MAX = Math.max(1, Math.min(40, parseInt(arg('max', '20'), 10)));   // 40 — стеля, вище не пускаємо
const DRY = has('dry-run');
const [GAP_LO, GAP_HI] = String(arg('gap', '60,180')).split(',').map((x) => Math.max(5, parseInt(x, 10) || 0));
const NO_TOUCH_DAYS = 90;
// Сесія Browserbase має пережити ВЕСЬ прогін: 20 сторінок по ~2.5 хв із паузами —
// це ~50 хв, а дефолт бекенду 1800 с. Перший прогін (2026-09-29) так і скінчився:
// на 31-й хвилині браузер закрився, три людини пішли в «помилки», а стоп назвав
// це «повторними помилками» і пообіцяв 48 годин тиші — за збій нашого таймера.
process.env.LI_SESSION_TIMEOUT ||= String(Math.max(3600, Math.ceil(MAX * 200)));

if (!AUTHOR) { console.error('enrich-profiles: --author=<slug> (або LI_AUTHOR) обовʼязковий'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (k) => String(k).replace(/^(in\/)(.{3}).*/, '$1$2…');
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// ---------------------------------------------------------------- черга
const ENG = path.join(REPO, 'dashboards', 'li-stats', AUTHOR, 'engagement.json');
if (!fs.existsSync(ENG)) { console.error(`enrich-profiles: немає ${ENG}`); process.exit(2); }
const engagement = JSON.parse(fs.readFileSync(ENG, 'utf8'));
const identity = JSON.parse(fs.readFileSync(path.join(SKILL, 'profiles.json'), 'utf8'));
const OURS = new Set(Object.entries(identity).filter(([k]) => !k.startsWith('_'))
  .map(([, v]) => String(v.profile_slug || '').toLowerCase()));

const ROLE = /\b(ceo|cto|coo|cfo|cio|founder|co-?founder|owner|president|partner|principal|director|head|vp|vice president|chief|manager|lead|engineer|developer|architect|designer|analyst|consultant|recruiter|executive|specialist|scientist|researcher)\b/i;
const HAS_COMPANY = /\s(at|@)\s|\||,/;

const lastSeen = {};
for (const ev of Object.values(engagement.events ?? {})) {
  if (!ev.person_key) continue;
  const d = ev.occurred_at || ev.attributed_week || '';
  if (!lastSeen[ev.person_key] || d > lastSeen[ev.person_key]) lastSeen[ev.person_key] = d;
}
function group(p) {
  const h = String(p.headline ?? '').trim();
  if (!h) return 1;
  if (!ROLE.test(h)) return 2;
  if (!HAS_COMPANY.test(h)) return 3;
  return 4;
}
const queue = Object.values(engagement.people ?? {})
  .filter((p) => String(p.key ?? '').startsWith('in/'))
  .filter((p) => !OURS.has(String(p.key).toLowerCase()))
  .filter((p) => p.profile_url)
  .map((p) => ({ ...p, grp: group(p), last: lastSeen[p.key] || '' }))
  .sort((a, b) => a.grp - b.grp || String(b.last).localeCompare(String(a.last)));

// ---------------------------------------------------------------- база
const client = new pg.Client(pgConfig(resolveDsn(null), { connectionTimeoutMillis: 20000 }));
client.on('error', () => {});
await client.connect();

const todayCount = Number((await client.query(
  `select count(*)::int n from enrich.visit where visited_by = $1 and visited_at >= date_trunc('day', now())`,
  [AUTHOR])).rows[0].n);
const recent = new Set((await client.query(
  `select person_key from enrich.visit where visited_at > now() - ($1 || ' days')::interval and outcome <> 'skipped'`,
  [String(NO_TOUCH_DAYS)])).rows.map((r) => r.person_key));

const budget = Math.max(0, MAX - todayCount);
const due = queue.filter((p) => !recent.has(p.key));
log(`автор ${AUTHOR}: у черзі ${queue.length}, з них не чіпали ${NO_TOUCH_DAYS} днів — ${due.length}`);
log(`сьогодні вже відкрито ${todayCount}, ліміт ${MAX} → беремо ${Math.min(budget, due.length)}`);
log(`групи в черзі: ${[1, 2, 3, 4].map((g) => `${g}:${due.filter((p) => p.grp === g).length}`).join(' ')}`);

if (DRY) {
  for (const p of due.slice(0, budget)) log(`  [dry] група ${p.grp} · ${mask(p.key)} · остання взаємодія ${String(p.last).slice(0, 10) || '—'}`);
  log('dry-run: нікого не відкривав, у базу не писав');
  await client.end();
  process.exit(0);
}
if (!budget) { log('денний ліміт вичерпано — виходжу'); await client.end(); process.exit(0); }

// ---------------------------------------------------------------- браузер
const { openBrowserbaseSession } = await import('./browserbase-backend.mjs');
let { context, release } = await openBrowserbaseSession(AUTHOR);
let opened = 0; let stop = null; let reopened = false;
const counts = { ok: 0, partial: 0, drift: 0, authwall: 0, captcha: 0, error: 0 };

async function record(person, outcome, parsed, note) {
  await client.query(
    `insert into enrich.visit (person_key, visited_by, outcome, note) values ($1,$2,$3,$4)`,
    [person.key, AUTHOR, outcome, note ?? null]);
  if (!parsed || !['ok', 'partial'].includes(outcome)) return;
  await client.query(
    `insert into enrich.profile (person_key, name, headline, location_raw, geo_bucket,
       current_title, current_company, work_history, parse_status, visited_at, visited_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9, now(), $10)
     on conflict (person_key) do update set
       name = coalesce(nullif(excluded.name,''), enrich.profile.name),
       headline = coalesce(nullif(excluded.headline,''), enrich.profile.headline),
       location_raw = coalesce(nullif(excluded.location_raw,''), enrich.profile.location_raw),
       geo_bucket = coalesce(excluded.geo_bucket, enrich.profile.geo_bucket),
       current_title = coalesce(nullif(excluded.current_title,''), enrich.profile.current_title),
       current_company = coalesce(nullif(excluded.current_company,''), enrich.profile.current_company),
       work_history = case when jsonb_array_length(excluded.work_history) > 0
                           then excluded.work_history else enrich.profile.work_history end,
       parse_status = excluded.parse_status,
       visited_at = excluded.visited_at,
       visited_by = excluded.visited_by`,
    [person.key, parsed.name, parsed.headline, parsed.location, parsed.geo_bucket,
      parsed.current_title, parsed.current_company, JSON.stringify(parsed.work_history),
      parsed.parse_status, AUTHOR]);
}

try {
  let page = context.pages()[0] || (await context.newPage());
  for (const person of due.slice(0, budget)) {
    if (stop) break;
    if (opened) {
      const gap = GAP_LO + Math.random() * (GAP_HI - GAP_LO);
      log(`пауза ${Math.round(gap)}с`);
      await sleep(gap * 1000);
    }
    opened++;
    try {
      await page.goto(person.profile_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(4000 + Math.random() * 2000);
      for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 1200); await sleep(1200 + Math.random() * 900); }

      const seen = await page.evaluate(() => ({
        url: location.href,
        wall: /authwall|\/login|checkpoint/.test(location.href),
        captcha: /captcha|are you a human|security verification/i.test(document.body.innerText.slice(0, 4000)),
        mainText: (document.querySelector('main')?.innerText || ''),
        employerNames: Array.from(document.querySelectorAll('main a[href*="/company/"]'))
          .map((a) => (a.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean),
      }));

      if (seen.wall) { counts.authwall++; await record(person, 'authwall', null, 'redirected to authwall'); stop = 'authwall'; break; }
      if (seen.captcha) { counts.captcha++; await record(person, 'captcha', null, 'captcha words on page'); stop = 'captcha'; break; }
      if (!seen.mainText.trim()) { counts.drift++; await record(person, 'drift', null, 'main is empty'); stop = 'empty page'; break; }

      const parsed = parseProfile({ mainText: seen.mainText, employerNames: seen.employerNames });
      counts[parsed.parse_status] = (counts[parsed.parse_status] || 0) + 1;
      await record(person, parsed.parse_status, parsed, null);
      log(`${opened}/${Math.min(budget, due.length)} ${mask(person.key)} → ${parsed.parse_status}`
        + ` · імʼя ${parsed.name ? 'є' : 'нема'} · підпис ${parsed.headline.length} симв`
        + ` · локація ${parsed.geo_bucket ?? '—'} · місць роботи ${parsed.work_history.length}`);
      if (parsed.parse_status === 'drift') { stop = 'parse drift'; break; }
    } catch (e) {
      const note = String(e?.message ?? e).split('\n')[0].slice(0, 120);
      if (/context or browser has been closed|Target closed|has been closed/i.test(note)) {
        // Наш браузер, не LinkedIn: сесія Browserbase дійшла до свого таймауту.
        // Людина сторінки не бачила — це не візит, її беремо наступного разу.
        await record(person, 'skipped', null, 'browser session ended before the page opened');
        if (reopened) { stop = 'browser session ended twice'; break; }
        log('сесія браузера закрилась — відкриваю нову, один раз');
        try {
          await release().catch(() => {});
          ({ context, release } = await openBrowserbaseSession(AUTHOR));
          page = context.pages()[0] || (await context.newPage());
          reopened = true;
          opened--;                      // ця спроба сторінки не відкрила
          due.splice(due.indexOf(person), 1, person);   // лишаємо її в черзі на цей прогін
          continue;
        } catch (e2) {
          stop = 'could not reopen the browser session';
          log(`не вдалося відкрити нову сесію: ${String(e2?.message ?? e2).split('\n')[0].slice(0, 100)}`);
          break;
        }
      }
      counts.error++;
      await record(person, 'error', null, note);
      log(`${mask(person.key)} → помилка: ${note}`);
      if (counts.error >= 3) { stop = 'repeated errors'; break; }
    }
  }
} finally {
  await release();
  log(`відкрито ${opened} · ${Object.entries(counts).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') || 'нічого'}`);
  if (stop) {
    const linkedinSide = /authwall|captcha|empty page|parse drift/.test(stop);
    log(`СТОП: ${stop} — ${linkedinSide
      ? 'це сигнал з боку LinkedIn: далі сьогодні не ходимо, наступна спроба не раніше ніж через 48 годин'
      : 'це наша інфраструктура, не LinkedIn: можна запускати знову, коли зручно'}`);
  }
  await client.end().catch(() => {});
  process.exit(stop && stop !== 'parse drift' ? 1 : 0);
}
