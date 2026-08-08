# Semantic Analysis Core

## Назначение

Чистая domain-инфраструктура для текстовых security-модулей. Она владеет встроенными semantic rules, Unicode-normalization, literal matching, semantic classification и детерминированной risk evaluation.

## Публичный контракт

- `prepareCustomLiteralCatalog(catalog, config, limits)` создаёт caller-owned bounded literal catalog из уже валидированной локальной конфигурации. Функция не читает configuration или storage.
- `analyzeSemanticCandidate(candidate, options)` принимает один bounded text candidate и возвращает только metadata semantic assessments и bounded numeric diagnostics.
- `validateSemanticCatalog(catalog)` возвращает только metadata валидации catalog: accepted/rejected counts и bounded entries `{ ruleId, errorCode }` для invalid rules.

Schema v2 добавляет opt-in опцию analysis `includeTransientContributionMap`. Только consumer того же вызова получает bounded ranges `{ signalId, start, end }` required built-in signals; если нормализацию нельзя безопасно сопоставить, возвращается `mappingReliable: false` без ranges. Ranges не содержат текста и не должны сериализоваться, кэшироваться, логироваться или сохраняться после возврата caller. Existing callers не получают contribution map и сохраняют v1 shape результата, кроме версии schema.

Результат analysis не содержит candidate text, preview, DOM nodes, selectors, URL, Chrome API, storage state, finding identity или полный rule/custom catalog. У core нет timers, queues, observers, lifecycle state, localization, network access и persistent state.

По умолчанию core ограничивает candidate 65 536 code points, а custom literal work — 500 prepared patterns. Более строгие caller-provided limits соблюдаются; overflow возвращает `partial` без скрытой catch-up работы.

`TriggerPhrases` остаётся владельцем candidate selection, lifecycle cancellation, scan budgets, finding creation и active-finding deduplication. `PromptSplitting` использует opt-in transient map только внутри decision engine Priority 5; reconstruction confidence, contribution policy и время жизни decision остаются его ответственностью.

## Локальная проверка

Из корня расширения: `node --experimental-vm-modules modules/semantic-analysis/run-tests.cjs`. Runner выполняет проверки semantic core, collector Priority 3, reconstruction Priority 4, decisions Priority 5 и finding state Priority 6 модуля Prompt Splitting.
