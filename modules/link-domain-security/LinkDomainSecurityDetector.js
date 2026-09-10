import ModuleCore from '../ModuleCore.js';
import { Logger } from '../../utils/logger.js';
import { inspectCurrentHostname, inspectTargetHostname } from './detectors/hostnameSecurityDetector.js';
import { inspectDocumentBase, inspectNavigationTarget } from './detectors/navigationTargetDetector.js';
import { inspectVisibleTargetMismatch } from './detectors/visibleMismatchDetector.js';
import {
    analyzeHostname,
    hasVisibleTargetMismatch,
    isUnsafeProtocol
} from './utils/domainUtils.js';
import { normalizeFindings } from './utils/findingFactory.js';
import { hasRedirectPattern, parseUrl } from './utils/urlUtils.js';

const LINK_TEXT_PRIVACY_SELECTOR = 'input, textarea, select, option, optgroup, [contenteditable]:not([contenteditable="false"]), [role="textbox" i]';

// How often the bounded link-text walk consults the clock. The walk is already capped at
// maxLinkTextNodes, so the clock is a second-order guard and does not have to run per node.
const LINK_TEXT_BUDGET_CHECK_INTERVAL = 16;

export default class LinkDomainSecurityDetector extends ModuleCore {
    constructor() {
        super('Link-Domain-Security', true);
        this.usesMutationObserver = true;
        // The whole module reads two attribute values, so it has to watch them (C5.4 in the root
        // TASKS): without this, `el.href = 'https://evil.io'` after the render was a one-line bypass
        // of link-mismatch and unsafe-protocol. The filter is deliberately narrow - `attributes:
        // true` would put every class and style change of an animated page through this pipeline.
        this.observerConfig = {
            ...this.observerConfig,
            attributes: true,
            attributeFilter: ['href', 'action', 'formaction']
        };
        // This module keeps its findings across a pause (see onPause), so the runtime may bring it
        // back without a rescan when the document did not change while it was away.
        this.keepsStateWhilePaused = true;
        this.maxRecordedFindings = 20;
        this.maxSerializedFindings = 10;
        this.maxInitialElements = 20000;
        this.maxInitialCandidates = 3000;
        this.maxMutationElements = 1000;
        this.maxMutationCandidates = 300;
        this.maxPendingMutationRecords = 200;
        this.maxMutationNodesPerRecord = 100;
        this.maxMutationNodesPerBatch = 1000;
        this.maxPendingMutationRoots = 100;
        this.maxRawTargetCharacters = 8192;
        this.maxLinkTextCharacters = 2048;
        this.maxLinkTextNodes = 64;
        this.initialScanTimeBudgetMs = 100;
        this.mutationScanTimeBudgetMs = 25;
        this.mutationThrottle = 500;
        this.recentFindings = [];
        this.seenFindingKeys = new Set();
        this.maxFindingKeys = 5000;
        this.pendingMutationRoots = new Set();
        this.mutationBatchTimer = null;
        this.processedCandidateElements = new WeakSet();
        // Batch-scoped memo for hostname analysis (TASKS 7.10). A page links to a handful of hosts
        // and to each of them many times, so the punycode decode and the per-label regexes were
        // being repeated for every link. Lives next to processedCandidateElements and is dropped
        // with it: a batch is the longest window in which the DOM is guaranteed not to have moved
        // under us. Cap included - a page could, in principle, link to thousands of distinct hosts.
        this.hostnameAnalysisCache = new Map();
        this.maxHostnameAnalysisCacheEntries = 512;
        this.scanRevision = 0;
        this.currentElementLimit = this.maxInitialElements;
        this.currentCandidateLimit = this.maxInitialCandidates;
        this.currentElementsVisited = 0;
        this.currentCandidatesAnalyzed = 0;
        this.scanElementsVisited = 0;
        this.scanCandidatesAnalyzed = 0;
        this.currentScanDeadline = Number.POSITIVE_INFINITY;
        this.scanTimeBudgetReachedInBatch = false;
        this.resetWorkStats();
    }

