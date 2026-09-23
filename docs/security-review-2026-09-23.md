# Ревью безопасности и стабильности перед сдачей — 23.09.2026

> Находки 1–6 и часть LOW исправлены 23.09 (см. журнал коммитов); оставшиеся LOW — в docs/limitations.md

Репозиторий `stavka`, ветка `main`, HEAD `012c577`. Прочитаны целиком: `server/src/api/{auth,routes}.ts`, `server/src/bot/{scenario,texts,updates}.ts`, `server/src/{main,app,config}.ts`, `server/src/db/index.ts`, `server/src/services/{hiring,market,staff,regions,region-digest,inspections,report,pool}.ts`, `server/src/integrations/{http,rmsp,trudvsem,erknm}.ts`, `server/src/scheduler/index.ts`, `server/src/report/pdf.ts`, `Dockerfile`, `compose.yaml`, `deploy/*`, `webapp/src/lib/{api,bridge,state}.ts`, а также `packs/loader.ts` (slug своей должности) и исходники `@maxhub/max-bot-api@0.3.1` (клиент, контекст, обработка ошибок, типы контакта).

Ранее закрытые темы (параметризованный SQL, владение карточками/вакансиями в API, лимит тяжёлых расчётов, длина текстов, дедупликация `bot_started`, случайный `SESSION_SECRET` в режиме `none`) повторно не описываются — проверены только обходы; два обхода найдены (№ 1 и № 2).

Числа в отчёте — замеры: регулярка штата прогнана через реальную `parseStaffLine`, разбор XML — через реальную `parseInspectionsXml` на 20 МБ, размеры таблиц сняты с боевой базы `/srv/stavka/data/stavka.db` (только чтение).

## Находки (по убыванию серьёзности)

### 1. HIGH — неограниченное усиление запросов к госисточникам и рост базы через демо-сессии (обход лимита тяжёлых расчётов)

`server/src/api/routes.ts:184–186` — демо-токен выдаётся любому `POST /api/session` без initData и без ограничения частоты; `:137–146` — `heavyGate` считает попадания по `s.uid`, а у демо-сессии uid случайный на каждую сессию; `:224–242` — `/api/market` и `:210–221` — `/api/profile` под `heavyGate` вообще не стоят. Один `/api/market` с новым `professionText`/регионом — это до 20 страниц «Работы России» (`config.maxVacancyRecords = 2000`, `trudvsem.ts:110–130`), до 60 запросов в реестр МСП (`market.ts:79–94`), строка `vacancy_cache` (на проде средняя 1,07 МБ, максимум 3,7 МБ: 13 строк = 13,6 МБ) и карточка в `cards`, которая для демо тоже сохраняется (`routes.ts:235` не передаёт `persist`, `market.ts:165–167`; на проде 44 из 49 карточек анонимные).

Воспроизведение (снаружи, без MAX):
```
for i in $(seq 1 100); do
  T=$(curl -s -XPOST https://radar.digital-projects.tech/api/session -H 'content-type: application/json' -d '{}' | jq -r .token)
  curl -s -XPOST https://radar.digital-projects.tech/api/market -H "authorization: Bearer $T" -H 'content-type: application/json' \
       -d "{\"regionFnsCode\":\"78\",\"professionText\":\"должность $i $RANDOM\"}" -o /dev/null &
done
```
Результат: ~2 000 запросов к trudvsem и до 6 000 к rmsp, ~100 МБ в базе за один прогон; 429 не возникает ни разу.

Исправление: (1) обернуть `/api/market` и `/api/profile` в `heavyGate`; (2) для демо-сессий ключ лимита — `req.ip` (nginx уже ставит `X-Forwarded-For $remote_addr`, `trustProxy: true` включён; в Docker без nginx лучше `trustProxy: '127.0.0.1'`), плюс лимит на `POST /api/session` по IP (например 10/мин); (3) в `/api/market` передавать `persist: !s.demo`.

### 2. MEDIUM — в боте кнопки `pub:`, `pdf:`, `sub:` работают с чужой карточкой (обход проверки владельца, которая есть в API)

`server/src/bot/scenario.ts:642–654` (`pub:`), `:612–626` (`pdf:`), `:627–636` (`sub:`) берут карточку по id и не сверяют `row.maxUserId` с `uid`; в API та же операция закрыта `ownsCard` (`routes.ts:467–470, 487`). Карточка с полной клавиатурой видна другим: в групповом чате (голосование в группе — задуманный сценарий, `texts.ts:122`), по `/start card_<id>` (`scenario.ts:759`) и `bot_started` с `card_` (`:559`), `sendCardById` (`:536–541`) показывает все кнопки. Вакансия создаётся с `employerName = result.profile?.name` владельца карточки (`:475`), а `maxUserId` — нажавшего.

