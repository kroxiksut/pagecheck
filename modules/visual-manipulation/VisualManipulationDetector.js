import ModuleCore from '../ModuleCore.js';
import { Logger } from '../../utils/logger.js';
import { scanHiddenText } from './detectors/hiddenTextDetector.js';
import { scanHiddenInputs } from './detectors/hiddenInputDetector.js';
import { scanOverlays } from './detectors/overlayDetector.js';
import { scanStyleObfuscation } from './detectors/styleObfuscationDetector.js';
import {
    describeElement,
    getElementPath,
    hasCandidateText,
    hasStyleObfuscationSignals,
    isInputHidden,
    isInputSurface,
    isLikelyOverlay,
    isOffscreen,
    isOverlayNamed,
    isPasswordInput,
    isVisuallyHidden,
    resolveViewportGeometry,
    resolveViewportSize,
    resolveWindowInnerSize
} from './utils/domUtils.js';
import { dedupeFindings, normalizeFindings } from './utils/findingFactory.js';

export default class VisualManipulationDetector extends ModuleCore {
    constructor() {
        super('Hidden-Content-Visual-Manipulation', true);
        this.usesMutationObserver = true;
        this.maxRecordedFindings = 20;
        this.recentFindings = [];
        this.totalFindingsCurrentScan = 0;
        this.seenDedupeKeys = new Set();
        this.maxDedupeKeys = 5000;
        this.detailedCandidatesScanned = 0;
        this.candidatesInspected = 0;
        this.candidateBudget = 250;
        this.candidateBudgetReached = 0;
        this.candidateBudgetReachedInBatch = false;
        this.initialPseudoStyleLookupLimit = 120;
        this.mutationPseudoStyleLookupLimit = 24;
        this.pseudoStyleLookupsRemaining = 0;
        this.pseudoStyleLookupsSkipped = 0;
        this.pendingMutations = [];
        this.mutationBatchTimer = null;
        this.lastMutationBatchTime = 0;
        this.maxPendingMutations = 200;
        this.maxInitialTraversalElements = 10000;
        this.maxMutationTraversalElements = 1000;
        this.initialTraversalTimeBudgetMs = 30;
        this.initialAnalysisTimeBudgetMs = 60;
        this.mutationAnalysisTimeBudgetMs = 20;
        this.mutationRecordsDropped = 0;
        this.traversalElementsSkipped = 0;
        this.scanTimeBudgetReached = 0;
        this.partialResult = false;
        this.currentScanCache = null;
        this.colorParserContext = null;
        this.observerConfig = {
            ...this.observerConfig,
            attributes: true,
            characterData: true,
            attributeFilter: [
                'aria-hidden', 'aria-modal', 'class', 'contenteditable', 'dir', 'disabled',
                'for', 'hidden', 'lang', 'popover', 'role', 'style', 'tabindex'
            ]
        };
    }

    async firstScan() {
        if (!this.isEnabled) {
            return;
        }

        const startTime = performance.now();
        if (this.mutationBatchTimer !== null) {
            clearTimeout(this.mutationBatchTimer);
            this.mutationBatchTimer = null;
        }
        this.pendingMutations = [];
        this.resetStats();
        this.recentFindings = [];
        this.totalFindingsCurrentScan = 0;
        this.seenDedupeKeys.clear();
        this.candidatesInspected = 0;
        this.candidateBudgetReached = 0;
        this.mutationRecordsDropped = 0;
        this.traversalElementsSkipped = 0;
        this.scanTimeBudgetReached = 0;
        this.partialResult = false;
        this.beginCandidateBatch();
        this.pseudoStyleLookupsRemaining = this.initialPseudoStyleLookupLimit;
        this.pseudoStyleLookupsSkipped = 0;

        try {
            const candidates = [];
            let traversedElements = 0;
            const traversalStartedAt = performance.now();
            const traversalLimit = Math.min(
                this.maxInitialTraversalElements,
                Math.max(1000, this.candidateBudget * 20)
            );
            const pendingElements = document.documentElement ? [document.documentElement] : [];

            while (pendingElements.length > 0 && traversedElements < traversalLimit) {
                if (performance.now() - traversalStartedAt >= this.initialTraversalTimeBudgetMs) {
                    this.scanTimeBudgetReached += 1;
                    this.partialResult = true;
                    break;
                }

                const element = pendingElements.pop();
                traversedElements += 1;
                if (this.getCandidatePriority(element) > 0) {
                    candidates.push(element);
                }

                for (let index = element.children.length - 1; index >= 0; index -= 1) {
                    pendingElements.push(element.children[index]);
                }
            }

            if (pendingElements.length > 0) {
                this.traversalElementsSkipped += pendingElements.length;
                this.partialResult = true;
            }
            this.scanCandidates(candidates, this.initialAnalysisTimeBudgetMs);

            const duration = performance.now() - startTime;
            this.stats.elementsScanned = traversedElements;
            this.stats.totalScanTime = duration;
            this.stats.lastScanTime = duration;
            Logger.info(`[${this.moduleName}] Scan completed with ${this.totalFindingsCurrentScan} findings from ${this.candidatesInspected} candidates`);
        } catch (error) {
            Logger.error(`[${this.moduleName}] First scan failed:`, error);
            throw error;
        }
    }

