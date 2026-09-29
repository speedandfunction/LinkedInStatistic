// Розбір сторінки людини на поля — чиста функція, без браузера.
//
// Верстка профілю на наших акаунтах — та сама обфускована, що й у стрічці
// активності (знято наживо 2026-09-29): НЕМА `h1`, нема `data-view-name`, нема
// `.pv-text-details__left-panel`, нема `#experience`. Є 443 елементи з
// `componentkey` і осмислений `innerText` у `main`. Тому парсер працює з ТЕКСТОМ
// плюс списком посилань на компанії — це те, що переживає зміну класів.
//
// LinkedIn дублює майже кожен рядок для скрінрідерів (502 дублі з 768 рядків на
// знятій сторінці), тож перший крок — прибрати сусідні повтори. Без цього будь-яка
// логіка «рядок над датою = посада» ловить не той рядок.
//
// Свідомо НЕ витягуємо: «Про себе», освіту, контакти, фото, кількість зв'язків.

export const HEADINGS = [
  'About', 'Activity', 'Experience', 'Education', 'Licenses & certifications', 'Licenses',
  'Skills', 'Volunteering', 'Publications', 'Projects', 'Courses', 'Languages',
  'Recommendations', 'Interests', 'Causes', 'Honors', 'Test scores', 'Organizations',
];
const HEADING_RE = new RegExp(`^(${HEADINGS.map((h) => h.replace(/[&]/g, '\\&')).join('|')})\\b`, 'i');
// "2021 - Present · 4 yrs 2 mos", "Jan 2019 - Dec 2021", "2019 - 2021"
const DATE_RE = /((19|20)\d{2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(19|20)\d{2})\s*[-–—]\s*(present|now|((19|20)\d{2})|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(19|20)\d{2})/i;
const COUNT_RE = /^\d[\d,\s]*\s*(followers?|connections?|mutual)/i;
// Хром сторінки, який не є ні підписом, ні локацією. Ступінь зв'язку окремо:
// рядок «1st degree connection» довший за 20 символів і без цього ставав
// «підписом» — саме так і сталося на першій фікстурі.
const NOISE_RE = /^(message|connect|follow(ing)?|more|open to.*|show all.*|see all.*|contact info|mutual connections?|·|\s*)$/i;
const DEGREE_RE = /^(\d+(st|nd|rd|th))([\s·-]*(degree)?[\s·-]*(connection)?)?$/i;

/** Прибрати сусідні повтори і порожні рядки. */
export function normalizeLines(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const l = raw.replace(/\s+/g, ' ').trim();
    if (!l) continue;
    if (out.length && out[out.length - 1] === l) continue;
    out.push(l);
  }
  return out;
}

/**
 * Голова сторінки: ім'я, підпис, локація.
 * Порядок на знятій сторінці: ім'я (рядок 0), підпис (перший довгий), локація
 * (короткий рядок після підпису, що не є лічильником). Локація буває відсутня.
 */
export function parseHead(lines) {
  const name = lines[0] && !HEADING_RE.test(lines[0]) && !COUNT_RE.test(lines[0]) ? lines[0] : '';
  let headline = '';
  let iHeadline = -1;
  for (let i = 1; i < Math.min(lines.length, 12); i++) {
    const l = lines[i];
    if (HEADING_RE.test(l) || COUNT_RE.test(l) || NOISE_RE.test(l) || DEGREE_RE.test(l)) continue;
    if (l.length >= 20) { headline = l; iHeadline = i; break; }
  }
  let location = '';
  for (let i = iHeadline + 1; i < Math.min(lines.length, iHeadline + 6); i++) {
    const l = lines[i];
    if (!l || HEADING_RE.test(l)) break;
    if (COUNT_RE.test(l) || NOISE_RE.test(l) || DEGREE_RE.test(l)) continue;
    // Локація коротка і без крапки в кінці; "Contact info" уже відсіяно.
    if (l.length <= 60 && !/[.!?]$/.test(l)) { location = l; break; }
  }
  return { name, headline, location };
}

