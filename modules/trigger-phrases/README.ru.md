# Модуль Trigger Phrases

## Назначение
Сканирует текст страницы на наличие рискованных trigger-фраз, которые могут указывать на попытки манипуляции, небезопасные инструкции или prompt-injection-подобный контент.

## Файл
- `TriggerPhrases.js`

## Текущий статус
- MVP / ранняя реализация.
- Встроенный EN/RU-каталог распознаёт ограниченный набор многосигнальных инструктивных конструкций.
- Безопасный сбор кандидатов и локальная Unicode-нормализация реализованы.
- Семантическая классификация, детерминированная оценка риска, агрегация action group и ограниченная локальная агрегация активных findings реализованы.
- Сбор кандидатов переведён на итеративный single-pass обход со scan-local memoization и явными лимитами количества, символов и времени.

## Текущее поведение
- Модуль собирает самостоятельные текстовые кандидаты без построения общего корпуса текста страницы.
- До чтения текста он исключает form controls, password-поля, editable-поверхности и технический DOM.
- Помимо текстовых кандидатов он анализирует только атрибуты `title`, `aria-label` и разрешённый `alt`.
- Текст кандидата кратковременно нормализуется по whitespace, Unicode NFC/NFKC, регистру, токенам и control-символам.
- Classifier возвращает metadata-only совпадения для instruction override, authority impersonation, sensitive disclosure, safety bypass, hidden action и supporting-категорий.
- Risk evaluator применяет детерминированную матрицу evidence/impact/severity и затем фильтрует результат по sensitivity, не изменяя саму оценку.
- Общий флаг `allowIntervention` по умолчанию включён для тестирования, но модуль пока не аннотирует и не подавляет контент страницы.

## Область обнаружения
- Видимые и скрытые DOM-текстовые фрагменты без оценки их визуального представления.
- Текстовые атрибуты `title`, `aria-label` и `alt` у `img` и `area`.
- Фразы, похожие на prompt override, coercion или небезопасные instruction-паттерны.

## Ключи конфигурации
- `enabled`
- `allowIntervention`
- `customPatterns`
- `caseSensitive`

`customPatterns` использует отдельный local-only каталог v1 и исключается из обычной синхронизируемой конфигурации и config export. Options UI пока не предоставляет его редактор.

Runtime принимает только включённые записи `literal`. Для них применяется та же Unicode-нормализация, что и для кандидатов страницы; source никогда не исполняется как код или регулярное выражение, а короткие literal-совпадения ограничены уровнем low.

## Shared Semantic Core

Built-in rules, normalization, literal matching, semantic classification и risk evaluation предоставляет `modules/semantic-analysis/SemanticAnalysisCore.js`. Этот модуль сохраняет DOM candidate selection, lifecycle, budgets, finding creation и active-finding deduplication. Shared core не получает DOM, Chrome API, storage или lifecycle state и возвращает только metadata assessments.

Persisted-конфигурация валидируется `ConfigManager` и передаётся content-level lifecycle. Перед initial- или mutation-scan детектор формирует неизменяемую effective-конфигурацию только с `caseSensitive` и `sensitivity`, помеченную локальной revision модуля. Пассивные metadata `allowIntervention`, `actionOnDetect`, `name` и `description` не входят в detection-конфигурацию; активацией через `enabled` управляет content lifecycle.

## Runtime-поведение
- Загружается из `js/content.js` под идентификатором модуля `Trigger-Phrases`.
- Автоматический continuous analysis работает только в foreground-вкладке сфокусированного окна Chrome и только в main frame.
- При потере foreground-статуса уничтожаются observer модуля, timer, очередь мутаций, scan-local cache и связанный с DOM active finding state.
- Непосредственно перед уничтожением content runtime сериализует последний bounded privacy-safe snapshot; cleanup завершается до отправки snapshot в background cache.
- Явное сканирование paused/background-вкладки выполняется как bounded one-shot; сразу после него runtime state уничтожается и observer не остаётся активным.
- При возврате к paused-вкладке сначала может быть опубликован кэшированный snapshot, после чего lifecycle выполняет не более одного refresh scan.
- Общий content/background runtime исполняет `autoScan`; одна только инъекция content script не активирует detector.

