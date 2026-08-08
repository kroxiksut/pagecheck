# Hidden Content & Visual Manipulation Module

## Purpose
Detects hidden text, hidden inputs, deceptive overlays, CSS-based visual manipulation signals, and suspicious image presentation patterns at the DOM and visual layer.

## Architecture
- `VisualManipulationDetector.js` is the module entry point and orchestrator.
- `detectors/hiddenTextDetector.js` contains hidden-text stub heuristics.
- `detectors/hiddenInputDetector.js` contains hidden-input and editable-surface stub heuristics.
- `detectors/overlayDetector.js` contains overlay and click-capture stub heuristics.
- `detectors/styleObfuscationDetector.js` contains CSS obfuscation and CSS text-presentation heuristics.
- `utils/domUtils.js` stores shared small DOM helper functions for this module.
- `utils/findingFactory.js` stores finding-shape helpers for this module.

### DOM access rule
Detectors read the DOM only through the `module` facade on their scan context, which serves computed
styles, rects, hit-test stacks, element paths, viewport size, root font size and the color parser from
a scan-local cache. A detector may import from `utils/domUtils.js` directly, but only functions that do
not read layout (for example `getElementMarker`, `getNormalizedText`, `isPasswordInput`, `resolveZIndex`,
`findHidingSource` and the pure parsers). Anything that would call `getBoundingClientRect`,
`window.innerWidth`, `documentElement.clientWidth` or `getComputedStyle` must go through the facade,
otherwise it escapes the cache and can force layout for every candidate. The full wrapper list lives in
the facade comment in `VisualManipulationDetector.js`.

## Scope Boundary
- This module owns DOM and visual presentation checks such as tiny images, hidden images, off-screen images, and suspicious inline SVG/image carriers.
- Declared MIME vs payload-signature checks are intentionally outside this module and belong to resource-level inspection.
- Semantic analysis of otherwise valid images that hide instructions for AI systems is deferred future scope.

## Current Status
- MVP heuristic implementation.
- The module is wired into the runtime and produces passive findings.
- It does not yet perform real blocking or DOM intervention.

## Config Keys
- `enabled`
- `allowIntervention`
- `detectHiddenText`
- `hiddenTextDisplayMode` (`ancestors` default, optional `self`)
- `detectHiddenInputs`
- `detectOverlays`
- `detectDeceptiveCapture`
- `detectStyleObfuscation`
- `trackRemovedBlocks`
- `scanInterval`
- `maxElements`
- `sensitivity`
- `actionOnDetect`

## Current Behavior
- Automatic continuous analysis runs only in the foreground tab of the focused Chrome window. Background tabs keep detectors paused.
- Losing foreground status disconnects the module observer, cancels its mutation timer, and clears pending mutation records.
- Explicit scans of paused tabs are bounded one-shot operations and do not leave the observer active.
- Automatic analysis currently runs only in the main frame. Independent full scans are not multiplied across iframes.
- Page-level counts and up to 10 sanitized visual findings per frame snapshot are cached in `chrome.storage.session`; navigation or relevant configuration changes invalidate the snapshot without waking every tab. Cached findings contain only bounded type, localized summary/details, severity, and detector fields. URL identity is limited to origin plus pathname, excluding query and fragment data.
- Scans candidate elements for hidden text and style-based suppression.
- Hidden-text checks have dedicated explainable branches for:
  - `display: none` (`self` / `ancestors` mode with explicit source in finding details),
  - `visibility: hidden`,
  - `opacity: 0`,
  - transparent glyph fill (`color: transparent`, zero-alpha colours, `-webkit-text-fill-color`; the near-transparent band up to alpha 0.05 needs extra context),
  - deliberate off-screen positioning,
  - `font-size` suppression (`0`, near-zero, and anomalously small with extra context).
- The transparent-text branch deliberately stays silent where a transparent fill is how visible text is produced: gradient/clipped text (`background-clip: text`) and glyphs drawn by `text-shadow` or `-webkit-text-stroke`. That evidence is conclusive, so it applies whatever the amount of text.
- Weaker evidence is treated differently. A declared transition/animation or a revealable-component marker (tooltip, dropdown, menu, modal, accordion, tab, skeleton, ...) only says the element looks like ordinary UI machinery - it does not prove the text is readable, and either is trivially added by the page. Such evidence suppresses hidden-text reporting only while the text is short enough to be a plain UI label; a larger payload is still reported. The decision is made once per element, so a branch cannot decline a case only for a later, less precise branch to claim it.
- Text and background colours are compared as they are actually painted: the backdrop is resolved by compositing translucent layers up to the nearest opaque one (falling back to the white browser canvas), a background image or gradient marks the backdrop as unknown and suppresses the contrast branch, and translucent glyph colours are composited onto that backdrop before contrast is measured.
- For `display: none` hidden-text checks, supports two modes:
  - `ancestors` (default): checks the element and its ancestors.
  - `self`: checks only the element itself.