    async firstScan() {
        if (!this.isEnabled) {
            return;
        }

        const startTime = performance.now();
        this.resetStats();
        this.recentFindings = [];
        this.seenFindingKeys.clear();
        this.resetErrorState();
        this.resetWorkStats();
        this.beginScanBatch(
            this.maxInitialElements,
            this.maxInitialCandidates,
            this.initialScanTimeBudgetMs
        );

        try {
            this.inspectCurrentLocation();
        } catch (error) {
            // Level 1 (C5.6): the page-level checks are units of work like any candidate, and
            // losing one has to show up as incomplete coverage. A bare warn left the scan reporting
            // `status: 'complete'` for a page whose hostname was never analysed (TASKS 7.14).
            // Backstop only - each check inside records its own context.
            this.recordUnitError('page-level-checks', error);
        }

        try {
            await this.collectCandidatesFromRoot(document.documentElement);
            this.scanRevision += 1;

            this.finishWorkSlice();
            const duration = performance.now() - startTime;
            this.stats.lastScanTime = duration;
            this.stats.totalScanTime = duration;

            Logger.info(`[${this.moduleName}] Target scan completed: ${this.currentCandidatesAnalyzed} candidates, ${this.currentElementsVisited} DOM elements, ${duration.toFixed(2)}ms`);
        } catch (error) {
            Logger.error(`[${this.moduleName}] Target scan failed:`, error);
            throw error;
        } finally {
            this.processedCandidateElements = new WeakSet();
        }
    }

    async performScan() {
        // The gate and the level-2 handler now live in ModuleCore (C7.3): this module was the only
        // one that had them, and four copies of performScan still let the exception escape.
        await this.runExplicitScan();
        // Форма снапшота живёт в ядре (C1): этот модуль собирал ровно её.
        return this.buildScanSnapshot();
    }

    scanElement(element) {
        if (!(element instanceof Element) || !this.isEnabled) {
            return;
        }

        // Loop-safety (C4): узел, вставленный расширением, кандидатом быть не может - иначе
        // наша собственная метка становится находкой, а находка - поводом для следующей метки.
        if (this.isExtensionOwnedElement(element)) {
            return;
        }

        // Classification runs on EVERY element of the document, so it is the one place where the
        // difference between a tag comparison and a selector engine call is worth having (TASKS
        // 7.7). Everything after this point costs only what a real candidate costs: the WeakSet
        // lookup and the clock read used to be paid by every <div> on the page too.
        const tagName = element.localName;
        const isLink = tagName === 'a' && element.hasAttribute('href');
        // `formaction` on a submit control OVERRIDES the form's own action, so a form that looks
        // harmless can submit anywhere (question В6 after Priority 7). It is the same hole `<base>`
        // was: an attribute elsewhere in the markup silently changes where navigation goes. No new
        // finding type - the target is analysed by the same rules as any other.
        const isForm = !isLink && tagName === 'form' && element.hasAttribute('action');
        const isFormActionControl = !isLink && !isForm
            && (tagName === 'button' || tagName === 'input')
            && element.hasAttribute('formaction');
        if (!isLink && !isForm && !isFormActionControl) {
            return;
        }

        if (this.processedCandidateElements.has(element)) {
            return;
        }

        this.processedCandidateElements.add(element);
        if (this.currentCandidatesAnalyzed >= this.currentCandidateLimit) {
            this.candidatesSkippedByLimit += 1;
            return;
        }

        let targetAttribute = 'action';
        if (isLink) {
            targetAttribute = 'href';
        } else if (isFormActionControl) {
            targetAttribute = 'formaction';
        }
        const rawTarget = element.getAttribute(targetAttribute);
        if (typeof rawTarget === 'string' && rawTarget.length > this.maxRawTargetCharacters) {
            this.targetsSkippedByLength += 1;
            return;
        }

        // Only links have a caption to compare. A submit control's label lives in its `value`
        // attribute, and reading input values is exactly what the privacy rule forbids - so a
        // formaction candidate deliberately gets no visible text and no mismatch check.
        const linkText = isLink && !element.matches(LINK_TEXT_PRIVACY_SELECTOR)
            ? this.getBoundedLinkText(element)
            : '';
        // The traversal reads the clock before every element, so this is the only budget check a
        // candidate needs: the one that stops the ANALYSIS. It is also why the counters below moved
        // under it - a candidate abandoned here was never analysed and must not be counted as one.
        if (this.isTimeBudgetReached()) {
            return;
        }

        this.currentCandidatesAnalyzed += 1;
        this.scanCandidatesAnalyzed += 1;
        this.inspectTarget(element, rawTarget, linkText, isLink);
    }

