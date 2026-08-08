# Prompt Splitting Module

## Purpose
Detects prompt-splitting patterns where malicious instructions are distributed across multiple DOM fragments to bypass simple single-string checks.

## File
- `PromptSplitting.js`

## Current Status
- MVP / Priority 7 runtime-integration implementation.
- The module is connected to runtime loading.
- Runtime findings, bounded active state, dynamic-DOM processing, and cache/runtime integration are implemented. Real-Chrome acceptance and the broader corpus remain Priority 8 work.

## Current Behavior
- The module can be instantiated by the shared module manager.
- It is disabled by default in the current configuration.
- The shared `allowIntervention` flag is enabled by default for testing.
- When enabled, it collects/reconstructs candidates, evaluates metadata-only decisions, and reconciles bounded prompt-splitting findings. Findings remain disabled by default with the module.
- The collector uses iterative, resumable traversal; it does not use the recursive `ModuleCore.firstScan()` implementation.

## Priority 3 Collector Contract
- A fragment is bounded text from exactly one source: DOM text, `title`, `aria-label`, or `alt` on `img`/`area`. Outer whitespace is preserved in scan-local raw text; trimming is used only to discard an otherwise empty source.
- A candidate is an independent primary, fallback, or safe interactive DOM boundary with document order and structural/context metadata. Inline markup belongs to its enclosing candidate and does not create a duplicate candidate.
- A local region is a bounded group of nearby candidates with the same local structural anchor. A candidate belongs to at most one region.
- Candidate raw text and DOM references are scan-local and cleared immediately after the collector batch. The runtime keeps only bounded numeric diagnostics.
- The collector excludes form/editable/password and technical subtrees before reading text. It does not inspect CSS, geometry, Shadow DOM, iframe documents, form values, `placeholder`, `value`, or arbitrary attributes.

## Priority 4 Reconstruction Contract
- `PromptReconstructionEngine` accepts only the collector's scan-local collection. It never reads DOM, lifecycle state, storage, Chrome APIs, or another module's findings.
- It processes one local region at a time using only consecutive document-order windows of two to four candidates. Windows never cross a region, skip a candidate, permute candidates, or backtrack.
- DOM text, `title`, `aria-label`, and `alt` are reconstructed only in homogeneous source-type chains.
- It emits at most three deduplicated assembly paths per window: boundary-aware, spaced, and compact. Compact is allowed only when every candidate boundary has no source whitespace and both adjacent non-whitespace characters are Unicode letters or digits.
- Reconstructed text is passed to one bounded consumer and cleared in `finally` immediately afterward. It is never kept in module state, serialized, cached, classified, or turned into a finding in Priority 4.

## Priority 5 Decision Contract
- `PromptDecisionEngine` invokes the shared semantic core with its opt-in transient contribution map, maps required semantic signals to temporary fragment spans, and returns metadata-only decisions.
- An eligible decision requires a primary semantic assessment, reliable contribution mapping, and evidence from at least two candidates. A complete equivalent match in one source fragment is ineligible and remains the responsibility of `TriggerPhrases`.
- Confidence is deterministic: `strong`, `moderate`, `weak`, or `insufficient`, accompanied by bounded reason and mitigation codes. It does not alter the semantic category, impact, or severity.
- Only complete text chains using `boundary-aware` or `spaced` assembly can be eligible. Compact and attribute-only chains are capped to `weak`; code/quote contexts are insufficient, while list/navigation context is capped to `weak`.
- Decision metadata never contains reconstructed/fragment text, source ranges, DOM references, URLs, selectors, timestamps, finding identity, or persisted configuration. Decisions are discarded after numeric diagnostics are aggregated.

## Priority 6 Finding-State Contract
- `PromptFindingState` creates one runtime finding for one independent reconstructed instruction. Equivalent assembly paths and overlapping same-rule windows are merged only when they share a region, source type, action group, and candidate evidence.
- Full complete scans atomically replace active state. Partial/error work keeps known positives and cannot publish a clean result; stale work aborts before commit.
- Active state has bounded finding, candidate/region reverse-index, pending, history, code, and serialized-payload limits. The authoritative active count is independent of the serialized payload length.
- Runtime findings contain only structured metadata: semantic/reconstruction fields, bounded structural summary, rule IDs, reason/mitigation codes, and timestamps. They contain no text, offsets, DOM, URL, selector, HTML, or internal identity.