Воспроизведение: владелец получает карточку по своему ИНН в групповом чате → другой участник жмёт «Опубликовать на …» → создаётся вакансия «Работодатель: <компания владельца>» с диплинком, отклики и телефоны кандидатов уходят участнику, у владельца в «Мои вакансии» её нет. Кнопка «Прислать PDF-отчёт» из того же чата отправляет PDF с ИНН и названием бизнеса владельца в любой чат.

Исправление (перед `pub:`, `pdf:`, `sub:`, 1 строка): `if (row.maxUserId != null && row.maxUserId !== uid) { await ack('Карточка принадлежит другому пользователю'); return; }`. Голосование `vote:` оставить общим.

### 3. MEDIUM — зависание реестра МСП растягивает одну карточку до ~7,5 минут

`server/src/services/market.ts:79–94` — `enrichEmployers` обогащает до 60 ИНН шестью воркерами и не прекращает после первого таймаута; `integrations/rmsp.ts:85` — `timeoutMs: 15_000, retries: 2` → 45 с на ИНН при молчании источника. 60 / 6 × 45 с = 450 с, что больше `proxy_read_timeout 300s` (`deploy/nginx.conf:32`): мини-приложение получает 504, бот — «Считаю…» без продолжения. При HTTP 502 всё быстро (retryable, backoff 0,5 + 1 с), проблема именно в таймаутах.

Воспроизведение: на стенде `iptables -I OUTPUT -d rmsp.nalog.ru -j DROP` (или `127.0.0.2 rmsp.nalog.ru` в hosts) и `/api/market` по новой профессии в новом регионе.

Исправление: в `enrichEmployers` после первой ошибки с таймаутом ставить флаг `sourceDown = true` и остальным ИНН отдавать кэш/`null` без запроса; для обогащения вызывать `fetchJson` с `timeoutMs: 5_000, retries: 0` (для профиля пользователя оставить как есть).

### 4. MEDIUM — при остановке процесса незавершённые события бота теряются безвозвратно

`server/src/main.ts:67–76` — `shutdown` делает `app.close()` → `db.close()` → `exit(0)`, но задачи из `bot/updates.ts:50–51` (`setImmediate(() => dispatchUpdate(...))` после ответа 200) никто не ждёт. Ключ уже записан в `updates_seen` (`updates.ts:26`), MAX получил 200 — повторной доставки не будет. `deploy/deploy.sh:29` перезапускает службу на каждом релизе.

Воспроизведение: отправить боту `/stavka` и в ту же секунду `sudo systemctl restart stavka` → в журнале `update handler failed … database is not open`, пользователь остаётся без ответа.

Исправление: счётчик `inFlight` в `updates.ts` (`++` перед `dispatchUpdate`, `--` в `finally`), в `shutdown` перед `db.close()` — `await` пока `inFlight === 0` (с потолком 10 с).

### 5. MEDIUM — данные растут без очистки; VACUUM основной базы нет

`server/src/db/index.ts:210–213` — `vacancy_cache` только `INSERT OR REPLACE`, строки никогда не удаляются (боевая база: средняя строка 1,07 МБ); `:280–283` — `cards` без удаления (44 из 49 на проде — анонимные демо/прогрев); `:216–225` — `vacancy_seen` растёт на каждую новую вакансию (5 770 строк за день); `services/report.ts:35–40` и `services/hiring.ts:124–130` пишут PDF и PNG в `DATA_DIR/reports`, `DATA_DIR/qr` и не удаляют; `deploy/backup.sh` делает `VACUUM INTO` копии, основная база (88 МБ + WAL 8 МБ) не сжимается. В сочетании с № 1 диск заполняется извне.

Воспроизведение: `du -sh /srv/stavka/data` до и после десятка `/api/market` по новым запросам.

Исправление: в планировщик суточную задачу: `DELETE FROM vacancy_cache WHERE fetched_at < ?` (7 дней), `DELETE FROM cards WHERE max_user_id IS NULL AND created_at < ?` (1 день), удаление файлов `reports/`, `qr/` старше 7 дней; при `openDb` — `PRAGMA auto_vacuum = INCREMENTAL` и после чистки `PRAGMA incremental_vacuum`.

### 6. MEDIUM — свободный текст должности в боте не ограничен по длине (в API — 120 символов)

