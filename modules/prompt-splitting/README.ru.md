# Модуль Prompt Splitting

## Назначение
Обнаруживает prompt-splitting-паттерны, при которых вредоносные инструкции распределяются по нескольким DOM-фрагментам, чтобы обойти простые проверки по одной строке.

## Файл
- `PromptSplitting.js`

## Текущий статус
- MVP / runtime-интеграция Priority 7.
- Модуль уже подключён к runtime-загрузке.
- Runtime findings, bounded active state, dynamic-DOM processing и cache/runtime integration реализованы. Real-Chrome acceptance и расширенный corpus остаются работой Priority 8.

## Текущее поведение
- Модуль может создаваться через общий менеджер модулей.
- По умолчанию он отключён в текущей конфигурации.
- Общий флаг `allowIntervention` по умолчанию включён для тестирования.
- При включении collector формирует/reconstructs candidates, оценивает metadata-only decisions и reconcile'ит bounded prompt-splitting findings. Модуль и findings по умолчанию остаются отключёнными.
- Collector обходит DOM итеративно и resumable; рекурсивная реализация `ModuleCore.firstScan()` не используется.

## Контракт collector Priority 3
- Fragment — bounded text ровно одного источника: DOM text, `title`, `aria-label` или `alt` у `img`/`area`. В scan-local raw text сохраняются внешние пробелы; `trim()` применяется только для отбрасывания пустого источника.
- Candidate — самостоятельная primary-, fallback- или safe interactive DOM-boundary с document order и structural/context metadata. Inline-разметка входит в enclosing candidate и не создаёт дубликат.
- Local region — bounded-группа близких candidates с одним local structural anchor. Candidate входит не более чем в один region.
- Raw text и DOM references candidate существуют только в пределах scan-local batch и очищаются сразу после него. Runtime сохраняет лишь bounded numeric diagnostics.
- Collector исключает form/editable/password и technical subtrees до чтения текста. Он не читает CSS, geometry, Shadow DOM, iframe documents, form values, `placeholder`, `value` или произвольные attributes.

## Контракт reconstruction Priority 4
- `PromptReconstructionEngine` принимает только scan-local collection collector. Он никогда не читает DOM, lifecycle state, storage, Chrome API или findings другого модуля.
- Он обрабатывает один local region за раз, используя только последовательные document-order windows из двух—четырёх candidates. Windows не пересекают regions, не пропускают candidates, не переставляют их и не выполняют backtracking.
- DOM text, `title`, `aria-label` и `alt` реконструируются только в однородных chains одного source type.
- На window создаётся не более трёх deduplicated assembly paths: boundary-aware, spaced и compact. Compact разрешён, только если на каждой границе нет source whitespace, а оба соседних non-whitespace символа — Unicode-буквы или цифры.
- Reconstructed text передаётся одному bounded consumer и очищается в `finally` сразу после него. В Priority 4 он не хранится в module state, не сериализуется, не кэшируется, не классифицируется и не превращается в finding.

## Контракт decision Priority 5
- `PromptDecisionEngine` вызывает shared semantic core с opt-in transient contribution map, сопоставляет required semantic signals с временными fragment spans и возвращает metadata-only decisions.
- Eligible decision требует primary semantic assessment, надёжный contribution mapping и evidence минимум двух candidates. Эквивалентный полный match в одном source fragment помечается ineligible и остаётся ответственностью `TriggerPhrases`.
- Confidence детерминирован: `strong`, `moderate`, `weak` или `insufficient`; ему сопутствуют bounded reason и mitigation codes. Он не меняет semantic category, impact или severity.
- Eligible могут быть только complete text chains с `boundary-aware` или `spaced` assembly. Compact и attribute-only chains ограничены `weak`; code/quote context даёт `insufficient`, а list/navigation context ограничен `weak`.
- Decision metadata не содержит reconstructed/fragment text, source ranges, DOM references, URL, selectors, timestamp, finding identity или persisted configuration. Decisions отбрасываются после агрегации только numeric diagnostics.

## Контракт finding state Priority 6
- `PromptFindingState` создаёт один runtime finding для одной независимой reconstructed instruction. Эквивалентные assembly paths и overlapping windows одного rule объединяются, только когда совпадают region, source type, action group и пересекающееся candidate evidence.
- Complete full scan атомарно заменяет active state. Partial/error work сохраняет known positives и не может опубликовать clean result; stale work abort'ится до commit.
- Active state имеет bounded limits для findings, candidate/region reverse indexes, pending state, history, codes и serialized payload. Authoritative active count не зависит от длины serialized payload.
- Runtime finding содержит только structured metadata: semantic/reconstruction fields, bounded structural summary, rule IDs, reason/mitigation codes и timestamps. Он не содержит text, offsets, DOM, URL, selector, HTML или internal identity.