    async performScan() {
        await this.firstScan();
        return {
            module: this.moduleName,
            threatsDetected: this.totalFindingsCurrentScan,
            findings: this.recentFindings.slice(0, 10),
            partialResult: this.partialResult,
            stats: this.getStats()
        };
    }

    scanElement(element, knownPriority = null) {
        if (!(element instanceof Element) || !this.isEnabled) {
            return;
        }

        if (isPasswordInput(element)) {
            return;
        }

        const priority = knownPriority ?? this.getCandidatePriority(element);
        if (priority === 0) {
            return;
        }

        if (this.detailedCandidatesScanned >= this.candidateBudget) {
            if (!this.candidateBudgetReachedInBatch) {
                this.candidateBudgetReached += 1;
                this.candidateBudgetReachedInBatch = true;
            }
            return;
        }

        this.detailedCandidatesScanned += 1;
        this.candidatesInspected += 1;
        const style = this.getComputedStyle(element);
        let normalizedText;
        const context = {
            element,
            style,
            module: this,
            findings: [],
            getNormalizedText: () => {
                if (normalizedText === undefined) {
                    normalizedText = (element.textContent || '').replace(/\s+/g, ' ').trim();
                }
                return normalizedText;
            },
            getPseudoStyle: (pseudoElement) => this.getPseudoStyle(context, pseudoElement)
        };
        const findings = [];

        if (this.config.detectHiddenText) {
            findings.push(...scanHiddenText(context));
            context.findings = findings;
        }

        if (this.config.detectHiddenInputs) {
            findings.push(...scanHiddenInputs(context));
            context.findings = findings;
        }

        if (this.config.detectOverlays || this.config.detectDeceptiveCapture) {
            findings.push(...scanOverlays(context));
            context.findings = findings;
        }

        if (this.config.detectStyleObfuscation) {
            findings.push(...scanStyleObfuscation({ ...context, supportingFindings: findings.slice() }));
            context.findings = findings;
        }

        if (findings.length === 0) {
            return;
        }

        const normalizedFindings = normalizeFindings(findings);
        const acceptedFindings = dedupeFindings(normalizedFindings, this.recentFindings).filter((finding) => {
            const dedupeKey = typeof finding.dedupeKey === 'string' ? finding.dedupeKey : '';
            if (!dedupeKey || this.seenDedupeKeys.has(dedupeKey)) {
                return !dedupeKey;
            }

            if (this.seenDedupeKeys.size < this.maxDedupeKeys) {
                this.seenDedupeKeys.add(dedupeKey);
            }
            return true;
        });

        if (acceptedFindings.length === 0) {
            return;
        }

        this.stats.threatsDetected += acceptedFindings.length;
        this.totalFindingsCurrentScan += acceptedFindings.length;
        acceptedFindings.forEach((finding) => this.recordFinding(finding));
    }

    getPseudoStyle(context, pseudoElement) {
        if (!['::before', '::after'].includes(pseudoElement)) {
            return null;
        }

        context.pseudoStyles ??= {};
        if (Object.hasOwn(context.pseudoStyles, pseudoElement)) {
            return context.pseudoStyles[pseudoElement];
        }

        if (this.pseudoStyleLookupsRemaining <= 0) {
            this.pseudoStyleLookupsSkipped += 1;
            return null;
        }

        this.pseudoStyleLookupsRemaining -= 1;
        const pseudoStyle = window.getComputedStyle(context.element, pseudoElement);
        context.pseudoStyles[pseudoElement] = pseudoStyle;
        return pseudoStyle;
    }

    handleMutations(mutations) {
        if (!this.isEnabled) {
            return;
        }

        const remainingCapacity = Math.max(0, this.maxPendingMutations - this.pendingMutations.length);
        if (remainingCapacity === 0) {
            this.mutationRecordsDropped += mutations.length;
            this.partialResult = true;
            return;
        }

        let accepted = 0;
        for (const mutation of mutations) {
            if (!this.isRelevantMutation(mutation)) {
                continue;
            }
            if (accepted >= remainingCapacity) {
                this.mutationRecordsDropped += 1;
                this.partialResult = true;
                continue;
            }
            this.pendingMutations.push(mutation);
            accepted += 1;
        }

        if (accepted === 0) {
            return;
        }
        this.scheduleMutationBatch();
    }

