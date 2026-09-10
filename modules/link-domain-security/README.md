# Link & Domain Security Module

## Purpose
Analyzes links, domains, redirects, homograph signals, and unsafe navigation protocols.

## Architecture
- `LinkDomainSecurityDetector.js` is the module entry point and orchestrator.
- `detectors/hostnameSecurityDetector.js` contains current-hostname and target-hostname stub analysis.
- `detectors/navigationTargetDetector.js` contains unsafe-protocol, redirect-pattern and `<base href>` stub analysis.
- `detectors/visibleMismatchDetector.js` contains visible-text vs target-hostname mismatch stub analysis.
- `utils/urlUtils.js` stores URL parsing and redirect-query helpers.
- `utils/domainUtils.js` stores hostname, protocol, and mismatch helpers.
- `utils/findingFactory.js` stores finding-shape helpers for this module.

## Current Status
- MVP heuristic stub.
- The module is wired into the runtime and produces passive findings.
- It never blocks navigation. With the intervention gate open it publishes the node of a `link-mismatch` finding, and the layer - not the module - places a note next to the link.

## Config Keys
- `enabled`
- `detectHomographs`
- `detectLinkMismatch`
- `detectRedirectPatterns`
- `detectUnsafeProtocols`
- `sensitivity`
- `actionOnDetect`

## Current Behavior
- Reviews the current hostname for punycode, mixed-script and whole-script confusable signals. A label
  written entirely in a non-Latin script whose every letter has a Latin lookalike is the canonical
  homograph and is reported as `hostname-confusable`; legitimate IDN names are not escalated. A name
  written in the script of its own IDN zone (`сахар.рф`) is not a lookalike, and labels shorter than
  four letters are not considered at all. A name written in ordinary letters with one substituted
  character that no language uses in a domain name - the IPA and small-capital blocks, as in
  `gogleɟ.com` - is reported the same way: the rules differ, the sentence the user reads does not.
  Letters of real orthographies (`ü`, `ı`, `ł`, `ø`, `ß`) are never treated as substitutions.
  Script mixing counts any two of Latin, Cyrillic and Greek inside one label. The plain punycode notice is reported only where the script does not belong to
  the zone - a Cyrillic name under `.com`, not a Cyrillic name under `.рф`. In an ASCII zone it is
  always reported, because there it is the only signal that can see a lookalike written in unusual
  Latin letters.
- Checks `a[href]`, `form[action]` and `formaction` on submit controls. A `formaction` overrides the
  form's own action, so a form that looks harmless can still submit anywhere; the target is analysed
  by the same rules, and the control contributes no visible text (its label lives in `value`).
- Resolves relative targets against `document.baseURI`, so a `<base href>` cannot silently retarget
  the links the module analyses. A `<base href>` pointing at another origin is itself reported as
  `base-origin-mismatch`: it retargets every relative link on the page at once.
- Flags unsafe protocols (`javascript:`, `vbscript:`, `data:`, `file:`) and common redirect-pattern query parameters. A redirect destination that
  cannot be parsed as a URL but is shaped like one - a bare host, a base64 payload, a doubly encoded
  URL - is reported at low severity; short identifier-like values are ignored. The length floor
  applies to the encoded and base64 shapes only: a bare hostname is judged by its own guard, so
  `?url=evil.com` is not missed for being short.
- Detects visible-text / target mismatch cases. Every hostname NAMED in the caption is compared, not
  only a caption that is nothing but a hostname, so "Sign in at paypal.com" is checked; any named host
  matching the destination clears the caption. The visible text counts as a hostname only when its
  last label is a known zone and not a file extension, so file names, dates, prices and dotted code
  identifiers (`Object.keys`, `os.path`) in a link caption are not mismatches.
  Known limit: a caption naming a brand whose file is served from a CDN on a different registrable
  domain reads as a mismatch. Without a Public Suffix List nothing offline separates that from a real
  one; a CDN on a subdomain of the same domain is quiet.
- Findings are identified by content, not by node: a re-render of the same links does not report them
  again. Keys live for the scan and are evicted FIFO at the cap.
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
The module stays passive: for a `link-mismatch` finding it publishes `emitFindingNode(finding, node)` and never writes to the page itself. When the gate is open the layer places a note NEXT TO the link rather than inside it - a note inside `<a>` would become part of the visible caption this detector compares against the href. Active intervention is gated by `settings.activeRemediationEnabled` (off by default) and applied by `js/intervention-layer.js`.

Real-Chrome acceptance with 50+ restored tabs, multiple windows, rapid switching, and sustained SPA mutations remains a required manual test.
