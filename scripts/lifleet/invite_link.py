"""Згенерувати живе invite-посилання (Live View) для автора.

На відміну від `lifleet invite`, не блокується на input() — просто піднімає
keep_alive сесію на сторінці входу, друкує посилання і виходить, лишаючи
сесію живою (keep_alive тримає її до api_timeout). Автор відкриває лінк,
логіниться сам. Запис вимкнено; автосолвер капчі вимкнено (розв'язує людина).

Сам рецепт сесії переїхав у lifleet/invite.py, бо його викликає ще й
щоденний монітор (session_report.py). Тут лишився тонкий CLI: ті самі
аргументи, ті самі рядки на виході — операторський воркфлоу не змінився.

Запуск: python invite_link.py <slug> [хвилини]
"""
import sys

from lifleet import browser, registry
from lifleet.invite import mint_invite


def main() -> int:
    slug = sys.argv[1] if len(sys.argv) > 1 else "peter"
    # Історичний дефолт саме цього скрипта — 30, а не 20 як у `lifleet invite`.
    # Не чіпаємо: команда, яку люди тримають в історії терміналу, має робити
    # рівно те саме, що робила вчора.
    minutes = int(sys.argv[2]) if len(sys.argv) > 2 else 30

    bb = browser.get_client()
    rec = registry.get(slug)
    # Створення context живе ТІЛЬКИ тут, у ручному шляху оператора. mint_invite
    # на автора без context_id кидає NoContext — щоб CI не «розпаузив» мовчки
    # того, кого свідомо не логінили.
    if not rec.get("context_id"):
        ctx = bb.contexts.create(
            name=f"lifleet-{slug}", project_id=browser.get_project_id()
        )
        registry.patch(slug, context_id=ctx.id)
        print("NEW_CONTEXT:", ctx.id)

    link = mint_invite(slug, minutes, bb=bb)
    print("AUTHOR:", link["name"])
    print("MINUTES:", link["minutes"])
    print("SESSION_ID:", link["session_id"])
    print("LIVEVIEW_URL:", link["liveview_url"])
    # Сесію не релізимо і не закриваємо — mint_invite свідомо цього не робить:
    # keep_alive тримає сесію живою, щоб автор устиг залогінитись, і вона сама
    # завершиться за api_timeout.
    return 0


# Гард не косметичний: до рефакторингу slug читався на рівні модуля, тож
# простий `import invite_link` мовчки піднімав платну keep_alive сесію.
if __name__ == "__main__":
    raise SystemExit(main())