`server/src/bot/scenario.ts:811` (шаг «должность»), `:838` (`regions_prof`), `:887` (свободная реплика) передают полный текст сообщения в `resolveProfession` (`packs/loader.ts:204–215`, `query = raw`), API режет до 120 (`routes.ts:112`). Далее: `texts.ts:240` собирает «Должности «<весь текст>» нет…» → сообщение > 4 000 → MAX API отклоняет → `dispatchUpdate` ловит ошибку, пользователь не получает ничего; при «Считать по «…»» текст уходит в `?text=` (`trudvsem.ts:103`) — URL ~36 КБ → 414 → «Портал не ответил»; текст сохраняется в `users.state` (`scenario.ts:201–205`, до 20 × 4 КБ на пользователя).

Воспроизведение: `/stavka` → шаг «должность» → прислать 3 900 символов, где есть слово «повар».

Исправление: в `handleProfessionText` и `regions_prof` — `const text = raw.slice(0, 120).trim()`; в `professionSuggestText` — `query.slice(0, 80)`.

### 7. LOW — устаревшие callback `exp:`/`sch:` переключают отклик на другую вакансию и дают дублировать отклики; `retry:` без проверки числа

`server/src/bot/scenario.ts:683–700` — `applyTarget(uid, vacancyId)` берёт id из payload и пишет его в состояние; проверка «уже откликался» есть только в `apply:` (`:671`). `:599` — `retry:<v>` → `Number(v)` без диапазона (в API диапазон 1 000…5 000 000, `routes.ts:231`): `retry:abc` → `offer = NaN` → карточка с «NaN ₽» (`core/market.ts:155–166`; в БД NaN ложится как NULL).

Воспроизведение: завершить отклик → нажать старую кнопку «Без опыта» в предыдущем сообщении → «Да, готов» → сумма → «Без номера» → второй отклик; работодателю уходит повторное уведомление (`:520`).

Исправление: в `exp:` и `sch:` — `if (findResponseByCandidate(db, vacancy.id, uid)) { await ack('Вы уже откликнулись'); return; }`; в `retry:` — `const offer = Number(v); if (v !== 'none' && !(offer >= 1000 && offer <= 5_000_000)) { await ack('Ставка вне диапазона'); return; }`.

### 8. LOW — контакт без `vcf_info` роняет обработчик, кандидат зависает на шаге «номер»

`server/src/bot/scenario.ts:741–742` — `payload.vcf_info` без проверки → `phoneFromVcf(undefined)` → `TypeError` в `services/hiring.ts:152` (`vcfInfo.replace`). SDK сам допускает отсутствие поля (`@maxhub/max-bot-api/dist/core/context.js:216`: `if (!contact?.payload.vcf_info) return undefined`).

Воспроизведение: на шаге «Поделитесь номером» переслать боту чужой контакт из адресной книги MAX (не кнопку «Поделиться номером»). В журнале `update handler failed`, ответа нет, состояние остаётся `apply_phone`.

Исправление: `const vcf = payload.vcf_info ?? ''; if (!vcf) { await ctx.reply('Нужна кнопка «Поделиться номером» — или «Без номера».', { attachments: [T.phoneKeyboard(vacancy.id)] }); return; }`.

### 9. LOW — вызовы MAX Bot API без таймаута

Клиент SDK передаёт `signal` только если он задан (`node_modules/@maxhub/max-bot-api/dist/core/network/api/client.js:42–47`), код его не задаёт: `routes.ts:262, 511, 517`, `scenario.ts:195, 285`, `hiring.ts:205`, `report.ts:41, 49`. Единственный предел — 300 с undici. В polling-режиме `updates.ts:86` ждёт `dispatchUpdate` последовательно, так что один зависший вызов останавливает приём событий на 5 минут.

Воспроизведение: `iptables -I OUTPUT -d platform-api2.max.ru -j DROP` → `POST /api/cards/:id/report` висит до 504 nginx.

Исправление: во все `extra` передавать `signal: AbortSignal.timeout(20_000)` (SDK принимает `signal` в `extra` у `sendMessage*`/`upload*`); проще всего — обёртка `withTimeout(fn)` в `sendToUser` и `sendReportToChat`.

### 10. LOW — общий лимит MAX 30 rps не соблюдается при массовых уведомлениях

`services/hiring.ts:185–199` — `throttleByChat` держит паузу только внутри одного получателя; `routes.ts:584–587` и `:598–601` (нанять/закрыть) шлют всем откликнувшимся подряд без пауз, `scheduler/index.ts:77` пишет напрямую. SDK повторяет только `attachment.not.ready`, 429 не повторяет (`dist/core/network/api/modules/messages/api.js:27–46`).

