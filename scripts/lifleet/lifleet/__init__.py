"""lifleet — керування пулом LinkedIn-акаунтів через Browserbase Contexts.

Модель: один автор = один context_id = один персистентний профіль браузера
в хмарі Browserbase. Автор логіниться сам через Live View посилання;
пароль і пошта ніколи не потрапляють ні в чат, ні на диск, ні в env.

Публічний API для щоденних скриптів:

    from lifleet import author_page, SessionDead

    with author_page("alex") as page:
        page.goto("https://www.linkedin.com/feed/")
"""
from .browser import MissingCredentials, SessionDead, author_page

__all__ = ["author_page", "SessionDead", "MissingCredentials"]
__version__ = "0.1.0"
