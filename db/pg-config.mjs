// Один спосіб зібрати конфіг підключення для всього db/.
//
// Навіщо окремий файл. Драйвер `pg` трактує sslmode=require як verify-full, а
// пулер Supabase підписаний власним коренем ("Supabase Root 2021 CA"), якого
// немає в довіреному сховищі Node — тож голий connectionString падав із
// SELF_SIGNED_CERT_IN_CHAIN. Вимкнути перевірку (rejectUnauthorized:false) —
// означає шифрувати, не знаючи з ким: у базі персональні дані й тижневі зрізи,
// які неможливо зібрати повторно. Тому корінь лежить поруч у certs/ і
// перевірка лишається ПОВНОЮ: і ланцюг, і ім'я хоста.
//
// certs/supabase-root-2021.crt — публічний сертифікат, не секрет. Узятий з
// офіційного бакета Supabase окремим TLS-каналом; його SHA-256
// (80:70:25:AD:…:E6:CA:FA) звірено з коренем, який пред'являє сам сервер.
// Дійсний до 2031-04-26 — після ротації з'єднання почне падати гучно, а не
// тихо деградує, і це правильна поведінка.
//
// Конфіг повертається БЕЗ connectionString навмисно: pg розбирає рядок після
// об'єднання опцій, і sslmode з рядка перетер би наш ssl-об'єкт.
import fs from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { parse } = require("pg-connection-string");

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPABASE_CA = join(HERE, "certs", "supabase-root-2021.crt");
const isSupabase = (host) => /\.supabase\.(com|co)$/i.test(String(host || ""));

export function pgConfig(dsn, extra = {}) {
  const url = new URL(dsn);
  const explicitCa = url.searchParams.get("sslrootcert");
  const sslmode = url.searchParams.get("sslmode");
  // Розбір лишаємо бібліотеці (percent-encoding пароля, options тощо), але
  // sslmode прибираємо: рішення про TLS ухвалюється нижче, явно.
  url.searchParams.delete("sslmode");
  url.searchParams.delete("sslrootcert");
  const cfg = parse(url.toString());
  delete cfg.ssl;

  if (explicitCa) {
    cfg.ssl = { ca: fs.readFileSync(explicitCa, "utf8"), rejectUnauthorized: true };
  } else if (isSupabase(cfg.host)) {
    cfg.ssl = { ca: fs.readFileSync(SUPABASE_CA, "utf8"), rejectUnauthorized: true };
  } else if (sslmode && sslmode !== "disable") {
    // Інший хост із вимогою TLS: системне сховище довіри, повна перевірка.
    cfg.ssl = { rejectUnauthorized: true };
  }
  return { ...cfg, ...extra };
}
