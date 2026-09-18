#!/usr/bin/env node
// Запустити psql / pg_dump з підключенням із DSN — так, щоб DSN не потрапив ні в
// argv, ні в лог.
//
//   node db/pg-env.mjs <ENV_VAR_WITH_DSN> [--db <name>] -- <command> [args...]
//
// Навіщо окремий файл. libpq-інструментам DSN можна дати двома шляхами, і обидва
// погані: аргументом (`pg_dump "$DSN"`) — тоді пароль видно в `ps` усім на
// машині; або розібрати URL у bash — і зламатися на першому ж паролі з `@` чи
// `%`. Тому DSN розбирає та сама бібліотека, що й у решті db/, а дочірній процес
// отримує його частинами через PG*-змінні середовища, яких у списку процесів не
// видно.
//
// TLS — як у pg-config.mjs, тільки мовою libpq: для хостів *.supabase.com
// ставиться PGSSLMODE=verify-full і PGSSLROOTCERT=db/certs/supabase-root-2021.crt,
// тобто перевіряються і ланцюг, і ім'я хоста. `sslmode=require` тут було б
// «шифруємо, не знаючи з ким»: libpq з require сертифікат не перевіряє взагалі.
//
// stderr дочірнього процесу проходить через redactor: libpq у повідомленні про
// невдале підключення друкує хост, IP і користувача (у Supabase в імені
// користувача зашитий код проєкту), а логи цього репозиторію публічні.
// stdout не чіпається — туди pg_dump пише сам дамп.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactor } from "./safe-log.mjs";

const require = createRequire(import.meta.url);
const { parse } = require("pg-connection-string");
const HERE = dirname(fileURLToPath(import.meta.url));
const SUPABASE_CA = join(HERE, "certs", "supabase-root-2021.crt");
const isSupabase = (host) => /\.supabase\.(com|co)$/i.test(String(host || ""));

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const envName = argv[0];
if (!envName || sep < 1 || sep === argv.length - 1) {
  console.error("usage: pg-env.mjs <ENV_VAR_WITH_DSN> [--db <name>] -- <command> [args...]");
  process.exit(2);
}
const dbAt = argv.indexOf("--db");
const dbOverride = dbAt > 0 && dbAt < sep ? argv[dbAt + 1] : null;
const dsn = process.env[envName];
if (!dsn) { console.error(`${envName} is not set`); process.exit(2); }

let cfg, url;
try { url = new URL(dsn); cfg = parse(dsn); }
catch { console.error(`${envName} is not a valid connection URL (value withheld)`); process.exit(2); }

const env = { ...process.env };
// Нічого зі спадку: ні чужий PGPASSWORD, ні PGSERVICE не повинні підмішатися.
for (const k of Object.keys(env)) if (/^PG[A-Z]+$/.test(k)) delete env[k];
delete env[envName];                       // дочірньому процесу сам DSN не потрібен
env.PGHOST = cfg.host || "localhost";
env.PGPORT = String(cfg.port || 5432);
if (cfg.user) env.PGUSER = cfg.user;
if (cfg.password) env.PGPASSWORD = cfg.password;
env.PGDATABASE = dbOverride || cfg.database || "postgres";
env.PGCONNECT_TIMEOUT = "20";
env.PGAPPNAME = "li-backup";
if (cfg.options) env.PGOPTIONS = cfg.options;

const explicitCa = url.searchParams.get("sslrootcert");
const sslmode = url.searchParams.get("sslmode");
if (explicitCa) { env.PGSSLMODE = "verify-full"; env.PGSSLROOTCERT = explicitCa; }
else if (isSupabase(cfg.host)) { env.PGSSLMODE = "verify-full"; env.PGSSLROOTCERT = SUPABASE_CA; }
else if (sslmode && sslmode !== "disable") { env.PGSSLMODE = "verify-full"; env.PGSSLROOTCERT = "system"; }

const red = redactor(dsn);
const child = spawn(argv[sep + 1], argv.slice(sep + 2), { env, stdio: ["inherit", "inherit", "pipe"] });
let tail = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  const lines = (tail + chunk).split("\n");
  tail = lines.pop();
  for (const l of lines) process.stderr.write(`${red(l)}\n`);
});
child.on("error", (e) => { console.error(`cannot run ${argv[sep + 1]}: ${e.code || e.name}`); process.exit(127); });
child.on("close", (code, signal) => {
  if (tail) process.stderr.write(`${red(tail)}\n`);
  process.exit(signal ? 1 : code ?? 1);
});