    async collectCandidatesFromRoot(root) {
        if (!(root instanceof Element) || !root.isConnected || !this.isEnabled) {
            return;
        }

        const pendingElements = [root];
        while (pendingElements.length > 0) {
            // The counters below are the frontier of the traversal - the elements we know by name
            // and decided not to visit. They are a LOWER BOUND on the skipped work, never the whole
            // subtree behind them: measuring that would need the very traversal we just aborted.
            // `traversalAborted` is what carries "we do not know how much is left" (C5.3).
            if (this.currentElementsVisited >= this.currentElementLimit) {
                this.elementsSkippedByLimit += pendingElements.length;
                this.traversalAborted = true;
                break;
            }
            if (this.isTimeBudgetReached()) {
                this.elementsSkippedByTime += pendingElements.length;
                this.traversalAborted = true;
                break;
            }
            // Потолок синхронного куска - не то же самое, что бюджет скана (C2). Бюджет отвечает
            // «сколько работы всего», а этот кусок - «сколько работы подряд»: 90 мс в бюджете всё
            // равно один длинный таск в main-thread страницы пользователя.
            if (this.shouldYieldSlice()) {
                await this.yieldSlice();
                // Страница за время уступки могла измениться, а модуль - уехать на паузу. Обе
                // проверки обязаны быть здесь, иначе продолжение работает на мёртвом состоянии.
                if (!this.isEnabled) {
                    this.traversalAborted = true;
                    break;
                }
            }

            const element = pendingElements.pop();
            if (!element.isConnected) {
                continue;
            }

            this.currentElementsVisited += 1;
            this.scanElementsVisited += 1;
            // The shared counter means visited elements, the same as in every other module (C7.1).
            // It used to be incremented per CANDIDATE here, so a page with thousands of elements and
            // twenty links reported twenty under a name that says otherwise.
            this.stats.elementsScanned += 1;
            try {
                this.scanElement(element);
            } catch (error) {
                // Level 1 (C5.6): a swallowed error used to be invisible - the candidate was gone
                // and the page still called itself fully analysed.
                this.recordUnitError('target-candidate', error);
            }

            for (let index = element.children.length - 1; index >= 0; index -= 1) {
                pendingElements.push(element.children[index]);
            }
        }
    }

