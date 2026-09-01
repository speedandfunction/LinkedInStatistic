// Browserbase-бекенд для скрапера: замість локального Chrome піднімає хмарну
// сесію на персистентному context автора (керується інструментом lifleet) і
// віддає CDP-контекст Playwright. Вмикається через LI_BACKEND=browserbase.
//
// Джерело context_id — реєстр lifleet (authors.json). Куки/логін живуть у
// самому Browserbase context; тут ми лише піднімаємо сесію на ньому.
//
// persist:true обов'язковий (інакше оновлені куки не пишуться назад у context).
// На free plan проксі недоступні (402) — тоді працюємо без них (сесія
// нестабільна на датацентр-IP; для стабільного скрапу потрібен платний план).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const API = 'https://api.browserbase.com/v1';
const REGIONS = ['us-west-2', 'us-east-1', 'eu-central-1', 'ap-southeast-1'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function authorsPath() {
  // Папка lifleet — база для відносних шляхів реєстру.
  const lifleetDir = path.resolve(__dirname, '../../../../scripts/lifleet');
  const override = process.env.LIFLEET_AUTHORS || process.env.LIFLEET_REGISTRY;
  if (override) {
    // Абсолютний беремо як є; відносний (напр. "./authors.json" з lifleet .env)
    // резолвимо відносно папки lifleet, а не cwd скрапера.
    return path.isAbsolute(override) ? override : path.resolve(lifleetDir, override);
  }
  return path.join(lifleetDir, 'authors.json');
}

function loadAuthor(slug) {
  const p = authorsPath();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`не читається реєстр lifleet (${p}): ${e.message}`);
  }
  const rec = data[slug];
  if (!rec) throw new Error(`автора '${slug}' немає в реєстрі ${p}`);
  if (!rec.context_id) {
    throw new Error(`у '${slug}' немає context_id — спочатку залогінь його: lifleet import ${slug} <cookies.json>`);
  }
  return rec;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`не задано ${name} (додай у .env і source перед запуском)`);
  return v;
}

async function createSession(apiKey, body) {
  const res = await fetch(`${API}/sessions`, {
    method: 'POST',
    headers: { 'X-BB-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Browserbase ${res.status}: ${text}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return JSON.parse(text);
}

// Піднімає сесію на context автора і повертає { context, release }.
// context — Playwright BrowserContext, сумісний із тим, що дає
// launchPersistentContext (newPage / on / route / browser / close).
export async function openBrowserbaseSession(slug) {
  const apiKey = requireEnv('BROWSERBASE_API_KEY');
  const projectId = requireEnv('BROWSERBASE_PROJECT_ID');
  const rec = loadAuthor(slug);
  const region = REGIONS.includes(rec.region) ? rec.region : 'eu-central-1';
  const country = rec.country || 'UA';

  const base = {
    projectId,
    browserSettings: {
      context: { id: rec.context_id, persist: true },
      solveCaptchas: true,
      recordSession: true,
    },
    keepAlive: true,
    region,
    timeout: Number(process.env.LI_SESSION_TIMEOUT || 1800), // скрап довший за probe
    userMetadata: { author: slug, kind: 'scrape' },
  };

  let session;
  const proxiesOff = ['off', '0', 'false', 'no'].includes(
    String(process.env.LIFLEET_PROXIES || 'on').toLowerCase());
  if (!proxiesOff) {
    try {
      session = await createSession(apiKey, {
        ...base,
        proxies: [{ type: 'browserbase', geolocation: { country } }],
      });
    } catch (e) {
      const proxyPayment = e.status === 402 && /prox/i.test(e.body || '');
      if (!proxyPayment) throw e;
      console.log('[bb] план без проксі — працюю без них (сесія нестабільна на датацентр-IP; для стабільного скрапу потрібен платний план)');
    }
  }
  if (!session) session = await createSession(apiKey, base);

  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0] || (await browser.newContext());

  const release = async () => {
    try { await browser.close(); } catch { /* best-effort */ }
    try {
      await fetch(`${API}/sessions/${session.id}`, {
        method: 'POST',
        headers: { 'X-BB-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, status: 'REQUEST_RELEASE' }),
      });
    } catch { /* best-effort — висячу сесію можна звільнити в дашборді */ }
  };

  console.log(`[bb] сесія ${session.id} на context ${rec.context_id} (${slug}, ${region})`);
  return { context, release, sessionId: session.id };
}
