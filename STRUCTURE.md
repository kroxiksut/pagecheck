Chrome PageCheck/
|
|-- _locales/
|   |-- en/
|   |   `-- messages.json
|   `-- ru/
|       `-- messages.json
|
|-- assets/
|   |-- blocked.html
|   |-- icons/
|   `-- themes/
|
|-- modules/
|   |-- ModuleCore.js
|   |-- timeSlicing.test.mjs                  # shield: cooperative slicing, active-time budgets, pause during a yield (C2)
|   |-- loopSafety.test.mjs                   # shield: the extension's own DOM edits never become work or findings (C4)
|   |-- *.test.mjs                          # core-contract shield tests (scan exclusion, error policy)
|   |-- semantic-analysis/
|   |   |-- SemanticAnalysisCore.js
|   |   |-- semanticCatalog.js
|   |   |-- SemanticAnalysisCore.test.mjs
|   |   |-- coreDefects.test.mjs             # shield tests for the Priority 1 defects (rule shape, U+FEFF flags, overlap scan, partial)
|   |   |-- fallbackTokenization.test.mjs    # the tokenization branch without Intl.Segmenter (ranges, mapping reliability)
|   |   |-- run-tests.cjs
|   |   |-- README.md
|   |   `-- README.ru.md
|   |-- visual-manipulation/
|   |   |-- VisualManipulationDetector.js
|   |   |-- *.test.mjs                      # module-level shield tests (scan budget, dedupe keys, pause keeps findings)
|   |   |-- detectors/
|   |   |   |-- hiddenTextDetector.js
|   |   |   |-- hiddenInputDetector.js
|   |   |   |-- overlayDetector.js
|   |   |   |-- styleObfuscationDetector.js
|   |   |   `-- *.test.mjs                  # detector shield tests
|   |   |-- utils/
|   |   |   |-- domUtils.js
|   |   |   |-- severityModel.js
|   |   |   |-- *.test.mjs                  # pure-helper tests (parsers, candidate text, severity, finding factory)
|   |   |   `-- findingFactory.js
|   |   |-- README.md
|   |   `-- README.ru.md
|   |-- link-domain-security/
|   |   |-- LinkDomainSecurityDetector.js
|   |   |-- *.test.mjs                      # module-level shield tests (finding identity, hostname memo, error visibility, base URI, formaction)
|   |   |-- detectors/
|   |   |   |-- hostnameSecurityDetector.js
|   |   |   |-- navigationTargetDetector.js
|   |   |   |-- visibleMismatchDetector.js
|   |   |   `-- *.test.mjs                  # detector shield tests (generic finding suppressed by a precise one)
|   |   |-- utils/
|   |   |   |-- domainUtils.js
|   |   |   |-- urlUtils.js
|   |   |   |-- *.test.mjs                  # pure-helper tests (TLD guard, confusables, redirects)
|   |   |   `-- findingFactory.js
|   |   |-- README.md
|   |   |-- README.ru.md
|   |   `-- manual-tests/
|   |       `-- link-domain-security.html
|   |-- trigger-phrases/
|   |   |-- TriggerPhrases.js
|   |   |-- candidateOwnership.test.mjs      # shield tests for owning-container attribution and mutation budgets
|   |   |-- initialScanCounters.test.mjs    # shield: the initial scan reports its own counters, not the reconciliation batch (10.5)
|   |   |-- mutationRootCoalescing.test.mjs # shield: root coalescing without Node.contains() passes over the queue (10.8)
|   |   |-- telemetryPublication.test.mjs   # shield: out-of-scan serialization must not mutate published telemetry (10.6)
|   |   |-- pauseKeepsFindings.test.mjs     # shield: pause keeps findings and candidate identity, destroy clears them (C2)
|   |   |-- README.md
|   |   `-- README.ru.md
|   |-- prompt-splitting/
|   |   |-- PromptSplitting.js
|   |   |-- PromptSplittingConfig.test.mjs
|   |   |-- mutationQueueAccounting.test.mjs # shield: overflow schedules exactly one rescan; skip counters stay distinct (11.4/11.7/11.9)
|   |   |-- pauseKeepsFindings.test.mjs     # shield: pause keeps findings and region identity, destroy clears them (C2)
|   |   |-- collectors/
|   |   |   |-- PromptCandidateCollector.js
|   |   |   `-- PromptCandidateCollector.test.mjs
|   |   |-- reconstruction/
|   |   |   |-- PromptDecisionEngine.js
|   |   |   |-- PromptDecisionEngine.test.mjs
|   |   |   |-- PromptFindingState.js
|   |   |   |-- PromptFindingState.test.mjs
|   |   |   |-- PromptReconstructionEngine.js
|   |   |   |-- PromptReconstructionEngine.test.mjs
|   |   |   `-- partialSemantics.test.mjs    # shield tests for what `partial` means at each level
|   |   |-- runtime/
|   |   |   |-- PromptMutationQueue.js
|   |   |   `-- PromptMutationQueue.test.mjs
|   |   |-- tests/
|   |   |   |-- PromptSplittingCorpus.test.mjs
|   |   |   |-- PromptSplittingCorpus.v1.mjs
|   |   |   |-- PromptSplittingDefaultPolicy.test.mjs  # the corpus on the SHIPPED default policy (C5.5)
|   |   |   |-- PromptSplittingPilotCorpus.test.mjs
|   |   |   `-- PromptSplittingPilotCorpus.v1.mjs
|   |   |-- fixtures/
|   |   |   |-- priority8-test-page.html
|   |   |   |-- priority9-pilot-page.html
|   |   |   `-- priority10-context-observation.html
|   |   |-- README.md
|   |   `-- README.ru.md
|   `-- api-interception/
|       |-- ApiInterceptor.js
|       |-- attributeMutations.test.mjs        # shield: in-place attribute swaps reach the DOM path (14.1)
|       |-- decision/
|       |   |-- apiMimeDecision.js
|       |   `-- apiMimeDecision.test.mjs
|       |-- runtime/
|       |   |-- apiMetadataNormalization.js
|       |   |-- ApiFindingState.js
|       |   |-- ApiFindingState.test.mjs
|       |   |-- ApiResourceObserver.js
|       |   |-- ApiResourceObserver.test.mjs
|       |   `-- BackgroundIntegration.test.mjs
|       |-- permissions/
|       |   |-- apiPermissionContract.js
|       |   |-- ApiPermissionCoordinator.js
|       |   |-- ApiPermissionCoordinator.test.mjs
|       |   `-- ApiPermissionUiContract.test.mjs
|       |-- fixtures/
|       |   |-- metadata-pilot-page.html
|       |   `-- priority2-resource-page.html
|       |-- tests/
|       |   |-- helpers/ApiTestHarness.mjs
|       |   |-- ApiTestHarness.test.mjs
|       |   |-- BrowserPortabilityContract.test.mjs
|       |   |-- metadata-fixture-server.mjs
|       |   |-- metadata-fixture-server.test.mjs
|       |   |-- Priority4Privacy.test.mjs
|       |   |-- priority2FixtureServer.mjs
|       |   |-- priority2FixtureServer.test.mjs
|       |   `-- runPriority4Suite.mjs
|       |-- README.md
|       `-- README.ru.md
|
|-- js/
|   |-- background.js
|   |-- backgroundRuntime.test.mjs           # core-contract shield tests (listener registration, config reapply, scan target)
|   |-- content.js
|   |-- findings-api.js
|   |-- intervention-layer.js               # active remediation: intention queue, applied-edit registry, rollback (C4.3)
|   |-- interventionLayer.test.mjs          # shield: gate closed by default, marks are ours, disabling reverts, link and region notes go beside the node (C4.3)
|   |-- findings-api.test.mjs
|   |-- info-page.js
|   |-- popup.js
|   |-- snapshotShape.test.mjs               # shield: one snapshot shape for both paths (C1) + shared per-tab slice cap (C2)
|   |-- startupNoScan.test.mjs               # shield: startup, session restore and SW restart wake at most one tab (C2)
|   |-- tabSwitchRescan.test.mjs             # shield: returning to an unchanged tab does not rescan (C2)
|   `-- options.js
|
|-- platform/
|   |-- browser.js
|   `-- browser.test.mjs                     # shield: Chrome callback vs Firefox promise, lastError, missing area, sync throw
|
|-- ui/
|   |-- about.html
|   |-- help.html
|   |-- popup.html
|   |-- options.html
|   `-- components/
|       |-- header.html
|       |-- module-card.html
|       `-- theme-switcher.html
|
|-- utils/
|   |-- config-manager.js
|   |-- configPersistence.test.mjs           # shield tests for config durability (deferred sync write, local fallback, migration)
|   |-- i18n.js
|   |-- logger.js
|   |-- logger.test.mjs                      # shield test for log level validation
|   |-- settingsValidation.test.mjs          # shield: every string-valued setting has an allowed-value list (C4.2)
|   `-- theme-manager.js
|
|-- styles/
|   |-- content.css
|   |-- popup.css
|   |-- options.css
|   |-- components/
|   `-- themes/
|
|-- rules/
|   `-- ruleset.json
|
|-- manifests/
|   `-- manifest.firefox.overlay.json
|
|-- scripts/
|   |-- build-extension.mjs
|   `-- certify-local-release.mjs
|
|-- tests/
|   |-- encoding.test.mjs
|   |-- data-lists.test.mjs                  # shield: every offline data list carries @data-list with its staleness direction (C7.2)
|   |-- i18n-coverage.test.mjs               # shield: EN/RU key parity, every data-i18n key translated
|   |-- manifest-contract.test.mjs
|   `-- release-certification.test.mjs
|
|-- .gitignore
|-- CONTRIBUTING.md
|-- manifest.json
|-- PACKAGING.md
|-- PACKAGING.ru.md
|-- README.md
|-- README.ru.md
`-- STRUCTURE.md
## Public repository scope

`STRUCTURE.md` is the only maintained project-structure reference. A separate Russian structure copy is intentionally not kept.

The tree above lists only files intended for the public source repository. Internal AI instructions, task and validation working documents, pilot notes, observation registries, local credentials, generated packages, and generated `release/` evidence are excluded by the root `.gitignore`.
## Selected File Notes

### `scripts/build-extension.mjs` and `manifests/manifest.firefox.overlay.json`
Dependency-free local packaging for Chrome, Edge, and Firefox. The root manifest remains the canonical Chromium source; the Firefox overlay projects an event-page module background, excludes DNR artifacts, and intentionally has no Gecko ID. Generated `dist/` artifacts are disposable and excluded from packages.

### `tests/encoding.test.mjs`

Deterministic UTF-8 contract for the **shipped** file set (the same filter `scripts/build-extension.mjs` uses). Rejects files that are not valid UTF-8 and the byte sequences that appear when UTF-8 text is read as cp1251 and written back. Locale files are additionally parsed as JSON. Development docs are not shipped and are not scanned, so `TASKS.ru.md` may quote damaged bytes as evidence.

### `tests/manifest-contract.test.mjs`
Deterministic manifest and package-inventory checks. They verify that source Chrome/Edge manifests remain unchanged, the Firefox projection excludes unsupported DNR material, and development files cannot enter generated artifacts.

### `scripts/certify-local-release.mjs`

Dependency-free local pre-certification. It writes ignored, local evidence for static/manual gates; it is not included in extension packages and cannot claim browser validation or a store-ready `go` outcome.

### `tests/release-certification.test.mjs`

Deterministic contract for the local evidence generator. It verifies byte-stable repeated generation, candidate identity fields, privacy-safe evidence shape, and the required `reject` result while legacy DNR material and the quarantined DOM stub remain.

### `modules/*.test.mjs`
Shield tests for the contracts `ModuleCore` owns: one analysis pass at a time (C5.1) and the three-level error policy (C5.6). They drive `ModuleCore` directly, without any module.

### `modules/ModuleCore.js`
Shared lifecycle base for security modules. Its default detector hooks are deliberately passive: inheriting from `ModuleCore` does not scan the DOM and does not install a `MutationObserver`. A module that needs continuous DOM observation must explicitly set `usesMutationObserver = true` and implement a bounded `handleMutations()` pipeline. Initial analysis likewise requires a bounded module-specific `firstScan()` implementation. `updateConfig()` returns an optional lifecycle-impact result; the default is `{ requiresDetectionRefresh: false }`, while a module may request a serialized refresh after applying a complete validated configuration snapshot.

### `modules/semantic-analysis/SemanticAnalysisCore.js`
Pure shared semantic infrastructure for bounded text candidates. It owns catalog validation, Unicode normalization, literal matching, semantic classification, and risk evaluation, while callers retain DOM access, lifecycle, findings, and storage responsibilities.

### `modules/prompt-splitting/collectors/PromptCandidateCollector.js`
Module-local, iterative Priority 3 collector. It creates bounded scan-local fragments, independent candidate boundaries, and structural local regions without reconstructing text, invoking semantic analysis, or creating findings.

### `modules/prompt-splitting/reconstruction/PromptReconstructionEngine.js`
Module-local Priority 4 reconstruction engine. It streams bounded consecutive same-source windows from one collector region, emits at most three deduplicated assembly paths, and clears reconstructed text immediately after its consumer returns.

### `modules/prompt-splitting/reconstruction/PromptDecisionEngine.js`
Module-local Priority 5 decision engine. It invokes the shared core through its opt-in transient contribution map, requires multi-candidate evidence, and returns bounded metadata-only confidence decisions without findings or persistent state.

### `modules/prompt-splitting/reconstruction/PromptFindingState.js`
Module-local Priority 6 active-state component. It performs bounded pending-batch reconciliation, overlap deduplication, atomic commits, reverse indexing, monotonic finding revisions, and privacy-safe runtime/cache projections.

### `modules/prompt-splitting/runtime/PromptMutationQueue.js`
Module-local Priority 7 queue. It immediately converts mutation work into bounded live roots and removed candidate identities, coalesces ancestor/descendant roots, and never retains mutation records or removed-node text.

### `modules/prompt-splitting/tests/PromptSplittingCorpus.v1.mjs`
Versioned, synthetic Priority 8 corpus for deterministic prompt-splitting decision coverage. It contains only safe fixture metadata and no user data or third-party page text.

### `modules/prompt-splitting/tests/PromptSplittingPilotCorpus.v1.mjs`
Versioned Priority 9 pilot corpus split into calibration, immutable regression, and held-out control cases. It preserves privacy-safe synthetic metadata and keeps control cases out of parameter tuning.

### `modules/prompt-splitting/fixtures/priority9-pilot-page.html`
Local-only Priority 9 fixture with synthetic article, forum, documentation, dashboard, table, card, ARIA-surface, and SPA-replacement scenarios. It loads no external resources.

### `modules/prompt-splitting/fixtures/priority10-context-observation.html`
Local-only synthetic fixture for the recorded documentation/quotation/code context observation. It exists for future reproducibility and uses no external resources.

### `modules/visual-manipulation/VisualManipulationDetector.js`
Main module entry point for hidden-content and visual-manipulation checks. Keeps the existing module API and orchestrates internal detector files, including future DOM-level image presentation heuristics such as tiny images, hidden images, and suspicious inline SVG markers.

### `modules/visual-manipulation/detectors/*.js`
Grouped stub detectors for hidden text, hidden inputs, overlays, style obfuscation, and related DOM-level image presentation checks. These files should hold category-level heuristics, not one-file-per-micro-rule.

### `modules/visual-manipulation/utils/domUtils.js`
Shared small DOM helper functions used only by the visual-manipulation module.

### `modules/visual-manipulation/utils/findingFactory.js`
Shared finding-shape helpers for consistent passive findings returned by the visual-manipulation module. Also the single place where the module's severity vocabulary is enforced on every finding.

### `modules/visual-manipulation/utils/severityModel.js`
Severity vocabulary of the module (`low`/`medium`/`high`) and the two pure operations that move a verdict along it. Shares its levels with `semantic-analysis` so a level means the same thing in the UI and in the findings API; the resolution rule itself stays per-module.

### `modules/link-domain-security/LinkDomainSecurityDetector.js`
Main module entry point for link and domain analysis. Keeps the existing module API and orchestrates internal detector files.

### `modules/link-domain-security/detectors/*.js`
Grouped stub detectors for hostname analysis, target navigation analysis, and visible-text mismatch checks. Navigation-target analysis also owns the page-level `<base href>` check, because that is the same question - where navigation actually goes - asked about the document instead of one link.

### `modules/link-domain-security/utils/*.js`
Shared helpers for URL parsing, domain checks, and finding normalization used only by the link-domain-security module. `domainUtils.js` carries the two lists that decide whether a caption label is a zone: the TLD allowlist and the file-extension override that wins over it.

### `modules/api-interception/ApiInterceptor.js`
Quarantined legacy content-side DOM stub. It is not imported, activated, or used as a snapshot source; physical removal waits for the required Chrome migration validation.

### `modules/api-interception/runtime/ApiResourceObserver.js`
Background-owned passive metadata observer for one foreground tab. It uses only non-blocking `webRequest` events for `xmlhttprequest` and `image`, maintains bounded ephemeral state, and exports aggregate observation state without findings or raw metadata.

### `modules/api-interception/runtime/apiMetadataNormalization.js`
Pure module-local normalization of the bounded request method, response status, and declared MIME allowlists. It imports no Chrome APIs and never emits raw URL or header data.

### `modules/api-interception/decision/apiMimeDecision.js`
Pure Priority 3 candidate rule for final successful image observations with an explicit document or script declared MIME allowlist. It emits only immutable bounded category metadata and has no browser, DOM, URL, or payload access.

### `modules/api-interception/runtime/ApiFindingState.js`
Background-local Priority 3 candidate aggregation. It retains at most the `document` and `script` categories with bounded counts and an immutable internal diagnostic projection; its product projection is always empty before Stage 4 acceptance.

### `modules/api-interception/permissions/ApiPermissionCoordinator.js`
Module-local optional-permission transaction coordinator. It separates synchronized desired intent from browser-local capability, verifies a grant before activation, pauses immediately on revoke or disable, and exposes only bounded normalized state.

### `modules/api-interception/fixtures/priority2-resource-page.html`
Local-only Chrome fixture page for main-frame image, XHR, redirect, and iframe observation scenarios.

### `modules/api-interception/tests/priority2FixtureServer.mjs`
Ephemeral localhost-only fixture server and its contract test. They provide no external requests or extension-side network behavior.

### `modules/api-interception/tests/metadata-fixture-server.mjs` and `helpers/ApiTestHarness.mjs`
Local synthetic Priority 4 infrastructure for metadata routes and deterministic browser-event simulation. It retains bounded fixture route identifiers only and does not perform extension-side network activity.

### `modules/api-interception/tests/BrowserPortabilityContract.test.mjs`
Priority 8 synthetic contract test. It applies the same event corpus to three API facades and verifies passive unavailable behavior when an event is missing or listener registration fails.