    getBoundedLinkText(element) {
        const textParts = [];
        const pendingNodes = [];
        let charactersCollected = 0;
        let nodesVisited = 0;
        let truncated = false;

        for (let index = element.childNodes.length - 1; index >= 0; index -= 1) {
            pendingNodes.push(element.childNodes[index]);
        }

        while (pendingNodes.length > 0) {
            // The node cap is the real bound here (64 nodes), so the clock does not need reading on
            // every one of them: a typical caption is one to three nodes and used to pay a
            // performance.now() per node for nothing (TASKS 7.9). The budget still cuts a long walk
            // short, just at a coarser granularity than the cap itself.
            if (nodesVisited >= this.maxLinkTextNodes
                || (nodesVisited > 0
                    && nodesVisited % LINK_TEXT_BUDGET_CHECK_INTERVAL === 0
                    && this.isTimeBudgetReached())) {
                truncated = true;
                break;
            }

            const node = pendingNodes.pop();
            nodesVisited += 1;
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent || '';
                const remainingCharacters = this.maxLinkTextCharacters - charactersCollected;
                if (remainingCharacters <= 0) {
                    truncated = true;
                    break;
                }
                if (text.length > remainingCharacters) {
                    textParts.push(text.slice(0, remainingCharacters));
                    truncated = true;
                    break;
                }
                textParts.push(text);
                charactersCollected += text.length;
                continue;
            }

            if (!(node instanceof Element) || node.matches(LINK_TEXT_PRIVACY_SELECTOR)) {
                continue;
            }
            for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
                pendingNodes.push(node.childNodes[index]);
            }
        }

        if (truncated) {
            this.linkTextsTruncated += 1;
        }
        return textParts.join('');
    }

    // Page-level checks: the things that are true of the document rather than of one candidate.
    // Each is its own unit of work, so a failure of one is recorded on its own and does not take
    // the other down with it (C5.6).
    inspectCurrentLocation() {
        const pageFindings = [];

        try {
            pageFindings.push(...inspectCurrentHostname({ module: this }));
        } catch (error) {
            this.recordUnitError('current-hostname', error);
        }

        try {
            pageFindings.push(...inspectDocumentBase({ module: this }));
        } catch (error) {
            this.recordUnitError('document-base', error);
        }

        const findings = this.acceptFindings(normalizeFindings(pageFindings));
        this.stats.threatsDetected += findings.length;
        findings.forEach((finding) => this.recordFinding(finding));
    }

    // Findings have an identity by CONTENT, not by node (TASKS 6.4). A SPA that re-renders a list
    // of links hands the module brand-new elements describing the same links, so an element-keyed
    // set would let every re-render report the same problems again: recentFindings filled up with
    // copies of one line and stats.threatsDetected - the module badge - grew for as long as the
    // page lived. Keys are kept for the whole scan and evicted FIFO at the cap, the same contract
    // the visual-manipulation module uses for its dedupe keys.
    acceptFindings(findings) {
        return findings.filter((finding) => {
            const dedupeKey = typeof finding?.dedupeKey === 'string' ? finding.dedupeKey : '';
            if (!dedupeKey) {
                return true;
            }
            if (this.seenFindingKeys.has(dedupeKey)) {
                return false;
            }

            if (this.seenFindingKeys.size >= this.maxFindingKeys) {
                const oldestKey = this.seenFindingKeys.values().next().value;
                this.seenFindingKeys.delete(oldestKey);
            }
            this.seenFindingKeys.add(dedupeKey);
            return true;
        });
    }

    // `isLink` is passed in rather than re-derived: scanElement already classified this element, and
    // asking the selector engine the same question twice more per candidate was pure repetition
    // (TASKS 7.8).
    inspectTarget(element, rawTarget, linkText, isLink = element.localName === 'a') {
        if (typeof rawTarget !== 'string' || rawTarget.trim() === '' || rawTarget.trim().startsWith('#')) {
            return;
        }

        const targetUrl = this.parseUrl(rawTarget);
        if (!targetUrl) {
            return;
        }

        const requiresHostnameAnalysis = targetUrl.hostname && (
            this.config.detectHomographs || (
                this.config.detectLinkMismatch &&
                isLink &&
                linkText.trim() &&
                (targetUrl.protocol === 'http:' || targetUrl.protocol === 'https:')
            )
        );
        let hostnameAnalysis = null;
        if (requiresHostnameAnalysis) {
            // `null` is a legitimate cached answer here ("excluded hostname, nothing to say"), so
            // the presence check has to be `has`, not a truthiness test on the value.
            if (this.hostnameAnalysisCache.has(targetUrl.hostname)) {
                hostnameAnalysis = this.hostnameAnalysisCache.get(targetUrl.hostname);
            } else {
                hostnameAnalysis = this.analyzeHostname(targetUrl.hostname);
                if (this.hostnameAnalysisCache.size < this.maxHostnameAnalysisCacheEntries) {
                    this.hostnameAnalysisCache.set(targetUrl.hostname, hostnameAnalysis);
                }
            }
        }
        const context = { element, targetUrl, hostnameAnalysis, linkText, isLink, module: this };
        const findings = [
            ...inspectNavigationTarget(context),
            ...inspectTargetHostname(context)
        ];

        if (isLink && linkText.trim()) {
            findings.push(...inspectVisibleTargetMismatch(context));
        }

        if (findings.length === 0) {
            return;
        }

        const acceptedFindings = this.acceptFindings(normalizeFindings(findings));
        if (acceptedFindings.length === 0) {
            return;
        }

        this.stats.threatsDetected += acceptedFindings.length;
        acceptedFindings.forEach((finding) => {
            this.recordFinding(finding);
            // C4.3: узел отдаётся ровно здесь - в момент, когда находка принята, и ни мгновением
            // раньше. Что с ним делать, решает слой вмешательства: детектор остаётся пассивным и
            // при закрытом гейте вызов стоит одну проверку. Из всех находок модуля осмысленное
            // действие есть только у link-mismatch, и слой отбирает её сам по типу - фильтровать
            // здесь значило бы держать политику вмешательства в двух местах.
            this.emitFindingNode(finding, element);
        });
    }

    handleMutations(rawMutations) {
        if (!this.isEnabled) {
            return;
        }

        // Loop-safety (C4): наши собственные правки не работа страницы.
        const mutations = this.filterForeignMutations(rawMutations);
        if (mutations.length === 0) {
            return;
        }

        const recordLimit = Math.min(mutations.length, this.maxPendingMutationRecords);
        if (mutations.length > recordLimit) {
            this.mutationRecordsSkippedByLimit += mutations.length - recordLimit;
        }

        let mutationNodesInspected = 0;
        mutationLoop:
        for (let mutationIndex = 0; mutationIndex < recordLimit; mutationIndex += 1) {
            const mutation = mutations[mutationIndex];

            // An attribute change is one unit of work and rides the same budget as an added node.
            if (mutation.type === 'attributes') {
                if (this.pendingMutationRoots.size >= this.maxPendingMutationRoots) {
                    this.mutationRootsSkippedByLimit += 1;
                    this.mutationRecordsSkippedByLimit += Math.max(0, recordLimit - mutationIndex - 1);
                    break mutationLoop;
                }
                mutationNodesInspected += 1;
                if (mutation.target instanceof Element && mutation.target.isConnected) {
                    this.addMutationRoot(mutation.target);
                }
                if (mutationNodesInspected >= this.maxMutationNodesPerBatch) {
                    this.mutationRecordsSkippedByLimit += Math.max(0, recordLimit - mutationIndex - 1);
                    break;
                }
                continue;
            }

            if (mutation.type !== 'childList') {
                continue;
            }

            const nodeLimit = Math.min(
                mutation.addedNodes.length,
                this.maxMutationNodesPerRecord,
                Math.max(0, this.maxMutationNodesPerBatch - mutationNodesInspected)
            );
            if (mutation.addedNodes.length > nodeLimit) {
                this.mutationNodesSkippedByLimit += mutation.addedNodes.length - nodeLimit;
            }
            for (let nodeIndex = 0; nodeIndex < nodeLimit; nodeIndex += 1) {
                if (this.pendingMutationRoots.size >= this.maxPendingMutationRoots) {
                    // One unit of work increments exactly one counter exactly once (C5.3): the
                    // nodes left in THIS record are nodes, the records after it are records. The
                    // previous form counted the current, already partly processed record as a
                    // skipped record on top of the nodes it had just handled.
                    this.mutationRootsSkippedByLimit += 1;
                    this.mutationNodesSkippedByLimit += nodeLimit - nodeIndex;
                    this.mutationRecordsSkippedByLimit += Math.max(0, recordLimit - mutationIndex - 1);
                    break mutationLoop;
                }
                const node = mutation.addedNodes[nodeIndex];
                mutationNodesInspected += 1;
                if (node instanceof Element && node.isConnected) {
                    this.addMutationRoot(node);
                }
            }
            if (mutationNodesInspected >= this.maxMutationNodesPerBatch) {
                this.mutationRecordsSkippedByLimit += Math.max(0, recordLimit - mutationIndex - 1);
                break;
            }
        }

        if (this.pendingMutationRoots.size > 0) {
            this.scheduleMutationBatch();
        }
    }

    // The two passes stay two passes (TASKS 7.12). Merging them into one loop was tried and
    // measured: it makes the common case WORSE, because the first pass leaves as soon as it finds
    // an ancestor, while a merged loop pays a second contains() on every iteration before that
    // point - +16% contains() calls on the mutation benchmark. What was removed is the copy of the
    // set: deleting entries from a Set while iterating it is defined behaviour, already-visited
    // entries are simply gone, so `[...this.pendingMutationRoots]` allocated an array per added
    // node for nothing.
    addMutationRoot(root) {
        for (const pendingRoot of this.pendingMutationRoots) {
            if (pendingRoot.contains(root)) {
                return;
            }
        }

        for (const pendingRoot of this.pendingMutationRoots) {
            if (root.contains(pendingRoot)) {
                this.pendingMutationRoots.delete(pendingRoot);
            }
        }

        if (this.pendingMutationRoots.size >= this.maxPendingMutationRoots) {
            this.mutationRootsSkippedByLimit += 1;
            return;
        }
        this.pendingMutationRoots.add(root);
    }

    scheduleMutationBatch() {
        if (this.mutationBatchTimer !== null) {
            return;
        }

        const delay = Math.max(0, this.mutationThrottle - (Date.now() - this.lastMutationTime));
        this.mutationBatchTimer = setTimeout(async () => {
            this.mutationBatchTimer = null;
            const roots = [...this.pendingMutationRoots];
            this.pendingMutationRoots.clear();
            if (roots.length === 0 || !this.isEnabled) {
                return;
            }

            this.lastMutationTime = Date.now();
            // Через гейт C5.1. До слайсинга батч был одним синхронным куском и чередоваться с
            // полным сканом не мог физически; теперь он уступает event-loop, и гейт стал не
            // страховкой, а необходимостью.
            await this.runGuardedScan('mutation-batch', () => this.processMutationRoots(roots));
            if (this.pendingMutationRoots.size > 0) {
                this.scheduleMutationBatch();
            }
        }, delay);
    }

    async processMutationRoots(roots) {
        const startTime = performance.now();
        this.beginScanBatch(
            this.maxMutationElements,
            this.maxMutationCandidates,
            this.mutationScanTimeBudgetMs
        );

        try {
            for (const root of roots) {
                if (this.isTimeBudgetReached()) {
                    this.mutationRootsSkippedByTime += 1;
                    break;
                }
                await this.collectCandidatesFromRoot(root);
            }
            this.scanRevision += 1;
            this.finishWorkSlice();
            const duration = performance.now() - startTime;
            this.stats.totalScanTime += duration;
            this.stats.lastScanTime = duration;
        } catch (error) {
            Logger.error(`[${this.moduleName}] Error processing mutation roots:`, error);
        } finally {
            this.processedCandidateElements = new WeakSet();
        }
    }

    beginScanBatch(elementLimit, candidateLimit, timeBudgetMs) {
        this.currentElementLimit = elementLimit;
        this.currentCandidateLimit = candidateLimit;
        this.currentElementsVisited = 0;
        this.currentCandidatesAnalyzed = 0;
        // Бюджет теперь измеряет АКТИВНУЮ работу: обход уступает event-loop, и стенные часы включали
        // бы в бюджет чужое время - слайсинг выключал бы сам себя на первой уступке (C2).
        this.currentScanBudgetMs = timeBudgetMs;
        this.resetSliceAccounting();
        this.beginWorkSlice();
        this.scanTimeBudgetReachedInBatch = false;
        this.processedCandidateElements = new WeakSet();
        this.hostnameAnalysisCache.clear();
    }

    isTimeBudgetReached() {
        if (this.getScanActiveMs() <= this.currentScanBudgetMs) {
            return false;
        }

        if (!this.scanTimeBudgetReachedInBatch) {
            this.scanTimeBudgetReached += 1;
            this.scanTimeBudgetReachedInBatch = true;
        }
        return true;
    }

    // Everything reset here is scan-scoped on purpose: it feeds partialResult, and "this page was
    // not fully analysed" stays true until the page is scanned again (TASKS 6.7). The batch-scoped
    // pair lives in beginScanBatch and is reported under names that say so.
    resetWorkStats() {
        this.scanElementsVisited = 0;
        this.scanCandidatesAnalyzed = 0;
        this.traversalAborted = false;
        this.candidatesSkippedByLimit = 0;
        this.elementsSkippedByLimit = 0;
        this.elementsSkippedByTime = 0;
        this.targetsSkippedByLength = 0;
        this.linkTextsTruncated = 0;
        this.mutationRecordsSkippedByLimit = 0;
        this.mutationNodesSkippedByLimit = 0;
        this.mutationRootsSkippedByLimit = 0;
        this.mutationRootsSkippedByTime = 0;
        this.scanTimeBudgetReached = 0;
    }

    // Three signals of different natures, not one flag for all of them (C5.2 in the root TASKS):
    //  - budgetReached: a limit or the time budget stopped the work, the rest is unknown;
    //  - partialResult: coverage is incomplete - budgetReached, an aborted traversal, or a unit of
    //    work we explicitly skipped. This is what reaches the findings API, so it must mean exactly
    //    "part of the page was not analysed";
    //  - contentTruncated: the unit WAS analysed, on shortened data. A single 2049-character link
    //    caption used to mark a fully scanned page as partial for the rest of its life.
    // All three are scan-scoped and are not reset per batch: "this page was not fully analysed"
    // stays true until the next full scan.
    getSnapshotState() {
        const budgetReached = this.candidatesSkippedByLimit > 0
            || this.elementsSkippedByLimit > 0
            || this.elementsSkippedByTime > 0
            || this.mutationRecordsSkippedByLimit > 0
            || this.mutationNodesSkippedByLimit > 0
            || this.mutationRootsSkippedByLimit > 0
            || this.mutationRootsSkippedByTime > 0
            || this.scanTimeBudgetReached > 0;
        // A target skipped because its href is longer than the cap was never analysed at all, so it
        // is a coverage gap - unlike a truncated caption, where the analysis did run.
        // A unit skipped because it threw is a coverage gap like any other (C5.6).
        const partialResult = budgetReached
            || this.traversalAborted
            || this.scanFailed
            || this.unitErrorCount > 0
            || this.targetsSkippedByLength > 0;
        const contentTruncated = this.linkTextsTruncated > 0 || this.targetsSkippedByLength > 0;

        return {
            status: partialResult ? 'partial' : 'complete',
            partialResult,
            budgetReached,
            contentTruncated,
            traversalAborted: this.traversalAborted
        };
    }

    onDestroy() {
        this.stopScheduledWork();
        this.recentFindings = [];
        this.seenFindingKeys.clear();
    }

    // Pause keeps the results and drops everything else (C1/C2). What must go: the timer and the
    // queue, because they would fire in a background tab; the scan-local caches, because they are
    // only valid while the DOM is known not to have moved; and the deadline, because the next batch
    // sets its own. What stays: the findings and their identity keys - they describe the page, and
    // the page is still there. Rescanning to recompute them was measured as pure waste on an
    // unchanged page (`.agents/harness/run-tab-switching.mjs`).
    onPause() {
        this.stopScheduledWork();
    }

    stopScheduledWork() {
        if (this.mutationBatchTimer !== null) {
            clearTimeout(this.mutationBatchTimer);
            this.mutationBatchTimer = null;
        }
        this.pendingMutationRoots.clear();
        this.processedCandidateElements = new WeakSet();
        this.hostnameAnalysisCache.clear();
        this.currentScanDeadline = Number.NEGATIVE_INFINITY;
    }

    parseUrl(rawTarget) {
        return parseUrl(rawTarget);
    }

    isUnsafeProtocol(protocol) {
        return isUnsafeProtocol(protocol);
    }

    hasRedirectPattern(targetUrl) {
        return hasRedirectPattern(targetUrl);
    }

    analyzeHostname(hostname) {
        return analyzeHostname(hostname);
    }

    hasVisibleTargetMismatch(linkText, hostname, hostnameAnalysis) {
        return hasVisibleTargetMismatch(linkText, hostname, hostnameAnalysis);
    }

    describeElement(element) {
        const tag = element.tagName.toLowerCase();
        return `<${tag}>`;
    }

    recordFinding(finding) {
        // `dedupeKey` is internal bookkeeping and stops here (TASKS 7.16). It was travelling out of
        // the module inside recentFindings - which js/content.js hands on unsanitised in the stats
        // path - and for `unsafe-protocol` it carries up to 96 characters of the raw target, i.e. a
        // fragment of a javascript: payload or a data: URI taken off the page. The set of seen keys
        // already holds what the deduplication needs.
        const { dedupeKey, ...publishedFinding } = finding;
        this.recentFindings.unshift({
            ...publishedFinding,
            timestamp: Date.now()
        });

        if (this.recentFindings.length > this.maxRecordedFindings) {
            this.recentFindings = this.recentFindings.slice(0, this.maxRecordedFindings);
        }
    }

    // The snapshot state can be passed in by a caller that has just computed it: performScan needs
    // the same object twice, at the top level and inside stats, and used to derive it twice (TASKS
    // 7.18). Every other caller gets the same value it always got.
    getStats(snapshotState = this.getSnapshotState()) {
        return {
            ...super.getStats(),
            recentFindings: this.recentFindings.slice(0, 5),
            scanRevision: this.scanRevision,
            // Totals for the whole scan; the trailing `batch*` pair is the last batch only. Before
            // TASKS 6.7 the batch numbers were reported under these names, so a stats read taken
            // after a one-element mutation batch claimed one candidate for a page with thousands.
            elementsVisited: this.scanElementsVisited,
            candidatesAnalyzed: this.scanCandidatesAnalyzed,
            batchElementsVisited: this.currentElementsVisited,
            batchCandidatesAnalyzed: this.currentCandidatesAnalyzed,
            candidatesSkippedByLimit: this.candidatesSkippedByLimit,
            elementsSkippedByLimit: this.elementsSkippedByLimit,
            elementsSkippedByTime: this.elementsSkippedByTime,
            targetsSkippedByLength: this.targetsSkippedByLength,
            linkTextsTruncated: this.linkTextsTruncated,
            mutationRecordsSkippedByLimit: this.mutationRecordsSkippedByLimit,
            mutationNodesSkippedByLimit: this.mutationNodesSkippedByLimit,
            mutationRootsSkippedByLimit: this.mutationRootsSkippedByLimit,
            mutationRootsSkippedByTime: this.mutationRootsSkippedByTime,
            scanTimeBudgetReached: this.scanTimeBudgetReached,
            findingsTruncated: this.recentFindings.length > this.maxSerializedFindings,
            ...snapshotState
        };
    }
}
