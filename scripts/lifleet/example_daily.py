"""Приклад щоденного прогону по всіх авторах.

Усе строго послідовно (безкоштовний план Browserbase = 1 одночасна сесія)
з випадковою людською паузою між авторами. Наприкінці друкує готові
команди invite для тих, кого треба перелогінити.

Запуск:
    op run --env-file .env -- python example_daily.py
"""
import random
import sys
import time

from lifleet import SessionDead, author_page, registry


def do_work(slug: str, page) -> None:
    # ЗАГЛУШКА: встав сюди реальну щоденну дію для акаунта.
    # page — це вже залогінений Playwright Page. Наприклад:
    #   page.goto("https://www.linkedin.com/mynetwork/")
    #   ... кліки, читання стрічки, тощо ...
    page.goto("https://www.linkedin.com/feed/")
    print(f"  [{slug}] стрічка відкрита: {page.url}")


def main() -> int:
    slugs = list(registry.load())
    if not slugs:
        print("Реєстр порожній. Спочатку: lifleet add ...")
        return 0

    need_invite = []
    for i, slug in enumerate(slugs):
        if i:
            # Людська пауза між акаунтами — не поспішаємо.
            pause = random.uniform(90, 240)
            print(f"(пауза {pause:.0f} с перед наступним автором)")
            time.sleep(pause)
        try:
            with author_page(slug) as page:
                do_work(slug, page)
            print(f"[ok]   {slug}")
        except SessionDead as exc:
            print(f"[skip] {slug}: {exc}")
            need_invite.append(slug)
        except Exception as exc:  # не даємо одному автору покласти весь прогін
            print(f"[err]  {slug}: {exc}")

    if need_invite:
        print("\nЦим авторам треба перелогінитись:")
        for slug in need_invite:
            print(f"  lifleet invite {slug}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