Воспроизведение: вакансия с 40 откликами → «Закрыть» → 40 `sendMessageToUser` меньше чем за секунду → часть 429 → «Вакансия закрыта» не доставлено (`catch(() => undefined)`).

Исправление: в `throttleByChat` добавить второй, общий ключ (`0`) с интервалом 50 мс (20 rps) и прогонять через него все отправки, включая планировщик.

### 11. LOW — `markUpdateSeen` любую ошибку БД считает дубликатом события

`server/src/db/index.ts:451–458` — `catch { return false; }` → `updates.ts:26` пишет «duplicate update skipped» уровнем info. При `SQLITE_FULL`/`SQLITE_IOERR` бот молча теряет все события без единой ошибки в журнале.

Воспроизведение: заполнить раздел с `DATA_DIR` (`fallocate -l …`) и написать боту.

Исправление: `catch (e) { if ((e as { errcode?: number }).errcode === 1555) return false; throw e; }` — `errcode 1555` (`SQLITE_CONSTRAINT_PRIMARYKEY`) проверен на node:sqlite 24.

### 12. LOW — часовая проверка подписок может наложиться сама на себя

`server/src/scheduler/index.ts:26–30` — `every` это `setInterval` без флага «уже идёт»; `:55–83` обходит подписки последовательно с `forceRefresh` (≈30–40 с на подписку при 6–11 с на страницу), `lastCheckedAt` ставится после расчёта. Если к сроку подошли больше ~90 подписок (созданы в один день недели), обход длится дольше часа, второй запуск пересчитывает те же подписки → двойные уведомления и двойная нагрузка на источник. В `syncInspections` защита есть (`inspections.ts:32, 46`), здесь нет.

Исправление: `let busy = false; … if (busy) return; busy = true; try { … } finally { busy = false; }` внутри задачи подписок (или в `every`).

### 13. LOW — ИНН попадает в журнал вопреки `docs/architecture.md:97` («персональные данные не логируются»)

`server/src/app.ts:36` — логгер Fastify пишет `req.url` каждого запроса, а ИНН передаётся в query: `GET /api/inspections?inn=…` (`routes.ts:352`), туда же попадает `q=` подсказок; `services/market.ts:48–50` — `warn({ inn, err })`. ИНН ИП — персональные данные.

Воспроизведение: `journalctl -u stavka | grep 'inn='`.

Исправление: `inn` в `/api/inspections` принимать в теле POST (или `serializers.req` с обрезкой query), в `market.ts` логировать `inn.slice(0, 4) + '…'`.

### 14. LOW — нет защитных HTTP-заголовков

`server/src/app.ts:35–39` без `@fastify/helmet`, `deploy/nginx.conf:21` добавляет только HSTS: `curl -sI https://radar.digital-projects.tech/app/` не содержит `X-Content-Type-Options`, `Referrer-Policy`, `Content-Security-Policy`. Мини-приложение живёт в webview/iframe MAX, поэтому `X-Frame-Options: DENY` ставить нельзя.

Исправление (nginx, в `server { … 443 }`): `add_header X-Content-Type-Options nosniff always; add_header Referrer-Policy strict-origin-when-cross-origin always; add_header Content-Security-Policy "default-src 'self'; img-src 'self' data:; frame-ancestors https://max.ru https://*.max.ru" always;` — предварительно проверить, что сборка webapp не тянет внешние шрифты/скрипты.

### 15. LOW — старт без доступа к MAX API кладёт весь сервис, включая мини-приложение

`server/src/main.ts:16–27` — в режимах `webhook`/`polling` ошибка `getMyInfo` → `throw` → `exit 1`; `deploy/stavka.service:17` `Restart=always` и `compose.yaml:17` `restart: unless-stopped` дают бесконечный перезапуск, `/api/health` и `/app/` тоже недоступны, хотя от MAX API они не зависят.

Воспроизведение: закрыть `platform-api2.max.ru` (hosts/iptables) и перезапустить службу — цикл рестартов каждые 5 с.

Исправление: при ошибке не бросать, а поднимать HTTP сразу и повторять `getMyInfo` в фоне с backoff (5, 10, 30 с), регистрируя бота и вебхук по первому успеху.

### 16. LOW — разбор архива ЕРКНМ блокирует event loop

`server/src/integrations/erknm.ts:195–212` — синхронный `fast-xml-parser`, `services/inspections.ts:86–115` вызывает его в основном потоке. Замер на реальной функции: XML 20 МБ (максимальный файл набора) → 0,56 с непрерывной блокировки; в архиве 809 файлов, поэтому первые минуты после старта и раз в неделю (`scheduler/index.ts:98–99`) API и вебхук отвечают с задержками до полусекунды.

