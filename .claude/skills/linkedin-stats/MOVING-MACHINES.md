# Переїзд на іншу машину (або на сервер)

**Спершу головне: щотижневий збір уже не на твоїй машині.** Він живе в GitHub
Actions (`linkedin-stats-weekly.yml`, понеділок 00:00 UTC) разом зі своїми
секретами, і переїзд ноутбука його не зачіпає. Переносити треба тільки
**операторську** частину: заливку дашбордів, ручні перевірки, логін акаунтів.

---

## 1. Що скопіювати (цього немає в git — і не має бути)

| Файл | Що всередині | Якщо загубити |
|---|---|---|
| `.env` | Grafana (адреса, токен, uid джерела й папки), п'ять DSN бази | видається наново; паролі ролей є в секретах GitHub |
| `scripts/lifleet/.env` | `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, регіон | новий ключ у дашборді Browserbase |
| `scripts/lifleet/authors.json` | реєстр: slug автора → `context_id` хмарного профілю | **найдорожче.** Зв'язок із профілями зникає, і всіх авторів доведеться логінити наново |

Форми файлів: `.env.example`, `scripts/lifleet/.env.example`,
`scripts/lifleet/authors.example.json`. Значення в них навмисно фальшиві.

**Логіни LinkedIn переносити НЕ потрібно.** Куки живуть у хмарі Browserbase,
прив'язані до `context_id`, а не до машини. Тому після переїзду ніхто не мусить
перелогінюватись — за умови, що `authors.json` (або секрет
`LIFLEET_AUTHORS_JSON`) на місці. Резервна копія реєстру — саме цей секрет:
`gh secret list` покаже, що він є, а витягти його звідти не можна, тому тримай
копію ще й у менеджері паролів.

**Як передавати.** Не месенджером і не поштою. Або менеджер паролів і руками
створити файли на новій машині, або — краще — **видати нові ключі саме для
неї**: окремий сервісний акаунт Grafana і окремий ключ Browserbase. Тоді старі
лишаються там, де були, і в разі чого відкликається лише один.

## 2. Що встановити

```bash
git clone https://github.com/speedandfunction/LinkedInStatistic.git
cd LinkedInStatistic
(cd .claude/skills/linkedin-stats/fast && npm install)   # playwright-core
(cd db && npm install)                                   # pg
python3 -m venv scripts/lifleet/.venv
scripts/lifleet/.venv/bin/pip install -e scripts/lifleet # browserbase, playwright
gh auth login                                            # гілки, PR-и, секрети
```

Node 22. Docker — лише якщо хочеш ганяти локальні тести бази
(`db/test-roles.mjs`, `restore-drill.sh`); для щоденної роботи не потрібен.

## 3. Перевірка після переїзду

Усі чотири команди **лише читають** — жодна нічого не змінює.

```bash
cd ~/LinkedInStatistic && set -a && . ./.env && set +a

# 1. реєстр акаунтів на місці (без мережі, без витрат Browserbase).
#    Шлях до реєстру — відносний до поточної теки (LIFLEET_REGISTRY, дефолт
#    ./authors.json), тож або зайди в теку, або назви його явно. Запущена з
#    кореня без цього команда чесно скаже «Реєстр порожній» — і це НЕ втрата
#    реєстру, а не та тека. Перевір `ls -l scripts/lifleet/authors.json`
#    перш ніж когось перелогінювати.
(cd scripts/lifleet && .venv/bin/python -m lifleet list)

# 2. база відповідає і сходиться з JSON байт-у-байт (роль li_sync)
LI_DSN="$LI_SYNC_DATABASE_URL" node db/verify.mjs

# 3. кожна панель кожного дашборда дає той самий кадр (роль grafana_ro —
#    саме та, якою ходить Grafana)
LI_DSN="$LI_GRAFANA_RO_DATABASE_URL" node db/verify-panels.mjs --baseline caf2834

# 4. токен Grafana і uid джерела живі (нічого не пушить)
node .github/scripts/push-dashboard.mjs --uid linkedin-page \
  --file dashboards/grafana/linkedin-page.json --dry-run
```

Що очікувати: `list` покаже рядок на автора зі статусом (`live` / `new`) і
`context_id`; `verify.mjs` —
`all feeds byte-identical`; `verify-panels.mjs` — `0 problem(s)`; `--dry-run` —
`dry run — nothing pushed` (а якщо uid не заданий, він відмовиться, і це теж
відповідь). Витратна перевірка, яка справді ходить у LinkedIn, — окремо:
`python -m lifleet check` (їсть хвилини Browserbase).

## 4. Чого на сервері не буде

- **Збір сторінки компанії** (`fast/page/scrape-page.mjs`) — потрібен справжній
  локальний Chrome із профілем і перехоплення завантаження XLS. На сервері без
  графіки не працює; лишається ручним кроком на робочій машині.
- **Класифікація ICP** (`fast/classify-icp.mjs`) — кличе локальний `claude` з
  твоїм логіном. На сервері без нього всі люди рахуються як `normal`.

## 5. Якщо переносиш САМ збір на свій сервер

Спитай себе, навіщо: зараз його безкоштовно робить GitHub, з логами, PR-ами й
повідомленнями в Slack. Якщо все ж треба, знадобиться:

- ті самі значення як змінні оточення (`BROWSERBASE_*`, `LIFLEET_AUTHORS` або
  `LIFLEET_REGISTRY`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, `SLACK_PEOPLE_JSON`,
  `LI_SYNC_DATABASE_URL`, `GRAFANA_*`);
- запуск на автора: `LI_BACKEND=browserbase LI_AUTHOR=<slug> node
  .claude/skills/linkedin-stats/fast/scrape-weekly.mjs --deadline-secs=1500`;
- планувальник (cron/systemd) і **щось, що помітить, коли прогін не стартував** —
  у GitHub це видно в Actions, на своєму сервері тишу ніхто не побачить;
- а далі те саме, що робить воркфлоу: коміт, PR, мердж, `pages-deploy`,
  синхронізація бази. Простіше лишити це в Actions, а на сервер віддати
  щось одне.

Деталі кожного секрета — у `WEEKLY-CADENCE.md` §4 (таблиця змінних) і §9 (база).
