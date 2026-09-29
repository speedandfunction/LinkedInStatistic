#!/usr/bin/env node
// Парсер сторінки людини — перевірка на вигаданих сторінках тієї ж ФОРМИ, що й
// справжня (знято наживо 2026-09-29): дублювання майже кожного рядка для
// скрінрідерів, ім'я першим рядком, довгий підпис, коротка локація, досвід під
// заголовком Experience із рядком-періодом на кожен запис.
//
// Жодного реального профілю тут немає і бути не може: файл лежить у ПУБЛІЧНОМУ
// репозиторії, а сторінка людини — це її дані, не наші.
//
//   node .claude/skills/linkedin-stats/fast/test-profile-parse.mjs

import assert from 'node:assert/strict';
import { parseProfile, parseHead, parseExperience, normalizeLines, geoBucket } from './profile-parse.mjs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (err) { console.error(`FAIL ${name}\n     ${err.message}`); process.exitCode = 1; }
};

// LinkedIn дублює рядки — фікстура теж, інакше вона перевіряла б не те.
const dup = (...lines) => lines.flatMap((l) => (l === '' ? [''] : [l, l])).join('\n');

const FULL = dup(
  'Test Person',
  '',
  '1st degree connection',
  '',
  'Head of Platform at Invented Foundation · building things that must not fall over',
  '',
  'Greater Boston',
  '',
  '500+ connections',
  '',
  'About',
  'Something about themselves that we deliberately do not store.',
  '',
  'Experience',
  'Head of Platform',
  'Invented Foundation',
  'Jan 2023 - Present · 3 yrs 9 mos',
  'Boston, Massachusetts',
  'Engineering Manager',
  'Imaginary Health Co',
  'Mar 2019 - Dec 2022 · 3 yrs 10 mos',
  'Senior Engineer',
  'Nowhere Systems',
  'Jun 2015 - Feb 2019 · 3 yrs 9 mos',
  '',
  'Education',
  'University of Nowhere',
);

test('дублі рядків прибираються, порожні теж', () => {
  const lines = normalizeLines(FULL);
  assert.equal(lines[0], 'Test Person');
  assert.ok(!lines.some((l, i) => l === lines[i + 1]), 'сусідніх повторів не лишилось');
  assert.ok(!lines.includes(''), 'порожніх рядків не лишилось');
});

test('голова: імʼя, підпис, локація', () => {
  const h = parseHead(normalizeLines(FULL));
  assert.equal(h.name, 'Test Person');
  assert.match(h.headline, /^Head of Platform at Invented Foundation/);
  assert.equal(h.location, 'Greater Boston');
});

test('лічильник звʼязків не плутається з локацією', () => {
  const lines = normalizeLines(dup('Test Person', '', 'A headline long enough to be one', '', '900 followers', '', 'Kyiv, Ukraine'));
  assert.equal(parseHead(lines).location, 'Kyiv, Ukraine');
});

test('досвід: три місця, посада й компанія не переплутані', () => {
  const work = parseExperience(normalizeLines(FULL), ['Invented Foundation', 'Imaginary Health Co', 'Nowhere Systems']);
  assert.equal(work.length, 3);
  assert.deepEqual(work[0], { title: 'Head of Platform', company: 'Invented Foundation', dates: 'Jan 2023 - Present · 3 yrs 9 mos' });
  assert.equal(work[1].company, 'Imaginary Health Co');
  assert.equal(work[2].title, 'Senior Engineer');
});

test('досвід зупиняється на наступному заголовку, а не з\'їдає освіту', () => {
  const work = parseExperience(normalizeLines(FULL));
  assert.ok(work.every((w) => !/University/.test(`${w.title} ${w.company}`)), 'освіта не потрапила в досвід');
});

test('не більше пʼяти місць', () => {
  const many = dup('P', '', 'A headline long enough to count', '', 'Experience',
    ...Array.from({ length: 8 }, (_, i) => [`Title ${i}`, `Company ${i}`, `Jan 201${i} - Dec 201${i} · 1 yr`]).flat());
  assert.equal(parseExperience(normalizeLines(many)).length, 5);
});

test('тип зайнятості не стає компанією', () => {
  const lines = normalizeLines(dup('P', '', 'A headline long enough to count', '', 'Experience',
    'Staff Engineer', 'Full-time', 'Feb 2020 - Present · 6 yrs'));
  const w = parseExperience(lines);
  assert.equal(w[0].title, 'Staff Engineer');
  assert.equal(w[0].company, '', 'краще порожнє поле, ніж «Full-time» як роботодавець');
});

test('географія: дзеркало geo_classify.py — метро без країни це США', () => {
  assert.equal(geoBucket('Greater Boston'), 'US');
  assert.equal(geoBucket('Boston, Massachusetts, United States'), 'US');
  assert.equal(geoBucket('Kyiv, Ukraine'), 'TEAM');
  assert.equal(geoBucket('Bengaluru, India'), 'ANTI');
  assert.equal(geoBucket('Shanghai, China'), 'ANTI');
  assert.equal(geoBucket('Berlin, Germany'), 'OTHER');
  assert.equal(geoBucket(''), null, 'порожня локація — не здогадка, а null');
});

test('статус: ok / partial / drift', () => {
  assert.equal(parseProfile({ mainText: FULL }).parse_status, 'ok');
  // Сторінка відкрилась, але з неї нічого не читається — це зміна верстки,
  // і саме на цьому прогін мусить зупинитись, а не зібрати 18 порожніх рядків.
  assert.equal(parseProfile({ mainText: '\n\n\n' }).parse_status, 'drift');
  assert.equal(parseProfile({ mainText: dup('Test Person') }).parse_status, 'partial');
});

test('усе разом: поточне місце роботи береться з верхнього запису', () => {
  const r = parseProfile({ mainText: FULL, employerNames: ['Invented Foundation'] });
  assert.equal(r.current_title, 'Head of Platform');
  assert.equal(r.current_company, 'Invented Foundation');
  assert.equal(r.geo_bucket, 'US');
  assert.equal(r.work_history.length, 3);
});

console.log(`\n${passed} passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
