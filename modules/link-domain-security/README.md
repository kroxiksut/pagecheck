# Link & Domain Security Module

## Purpose
Analyzes links, domains, redirects, homograph signals, and unsafe navigation protocols.

## Architecture
- `LinkDomainSecurityDetector.js` is the module entry point and orchestrator.
- `detectors/hostnameSecurityDetector.js` contains current-hostname and target-hostname stub analysis.
- `detectors/navigationTargetDetector.js` contains unsafe-protocol and redirect-pattern stub analysis.
- `detectors/visibleMismatchDetector.js` contains visible-text vs target-hostname mismatch stub analysis.
- `utils/urlUtils.js` stores URL parsing and redirect-query helpers.
- `utils/domainUtils.js` stores hostname, protocol, and mismatch helpers.
- `utils/findingFactory.js` stores finding-shape helpers for this module.

## Current Status
- MVP heuristic stub.
- The module is wired into the runtime and produces passive findings.
- It does not yet perform real marking or blocking on the page.

## Config Keys
- `enabled`
- `allowIntervention`
- `detectHomographs`
- `detectLinkMismatch`
- `detectRedirectPatterns`
- `detectUnsafeProtocols`
- `sensitivity`
- `actionOnDetect`

## Current Behavior
- Reviews the current hostname for punycode and mixed-script signals.
- Checks `a[href]` and `form[action]` targets.
- Flags unsafe protocols and common redirect-pattern query parameters.
- Detects obvious visible-text / target mismatch cases.
- Candidate collection is iterative and bounded; it does not materialize a page-wide or added-subtree `querySelectorAll()` result.

## Runtime and Performance
- Automatic continuous monitoring runs only in the foreground tab of the focused Chrome window and only in the main frame. Content-script injection alone does not activate the module.
- A paused/background explicit scan is bounded one-shot work. Observer, timer, pending roots, scan-local element references, and in-module finding details are removed on pause/destroy.
- Initial profile: 20,000 visited DOM elements, 3,000 target candidates, and 100 ms elapsed time.
- Mutation profile: 500 ms minimum interval, 200 incoming records, 100 added nodes per record, 1,000 added nodes per callback, 100 coalesced roots, 1,000 visited DOM elements, 300 candidates, and 25 ms elapsed time.
- Raw `href`/`action` longer than 8,192 characters is skipped and marks the snapshot partial. Visible link text reads at most 64 nodes and 2,048 characters while excluding form controls and editable surfaces.
- Overflow is discarded and exposed through bounded counters and `partialResult`; the detector never creates an unbounded catch-up queue.

## Session Snapshot
- On pause, the latest snapshot is serialized before module cleanup and sent only after the detector pipeline has stopped.
- `chrome.storage.session` stores counts, up to 10 normalized findings, revision, timestamp, and partial/stale state.
- Cached link findings contain only `type`, localized `summary`, `severity`, and `detector`. They never contain URLs, hostnames, `href`, `action`, visible link text, form values, finding details, or DOM references.
- The shared cache schema is versioned. Navigation and relevant configuration changes invalidate the snapshot without waking background tabs.

## Page Indicator Integration
- Findings from this module are expected to contribute to the shared page-level extension indicator.
- Each detected problem increments the shared action-icon counter by 1.
- If the page has at least one problem, the extension icon should turn red and display a badge with the problem count.
- If the page has no findings, the icon should display the classic green check mark.

## Guardrails
- Keep `LinkDomainSecurityDetector` as the public entry point.
- Do not split the module into one file per micro-heuristic.
- Keep network checks, DNS checks, reputation lookup, and blacklist integrations out of MVP scope.
- Do not add active link blocking or DOM intervention here without explicit approval.

## Notes
`allowIntervention` is still a future-facing testing gate. In the current MVP state the module remains passive.

Real-Chrome acceptance with 50+ restored tabs, multiple windows, rapid switching, and sustained SPA mutations remains a required manual test.
