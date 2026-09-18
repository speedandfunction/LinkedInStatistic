#!/usr/bin/env bash
# Навчальне відновлення: резервна копія, яку ніхто не відновлював, — не копія.
#
#   LI_DRILL_DSN=<dsn сервера, де можна створити базу>  \
#   LI_BACKUP_DSN=<dsn джерела, ролі li_backup досить>  \
#   db/restore-drill.sh <dump.sql> [--verify] [--keep]
#
# Що робить:
#   1. створює ТИМЧАСОВУ базу li_restore_drill_<час>_<pid> на сервері з LI_DRILL_DSN
#      (це НЕ бойовий сервер: локальний контейнер або одноразовий Postgres у CI);
#   2. відновлює в неї дамп через psql з ON_ERROR_STOP — будь-яка помилка
#      відновлення валить навчання, а не ховається в середині виводу;
#   3. рахує рядки в кожній таблиці відновленої бази і джерела та порівнює;
#      звіряє кількість dash-в'юх і li-функцій; читає КОЖНУ dash-в'юху — схема,
#      яка відновилась, але не виконується, теж не відновлення;
#   4. з --verify — проганяє db/verify.mjs ПРОТИ ВІДНОВЛЕНОЇ бази: побайтовий
#      паритет відновленого з JSON у робочому дереві. Це найсильніше з тверджень
#      («з цієї копії можна зібрати ті самі дашборди»), але воно правдиве лише
#      коли дерево відповідає моменту дампа, тому не ввімкнене за замовчуванням;
#   5. видаляє тимчасову базу (--keep лишає).
#
# Без LI_BACKUP_DSN порівнювати нема з чим: тоді звіряється лише внутрішня
# цілісність (кількість рядків у дампі проти відновленого) — і про це сказано вголос.
#
# У лог — лише імена таблиць і числа. Сервер відновлення має бути НЕ старший за
# pg_dump, яким знято копію: дамп від 17-го клієнта містить `SET transaction_timeout`,
# якого Postgres 16 не знає.
#
# Коди виходу: 0 збіглося · 1 розбіжність · 2 неправильний виклик · 4 відновлення впало
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DUMP=""; KEEP=0; VERIFY=0
for a in "$@"; do
  case "$a" in
    --keep) KEEP=1 ;;
    --verify) VERIFY=1 ;;
    -*) echo "restore-drill: unknown flag $a" >&2; exit 2 ;;
    *) DUMP="$a" ;;
  esac
done
if [[ -z "$DUMP" || ! -s "$DUMP" ]]; then
  echo "usage: LI_DRILL_DSN=<dsn> [LI_BACKUP_DSN=<dsn>] db/restore-drill.sh <dump.sql> [--verify] [--keep]" >&2; exit 2
fi
if [[ -z "${LI_DRILL_DSN:-}" ]]; then
  echo "restore-drill: LI_DRILL_DSN is not set (a server where a scratch database may be created)" >&2; exit 2
fi
for tool in node psql; do
  command -v "$tool" >/dev/null 2>&1 || { echo "restore-drill: '$tool' is not on PATH" >&2; exit 2; }
done

DB="li_restore_drill_$(date -u +%Y%m%d%H%M%S)_$$"
admin()   { node "$HERE/pg-env.mjs" LI_DRILL_DSN -- "$@"; }
scratch() { node "$HERE/pg-env.mjs" LI_DRILL_DSN --db "$DB" -- "$@"; }
source_() { node "$HERE/pg-env.mjs" LI_BACKUP_DSN -- "$@"; }

COUNT_SQL="$(cat <<'SQL'
select format('select %L, count(*) from %I.%I', schemaname || '.' || tablename, schemaname, tablename)
  from pg_tables where schemaname in ('li','dash') order by 1
\gexec
SQL
)"
SHAPE_SQL="select (select count(*) from pg_views where schemaname='dash'), (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='li')"

RESTORED="$(mktemp)"; SRC="$(mktemp)"; INDUMP="$(mktemp)"
cleanup() {
  rm -f "$RESTORED" "$SRC" "$INDUMP"
  if (( KEEP )); then echo "restore-drill: kept scratch database ${DB}"
  else admin psql -X -q -v ON_ERROR_STOP=1 -c "drop database if exists ${DB} with (force)" >/dev/null || echo "restore-drill: could not drop ${DB}" >&2; fi
}
trap cleanup EXIT

echo "restore-drill: dump $(wc -c < "$DUMP" | tr -d ' ') bytes -> scratch database ${DB}"
admin psql -X -q -v ON_ERROR_STOP=1 -c "create database ${DB}" || { echo "restore-drill: could not create the scratch database" >&2; exit 4; }

