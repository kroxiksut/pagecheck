# API Interception Module

## Purpose

Provides passive, local observation of selected browser resource metadata. Priority 2 is the observation-only foundation; Priority 3 adds an internal candidate-only MIME decision layer and still does not establish that a resource is harmful.

## Current Status

- Priority 2 background metadata pipeline and the Priority 3 internal candidate checkpoint are implemented; the module remains disabled by default.
- It observes only the foreground tab in the focused window and only after activation.
- The retired content-side `ApiInterceptor.js` DOM stub remains temporarily quarantined for the Chrome migration gate; it is neither loaded nor used as a snapshot source by `js/content.js`.
- The local Priority 4 suite passed on 2026-07-20. Chrome manual smoke, pilot outcome, and any product projection remain pending.

## Runtime Components

- `ApiInterceptor.js` — quarantined legacy DOM stub pending the required Chrome migration validation; it has no runtime owner or snapshot role.
- `runtime/apiMetadataNormalization.js` — pure bounded normalization of request method, response status, and declared MIME metadata.
- `runtime/ApiResourceObserver.js` — background-owned listener lifecycle, ephemeral request state, bounded queue, and aggregate observation state.
- `decision/apiMimeDecision.js` — pure, allowlisted candidate decision for unexpected document/script MIME declared by an image response.
- `runtime/ApiFindingState.js` — bounded candidate aggregation for the `document` and `script` categories.

`ApiResourceObserver` exposes the internal methods `activate(context)`, `pause(revision)`, `destroy()`, and `getObservationState()` for the background runtime. Browser event handlers remain internal.

## Observation Scope

- Resource types: `xmlhttprequest` and `image` only.
- Main frame of one active foreground tab only.
- Non-blocking `webRequest` events: `onBeforeRequest`, `onHeadersReceived`, `onBeforeRedirect`, `onCompleted`, and `onErrorOccurred`.
- Declared `Content-Type` is read only to extract one bounded normalized MIME type. The first 64 headers are considered; raw values above 256 characters are rejected and normalized MIME is limited to 128 characters.

No request or response body, request headers, cookies, credentials, form data, URL, query string, initiator, IP address, redirect target, or raw error text is stored or published.

## Lifecycle and Budgets

- Listener filters are registered for one tab and removed immediately on pause, navigation, foreground change, disablement, tab removal, or destroy.
- A superseding foreground transition invalidates the observer before waiting for the previous content lifecycle response.
- A one-shot content scan does not activate this observer or leave metadata listeners behind.
- Limits: 256 active records, 256 queued completed observations, 128 ephemeral ring entries, 64 records per batch, 8 redirects per request, and 10 ms batch work.
- Overflow, orphan events, normalization failures, and registration failures produce bounded aggregate counters and a `partial` or `unavailable` state. They never trigger replay, rescanning, or network requests.
- Aggregate state publication is coalesced to no more than once per 500 ms.
- Page-status session cache uses schema version `7`, which invalidates retired DOM API snapshots. It stores no API observation or candidate state. The internal candidate projection has schema version `1`, is ephemeral, and is reset on observer invalidation.

## Candidate and Output Boundary

The observer exports only a bounded revision, status, aggregate counters, overflow counters, and a partial flag. Priority 3 consumes bounded completed observations only inside the background runtime and produces at most two internal candidate categories: `document` and `script`. Candidate state never enters content scripts, ordinary page-status findings, total counts, badge, notifications, or session cache. Its product snapshot is deliberately empty until a separate Stage 4 pilot accepts a product projection.

## Scope Boundaries

- URL, hostname, redirect, homograph, and visible-target checks belong to `link-domain-security`.
- DOM-level image presentation checks belong to `visual-manipulation`.
- MIME-vs-payload-signature checks, payload analysis, page-world hooks, and active traffic intervention are out of scope for Priority 2.

## Configuration

- `enabled`
- `monitorOnly` — must be `true` for the observer to activate.
- `allowIntervention` — ignored by Priority 2; this stage never modifies traffic.

## Validation

## Optional Permission Lifecycle

`enabled` is synchronized desired intent, not proof of local browser capability. `ApiPermissionCoordinator` requests and verifies only `webRequest` with `http://*/*` and `https://*/*`; it pauses work on denial, failure, disable, or revoke. The coordinator retains no origins, prompt history, or raw browser errors. The deterministic suite includes coordinator, background-revoke, and UI-flow contracts; real browser validation remains pending.

`node modules/api-interception/tests/runPriority4Suite.mjs` passed on 2026-07-21. It runs the MIME decision, candidate-state, observer, background integration, test-harness, synthetic portability, privacy, and local fixture contracts. `PORTABILITY-MATRIX.md` records a contract-ready (not real-browser-validated) Chrome/Edge/Firefox facade checkpoint. `P5-FACT-INVENTORY.md` records exact reviewed revisions and status. Both records are maintainer-local documents and are not part of the public repository. The local fixture servers remain local-only. Chrome candidate-mode smoke and all post-pilot product work remain pending.