    isRelevantMutation(mutation) {
        return mutation.type === 'attributes'
            || mutation.type === 'characterData'
            || mutation.addedNodes.length > 0;
    }

    processMutationBatch(mutations) {
        const startTime = performance.now();

        try {
            const candidates = new Set();
            let traversedElements = 0;
            let traversalLimitReached = false;
            const addCandidate = (element) => {
                if (!(element instanceof Element) || !element.isConnected) {
                    return false;
                }
                if (traversedElements >= this.maxMutationTraversalElements) {
                    traversalLimitReached = true;
                    return false;
                }
                traversedElements += 1;
                candidates.add(element);
                return true;
            };

            mutationLoop: for (const mutation of mutations) {
                if (mutation.type === 'attributes' && mutation.target instanceof Element) {
                    addCandidate(mutation.target);
                }

                if (mutation.type === 'characterData' && mutation.target.parentElement instanceof Element) {
                    addCandidate(mutation.target.parentElement);
                }

                for (const node of mutation.addedNodes) {
                    if (traversalLimitReached) {
                        break mutationLoop;
                    }
                    if (!(node instanceof Element) || !addCandidate(node)) {
                        continue;
                    }

                    const pendingElements = [];
                    for (let index = node.children.length - 1; index >= 0; index -= 1) {
                        pendingElements.push(node.children[index]);
                    }
                    while (pendingElements.length > 0 && !traversalLimitReached) {
                        const candidate = pendingElements.pop();
                        if (!addCandidate(candidate)) {
                            break;
                        }
                        for (let index = candidate.children.length - 1; index >= 0; index -= 1) {
                            pendingElements.push(candidate.children[index]);
                        }
                    }
                }
            }

            if (traversalLimitReached) {
                this.traversalElementsSkipped += 1;
                this.partialResult = true;
            }
            this.stats.elementsScanned += traversedElements;
            this.scanCandidates([...candidates], this.mutationAnalysisTimeBudgetMs);

            const duration = performance.now() - startTime;
            this.stats.totalScanTime += duration;
            this.stats.lastScanTime = duration;
        } catch (error) {
            Logger.error(`[${this.moduleName}] Error processing mutation:`, error);
        }
    }

    beginCandidateBatch() {
        this.detailedCandidatesScanned = 0;
        this.candidateBudgetReachedInBatch = false;
        this.candidateBudget = this.resolveCandidateBudget();
    }

    scanCandidates(candidates, timeBudgetMs = this.initialAnalysisTimeBudgetMs) {
        const startedAt = performance.now();
        const priorityBuckets = [[], [], [], []];
        this.currentScanCache = {
            styles: new Map(),
            rects: new Map(),
            points: new Map(),
            paths: new Map(),
            viewportSize: null
        };

        try {
            for (const element of candidates) {
                if (performance.now() - startedAt >= timeBudgetMs) {
                    this.scanTimeBudgetReached += 1;
                    this.partialResult = true;
                    break;
                }
                const priority = this.getCandidatePriority(element);
                if (priority > 0) {
                    priorityBuckets[priority].push(element);
                }
            }

            for (let priority = 3; priority >= 1; priority -= 1) {
                for (const element of priorityBuckets[priority]) {
                    if (performance.now() - startedAt >= timeBudgetMs) {
                        this.scanTimeBudgetReached += 1;
                        this.partialResult = true;
                        return;
                    }
                    this.scanElement(element, priority);
                }
            }
        } finally {
            this.currentScanCache = null;
        }
    }

    getCandidatePriority(element) {
        if (!(element instanceof Element) || isPasswordInput(element)) {
            return 0;
        }

        const isInputCandidate = this.isInputSurface(element);
        const isInteractive = element.matches('a, button, label, iframe, [tabindex], [contenteditable], [role="button"], [role="link"]');
        if (isInputCandidate || isInteractive) {
            return 3;
        }

        if (this.hasCandidateText(element)) {
            return element.children.length <= 6 ? 2 : 1;
        }

        const hasInlineStyle = element.hasAttribute('style');
        const isOverlayCandidate = this.isOverlayNamed(element);
        const isSemanticCandidate = this.config.detectStyleObfuscation
            && (
                element.getAttribute('aria-hidden') === 'true'
                || ['presentation', 'none'].includes((element.getAttribute('role') || '').toLowerCase())
                || Boolean(element.closest('[aria-hidden="true"]'))
            );
        return hasInlineStyle || isOverlayCandidate || isSemanticCandidate ? 1 : 0;
    }

