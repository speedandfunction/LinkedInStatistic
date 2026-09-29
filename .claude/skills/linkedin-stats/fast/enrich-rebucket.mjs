#!/usr/bin/env node
// Перерахунок географії в уже зібраних профілях — без повторного відкриття сторінок.
//
// Кошик (US / TEAM / ANTI / OTHER / NULL) пише парсер у момент візиту. Коли правило
// парсера змінюється, старі рядки лишаються зі старим кошиком. Цей скрипт бере
// enrich.profile.location_raw, рахує кошик ПОТОЧНИМ правилом (profile-parse.mjs,
// geoBucket) і виправляє рядки, де він відрізняється.
//
//   LI_DSN="$LI_WRITER_DATABASE_URL" node enrich-rebucket.mjs            # лише показати
//   LI_DSN="$LI_WRITER_DATABASE_URL" node enrich-rebucket.mjs --apply    # записати
//
// У stdout — тільки лічильники «з кошика → у кошик». Жодного імені чи локації:
// вивід потрапляє в чат і в логи, а це дані людей.

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { geoBucket } from './profile-parse.mjs';

const APPLY = process.argv.includes('--apply');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = path.resolve(HERE, '../../../../db') + path.sep;

/** Чиста частина: що зміниться. rows = [{ person_key, location_raw, geo_bucket }]. */
export function planRebucket(rows) {
  const changes = [];
  for (const r of rows) {
    const next = geoBucket(r.location_raw);
    if ((r.geo_bucket ?? null) !== next) changes.push({ person_key: r.person_key, from: r.geo_bucket ?? null, to: next });
  }
  return changes;
}

export function summarize(changes) {
  const by = new Map();
  for (const c of changes) {
    const k = `${c.from ?? 'unknown'} → ${c.to ?? 'unknown'}`;
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  return [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pg = createRequire(DB)('pg');
  const { pgConfig, resolveDsn } = await import(pathToFileURL(DB + 'pg-config.mjs'));
  const client = new pg.Client(pgConfig(resolveDsn(null)));
  client.on('error', () => {});
  await client.connect();
  try {
    const { rows } = await client.query('select person_key, location_raw, geo_bucket from enrich.profile');
    const changes = planRebucket(rows);
    console.log(`профілів: ${rows.length} · зміниться: ${changes.length}`);
    for (const [k, n] of summarize(changes)) console.log(`  ${k.padEnd(20)} ${n}`);
    if (!changes.length) { console.log('усе вже відповідає поточному правилу.'); }
    else if (!APPLY) { console.log('нічого не записано (запусти з --apply).'); }
    else {
      await client.query('begin');
      for (const c of changes)
        await client.query('update enrich.profile set geo_bucket = $2 where person_key = $1', [c.person_key, c.to]);
      await client.query('commit');
      console.log(`записано: ${changes.length}`);
    }
  } catch (err) {
    await client.query('rollback').catch(() => {});
    console.error(`помилка: ${err.code ?? ''} ${String(err.message).split('\n')[0]}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}
