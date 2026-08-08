# Semantic Analysis Core

## Purpose

Pure domain infrastructure shared by text-security modules. It owns built-in semantic rules, Unicode normalization, literal matching, semantic classification, and deterministic risk evaluation.

## Public Contract

- `prepareCustomLiteralCatalog(catalog, config, limits)` creates a caller-owned, bounded literal catalog from an already validated local configuration. It does not read configuration or storage.
- `analyzeSemanticCandidate(candidate, options)` accepts one bounded text candidate and returns metadata-only semantic assessments plus bounded numeric diagnostics.
- `validateSemanticCatalog(catalog)` returns only catalog-validation metadata: accepted/rejected counts and bounded `{ ruleId, errorCode }` entries for invalid rules.

Schema v2 adds the opt-in `includeTransientContributionMap` analysis option. Only a same-call consumer receives bounded `{ signalId, start, end }` ranges for required built-in signals, with `mappingReliable: false` and no ranges when normalization cannot be mapped safely. These ranges contain no text and must never be serialized, cached, logged, or retained after the caller returns. Existing callers receive no contribution map and retain the v1 result shape apart from the schema version.

The analysis result never includes candidate text, previews, DOM nodes, selectors, URLs, Chrome APIs, storage state, finding identities, or a full rule/custom catalog. The core has no timers, queues, observers, lifecycle state, localization, network access, or persistent state.

The core caps a candidate at 65,536 code points and custom literal work at 500 prepared patterns by default. Caller-provided lower limits are honored; overflow returns `partial` without hidden catch-up work.

`TriggerPhrases` owns candidate selection, lifecycle cancellation, scan budgets, finding creation, and active-finding deduplication. `PromptSplitting` uses the opt-in transient map only inside its Priority 5 decision engine; it retains responsibility for reconstruction confidence, contribution policy, and decision lifetime.

## Local Checks

Run `node --experimental-vm-modules modules/semantic-analysis/run-tests.cjs` from the extension root. The runner covers the semantic-core checks plus the Prompt Splitting Priority 3 collector, Priority 4 reconstruction, Priority 5 decisions, and Priority 6 finding-state checks.