    resolveCandidateBudget() {
        const configuredValue = Number.parseInt(this.config.maxElements, 10);
        return Number.isFinite(configuredValue) && configuredValue >= 10 && configuredValue <= 5000
            ? configuredValue
            : 250;
    }

    resolveScanInterval() {
        const configuredValue = Number.parseInt(this.config.scanInterval, 10);
        return Number.isFinite(configuredValue) && configuredValue >= 100 && configuredValue <= 5000
            ? configuredValue
            : 1000;
    }

    scheduleMutationBatch() {
        if (this.mutationBatchTimer !== null) {
            return;
        }

        const delay = Math.max(0, this.resolveScanInterval() - (Date.now() - this.lastMutationBatchTime));
        this.mutationBatchTimer = setTimeout(() => {
            this.mutationBatchTimer = null;
            const mutations = this.pendingMutations.splice(0);
            if (mutations.length === 0 || !this.isEnabled) {
                return;
            }

            this.lastMutationBatchTime = Date.now();
            this.beginCandidateBatch();
            this.pseudoStyleLookupsRemaining = this.mutationPseudoStyleLookupLimit;
            this.processMutationBatch(mutations);
            this.onMutationsProcessed(mutations);

            if (this.pendingMutations.length > 0) {
                this.scheduleMutationBatch();
            }
        }, delay);
    }

    onConfigUpdate(oldConfig, newConfig) {
        if (oldConfig.scanInterval === newConfig.scanInterval || this.mutationBatchTimer === null) {
            return;
        }

        clearTimeout(this.mutationBatchTimer);
        this.mutationBatchTimer = null;
        this.scheduleMutationBatch();
    }

    onDestroy() {
        if (this.mutationBatchTimer !== null) {
            clearTimeout(this.mutationBatchTimer);
            this.mutationBatchTimer = null;
        }
        this.pendingMutations = [];
        this.lastMutationBatchTime = 0;
        this.currentScanCache = null;
        this.colorParserContext = null;
    }

    // Scan-local cache facade. Correctness invariants (Layer 1 optimization):
    // 1. Cache validity rests on detector passivity: no detector writes to the DOM while a scan
    //    runs (see Block E), so inside one synchronous scanCandidates() pass layout is frozen and
    //    computed styles, rects and hit-test results cannot change.
    // 2. The cache is strictly scan-local: created in scanCandidates(), dropped in the finally of
    //    that same call and in onDestroy(). It never reaches a snapshot, findings or storage.
    // 3. Base computed style is not pseudo-element style: `styles` holds getComputedStyle(element)
    //    without a pseudo argument; ::before/::after stay on the budgeted getPseudoStyle() path.
    // Every method falls back to a direct DOM call when no batch cache is active (scanElement can
    // be invoked outside scanCandidates), so correctness never depends on the cache being present.
    //
    // FACADE CONTRACT (Layer 3, 6.3). Detectors reach the DOM only through the `module` reference on
    // their scan context. The split is by what a function reads, not by taste:
    //  - Cache-aware wrappers (must be used, never bypassed): getComputedStyle, getRect,
    //    elementsFromPoint, getElementPath, getViewportSize, getRootFontSizePx,
    //    resolveViewportGeometry, getColorParser.
    //  - Predicate wrappers that combine style with geometry: isVisuallyHidden, isInputHidden,
    //    isLikelyOverlay, isOffscreen - they take the element, resolve the rect here, and hand pure
    //    data to utils/domUtils.js.
    //  - Plain delegates over pure helpers: hasCandidateText, isInputSurface, isOverlayNamed,
    //    hasStyleObfuscationSignals, describeElement.
    // A detector MAY import from utils/domUtils.js directly, but ONLY functions that do not read
    // layout - getElementMarker, getNormalizedText, isPasswordInput, resolveZIndex, findHidingSource
    // and the pure parsers. Anything calling getBoundingClientRect / window.innerWidth /
    // documentElement.clientWidth / getComputedStyle must go through a wrapper above, otherwise it
    // escapes the scan cache and can force layout per candidate.
    // Known accepted exceptions (element lookup, not layout): document.getElementById in
    // overlayDetector and document.querySelectorAll('label[for=...]') in hiddenInputDetector.
    getComputedStyle(element) {
        const cache = this.currentScanCache;
        if (!cache) {
            return window.getComputedStyle(element);
        }

        let style = cache.styles.get(element);
        if (style === undefined) {
            style = window.getComputedStyle(element);
            cache.styles.set(element, style);
        }
        return style;
    }