## Priority 7 Runtime Contract
- The observer is limited to child-list, subtree, character-data, and the `title`, `aria-label`, `alt`, `contenteditable`, `role`, and `aria-multiline` attributes. It never requests old values or observes form values, placeholders, styles, classes, or arbitrary data attributes.
- `PromptMutationQueue` immediately coalesces bounded live roots and removed candidate identities. Removed subtree text is never read or retained. Overflow preserves known findings, marks the result partial, and requests at most one bounded reconciliation pass during initial work.
- Initial collection and reconstruction yield in bounded slices. Each scan captures an immutable configuration/lifecycle revision, and stale work aborts before finding commit or status publication.
- `sensitivity` controls semantic eligibility. `detectionThreshold` only selects the minimum reconstruction confidence: `0..0.33` is `weak`, `0.34..0.66` is `moderate`, and `0.67..1` is `strong`. It does not alter semantic severity.
- Prompt splitting and trigger phrases receive the same validated custom-literal catalog. Pattern source is prepared only in memory, removed from module configuration after preparation, and never logged or cached.
- A material prompt-finding or completeness change emits a coalesced page-status update. Cache entries retain only the authoritative count, revision, flags, and up to ten localized `{ type, summary }` findings.

## Priority 8 Verification Assets
- `tests/PromptSplittingCorpus.v1.mjs` is the versioned synthetic corpus; `tests/PromptSplittingCorpus.test.mjs` runs it through the pure decision layer.
- `fixtures/priority8-test-page.html` is a local-only Chrome fixture for mutation, queue, DOM-complexity, and main-frame scenarios.
- `MANUAL-TESTS.ru.md`, `PERFORMANCE-SCENARIOS.ru.md`, and `READINESS-REPORT.ru.md` define Chrome acceptance, measurements, and the final readiness record. These `.ru.md` working documents, like the pilot and observation records referenced below, are maintainer-local and are not part of the public repository.
- Run all automated component and corpus checks with `node --experimental-vm-modules modules\\semantic-analysis\\run-tests.cjs`.
- The component exposes a strict session-cache subset of at most ten `{ type, summary }` entries; serialization and coalesced cache writing are handled by the shared content/background runtime.

## Priority 9 Pilot Preparation
- `tests/PromptSplittingPilotCorpus.v1.mjs` splits synthetic pilot cases into calibration, immutable regression, and held-out control partitions; its structural test is included in the shared test runner.
- `fixtures/priority9-pilot-page.html` supplies local-only synthetic article, forum, documentation, dashboard, table, card, ARIA, and SPA scenarios without external resources.
- `PILOT-BASELINE.ru.md`, `PILOT-PROTOCOL.ru.md`, and `PILOT-REPORT.ru.md` freeze the starting contract, specify the future pilot process, and provide an unfilled factual report template.
- This preparation does not change rules, confidence, sensitivity, thresholds, limits, default enablement, or the detection scope.

## Priority 10 Observation Registry
- `OBSERVATION-REGISTRY.ru.md` records privacy-safe, synthetic observations before any calibration change; entries cannot change detector behavior on their own.
- `fixtures/priority10-context-observation.html` is the local-only reproducer for initial observation `P10-001` about documentation, quotation, and code context.
- A confirmed cluster still needs a separate change plan and user approval before it can affect the regression corpus or production logic.

## Detection Scope
- Nearby DOM text fragments.
- Hidden and visible text fragments that may form one instruction chain.
- Attribute-based fragments when phrase reconstruction is implemented.
- Delimiter abuse and suspicious sequencing markers across multiple nodes.

## Config Keys
- `enabled`
- `allowIntervention`
- `sensitivity`
- `detectionThreshold`

## Runtime Behavior
- Loaded from `js/content.js` under the module id `Prompt-Splitting`.
- Receives active/paused/one-shot state only from the shared runtime. Automatic continuous work is limited to the foreground tab of the focused Chrome window and the main frame.
- Content-script injection alone does not activate the module. A background explicit scan is bounded one-shot work and leaves no observer, timer, pending roots, fragments, or findings in module memory afterward.
- On pause, the latest privacy-safe snapshot is serialized before cleanup and sent only after the detector pipeline has stopped.