Исправление: в `readDataset` после каждого файла `await setImmediate()` из `node:timers/promises`, а внутри `parseInspectionsXml` резать по 500 блоков `INSPECTION` с тем же `yield`; радикально — вынести `syncInspections` в `worker_threads`.

### 17. LOW — `parseStaffLine` квадратичен по длине строки

`server/src/bot/scenario.ts:114` — в регулярке `[\d\s]*` и следующий `\s*` пересекаются. Замер через реальную функцию: строка 4 000 символов «1 1 1 … .1 x» → 150 мс синхронно на одно сообщение (спасает сжатие пробелов в `:112`; без него те же входы дают 20+ с). Поток таких сообщений в шаге «штат» занимает CPU единственного процесса.

Исправление: в начале `parseStaffLine` — `if (t.length > 200) return null;`.

## Проверено — замечаний нет

- `validateInitData` (`auth.ts:29–58`): окно `auth_date` ±1 ч, `hash` обязателен и ровно один, сравнение через `timingSafeEqual`, значения декодируются до подписи; повтор initData в течение часа выдаёт новые сессии — это ожидаемо, initData нигде не логируется и передаётся в теле POST.
- Сессия (`auth.ts:72–90`): HMAC-SHA256 по base64url-телу, `exp` 12 ч, `uid` демо < 0 подделать без секрета нельзя; `SESSION_SECRET` в боевых режимах обязателен и не короче 16 символов (`config.ts:57–59`).
- Вебхук (`updates.ts:36–53`): путь `sha256(токен)[:32]`, секрет обязателен в режиме webhook (`config.ts:60`), сравнение за постоянное время, чужим — 404, ответ 200 после проверки, исключения обработчика не влияют на ответ, идемпотентность по `update_type:timestamp:mid|callback_id`.
- Телефоны кандидатов: отдаются только владельцу вакансии (`routes.ts:533–548`, 403 остальным), подпись контакта — HMAC по токену с `timingSafeEqual` (`hiring.ts:137–148`), чужой/поддельный контакт сохраняется как `phone_verified = 0` и так и помечается работодателю; телефон и имя в журнал не пишутся.
- Файлы: имена PDF/QR — из UUID и slug `[a-z0-9-]` (`loader.ts:169–174`), traversal невозможен; статика отдаёт только `webapp/dist` под `/app/` (`app.ts:49`), `DATA_DIR` наружу не смотрит.
- Образ и стенд: `.env` не в git и не в образе (`.dockerignore`), контейнер от `node`, `/data` принадлежит ему; systemd с `MemoryMax`, `NoNewPrivileges`, `PrivateTmp`; приложение слушает `127.0.0.1`, наружу — только nginx с HTTPS/HSTS; healthcheck на `/api/health`; сборка в один этап `npm ci` + `prune`, чистая сборка ~1 мин.
- Ввод бота: сообщения режутся по 4 000 с паузой 600 мс (`splitText`, `replyLong`), числа с пробелами и «тыс» разбираются, эмодзи/RTL проходят через `normalizeText`; `vacclose:`/`unsub:` проверяют владельца в SQL; команды в группе не ломают состояние (chat_id группы не перезаписывает диалог).

## Что уже хорошо (для слайда про безопасность)

1. Подпись initData проверяется по официальному алгоритму MAX (HMAC-SHA256 с ключом `WebAppData`), окно `auth_date` — час, сравнение за постоянное время; `initDataUnsafe` на сервере не используется.
2. Сессии мини-приложения — подписанные HMAC-токены на 12 часов; демо-режим вне MAX (uid < 0) не может писать в чат, публиковать вакансии и видеть отклики.
3. Вебхук: путь из sha256 токена, секрет `X-Max-Bot-Api-Secret` обязателен и сверяется за постоянное время (чужим — 404), события идемпотентны (`updates_seen`), обработка идёт после ответа 200.
4. Персональные данные кандидата: номер только по кнопке MAX с проверкой HMAC-подписи контакта (флаг `phone_verified`), виден только владельцу вакансии (403 остальным); все запросы к SQLite параметризованы, идентификаторы — UUID v4.
5. Эксплуатация: секреты только в `.env` вне git и образа, контейнер и служба без привилегий (`node`, `NoNewPrivileges`, `MemoryMax`), HTTPS + HSTS, healthcheck, суточный `VACUUM INTO`-бэкап, лимиты 6/мин и 4 параллельных на тяжёлые расчёты с честными 429/503.
