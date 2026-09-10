# Модуль API Interception

## Назначение

Модуль выполняет пассивное локальное наблюдение за ограниченными metadata браузерных ресурсов. Priority 2 — observation-only основа; Priority 3 добавляет внутренний candidate-only MIME decision layer и по-прежнему не доказывает вредоносность ресурса.

## Текущий статус

- Background metadata pipeline Priority 2 и внутренний candidate checkpoint Priority 3 реализованы; модуль по умолчанию остаётся выключенным.
- Наблюдение работает только для foreground-вкладки сфокусированного окна и только после активации.
- Выведенный content-side DOM-stub `ApiInterceptor.js` временно изолирован до Chrome migration gate; `js/content.js` его не загружает и не использует как snapshot source.
- Локальный Priority 4 suite пройден 2026-07-20. Ручная Chrome smoke-проверка, pilot outcome и любая product projection остаются pending.

## Runtime-компоненты

- `ApiInterceptor.js` — изолированный legacy DOM-stub до требуемой Chrome migration validation; у него нет runtime owner или snapshot role.
- `runtime/apiMetadataNormalization.js` — pure bounded-нормализация request method, response status и declared MIME metadata.
- `runtime/ApiResourceObserver.js` — background-owned lifecycle listeners, эфемерное request state, bounded queue и aggregate observation state.
- `decision/apiMimeDecision.js` — pure allowlisted candidate decision для document/script MIME, declared image response.
- `runtime/ApiFindingState.js` — bounded candidate aggregation для категорий `document` и `script`.

`ApiResourceObserver` предоставляет background runtime внутренние методы `activate(context)`, `pause(revision)`, `destroy()` и `getObservationState()`. Browser event handlers остаются внутренними.

## Scope наблюдения

- Resource types: только `xmlhttprequest` и `image`.
- Только main frame одной активной foreground-вкладки.
- Non-blocking события `webRequest`: `onBeforeRequest`, `onHeadersReceived`, `onBeforeRedirect`, `onCompleted` и `onErrorOccurred`.
- `Content-Type` response читается только для извлечения одного bounded normalized MIME. Проверяются первые 64 headers; raw value длиннее 256 символов отклоняется, а normalized MIME ограничен 128 символами.

Не сохраняются и не публикуются request/response body, request headers, cookies, credentials, form data, URL, query string, initiator, IP address, redirect target или raw error text.

## Lifecycle и бюджеты

- Listener filters регистрируются для одной вкладки и немедленно снимаются при pause, navigation, смене foreground-вкладки, выключении модуля, удалении вкладки или destroy.
- Superseding foreground transition инвалидирует observer до ожидания ответа предыдущего content lifecycle.
- One-shot content scan не активирует этот observer и не оставляет metadata listeners.
- Лимиты: 256 active records, 256 queued completed observations, 128 эфемерных ring entries, 64 record на batch, 8 redirects на request и 10 мс batch work.
- Overflow, orphan events, normalization failures и registration failures дают только bounded aggregate counters и состояние `partial` или `unavailable`. Они не запускают replay, rescan или network request.
- Публикация aggregate state coalesce'ится не чаще одного раза в 500 мс.
- Session cache page status использует schema version `7`, которая инвалидирует выведенные DOM API snapshots. Он не хранит API observation или candidate state. Внутренняя candidate projection имеет schema version `1`, существует только в памяти и сбрасывается при invalidation observer.

## Граница candidate и output

Observer экспортирует только bounded revision, status, aggregate counters, overflow counters и partial flag. Priority 3 потребляет bounded completed observations только внутри background runtime и создаёт максимум две internal candidate categories: `document` и `script`. Candidate state никогда не попадает в content scripts, ordinary page-status findings, total counts, badge, notifications или session cache. Его product snapshot намеренно пуст до отдельного Stage 4 pilot, который утвердит product projection.

## Границы ответственности

- URL, hostname, redirect, homograph и visible-target проверки принадлежат `link-domain-security`.
- DOM-level image presentation проверки принадлежат `visual-manipulation`.
- MIME-vs-payload-signature checks, payload analysis, page-world hooks и активное вмешательство в трафик не входят в Priority 2.

## Конфигурация

- `enabled`
- `monitorOnly` — для активации observer должен быть `true`.

## Проверка

`node modules/api-interception/tests/runPriority4Suite.mjs` пройден 2026-07-21. Он запускает контракты MIME decision, candidate state, observer, background integration, test harness, synthetic portability, privacy и local fixture. `PORTABILITY-MATRIX.ru.md` фиксирует checkpoint Chrome/Edge/Firefox facade со статусом contract-ready, но не real-browser-validated. `P5-FACT-INVENTORY.ru.md` фиксирует точные проверенные ревизии и статус. Оба документа ведутся локально сопровождающим и в публичный репозиторий не входят. Локальные fixture servers остаются local-only. Chrome candidate-mode smoke и вся post-pilot product работа остаются pending.