    getRect(element) {
        const cache = this.currentScanCache;
        if (!cache) {
            return element.getBoundingClientRect();
        }

        let rect = cache.rects.get(element);
        if (rect === undefined) {
            rect = element.getBoundingClientRect();
            cache.rects.set(element, rect);
        }
        return rect;
    }

    // Keyed by the exact coordinate pair, deliberately without rounding: rounding coordinates
    // would change which element the hit-test returns, so only truly identical points share a stack.
    // The cached array is treated as read-only by callers.
    elementsFromPoint(x, y) {
        const cache = this.currentScanCache;
        if (!cache) {
            return document.elementsFromPoint(x, y);
        }

        const key = `${x}:${y}`;
        let stack = cache.points.get(key);
        if (stack === undefined) {
            stack = document.elementsFromPoint(x, y);
            cache.points.set(key, stack);
        }
        return stack;
    }

    getElementPath(element) {
        const cache = this.currentScanCache;
        if (!cache) {
            return getElementPath(element);
        }

        let path = cache.paths.get(element);
        if (path === undefined) {
            path = getElementPath(element);
            cache.paths.set(element, path);
        }
        return path;
    }

    // max(window.innerWidth, documentElement.clientWidth) - the viewport size used for coverage
    // geometry. Constant for the duration of one synchronous scan, so it rides the batch cache;
    // reading documentElement.clientWidth is the part worth caching (it can force layout).
    getViewportSize() {
        const cache = this.currentScanCache;
        if (!cache) {
            return resolveViewportSize();
        }

        if (cache.viewportSize === null) {
            cache.viewportSize = resolveViewportSize();
        }
        return cache.viewportSize;
    }

    // Root font size for rem resolution. The underlying computed style already rides the style
    // cache, so this only adds the parse. NaN is passed through: callers own the fallback.
    getRootFontSizePx() {
        return Number.parseFloat(this.getComputedStyle(document.documentElement).fontSize);
    }

    resolveViewportGeometry(element) {
        return resolveViewportGeometry(this.getRect(element), this.getViewportSize());
    }

    // Canvas 2d context used only to normalize advanced CSS color notations through a fillStyle
    // round-trip. Created once per module instance, holds no page or user data, and is dropped in
    // onDestroy(). Returns null when a context is unavailable; callers must handle that.
    getColorParser() {
        if (!this.colorParserContext) {
            const colorParserCanvas = document.createElement('canvas');
            this.colorParserContext = colorParserCanvas.getContext('2d') || null;
        }

        return this.colorParserContext;
    }

    hasCandidateText(element) {
        return hasCandidateText(element);
    }

    isInputSurface(element) {
        return isInputSurface(element);
    }

    isOverlayNamed(element) {
        return isOverlayNamed(element);
    }

    isVisuallyHidden(style, element) {
        return isVisuallyHidden(style, this.getRect(element), resolveWindowInnerSize());
    }

    isInputHidden(style, element) {
        return isInputHidden(style, element, this.getRect(element), resolveWindowInnerSize());
    }

    isLikelyOverlay(style, element) {
        return isLikelyOverlay(style, element, this.getRect(element), this.getViewportSize());
    }

    hasStyleObfuscationSignals(style, element) {
        return hasStyleObfuscationSignals(style, element);
    }

    isOffscreen(element) {
        return isOffscreen(this.getRect(element), resolveWindowInnerSize());
    }

    describeElement(element) {
        return describeElement(element);
    }

    recordFinding(finding) {
        this.recentFindings.unshift({
            ...finding,
            timestamp: Date.now()
        });

        if (this.recentFindings.length > this.maxRecordedFindings) {
            this.recentFindings = this.recentFindings.slice(0, this.maxRecordedFindings);
        }
    }

    getStats() {
        return {
            ...super.getStats(),
            recentFindings: this.recentFindings.slice(0, 5),
            totalFindingsCurrentScan: this.totalFindingsCurrentScan,
            candidatesInspected: this.candidatesInspected,
            candidateBudget: this.candidateBudget,
            candidateBudgetReached: this.candidateBudgetReached,
            pseudoStyleLookupsSkipped: this.pseudoStyleLookupsSkipped,
            maxPendingMutations: this.maxPendingMutations,
            pendingMutations: this.pendingMutations.length,
            mutationRecordsDropped: this.mutationRecordsDropped,
            traversalElementsSkipped: this.traversalElementsSkipped,
            scanTimeBudgetReached: this.scanTimeBudgetReached,
            partialResult: this.partialResult
        };
    }
}