## Runtime-контракт Priority 7
- Observer ограничен `childList`, `subtree`, `characterData` и attributes `title`, `aria-label`, `alt`, `contenteditable`, `role`, `aria-multiline`. Он не запрашивает old values и не наблюдает form values, `placeholder`, styles, classes или произвольные data-attributes.
- `PromptMutationQueue` сразу coalesce'ит bounded live roots и removed candidate identities. Text удалённого subtree не читается и не удерживается. Overflow сохраняет known findings, выставляет `partial` и запрашивает не более одного bounded reconciliation pass при initial work.
- Initial collection и reconstruction выполняются bounded slices. Каждый scan получает immutable configuration/lifecycle revision; stale work abort'ится до finding commit или status publication.
- `sensitivity` управляет semantic eligibility. `detectionThreshold` выбирает только minimum reconstruction confidence: `0..0.33` — `weak`, `0.34..0.66` — `moderate`, `0.67..1` — `strong`. Semantic severity он не меняет.
- Prompt splitting и trigger phrases получают один validated custom-literal catalog. Source pattern подготавливается только в памяти, после подготовки удаляется из module configuration и не логируется и не кэшируется.
- Material change prompt findings или completeness создаёт coalesced page-status update. Cache хранит только authoritative count, revision, flags и до десяти localized `{ type, summary }` findings.

## Проверочные материалы Priority 8
- `tests/PromptSplittingCorpus.v1.mjs` — versioned synthetic corpus; `tests/PromptSplittingCorpus.test.mjs` прогоняет его через чистый decision layer.
- `fixtures/priority8-test-page.html` — local-only Chrome fixture для mutation, queue, DOM-complexity и main-frame scenarios.
- `MANUAL-TESTS.ru.md`, `PERFORMANCE-SCENARIOS.ru.md` и `READINESS-REPORT.ru.md` задают Chrome acceptance, measurements и итоговую readiness-запись. Эти рабочие `.ru.md`-документы, как и упомянутые ниже записи пилота и наблюдений, ведутся локально сопровождающим и в публичный репозиторий не входят.
- Все automated component и corpus checks запускаются командой `node --experimental-vm-modules modules\\semantic-analysis\\run-tests.cjs`.
- Компонент предоставляет строгий session-cache subset максимум из десяти `{ type, summary }`; serialization и coalesced cache writing выполняет общий content/background runtime.

## Подготовка пилота Priority 9
- `tests/PromptSplittingPilotCorpus.v1.mjs` разделяет synthetic pilot cases на calibration, immutable regression и held-out control; его structural check включён в общий test runner.
- `fixtures/priority9-pilot-page.html` содержит local-only synthetic scenarios article, forum, documentation, dashboard, table, cards, ARIA и SPA без внешних ресурсов.
- `PILOT-BASELINE.ru.md`, `PILOT-PROTOCOL.ru.md` и `PILOT-REPORT.ru.md` фиксируют исходный контракт, будущий процесс пилота и незаполненный factual report template.
- Эта подготовка не меняет rules, confidence, sensitivity, thresholds, limits, default enablement или scope обнаружения.

## Реестр наблюдений Priority 10
- `OBSERVATION-REGISTRY.ru.md` фиксирует privacy-safe synthetic observations до любой calibration change; запись сама по себе не может изменить detector behavior.
- `fixtures/priority10-context-observation.html` — local-only reproducer для первого observation `P10-001` о documentation, quotation и code context.
- Подтверждённый кластер всё равно требует отдельного change plan и user approval до изменения regression corpus или production logic.

## Область обнаружения
- Близко расположенные DOM-текстовые фрагменты.
- Скрытые и видимые текстовые фрагменты, которые могут составлять одну цепочку инструкций.
- Атрибутные фрагменты, когда будет реализована реконструкция фраз.
- Злоупотребление разделителями и подозрительные sequencing-маркеры в нескольких узлах.

## Ключи конфигурации
- `enabled`
- `allowIntervention`
- `sensitivity`
- `detectionThreshold`

