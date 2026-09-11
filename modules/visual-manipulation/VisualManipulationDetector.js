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

// Share of one scan's time budget the candidate classification pass may consume before the
// detection pass starts on its own clock (TASKS 8.3).
const CLASSIFICATION_BUDGET_SHARE = 0.25;

export default class VisualManipulationDetector extends ModuleCore {
    constructor() {
        super('Hidden-Content-Visual-Manipulation', true);
        this.usesMutationObserver = true;
        // Пауза сохраняет находки (см. onPause), поэтому рантайм имеет право вернуть модуль без
        // рескана, когда документ за время паузы не менялся (C2, контракт resume в ModuleCore).
        this.keepsStateWhilePaused = true;
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

        this.resetErrorState();
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
        this.findingAnchors.clear();
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
            // Бюджеты этого модуля считаются по АКТИВНОЙ работе: обход и анализ уступают
            // event-loop, а стенные часы включали бы в бюджет чужое время (C2).
            this.resetSliceAccounting();
            this.beginWorkSlice();
            const traversalBudgetMs = this.initialTraversalTimeBudgetMs;
            const traversalLimit = Math.min(
                this.maxInitialTraversalElements,
                Math.max(1000, this.candidateBudget * 20)
            );
            const pendingElements = document.documentElement ? [document.documentElement] : [];

            while (pendingElements.length > 0 && traversedElements < traversalLimit) {
                if (this.getScanActiveMs() >= traversalBudgetMs) {
                    this.scanTimeBudgetReached += 1;
                    this.partialResult = true;
                    break;
                }
                // Потолок синхронного куска: обход самой тяжёлой страницы не имеет права быть одним
                // длинным таском в main-thread пользователя (C2).
                if (this.shouldYieldSlice()) {
                    await this.yieldSlice();
                    if (!this.isEnabled) {
                        this.partialResult = true;
                        break;
                    }
                }

                const element = pendingElements.pop();
                traversedElements += 1;
                // The priority computed here is carried into scanCandidates instead of being
                // thrown away and recomputed there (TASKS 8.2).
                const priority = this.getCandidatePriority(element);
                if (priority > 0) {
                    candidates.push([element, priority]);
                }

                for (let index = element.children.length - 1; index >= 0; index -= 1) {
                    pendingElements.push(element.children[index]);
                }
            }

            if (pendingElements.length > 0) {
                this.traversalElementsSkipped += pendingElements.length;
                this.partialResult = true;
            }
            await this.scanCandidates(candidates, this.initialAnalysisTimeBudgetMs);

            const duration = performance.now() - startTime;
            this.stats.elementsScanned = traversedElements;
            this.stats.totalScanTime = duration;
            this.stats.lastScanTime = duration;
            const completion = this.partialResult
                ? `truncated (timeBudgetHits=${this.scanTimeBudgetReached}, skippedElements=${this.traversalElementsSkipped})`
                : 'completed';
            Logger.info(`[${this.moduleName}] Scan ${completion} with ${this.totalFindingsCurrentScan} findings from ${this.candidatesInspected} candidates`);
        } catch (error) {
            // Level 2 (C5.6): the page could not be scanned, the module stays alive. Rethrowing
            // used to reach ModuleCore.init(), whose catch destroyed the module for the whole page.
            this.recordScanFailure('first-scan', error);
            this.partialResult = true;
        }
    }

    async performScan() {
        // Gate plus the level-2 error handler, shared by every module (C7.3).
        await this.runExplicitScan();
        // Форма снапшота живёт в ядре (C1); отсюда - только содержимое.
        return this.buildScanSnapshot();
    }

    // Находки этого модуля живут не в stats.threatsDetected, а в счётчике текущего скана.
    getFindingCount() {
        return Math.max(0, Math.trunc(Number(this.totalFindingsCurrentScan) || 0));
    }

    // Б1: находка, чьих узлов больше нет в документе, уходит из счётчика, из списка и из ключей
    // дедупликации - вернувшись на страницу, она будет найдена и посчитана заново.
    pruneDetachedFindings() {
        const detachedKeys = this.collectDetachedFindingKeys();
        if (detachedKeys.length === 0) {
            return 0;
        }
        const detached = new Set(detachedKeys);
        detachedKeys.forEach((key) => this.seenDedupeKeys.delete(key));
        this.recentFindings = this.recentFindings.filter((finding) => !detached.has(finding.dedupeKey));
        this.totalFindingsCurrentScan = Math.max(0, this.totalFindingsCurrentScan - detachedKeys.length);
        this.stats.threatsDetected = Math.max(0, this.stats.threatsDetected - detachedKeys.length);
        return detachedKeys.length;
    }

    scanElement(element, knownPriority = null) {
        if (!(element instanceof Element) || !this.isEnabled) {
            return;
        }

        // Loop-safety (C4): узел, вставленный расширением, кандидатом быть не может - иначе
        // наша собственная метка становится находкой, а находка - поводом для следующей метки.
        if (this.isExtensionOwnedElement(element)) {
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

            // Evict the oldest key instead of quietly leaving the set full (TASKS 8.10). Refusing
            // to record new keys used to disable cross-batch dedupe altogether: the findings were
            // still accepted, so a long-lived SPA kept re-reporting the same nodes and
            // threatsDetected grew without bound. A Set iterates in insertion order, so taking the
            // first entry is FIFO; a repeat hit deliberately does not refresh a key's age.
            if (this.seenDedupeKeys.size >= this.maxDedupeKeys) {
                const oldestKey = this.seenDedupeKeys.values().next().value;
                this.seenDedupeKeys.delete(oldestKey);
                // Вытесненная находка остаётся посчитанной: снимать её по узлам больше нельзя,
                // иначе счётчик уйдёт ниже того, что модуль когда-либо прибавил (Б1).
                this.findingAnchors.delete(oldestKey);
            }
            this.seenDedupeKeys.add(dedupeKey);
            return true;
        });

        // Б1: узел привязывается к ключу и новой находки, и повтора уже известной - перерисовка
        // SPA отдаёт новые узлы с теми же находками, и без этого находка ушла бы вместе со старым
        // узлом, хотя на странице осталась.
        const accepted = new Set(acceptedFindings);
        for (const finding of normalizedFindings) {
            this.anchorFinding(finding.dedupeKey, element, accepted.has(finding));
        }

        if (acceptedFindings.length === 0) {
            return;
        }

        this.stats.threatsDetected += acceptedFindings.length;
        this.totalFindingsCurrentScan += acceptedFindings.length;
        acceptedFindings.forEach((finding) => {
            this.recordFinding(finding);
            // C4.3: узел отдаётся ровно здесь и только здесь - в момент, когда находка принята.
            // Дальше он живёт в очереди намерений слоя и не переживает скан.
            this.emitFindingNode(finding, element);
        });
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

    handleMutations(rawMutations) {
        if (!this.isEnabled) {
            return;
        }

        // Loop-safety (C4): наши собственные правки не работа страницы.
        const mutations = this.filterForeignMutations(rawMutations);
        if (mutations.length === 0) {
            return;
        }

        // Удаление узлов этот модуль раньше не интересовало (isRelevantMutation), и находка на
        // удалённом узле жила до следующего полного скана. Теперь удаление - повод проверить
        // привязанные узлы (Б1); батч без добавлений ничего не анализирует.
        if (this.findingAnchors.size > 0 && mutations.some((mutation) => mutation.removedNodes?.length > 0)) {
            this.scheduleMutationBatch();
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

    async processMutationBatch(mutations) {
        const startTime = performance.now();
        this.resetSliceAccounting();
        this.beginWorkSlice();

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
            await this.scanCandidates([...candidates].map((element) => [element, null]), this.mutationAnalysisTimeBudgetMs);

            this.finishWorkSlice();
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

    // `entries` are [element, priority] pairs; a null priority means "not classified yet" and comes
    // from the mutation path, where candidates are collected without a priority pass.
    // Classification and detection get SEPARATE clocks (TASKS 8.3). With one shared clock a
    // text-heavy page could spend the whole budget classifying and then return from the very first
    // detection check - zero elements scanned, zero findings, and a log line claiming success.
    // The two shares add up to the caller's budget, so total scan time is unchanged.
    async scanCandidates(entries, timeBudgetMs = this.initialAnalysisTimeBudgetMs) {
        const classificationBudgetMs = timeBudgetMs * CLASSIFICATION_BUDGET_SHARE;
        const detectionBudgetMs = timeBudgetMs - classificationBudgetMs;
        const classificationStartedAt = this.getScanActiveMs();
        const priorityBuckets = [[], [], [], []];
        this.currentScanCache = {
            styles: new Map(),
            rects: new Map(),
            points: new Map(),
            paths: new Map(),
            texts: new Map(),
            viewportSize: null
        };

        try {
            for (const [element, knownPriority] of entries) {
                if (this.getScanActiveMs() - classificationStartedAt >= classificationBudgetMs) {
                    this.scanTimeBudgetReached += 1;
                    this.partialResult = true;
                    break;
                }
                if (this.shouldYieldSlice()) {
                    await this.yieldSlice();
                    if (!this.isEnabled) {
                        this.partialResult = true;
                        break;
                    }
                }
                const priority = knownPriority ?? this.getCandidatePriority(element);
                if (priority > 0) {
                    priorityBuckets[priority].push(element);
                }
            }

            const detectionStartedAt = this.getScanActiveMs();
            for (let priority = 3; priority >= 1; priority -= 1) {
                for (const element of priorityBuckets[priority]) {
                    if (this.getScanActiveMs() - detectionStartedAt >= detectionBudgetMs) {
                        this.scanTimeBudgetReached += 1;
                        this.partialResult = true;
                        return;
                    }
                    if (this.shouldYieldSlice()) {
                        await this.yieldSlice();
                        if (!this.isEnabled) {
                            this.partialResult = true;
                            return;
                        }
                    }
                    // Level 1 (C5.6): one bad candidate costs one candidate, not the scan.
                    try {
                        this.scanElement(element, priority);
                    } catch (error) {
                        this.recordUnitError('scan-element', error);
                        this.partialResult = true;
                    }
                }
            }
        } finally {
            this.currentScanCache = null;
        }
    }

    // Кэш стилей, rect'ов и геометрии построен на «DOM статичен». Между кусками это перестаёт быть
    // правдой, поэтому инвариант держится per-slice, а не per-scan (C2; visual-manipulation 6.1).
    onSliceYield() {
        const cache = this.currentScanCache;
        if (!cache) {
            return;
        }
        cache.styles.clear();
        cache.rects.clear();
        cache.points.clear();
        cache.paths.clear();
        cache.texts.clear();
        cache.viewportSize = null;
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
        this.mutationBatchTimer = setTimeout(async () => {
            this.mutationBatchTimer = null;
            const mutations = this.pendingMutations.splice(0);
            if (!this.isEnabled) {
                return;
            }
            if (mutations.length === 0) {
                // Батч без добавлений - только удаления узлов (Б1).
                this.settleFindingCount();
                return;
            }

            this.lastMutationBatchTime = Date.now();
            this.beginCandidateBatch();
            this.pseudoStyleLookupsRemaining = this.mutationPseudoStyleLookupLimit;
            // Через гейт C5.1: батч теперь уступает event-loop и может чередоваться с полным сканом.
            await this.runGuardedScan('mutation-batch', () => this.processMutationBatch(mutations));
            this.onMutationsProcessed(mutations);
            this.settleFindingCount();

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
        this.stopScheduledWork();
    }

    // Пауза оставляет результаты и снимает всё остальное. Уходит то, что либо сработает в фоновой
    // вкладке (таймер и очередь мутаций), либо верно лишь пока DOM заведомо не двигался (scan-local
    // кэш стилей и контекст разбора цвета). Остаются находки и их ключи дедупликации: они описывают
    // страницу, а страница никуда не делась. Отдельный хук, а не наследование onDestroy: инвариант
    // «на паузе находки живут» - предпосылка resume без рескана, и он должен ломаться заметно, а не
    // тихо через правку соседнего метода.
    onPause() {
        this.stopScheduledWork();
    }

    stopScheduledWork() {
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
    //    resolveViewportGeometry, getColorParser, hasCandidateText.
    //  - Predicate wrappers that combine style with geometry: isVisuallyHidden, isInputHidden,
    //    isLikelyOverlay, isOffscreen - they take the element, resolve the rect here, and hand pure
    //    data to utils/domUtils.js.
    //  - Plain delegates over pure helpers: isInputSurface, isOverlayNamed,
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

    // Cache-aware: the answer is asked again by the hidden-text gate and by the style-obfuscation
    // fallbacks for the same element within one scan (TASKS 8.1).
    hasCandidateText(element) {
        const cache = this.currentScanCache;
        if (!cache) {
            return hasCandidateText(element);
        }

        let result = cache.texts.get(element);
        if (result === undefined) {
            result = hasCandidateText(element);
            cache.texts.set(element, result);
        }
        return result;
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
