# Trigger Phrases Module

## Purpose
Scans page text for risky trigger phrases that may indicate manipulation attempts, unsafe instructions, or prompt-injection-style content.

## File
- `TriggerPhrases.js`

## Current Status
- MVP / early implementation.
- The built-in EN/RU catalog recognizes a limited set of multi-signal instruction constructions.
- Safe candidate collection and local Unicode normalization are implemented.
- Semantic classification, deterministic risk evaluation, action-group aggregation, and bounded local active-finding aggregation are implemented.
- Candidate collection now uses an iterative single-pass traversal with scan-local memoization and explicit count, character, and elapsed-time budgets.

## Current Behavior
- The module collects independent text candidates without rebuilding a page-wide text corpus.
- It excludes form controls, password fields, editable surfaces, and technical DOM before reading text.
- It analyzes only the `title`, `aria-label`, and permitted `alt` attributes in addition to text candidates.
- Candidate text is normalized transiently with whitespace, Unicode NFC/NFKC, case, token, and control-character representations.
- The classifier returns metadata-only matches for instruction override, authority impersonation, sensitive disclosure, safety bypass, hidden action, and supporting context categories.
- Risk evaluation applies a deterministic evidence/impact severity matrix and then filters the result by sensitivity without changing the assessment itself.
- The shared `allowIntervention` flag is enabled by default for testing, but the module does not yet annotate or suppress page content.

## Detection Scope
- Visible and hidden DOM text fragments without assessing their visual presentation.
- Text-bearing attributes `title`, `aria-label`, and `alt` for `img` and `area`.
- Phrases that resemble prompt override, coercion, or unsafe instruction patterns.

## Config Keys
- `enabled`
- `allowIntervention`
- `customPatterns`
- `caseSensitive`

`customPatterns` uses a separate local-only v1 catalog and is excluded from normal synchronized configuration and config export. The options UI does not yet provide an editor for it.

The runtime accepts enabled `literal` entries only. It applies the same Unicode normalization as page candidates, never executes pattern source as code or a regular expression, and caps short literal matches at low severity.

## Shared Semantic Core

Built-in rules, normalization, literal matching, semantic classification, and risk evaluation are provided by `modules/semantic-analysis/SemanticAnalysisCore.js`. This module retains DOM candidate selection, lifecycle, budgets, finding creation, and active-finding deduplication. The shared core receives no DOM, Chrome API, storage, or lifecycle state and returns metadata-only assessments.

The persisted configuration is validated by `ConfigManager` and delivered by the content-level lifecycle. Before an initial or mutation scan, the detector creates an immutable effective configuration containing only `caseSensitive` and `sensitivity`, tagged with a module-local revision. Passive metadata such as `allowIntervention`, `actionOnDetect`, `name`, and `description` is not part of detection configuration; content lifecycle owns activation through `enabled`.

## Runtime Behavior
- Loaded from `js/content.js` under the module id `Trigger-Phrases`.
- Automatic continuous analysis runs only in the foreground tab of the focused Chrome window and only in the main frame.
- Losing foreground status destroys the module observer, timer, pending mutation queue, scan-local caches, and active DOM-linked finding state.
- Immediately before destruction, the content runtime serializes the latest bounded privacy-safe snapshot; cleanup happens before the snapshot is sent to the background cache.
- An explicit scan of a paused/background tab is bounded one-shot work; it destroys module runtime state immediately afterward and does not leave observers active.
- Returning to a paused tab may publish the cached snapshot first and then performs at most one lifecycle refresh scan.
- The common content/background runtime enforces `autoScan`; content-script injection alone does not activate this detector.