## Runtime-поведение
- Загружается из `js/content.js` под идентификатором модуля `Prompt-Splitting`.
- Получает active/paused/one-shot state только от общего runtime. Automatic continuous work ограничен foreground-вкладкой сфокусированного окна Chrome и main frame.
- Одна только инъекция content script не активирует модуль. Explicit background scan является bounded one-shot и после завершения не оставляет observer, timer, pending roots, fragments или findings в памяти модуля.
- При pause последний privacy-safe snapshot сериализуется до cleanup, но отправляется только после остановки detector pipeline.

## Lifecycle-контракт Priority 1
- `disabled`: у модуля нет активных observer, timer, pending mutation roots, scan-local DOM state и findings.
- `paused`: общий runtime остановил модуль; cached page status может отображаться, но continuous work не выполняется.
- `activating`: `ModuleCore.init()` может установить явно включённый observer и выполнить один bounded initial scan. Более новая lifecycle revision отменяет эту работу до перехода модуля в active.
- `active`: continuous mutation handling разрешён только в main frame foreground-вкладки сфокусированного окна Chrome.
- `one-shot`: explicit scan paused/background-вкладки не запускает continuous observation и всегда завершается через `destroy()`.
- `cleanup`: pause, disable, navigation, error и superseding lifecycle request очищают observer records, timers, roots, scan-local DOM references, fragments и bounded finding details.

## Лимиты производительности
- Initial profile: 10 000 DOM-элементов, 2 000 candidate containers, 5 000 fragments, 250 000 fragment characters и 100 ms.
- Mutation profile: минимальный интервал 500 ms, 200 records, 100 added nodes на record, 1 000 added nodes на callback, 100 coalesced roots, 1 000 DOM-элементов, 300 containers, 1 000 fragments, 50 000 символов и 25 ms.
- Один container проверяет не более 128 direct child nodes и читает не более 4 096 символов в один candidate text fragment.
- Комбинации fragments не строятся. Overflow отбрасывается, отражается в bounded counters и помечает snapshot как `partial`.
- Reconstruction profile: не более 80 regions, 16 candidates и starts на region, четырёх candidates на window, 48 windows на region, 1 000 windows на scan, трёх variants на window, 4 096 символов на window, 100 000 reconstructed characters, 1 024 transient dedupe keys и 35 ms. Local mutation profile снижает лимит до восьми regions, 96 windows, 20 000 символов и 10 ms.
- Decision profile на reconstructed candidate: до пяти semantic analyses, четырёх source-fragment analyses, четырёх assessments/decisions, четырёх mapped candidates/fragments, 12 reason или mitigation codes и 25 ms. Mutation evaluation использует лимит 10 ms.
- Finding-state profile: 200 active findings, 1 000 reverse-index entries, 200 pending findings, восемь candidate identities на finding, восемь supporting rules, 12 codes, 20 history entries и десять serialized findings.
- Form controls, password fields, active contenteditable surfaces, role=textbox subtrees и technical DOM исключаются, включая mutation root внутри уже существующего excluded ancestor.

## Session snapshot
- Общий версионированный cache в `chrome.storage.session` хранит counts, не более 10 metadata-only findings, revision, timestamp и stale/partial state.
- Cached prompt-splitting findings содержат только `type` и локализованный `summary`. Reconstructed text, finding `details`, полный page text, DOM references, form values и editable input не кэшируются.

## Известные ограничения
- Нет cross-region/frame reconstruction, arbitrary subset search или нетекстовой deobfuscation.
- Compact и attribute-only reconstruction не могут стать eligible в этом приоритете.
- Real-Chrome lifecycle, dynamic-DOM и performance acceptance остаются работой Priority 8.

## Приватность и безопасность
- Модуль должен работать полностью локально.
- Нельзя сохранять реконструированные текстовые цепочки за пределами локальной runtime-памяти.
- Нужно избегать широкого сбора текста, который не нужен для активной эвристики.
- Любое будущее активное вмешательство должно оставаться за `allowIntervention`.

## Следующие шаги
- Завершить real-Chrome lifecycle acceptance с 50+ восстановленными вкладками, несколькими окнами, быстрым переключением и sustained SPA mutations.
- Завершить в Priority 8 corpus, real-Chrome lifecycle, dynamic-DOM и performance acceptance.

## Интеграция
- Загружается из `js/content.js`.
- Наследует общий lifecycle и observer-поведение из `modules/ModuleCore.js`.
- Включается и настраивается через `utils/config-manager.js`.
- После появления структурированных findings должен передавать их в общий page-level индикатор расширения.
- Каждая найденная проблема должна увеличивать общий счётчик action icon на 1.
- При наличии хотя бы одной проблемы на странице action icon должен быть красным с badge; при отсутствии проблем должна показываться классическая зелёная галочка.