/**
 * Досвід: від заголовка Experience до наступного відомого заголовка. Записи
 * розділяє рядок із періодом; посада і компанія — два рядки над ним у якомусь
 * порядку, тому беремо обидва і не вгадуємо, який саме що, коли неясно:
 * компанією вважаємо той, що збігається з видимою назвою роботодавця
 * (anchors), інакше — рядок, що ближче до дати.
 */
export function parseExperience(lines, employerNames = []) {
  const start = lines.findIndex((l) => /^experience\b/i.test(l));
  if (start < 0) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i]) && !/^experience\b/i.test(lines[i])) { end = i; break; }
  }
  const block = lines.slice(start + 1, end);
  const known = new Set(employerNames.map((x) => String(x).toLowerCase().trim()).filter(Boolean));

  const out = [];
  for (let i = 0; i < block.length; i++) {
    if (!DATE_RE.test(block[i])) continue;
    const dates = block[i];
    const above = [block[i - 2], block[i - 1]].filter((x) => x && !DATE_RE.test(x) && !NOISE_RE.test(x));
    let title = '';
    let company = '';
    if (above.length === 2) {
      const [a, b] = above;
      if (known.has(b.toLowerCase())) { title = a; company = b; }
      else if (known.has(a.toLowerCase())) { title = b; company = a; }
      else { title = a; company = b; }           // порядок на знятій сторінці: посада, потім компанія
    } else if (above.length === 1) {
      if (known.has(above[0].toLowerCase())) company = above[0]; else title = above[0];
    }
    // "Full-time", "Part-time" тощо чіпляються до компанії через "·"
    company = company.replace(/\s*·\s*(full|part)-time.*$/i, '').trim();
    // Захисники від типових промахів: тип зайнятості замість компанії, той самий
    // рядок в обох полях, службові слова. Краще порожнє поле, ніж вигадане.
    if (/^(full|part)-time$|^(self|freelance|contract|internship|temporary)\b/i.test(company)) company = '';
    if (title && company && title === company) company = '';
    if (title || company) out.push({ title, company, dates });
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * US / TEAM / ANTI / OTHER — ДЗЕРКАЛО fast/page/geo_classify.py, рядок у рядок.
 * Той файл уже рахує географію для дашборда сторінки компанії, і два різні
 * правила дали б дві різні відповіді про ту саму людину.
 *
 * Правило LinkedIn: метро США пишеться БЕЗ країни ("Greater Boston"), у решти
 * світу останній токен — країна ("Kyiv, Ukraine"). Тому: немає коми — США.
 */
const COUNTRY_BUCKET = { ukraine: 'TEAM', india: 'ANTI', china: 'ANTI' };
export function countryOf(loc) {
  const parts = String(loc ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return 'United States';
  return parts[parts.length - 1];
}
export function geoBucket(location) {
  if (!String(location ?? '').trim()) return null;   // порожнє — не здогадка, а «не знаємо»
  const c = countryOf(location).toLowerCase();
  if (['united states', 'usa', 'us'].includes(c)) return 'US';
  return COUNTRY_BUCKET[c] ?? 'OTHER';
}

/**
 * Усе разом. `status`:
 *   ok      — є ім'я і (підпис або досвід)
 *   partial — щось знайшли, але не голову
 *   drift   — сторінка відкрилась, а не знайшли нічого: це зміна верстки
 */
export function parseProfile({ mainText, employerNames = [] } = {}) {
  const lines = normalizeLines(mainText);
  const head = parseHead(lines);
  const work = parseExperience(lines, employerNames);
  const status = head.name && (head.headline || work.length) ? 'ok'
    : (head.name || head.headline || work.length) ? 'partial' : 'drift';
  return {
    ...head,
    geo_bucket: geoBucket(head.location),
    current_title: work[0]?.title || '',
    current_company: work[0]?.company || '',
    work_history: work,
    parse_status: status,
    lines: lines.length,
  };
}