## Performance Budgets
- Initial scan: at most 10,000 DOM elements, 3,000 candidates, 500,000 normalized characters, 30,000 rule-family evaluations, and 100 ms active processing time. It cooperatively yields after at most 8 ms, 250 elements, 75 candidates, 32,768 normalized characters, or 250 rule-family evaluations in one slice.
- Mutation batch: 500 ms minimum interval, at most 200 coalesced live mutation roots, 100 nodes inspected from each added/removed node list, 1,000 DOM elements, 300 candidates, 50,000 normalized characters, 3,000 rule-family evaluations, and 25 ms active processing time.
- Candidate source text is capped at 65,536 characters. Removed-subtree cleanup is capped at 1,000 elements per batch.
- The queue deduplicates roots and drops a queued child when its queued parent covers it. On overflow or incomplete removal cleanup, it requests one serialized full rescan instead of creating an unbounded catch-up loop.
- Mutation roots received while an initial scan is yielding are reconciled before that initial result returns. An overflow permits one immediate reconciliation rescan; a repeated overflow remains `partial` and returns to the throttled queue.
- Initial scan has priority over queued mutation analysis: a pending mutation timer is cancelled when initial work starts, removal cleanup remains immediate, and the bounded queue is reconciled before the initial result is returned. The detector exposes only numeric deferred-work counters.
- Text-container selection, privacy ancestry, primary-container ancestry, and code/quote context use scan-local `WeakMap` memoization. Candidate selection has no mutual recursion and does not use `querySelectorAll('*')`.
- The latest initial and mutation batches expose bounded numeric stage telemetry for traversal, candidate prefiltering, extraction, normalization, matching, risk evaluation, deduplication, and serialization. Initial-scan telemetry also records active processing time, maximum slice duration, and yield count; mutation telemetry records queue high-water mark, coalescing, overflows, and forced rescans. It contains no page text, URL, selector, or DOM reference.
- Candidate, rule-family, catalog, and queue errors are isolated with bounded fixed diagnostic codes and numeric counters. A local error keeps later candidates running; a system error or exhausted coverage is never reported as a clean result.

## Expected Findings
- Prompt-injection-style instructions.
- Unsafe disclosure or exfiltration prompts.
- Social-engineering and coercive phrases.
- User-defined custom phrase matches.

## Known Limitations
- The default pattern set is too small for meaningful coverage.
- Unicode normalization is not semantic classification and does not make a phrase malicious by itself.
- Active findings use a versioned `trigger-phrase` schema and contain only risk metadata, never page text, DOM references, or internal deduplication identifiers.
- Findings are deduplicated locally by candidate, source, category, and rule. Repeated observations increase an occurrence counter; edits, privacy exclusions, and removed subtrees clear their active findings.
- Equivalent EN/RU constructions and an unambiguous matching custom literal are represented by one finding with a built-in primary rule and metadata-only supporting rule IDs. Independent instruction categories remain separate findings.
- `performScan()` returns the known active count, a local monotonic revision, and at most 10 active findings with `payloadTruncated` metadata.
- Active finding state is capped at 1,000 entries. Candidate, normalization, mutation, or state-capacity limits produce `status: "partial"` and `budgetReached: true`; they never report a false clean result.
- Local scan status distinguishes `complete`, `partial`, `error`, `disabled`, and `aborted`. Scan failures keep their safe `scan-failed` code in module state and are rethrown instead of being emitted as a clean snapshot.
- A finding includes structured machine-readable `details` (category, source type, risk fields, and reason/mitigation codes), never a page-text preview. The session cache intentionally omits these details.
- The shared page-status cache stores at most 10 normalized trigger findings plus counts, revision, timestamps, and stale/partial flags in `chrome.storage.session`.
- The cache schema is versioned and configuration/catalog changes invalidate cached page status without scanning background tabs.
- The literal-pattern catalog is intentionally capped at 500 entries and 65,536 normalized source characters; regex mode remains unsupported.
- False positives and false negatives are both likely in the current MVP state.

## Privacy and Safety
- Must work fully locally.
- Must not persist collected page text or user input.
- Must never analyze password field contents.
- Must keep custom-pattern source only in local extension storage and redact it from logs.
- Any future page annotation or suppression should remain behind `allowIntervention`.

## Planned Next Steps
- Validate the lifecycle in Chrome with 50+ restored tabs, multiple windows, rapid switching, iframe-heavy pages, and sustained SPA mutations.
- Consider coalescing mutation roots before the batch timer; the current raw-record queue is safe but intentionally capped at 200 records.

## Integration
- Loaded by `js/content.js`.
- Inherits the shared lifecycle from `modules/ModuleCore.js`.
- Enabled and configured through `utils/config-manager.js`.
- Exposes a bounded `performScan()` result and a privacy-safe subset through the shared page-status session cache.
- Does not import detector logic or private state from sibling security modules.
