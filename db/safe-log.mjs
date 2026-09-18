// Що можна друкувати в лог, а що ні.
//
// Репозиторій публічний, тож логи CI читає будь-хто. А помилка Postgres — це
// найкоротший шлях персональних даних у лог: `detail` несе сам рядок
// ("Failing row contains (…ім'я, хедлайн, URL…)", "Key (author, person_key)=(…)"),
// `message` — значення, яке не розпарсилось ("invalid input syntax for type
// date: "…""), помилка підключення — хост і користувача з DSN, а SyntaxError від
// JSON.parse у Node 20+ цитує шматок самого файла.
//
// Тому правило одне: у лог іде ФОРМА помилки — SQLSTATE, імена таблиць, колонок,
// обмежень і функцій, — і ніколи не значення. Повний текст — лише з
// --show-values, і лише на локальному терміналі.

// Помилка, текст якої ми написали самі й знаємо, що в ньому немає ні значень, ні
// DSN: лічильники, імена таблиць, ключі авторів (вони й так є іменами тек у репо).
export class SafeError extends Error {}

const SQLSTATE = /^[0-9A-Z]{5}$/;

// Тексти, які кидають самі pg / pg-pool (node_modules/pg/lib/client.js,
// pg-pool/index.js), -> коротка фіксована назва для логу.
const PG_CLIENT_MESSAGES = new Map([
  ["timeout expired", "connection timeout"],
  ["timeout exceeded when trying to connect", "connection timeout"],
  ["Connection terminated due to connection timeout", "connection timeout"],
  ["Connection terminated unexpectedly", "connection terminated unexpectedly"],
  ["Connection terminated", "connection terminated"],
  ["Query read timeout", "query read timeout"],
  ["The server does not support SSL connections", "server does not support SSL"],
  ["There was an error establishing an SSL connection", "SSL handshake error"],
]);

// Частини DSN, які не мають з'являтися в лозі навіть уламками: пароль, хост,
// користувач (у Supabase в ньому код проєкту), ім'я бази.
export function redactor(dsn) {
  const parts = [];
  try {
    const u = new URL(dsn);
    for (const p of [u.password, decodeURIComponent(u.password || ""), u.hostname,
                     u.username, decodeURIComponent(u.username || ""),
                     u.pathname.replace(/^\//, "")]) {
      if (p && p.length >= 3) parts.push(p);
    }
  } catch { /* не URL — нема чого вирізати */ }
  parts.sort((a, b) => b.length - a.length);
  return (text) => {
    let s = String(text ?? "");
    if (dsn) s = s.split(dsn).join("<dsn>");
    for (const p of parts) s = s.split(p).join("<redacted>");
    // адреси, які libpq і Node дописують у дужках чи після хоста
    s = s.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<addr>")
         .replace(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/gi, "<addr>");
    return s;
  };
}

// Рядок для логу. `dsn` потрібен, щоб вирізати його частини з того, що лишилось.
export function safeError(e, { dsn = "", showValues = false } = {}) {
  const red = redactor(dsn);
  if (showValues) {
    return red([e?.message, e?.detail && `detail: ${e.detail}`, e?.where && `where: ${e.where}`]
      .filter(Boolean).join("\n  "));
  }
  // Наш власний текст: DSN у ньому немає за побудовою, а redactor зіпсував би
  // його (локально ім'я ролі збігається з користувачем із DSN).
  if (e instanceof SafeError) return e.message;

  // Помилка сервера Postgres: форма без значень.
  if (e && typeof e.code === "string" && SQLSTATE.test(e.code) && e.severity) {
    const where = String(e.where || "").split("\n")
      .map((l) => l.match(/PL\/pgSQL function ([a-z_.]+)\(/i)?.[1]).filter(Boolean)[0];
    const bits = [
      `SQLSTATE ${e.code}`,
      e.schema && e.table ? `table ${e.schema}.${e.table}` : e.table && `table ${e.table}`,
      e.column && `column ${e.column}`,
      e.constraint && `constraint ${e.constraint}`,
      e.dataType && `type ${e.dataType}`,
      where && `in ${where}`,
      e.routine && `(${e.routine})`,
    ].filter(Boolean);
    // Текст повідомлення — тільки до першого значення: усе після двокрапки з
    // лапками ("…: "value"") і будь-який вміст лапок після user/database/role.
    // Клас 22 (data exception) цитує саме значення де завгодно в тексті
    // ('value "…" is out of range'), тож там лапки вичищаються всі; у класі 23 у
    // лапках лише ідентифікатори, і вони якраз потрібні.
    const msg = String(e.message || "")
      .replace(e.code.startsWith("22") ? /"[^"]*"/g : /$^/, '"<value withheld>"')
      .replace(/:\s*".*$/s, ": <value withheld>")
      .replace(/\b(user|database|role)\s+"[^"]*"/gi, '$1 "<redacted>"')
      .split("\n")[0].slice(0, 200);
    return red(`${bits.join(" · ")} — ${msg}`);
  }

  // Мережа / TLS: код каже все потрібне, а повідомлення несе хост.
  if (e && typeof e.code === "string") {
    return `${e.code}${e.syscall ? ` (${e.syscall})` : ""} — could not reach the database (details withheld)`;
  }

  // Власні повідомлення драйвера `pg` про з'єднання: без коду, зате з ФІКСОВАНИМ
  // текстом, у якому немає ні хоста, ні даних. Саме так виглядає приспаний
  // (paused) проєкт Supabase — TCP приймає, а відповіді немає, — тож ховати це за
  // "message withheld" означало б сховати найчастішу причину понеділкового збою.
  // Порівняння — на точний збіг зі списком, а не regex по чужому тексту.
  const own = PG_CLIENT_MESSAGES.get(String(e?.message ?? ""));
  if (own) return `${own} — could not reach the database (details withheld)`;

  // Усе інше — чуже повідомлення, якому ми не довіряємо.
  return `${e?.name || "Error"} — message withheld (it may quote data); re-run locally with --show-values`;
}
