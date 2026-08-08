# Модуль "Безопасность ссылок и доменов"

## Назначение
Анализирует ссылки, домены, redirect-паттерны, гомографические сигналы и небезопасные протоколы навигации.

## Архитектура
- `LinkDomainSecurityDetector.js` остаётся точкой входа и orchestrator-файлом модуля.
- `detectors/hostnameSecurityDetector.js` содержит stub-анализ текущего hostname и target-hostname.
- `detectors/navigationTargetDetector.js` содержит stub-анализ unsafe protocol и redirect-pattern сценариев.
- `detectors/visibleMismatchDetector.js` содержит stub-анализ несовпадения видимого текста ссылки и реального target.
- `utils/urlUtils.js` хранит helper'ы для парсинга URL и redirect-query параметров.
- `utils/domainUtils.js` хранит helper'ы для hostname, protocol и mismatch-проверок.
- `utils/findingFactory.js` хранит helper'ы для единого формата findings.

## Текущий статус
- Эвристическая заглушка уровня MVP.
- Модуль подключён к runtime и формирует пассивные findings.
- Реальной пометки или блокировки на странице пока нет.

## Ключи конфигурации
- `enabled`
- `allowIntervention`
- `detectHomographs`
- `detectLinkMismatch`
- `detectRedirectPatterns`
- `detectUnsafeProtocols`
- `sensitivity`
- `actionOnDetect`

## Текущее поведение
- Проверяет текущий hostname на punycode и mixed-script сигналы.
- Анализирует цели `a[href]` и `form[action]`.
- Выявляет небезопасные протоколы и типовые redirect-query параметры.
- Фиксирует очевидные несовпадения видимого текста ссылки и реального target.
- Candidate collection выполняется итеративно и с budgets; модуль не материализует page-wide или added-subtree результат `querySelectorAll()`.

## Runtime и производительность
- Automatic continuous monitoring работает только в foreground-вкладке сфокусированного окна Chrome и только в main frame. Одна только инъекция content script не активирует модуль.
- Явный scan paused/background-вкладки является bounded one-shot. При pause/destroy удаляются observer, timer, pending roots, scan-local ссылки на элементы и хранящиеся внутри модуля finding details.
- Initial profile: 20 000 посещённых DOM-элементов, 3 000 target candidates и 100 ms elapsed time.
- Mutation profile: минимальный интервал 500 ms, 200 входящих records, 100 added nodes на record, 1 000 added nodes на callback, 100 coalesced roots, 1 000 посещённых DOM-элементов, 300 candidates и 25 ms elapsed time.
- Raw `href`/`action` длиннее 8 192 символов пропускается и помечает snapshot как partial. Visible link text читает не более 64 nodes и 2 048 символов, исключая form controls и editable surfaces.
- Overflow отбрасывается и отражается в bounded counters и `partialResult`; detector не создаёт неограниченную catch-up очередь.

## Session snapshot
- При pause последний snapshot сериализуется до cleanup модуля, но отправляется только после остановки detector pipeline.
- В `chrome.storage.session` сохраняются counts, не более 10 normalized findings, revision, timestamp и partial/stale state.
- Cached link findings содержат только `type`, локализованный `summary`, `severity` и `detector`. URL, hostname, `href`, `action`, visible link text, form values, finding details и DOM references не сохраняются.
- Общая cache schema версионирована. Navigation и значимые config changes инвалидируют snapshot без пробуждения background tabs.

## Интеграция с индикатором страницы
- Findings этого модуля должны участвовать в общем page-level индикаторе расширения.
- Каждая найденная проблема увеличивает общий счётчик action icon на 1.
- Если на странице есть хотя бы одна проблема, иконка расширения должна становиться красной и показывать badge с числом проблем.
- Если findings на странице нет, иконка должна показывать классическую зелёную галочку.

## Архитектурные ограничения
- `LinkDomainSecurityDetector` должен оставаться публичной точкой входа модуля.
- Не нужно дробить модуль до одного файла на каждую микро-эвристику.
- Сетевые проверки доменов, DNS, reputation lookup и blacklist API не входят в MVP-объём.
- Активная блокировка ссылок и DOM-вмешательство здесь не добавляются без отдельного согласования.

## Примечание
`allowIntervention` пока остаётся тестовым флагом на будущее. В текущем MVP модуль работает пассивно.

Real-Chrome acceptance с 50+ восстановленными вкладками, несколькими окнами, быстрым переключением и sustained SPA mutations остаётся обязательной ручной проверкой.