## Лимиты производительности
- Initial scan: не более 10 000 DOM-элементов, 3 000 кандидатов, 500 000 нормализованных символов, 30 000 rule-family evaluations и 100 ms active processing time. Он кооперативно выполняет yield не позднее 8 ms, 250 DOM-элементов, 75 кандидатов, 32 768 нормализованных символов или 250 rule-family evaluations в одной порции.
- Mutation batch: минимальный интервал 500 ms, не более 200 сжатых живых mutation roots в очереди, по 100 узлов из каждого added/removed node list, 1 000 DOM-элементов, 300 кандидатов, 50 000 нормализованных символов, 3 000 rule-family evaluations и 25 ms active processing time.
- Исходный текст одного кандидата ограничен 65 536 символами. Cleanup удалённого subtree ограничен 1 000 элементами на batch.
- Очередь дедуплицирует roots и удаляет поставленный дочерний root, если его покрывает поставленный родитель. При переполнении или неполной очистке removed subtree она запрашивает один сериализованный full rescan вместо бесконечного catch-up loop.
- Mutation roots, поступившие во время yield initial scan, применяются до возврата его результата. Overflow допускает один немедленный reconciliation rescan; повторный overflow остаётся `partial` и возвращается в throttled queue.
- Initial scan имеет приоритет над queued mutation analysis: при его старте pending mutation timer отменяется, removal cleanup остаётся немедленным, а bounded queue проходит reconciliation до возврата результата. Detector раскрывает только числовые deferred-work counters.
- Выбор text containers, privacy ancestry, primary-container ancestry и code/quote context используют scan-local `WeakMap` memoization. Во время candidate selection нет взаимной рекурсии и `querySelectorAll('*')`.
- Последние initial- и mutation-batch содержат bounded числовую telemetry стадий traversal, candidate prefilter, extraction, normalization, matching, risk evaluation, deduplication и serialization. Telemetry initial scan также содержит active processing time, maximum slice duration и yield count; telemetry mutation batch содержит queue high-water mark, coalescing, overflows и forced rescans. В ней нет текста страницы, URL, selector или DOM-ссылки.
- Ошибки candidate, rule family, catalog и queue изолированы bounded фиксированными diagnostic codes и числовыми counters. Локальная ошибка не останавливает следующие candidates; системная ошибка или неполное покрытие никогда не выдаются как clean result.

## Ожидаемые находки
- Инструкции в стиле prompt injection.
- Небезопасные запросы на раскрытие или exfiltration данных.
- Фразы социального давления и coercion.
- Совпадения с пользовательскими паттернами.

## Известные ограничения
- Набор паттернов по умолчанию слишком мал для meaningful coverage.
- Unicode-нормализация не является семантической классификацией и сама по себе не делает фразу вредоносной.
- Активные findings используют версионную схему `trigger-phrase` и содержат только метаданные риска: без текста страницы, DOM-ссылок и внутренних ключей дедупликации.
- Findings локально дедуплицируются по кандидату, источнику, категории и правилу. Повторное наблюдение увеличивает счётчик; правка, privacy-исключение и удаление DOM-поддерева очищают его активные findings.
- Эквивалентные EN/RU-конструкции и однозначно совпавший custom literal представлены одним finding: built-in rule остаётся primary, а supporting rule IDs содержат только метаданные. Независимые категории инструкций остаются отдельными findings.
- `performScan()` возвращает известный active count, локальную монотонную revision и не более 10 active findings с метаданными `payloadTruncated`.
- Active state ограничен 1 000 entries. Лимиты кандидатов, нормализации, мутаций или active state дают `status: "partial"` и `budgetReached: true`, но никогда не выдают ложный clean result.
- Локальный scan status различает `complete`, `partial`, `error`, `disabled` и `aborted`. Ошибка scan сохраняет безопасный код `scan-failed` в module state и пробрасывается дальше, а не публикуется как clean snapshot.
- Finding содержит структурированные machine-readable `details` (category, source type, risk-поля и reason/mitigation codes), но никогда не содержит preview текста страницы. Session cache намеренно не сохраняет эти details.
- Общий page-status cache хранит в `chrome.storage.session` не более 10 нормализованных trigger findings, а также counts, revision, timestamps и stale/partial flags.
- Схема кэша версионирована; изменение конфигурации или каталога инвалидирует page status без сканирования фоновых вкладок.
- Literal-каталог намеренно ограничен 500 записями и 65 536 нормализованными символами source; regex-режим не поддерживается.
- И false positives, и false negatives в текущем состоянии MVP вполне вероятны.

## Приватность и безопасность
- Модуль должен работать полностью локально.
- Нельзя сохранять собранный текст страницы или пользовательский ввод.
- Никогда нельзя анализировать содержимое password-полей.
- Source пользовательского паттерна должен храниться только в local extension storage и редактироваться в логах.
- Любая будущая аннотация или подавление контента страницы должны оставаться за `allowIntervention`.

## Следующие шаги
- Проверить lifecycle в Chrome с 50+ восстановленными вкладками, несколькими окнами, быстрым переключением, iframe-heavy страницами и длительными SPA-мутациями.
- Рассмотреть coalescing mutation roots до batch timer; текущая очередь raw records безопасна, но намеренно ограничена 200 записями.

## Интеграция
- Загружается из `js/content.js`.
- Наследует общий lifecycle из `modules/ModuleCore.js`.
- Включается и настраивается через `utils/config-manager.js`.
- Предоставляет bounded `performScan()` result и privacy-safe subset через общий page-status session cache.
- Не импортирует detector logic или private state соседних security modules.
