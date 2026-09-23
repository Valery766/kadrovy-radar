# Соответствие требованиям кейса: требование → где реализовано

| Требование (стр. ТЗ) | Реализация | Где смотреть |
|---|---|---|
| Чат-бот + мини-приложение в MAX, мини-приложение подключено к боту (стр. 7) | бот `@t796_hakaton_max_bot`, мини-приложение `/app/`, кнопки `open_app` и диплинк `?startapp=card_<id>` | `server/src/bot/`, `webapp/`, `server/src/services/report.ts` |
| Сценарий доступен в мобильной и веб-версии (стр. 7) | в мини-приложении не используются DeviceStorage/shareContent; состояние на сервере; проверено в web.max.ru | `webapp/src/lib/bridge.ts`, README §14 |
| Выданный токен, секреты не в репозитории (стр. 7) | токен только в `.env`; `.env.example` без значений; проверка истории git | `.env.example`, `.gitignore`, README §5–6 |
| Реальные интеграции, модельные помечены (стр. 7, 18) | «Работа России» и реестр МСП — живые; словари пакетов помечены как переменная часть | README §9, `server/src/integrations/` |
| Происхождение и дата данных видны пользователю (стр. 18) | бейдж «источник · получено» в чате, мини-приложении и PDF; блок «Источники и метод» | `server/src/bot/texts.ts`, `webapp/src/screens/Card.tsx`, `server/src/report/pdf.ts` |
| Факты / расчёты / рекомендации разделены (стр. 18) | карточка: факты (выборка), расчёт (медиана, перцентиль), рекомендация (варианты ставки), допущения | `docs/limitations.md`, `server/src/core/verdict.ts` |
| Ограничения генеративного ИИ (стр. 18) | генеративные модели не используются; ядро детерминированное | README «Роль ИИ», `server/src/core/` |
| Ядро и переменная часть (стр. 19) | `server/src/core` без знаний о регионах; `packs/*.yaml`; выбор пакета по профилю | `docs/architecture.md`, `packs/README.md`, `server/src/packs/loader.ts` |
| README из 15 пунктов, одна команда Docker, ≤ 5 мин (стр. 9) | README §1–15; `docker compose up --build` ≈ 1 мин | `README.md`, `Dockerfile`, `compose.yaml` |
| Файл зависимостей, Dockerfile, compose, .dockerignore, .env.example (стр. 9) | `package-lock.json`, закреплённый digest базового образа | корень репозитория |
| Презентация PDF, служебный первый слайд (стр. 10) | сборщик `tools/build_deck.py`, план `docs/presentation-plan.md` | `out/stavka-presentation.pdf` |
| Стабильность и обработка ошибок (стр. 13) | «Повторить» без перезапуска, кэш при недоступности, идемпотентность вебхука, сторож подписки | `server/src/bot/scenario.ts`, `server/src/services/market.ts`, `server/src/scheduler/index.ts` |
| Безопасность (стр. 13) | HMAC initData, секрет вебхука (constant-time), UUID v4, редактирование секретов в логах | `server/src/api/auth.ts`, `server/src/bot/updates.ts` |
| Платформенный бонус (стр. 13) | PDF → uploads → messages → mid → `shareMaxContent`; диплинк с восстановлением карточки; голосование; подписка | README §2, `webapp/src/screens/Card.tsx`, `server/src/services/report.ts` |
| Метрики эффекта (стр. 17) | метрики пилота и наблюдение за закрытием вакансий | README §13, `server/src/db/index.ts: closureStats` |