# ---- відновлення ------------------------------------------------------------
if ! scratch psql -X -q -v ON_ERROR_STOP=1 -f - < "$DUMP" >/dev/null; then
  echo "restore-drill: RESTORE FAILED (see the redacted message above)" >&2; exit 4
fi
echo "restore-drill: restored without errors"

# ---- числа ------------------------------------------------------------------
scratch psql -X -At -F $'\t' -v ON_ERROR_STOP=1 <<<"$COUNT_SQL" | LC_ALL=C sort > "$RESTORED"
awk '
  /^COPY [^ ]+ \(.*\) FROM stdin;$/ { t = $2; gsub(/"/, "", t); n[t] = 0; inside = 1; next }
  inside && /^\\\.$/               { inside = 0; next }
  inside                           { n[t]++ }
  END { for (t in n) print t "\t" n[t] }
' "$DUMP" | LC_ALL=C sort > "$INDUMP"

against="source"
if [[ -n "${LI_BACKUP_DSN:-}" ]]; then
  source_ psql -X -At -F $'\t' -v ON_ERROR_STOP=1 <<<"$COUNT_SQL" | LC_ALL=C sort > "$SRC" \
    || { echo "restore-drill: could not count the source tables" >&2; exit 4; }
  src_shape="$(source_ psql -X -At -F ' ' -v ON_ERROR_STOP=1 -c "$SHAPE_SQL")"
else
  echo "restore-drill: LI_BACKUP_DSN is not set — comparing against the DUMP's own row counts, NOT against the live source" >&2
  cp "$INDUMP" "$SRC"; against="dump"; src_shape=""
fi

printf '%-34s %10s %10s\n' "table" "$against" "restored"
bad=0; total=0; tables=0
while IFS=$'\t' read -r t want; do
  got="$(awk -F'\t' -v t="$t" '$1 == t { print $2 }' "$RESTORED")"; got="${got:-MISSING}"
  flag=""; [[ "$got" == "$want" ]] || { flag="  <-- DIFFERS"; bad=$((bad + 1)); }
  printf '%-34s %10s %10s%s\n' "$t" "$want" "$got" "$flag"
  [[ "$got" == MISSING ]] || total=$((total + got)); tables=$((tables + 1))
done < "$SRC"
# таблиця, що є у відновленій базі, але не в джерелі, — теж розбіжність
extra="$(LC_ALL=C join -t $'\t' -v 2 "$SRC" "$RESTORED" | wc -l | tr -d ' ')"
(( extra == 0 )) || { echo "restore-drill: ${extra} table(s) exist only in the restored database" >&2; bad=$((bad + extra)); }

# ---- форма: в'юхи й функції, і чи вони живі ---------------------------------
got_shape="$(scratch psql -X -At -F ' ' -v ON_ERROR_STOP=1 -c "$SHAPE_SQL")"
echo "restore-drill: restored ${got_shape%% *} dash views and ${got_shape##* } li functions${src_shape:+ (source: ${src_shape%% *} and ${src_shape##* })}"
if [[ -n "$src_shape" && "$src_shape" != "$got_shape" ]]; then
  echo "restore-drill: the number of views/functions differs from the source" >&2; bad=$((bad + 1))
fi
broken="$(scratch psql -X -At -v ON_ERROR_STOP=0 2>&1 >/dev/null <<'SQL' | grep -c 'ERROR' || true
select format('select count(*) from (select * from dash.%I limit 1) x', viewname) from pg_views where schemaname = 'dash' order by 1
\gexec
SQL
)"
if (( broken > 0 )); then echo "restore-drill: ${broken} dash view(s) do not execute in the restored database" >&2; bad=$((bad + broken))
else echo "restore-drill: every dash view executes in the restored database"; fi
published="$(scratch psql -X -At -v ON_ERROR_STOP=1 -c 'select count(*) from dash.published_week')"
echo "restore-drill: ${tables} tables, ${total} rows, ${published} published week(s) visible through dash"

if (( VERIFY )); then
  # DSN тимчасової бази збирається в env дочірнього процесу — не в argv.
  if LI_DSN="$(DB="$DB" node -e 'const u = new URL(process.env.LI_DRILL_DSN); u.pathname = "/" + process.env.DB; process.stdout.write(u.toString())')" \
     node "$HERE/verify.mjs" > /dev/null; then
    echo "restore-drill: verify.mjs against the RESTORED database: byte-identical with the JSON in this tree"
  else
    echo "restore-drill: verify.mjs against the restored database did not pass (exit $?)" >&2; bad=$((bad + 1))
  fi
fi

if (( bad > 0 )); then echo "restore-drill: FAILED — ${bad} difference(s)" >&2; exit 1; fi
if (( total == 0 )); then echo "restore-drill: FAILED — the restored database is empty" >&2; exit 1; fi
echo "restore-drill: OK — the dump restores, and every table matches the ${against}"