- In `ancestors` mode a hidden region produces one finding, not one per hidden node. Attribution goes to the outermost `display: none` ancestor, so nested hidden blocks and every text node below them collapse onto a single finding, and that finding names the hiding container - the scanned node is reported only as a sample of the hidden text.
- A hidden container that looks like revealable UI (`role` of tabpanel/tab/menu/menuitem/dialog/tooltip/listbox, an `aria-expanded` or `aria-controls` attribute, a closed `<details>` around it, or a component marker) is reported at lower severity instead of being suppressed. Structure is stronger evidence than a class name, but the page author still controls it, so it may cost a severity level - never the finding itself.
- In the `font-size` suppression branch, low-contrast context currently supports color parsing for:
  - `rgb()` / `rgba()`,
  - `hsl()` / `hsla()`,
  - `lab()` / `lch()` / `oklab()` / `oklch()`,
  - `currentColor`,
  - hex colors (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`).
- Checks non-password inputs and editable surfaces for hidden presentation.
- Flags likely overlay layers and basic obfuscation signals.
- Detects presentation-only CSS spoofing on limited text and interactive candidates:
  - `unicode-bidi: bidi-override` and `isolate-override`;
  - textual `::before` / `::after` content that replaces a suppressed or empty DOM label;
  - active `-webkit-text-security` outside password fields.
- Reuses the current element's computed style and prior visual findings through a scan-local context. Pseudo-element style lookups have separate initial-scan and mutation-batch limits.
- Does not decode Punycode, inspect hostnames, compare labels with URLs, classify trigger phrases, or inspect input values.
- This is the planned home for image-presentation heuristics such as `1x1` or `2x2` images, hidden images, and active inline SVG markers at the DOM layer.
- Stores recent passive findings in module stats.
- Keeps the complete unique finding count for the active scan even when the retained finding history is capped.
- User-facing finding texts are localized through `_locales/en/messages.json` and `_locales/ru/messages.json`.

## Runtime Configuration Matrix

| Key | Runtime behavior |
| --- | --- |
| `enabled` | Enables or disables the complete module and its observer. |
| `detectHiddenText`, `hiddenTextDisplayMode`, `detectHiddenInputs`, `detectStyleObfuscation` | Independently enable their detector branches; hidden-text display mode is interpreted by the hidden-text detector. |
| `detectOverlays` | Enables full-screen, click-capture, stacking, and generic overlay checks. |
| `detectDeceptiveCapture` | Enables only deceptive-capture surface checks. |
| `maxElements` | Limits detailed candidates per initial scan and per mutation batch; invalid values fall back to `250`. |
| `scanInterval` | Sets the minimum interval between queued mutation batches; invalid values fall back to `1000` ms. Explicit `performScan()` is immediate. |
| `allowIntervention`, `actionOnDetect`, `trackRemovedBlocks`, `sensitivity` | Deferred configuration; they do not trigger intervention, notification, removed-content storage, or scoring changes. |

Runtime statistics expose only numeric candidate-budget diagnostics and a bounded finding history. Structural element paths are used only for module-local deduplication; they contain no text, form value, URL, or password data.

Initial traversal is iterative and bounded by element and elapsed-time limits. Mutation processing retains at most 200 records per queued batch, traverses at most 1000 elements from changed subtrees, and applies a separate analysis-time budget. Budget overflow marks the result as partial and increments diagnostic counters instead of creating an unbounded catch-up loop.

## Page Indicator Integration
- Findings from this module are expected to contribute to the shared page-level extension indicator.
- Each detected problem increments the action-icon counter by 1; a hidden-text finding also counts as one problem.
- If the page has at least one problem, the extension icon should turn red and display a badge with the problem count.
- If the page has no findings, the icon should display the classic green check mark.

## Guardrails
- Keep `VisualManipulationDetector` as the public entry point.
- Do not split the module into one file per micro-heuristic.
- Keep small reusable helpers inside this module unless they become cross-project utilities.
- Do not add active DOM intervention or blocking logic here without explicit approval.
- Do not move resource-level MIME or payload-signature sniffing into this module.

## Notes
`allowIntervention` is still a future-facing testing gate. In the current MVP state the module remains passive.
