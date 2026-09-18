#!/usr/bin/env bash
# Резервна копія схем li і dash — одним SQL-файлом.
#
#   LI_BACKUP_DSN=<dsn ролі li_backup> db/backup.sh <out.sql>
#
# DSN береться ТІЛЬКИ з env: в argv його видно в `ps` і в лозі. Сам файл дампа —
# це весь корпус (імена, хедлайни, тексти коментарів): його місце — приватний
# репозиторій, і ніколи не артефакт публічного прогону.
#
# У лог іде лише форма: таблиця -> кількість рядків, розмір файла, sha256.
# Жодного рядка даних, жодної частини DSN (stderr psql/pg_dump проходить через
# redactor у pg-env.mjs).
#
# Коди виходу:
#   0  дамп записано, кількість рядків у ньому збігається з базою
#   2  неправильний виклик / немає LI_BACKUP_DSN / немає psql, pg_dump чи node
#   3  pg_dump МОЛОДШИЙ за сервер (клієнт 16 проти сервера 17) — відмова з поясненням
#   4  pg_dump або psql упав (база лежить, спить, неправильний пароль, TLS)
#   5  дамп порожній або не збігається з базою — це НЕ резервна копія
#
# Кількість рядків рахується З САМОГО ФАЙЛА (рядки між `COPY … FROM stdin;` і
# `\.`), а не запитом до бази: твердження «у копії N рядків» має бути про копію.
# Поруч — те саме число з бази; розбіжність означає, що хтось писав під час дампа.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-}"
if [[ -z "$OUT" || "$OUT" == -* ]]; then
  echo "usage: LI_BACKUP_DSN=<dsn> db/backup.sh <out.sql>" >&2; exit 2
fi
if [[ -z "${LI_BACKUP_DSN:-}" ]]; then
  echo "backup: LI_BACKUP_DSN is not set" >&2; exit 2
fi
for tool in node pg_dump psql; do
  command -v "$tool" >/dev/null 2>&1 || { echo "backup: $tool is not on PATH" >&2; exit 2; }
done

pg() { node "$HERE/pg-env.mjs" LI_BACKUP_DSN -- "$@"; }

# ---- 1. pg_dump не молодший за сервер --------------------------------------
# pg_dump відмовляється дампити сервер новішої мажорної версії, але каже про це
# рядком, у якому легко не побачити причину. Бойовий сервер — Postgres 17, а на
# ubuntu-latest з коробки клієнт 16: це рівно той випадок.
dump_major="$(pg_dump --version | sed -E 's/^[^0-9]*([0-9]+).*/\1/')"
server_num="$(pg psql -X -At -v ON_ERROR_STOP=1 -c 'show server_version_num')" || {
  echo "backup: could not reach the database (see the redacted message above)" >&2; exit 4; }
server_major=$(( server_num / 10000 ))
echo "backup: pg_dump ${dump_major}, server ${server_major}"
if (( dump_major < server_major )); then
  echo "backup: pg_dump ${dump_major} is OLDER than the server (${server_major}) and cannot dump it." >&2
  echo "backup: install postgresql-client-${server_major} (apt.postgresql.org) and put it first on PATH." >&2
  exit 3
fi

# ---- 2. дамп ----------------------------------------------------------------
# У сусідній тимчасовий файл і перейменуванням наприкінці: обірваний дамп не
# повинен лежати під іменем справжнього. umask — бо це персональні дані.
umask 077
TMP="${OUT}.partial.$$"
COUNTS="$(mktemp)"; SRC="$(mktemp)"
trap 'rm -f "$TMP" "$COUNTS" "$SRC"' EXIT
if ! pg pg_dump --schema=li --schema=dash --no-owner --no-privileges --format=plain > "$TMP"; then
  echo "backup: pg_dump failed (see the redacted message above)" >&2; exit 4
fi
grep -q '^-- PostgreSQL database dump complete' "$TMP" || {
  echo "backup: the dump has no completion marker — truncated" >&2; exit 5; }

# ---- 3. що в ньому ----------------------------------------------------------
awk '
  /^COPY [^ ]+ \(.*\) FROM stdin;$/ { t = $2; gsub(/"/, "", t); n[t] = 0; inside = 1; next }
  inside && /^\\\.$/               { inside = 0; next }
  inside                           { n[t]++ }
  END { for (t in n) print t "\t" n[t] }
' "$TMP" | LC_ALL=C sort > "$COUNTS"

pg psql -X -At -F $'\t' -v ON_ERROR_STOP=1 > "$SRC" <<'SQL' || { echo "backup: could not count the source tables" >&2; exit 4; }
select format('select %L, count(*) from %I.%I', schemaname || '.' || tablename, schemaname, tablename)
  from pg_tables where schemaname in ('li','dash') order by 1
\gexec
SQL
LC_ALL=C sort -o "$SRC" "$SRC"

printf '%-34s %10s %10s\n' "table" "in dump" "in source"
total=0; mismatch=0; tables=0
while IFS=$'\t' read -r t src; do
  dumped="$(awk -F'\t' -v t="$t" '$1 == t { print $2 }' "$COUNTS")"
  dumped="${dumped:-MISSING}"
  flag=""; [[ "$dumped" == "$src" ]] || { flag="  <-- DIFFERS"; mismatch=$((mismatch + 1)); }
  printf '%-34s %10s %10s%s\n' "$t" "$dumped" "$src" "$flag"
  [[ "$dumped" == MISSING ]] || total=$((total + dumped))
  tables=$((tables + 1))
done < "$SRC"

views="$(grep -c '^CREATE VIEW dash\.' "$TMP" || true)"
funcs="$(grep -c '^CREATE FUNCTION li\.' "$TMP" || true)"
echo "backup: ${tables} tables, ${total} rows, ${views} dash views, ${funcs} li functions"

# Тихий нуль — фірмова поломка цього репозиторію. Дамп бази, яку щойно скинули
# або яка прокинулась порожньою, технічно «успішний»; резервною копією він не є.
snapshots="$(awk -F'\t' '$1 == "li.account_week" { print $2 }' "$COUNTS")"
if (( total == 0 )) || [[ -z "$snapshots" || "$snapshots" == 0 ]]; then
  echo "backup: the dump holds no account snapshots (li.account_week = ${snapshots:-absent}) — refusing to call this a backup" >&2
  exit 5
fi
if (( mismatch > 0 )); then
  echo "backup: ${mismatch} table(s) differ between the dump and the source — a concurrent write, or a broken dump" >&2
  exit 5
fi

mv "$TMP" "$OUT"
bytes="$(wc -c < "$OUT" | tr -d ' ')"
if command -v sha256sum >/dev/null 2>&1; then sum="$(sha256sum "$OUT" | cut -d' ' -f1)"; else sum="$(shasum -a 256 "$OUT" | cut -d' ' -f1)"; fi
echo "backup: wrote ${bytes} bytes, sha256 ${sum}"