## Priority 1 Lifecycle Contract
- `disabled`: the module has no active observer, timer, pending mutation roots, scan-local DOM state, or findings.
- `paused`: the shared runtime has stopped the module; cached page status may be displayed, but the module performs no continuous work.
- `activating`: `ModuleCore.init()` may set up the explicitly opted-in observer and run one bounded initial scan. A newer lifecycle revision invalidates this work before the module becomes active.
- `active`: continuous mutation handling is allowed only in the main frame of the foreground tab in the focused Chrome window.
- `one-shot`: an explicit scan of a paused/background tab does not start continuous observation and always ends with `destroy()`.
- `cleanup`: pause, disable, navigation, error, and superseding lifecycle requests clear observer records, timers, roots, scan-local DOM references, fragments, and bounded finding details.

## Performance Budgets
- Initial profile: 10,000 DOM elements, 2,000 candidate containers, 5,000 fragments, 250,000 fragment characters, and 100 ms.
- Mutation profile: 500 ms minimum interval, 200 records, 100 added nodes per record, 1,000 added nodes per callback, 100 coalesced roots, 1,000 DOM elements, 300 containers, 1,000 fragments, 50,000 characters, and 25 ms.
- A container inspects at most 128 direct child nodes and reads at most 4,096 characters into one candidate text fragment.
- No fragment combinations are generated. Overflow is discarded, exposed through bounded counters, and marks the snapshot `partial`.
- Reconstruction profile: at most 80 regions, 16 candidates and starts per region, four candidates per window, 48 windows per region, 1,000 windows per scan, three variants per window, 4,096 characters per window, 100,000 reconstructed characters, 1,024 transient dedupe keys, and 35 ms. The local mutation profile lowers this to eight regions, 96 windows, 20,000 characters, and 10 ms.
- Decision profile per reconstructed candidate: up to five semantic analyses, four source-fragment analyses, four assessments/decisions, four mapped candidates/fragments, 12 reason or mitigation codes, and 25 ms. Mutation evaluation uses a 10 ms limit.
- Finding-state profile: 200 active findings, 1,000 reverse-index entries, 200 pending findings, eight candidate identities per finding, eight supporting rules, 12 codes, 20 history entries, and ten serialized findings.
- Form controls, password fields, active contenteditable surfaces, role=textbox subtrees, and technical DOM are excluded, including mutation roots inserted inside an existing excluded ancestor.

## Session Snapshot
- The shared versioned `chrome.storage.session` cache stores counts, up to 10 metadata-only findings, revision, timestamp, and stale/partial state.
- Cached prompt-splitting findings contain only `type` and localized `summary`. Reconstructed text, finding `details`, full page text, DOM references, form values, and editable input are never cached.

## Known Limitations
- No cross-region/frame reconstruction, arbitrary subset search, or non-text deobfuscation exists.
- Compact and attribute-only reconstruction cannot become eligible in this priority.
- Real-Chrome lifecycle, dynamic-DOM, and performance acceptance remain Priority 8 work.

## Privacy and Safety
- Must work fully locally.
- Must not persist reconstructed text chains outside local runtime memory.
- Must avoid broad text harvesting that is not needed for the active heuristic.
- Any future active intervention should stay behind `allowIntervention`.

## Planned Next Steps
- Complete real-Chrome lifecycle acceptance with 50+ restored tabs, multiple windows, rapid switching, and sustained SPA mutations.
- Complete Priority 8 corpus, real-Chrome lifecycle, dynamic-DOM, and performance acceptance.

## Integration
- Loaded by `js/content.js`.
- Inherits the shared lifecycle and observer behavior from `modules/ModuleCore.js`.
- Enabled and configured through `utils/config-manager.js`.
- Once the module produces structured findings, they should feed the shared page-level extension indicator.
- Each detected problem should increment the shared action-icon counter by 1.
- If the page has at least one problem, the action icon should be red with a badge; if the page has no problems, it should show the classic green check mark.
