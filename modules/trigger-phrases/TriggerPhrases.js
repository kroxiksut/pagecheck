import ModuleCore from '../ModuleCore.js';
import { Logger } from '../../utils/logger.js';
import {
    analyzeSemanticCandidate,
    prepareCustomLiteralCatalog
} from '../semantic-analysis/SemanticAnalysisCore.js';

// @data-list Теги-контейнеры текста из HTML; устаревают со спецификацией. Устаревание =
// ТИШИНА: текст в новом теге не получит кандидата ни на одном уровне - ровно дефект 10.2,
// из-за которого в fallback-набор пришлось добавлять nav, form, figure, details и body.
const PRIMARY_TEXT_CONTAINERS = new Set([
    'p', 'li', 'blockquote', 'figcaption', 'caption', 'td', 'th', 'dt', 'dd',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
]);
const INTERACTIVE_TEXT_CONTAINERS = new Set(['a', 'button', 'summary', 'label']);
// @data-list (см. комментарий ниже: что это, чем оборачивается устаревание)
// nav, form, figure, details, fieldset и body добавлены по 10.2: у текста, чей ближайший
// контейнер-предок не входит ни в один набор, кандидата не существовало НИ НА ОДНОМ уровне -
// `<nav><span>...</span></nav>` и вставка прямо в body были невидимы для детектора целиком, и это
// дыра в отборе кандидатов, которую не закрывает никакая настройка чувствительности.
// body здесь терминальный контейнер: его собственный текст ограничен maxCandidateRawCharacters,
// как у любого другого fallback-контейнера.
const FALLBACK_TEXT_CONTAINERS = new Set([
    'div', 'section', 'article', 'aside', 'main', 'header', 'footer',
    'nav', 'form', 'figure', 'details', 'fieldset', 'body'
]);
// Объединённый набор контейнеров для подъёма mutation root (10.1). Отдельная константа, а не
// три проверки подряд: подъём отвечает на вопрос «кто владеет текстом», а не «кандидат ли это» -
// последнее решает processMutationBatch, потому что внутри колбэка observer нельзя собирать
// текст поддерева.
const CANDIDATE_CONTAINER_TAGS = new Set([
    ...PRIMARY_TEXT_CONTAINERS,
    ...INTERACTIVE_TEXT_CONTAINERS,
    ...FALLBACK_TEXT_CONTAINERS
]);
// @data-list Технические теги, чей текст не контент. Устаревание = ШУМ: содержимое нового
// технического тега пойдёт в анализ как обычный текст.
const TECHNICAL_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'base', 'title']);
const FORM_CONTROL_SELECTOR = 'input, textarea, select, option, optgroup';
const ACTIVE_EDITABLE_SELECTOR = '[contenteditable]:not([contenteditable="false"]), [role="textbox" i]';
const PRIVACY_ROOT_SELECTOR = `${FORM_CONTROL_SELECTOR}, ${ACTIVE_EDITABLE_SELECTOR}, [aria-multiline="true" i][role="textbox" i], [aria-multiline="true" i][contenteditable]:not([contenteditable="false"])`;
export default class TriggerPhrases extends ModuleCore {
    constructor() {
        super('Trigger-Phrases', true);
        this.usesMutationObserver = true;
        // Пауза сохраняет находки (см. onPause), поэтому рантайм имеет право вернуть модуль без
        // рескана, когда документ за время паузы не менялся (C2, контракт resume в ModuleCore).
        this.keepsStateWhilePaused = true;
        this.maxRecordedFindings = 20;
        this.maxInitialCandidates = 3000;
        this.maxMutationCandidates = 300;
        this.maxPendingMutationRoots = 200;
        this.maxMutationNodesPerRecord = 100;
        this.maxInitialElements = 10000;
        this.maxMutationElements = 1000;
        this.maxMutationCleanupElements = 1000;
        this.maxCandidateRawCharacters = 65536;
        this.maxInitialNormalizedCharacters = 500000;
        this.maxMutationNormalizedCharacters = 50000;
        this.maxInitialRuleEvaluations = 30000;
        this.maxMutationRuleEvaluations = 3000;
        this.initialScanTimeBudgetMs = 100;
        this.initialScanSliceTimeBudgetMs = 8;
        this.initialScanSliceElementLimit = 250;
        this.initialScanSliceCandidateLimit = 75;
        this.initialScanSliceNormalizedCharacterBudget = 32768;
        this.initialScanSliceRuleEvaluationLimit = 250;
        this.mutationScanTimeBudgetMs = 25;
        this.mutationThrottle = 500;
        this.maxSemanticMatchesPerSegment = 10;
        this.maxCustomMatchesPerSegment = 10;
        this.maxActiveCustomPatterns = 500;
        this.maxActiveCustomPatternCharacters = 65536;
        this.maxDiagnosticErrorCodes = 8;
        this.maxErrorLogEntriesPerScan = 4;
        this.segmentLength = 4096;
        this.segmentOverlap = 256;
        this.sentenceSegmenter = typeof Intl?.Segmenter === 'function'
            ? new Intl.Segmenter(undefined, { granularity: 'sentence' })
            : null;
        this.activeCustomPatterns = [];
        this.configRevision = 0;
        this.effectiveConfig = Object.freeze({
            caseSensitive: false,
            sensitivity: 'medium'
        });
        this.currentScanConfiguration = null;
        this.currentPerformanceTelemetry = null;
        this.lastInitialPerformanceTelemetry = null;
        this.lastMutationPerformanceTelemetry = null;
        this.lastCompletedPerformanceTelemetry = null;
        this.findingSchemaVersion = 1;
        this.maxSerializedFindings = 10;
        this.maxActiveFindings = 1000;
        this.activeFindings = new Map();
        this.findingKeysByCandidateId = new Map();
        this.candidateIds = new WeakMap();
        this.nextCandidateId = 1;
        this.findingRevision = 0;
        this.lastScanStatus = 'idle';
        this.lastScanErrorCode = null;
        this.recentFindings = [];
        this.pendingMutationRoots = [];
        // Зеркало очереди: проверка «этот корень уже стоит» за O(1) вместо прохода по массиву (10.8).
        this.pendingMutationRootSet = new Set();
        this.mutationQueueRequiresFullRescan = false;
        this.remainingCleanupBudget = this.maxMutationCleanupElements;
        this.maxMutationRootAscent = 8;
        this.mutationQueueHighWaterMark = 0;
        this.coalescedMutationRoots = 0;
        this.mutationQueueOverflows = 0;
        this.mutationFullRescans = 0;
        this.mutationWorkDeferredByInitialScan = false;
        this.mutationBatchesDeferredByInitialScan = 0;
        this.mutationBatchTimer = null;
        this.mutationBatchPromise = null;
        this.initialScanTimer = null;
        this.initialScanYieldResolver = null;
        this.initialScanState = null;
        this.processedCandidateElements = new Set();
        this.textCandidateCache = new WeakMap();
        this.primaryAncestorCache = new WeakMap();
        this.privacyExcludedCache = new WeakMap();
        this.ownCandidateTextCache = new WeakMap();
        this.candidateContextCache = new WeakMap();
        this.currentElementLimit = this.maxInitialElements;
        this.currentElementsVisited = 0;
        this.currentScanTimeBudgetMs = 0;
        this.currentScanActiveProcessingMs = 0;
        this.currentWorkSliceStartedAt = null;
        this.currentScanDeadline = Number.POSITIVE_INFINITY;
        // Расширяем дефолт ядра, а не перезаписываем его: перезапись молча теряет любое поле,
        // которое ядро добавит позже (C1, разбор 2026-09-09).
        this.observerConfig = {
            ...this.observerConfig,
            attributes: true,
            characterData: true,
            attributeFilter: ['title', 'aria-label', 'alt', 'contenteditable', 'role', 'aria-multiline', 'type']
        };
        this.resetCandidateStats();
        this.resetFindingState();
    }

    async firstScan(reconciliationRescanCount = 0) {
        if (!this.isEnabled) {
            this.lastScanStatus = 'disabled';
            this.lastScanErrorCode = null;
            return;
        }

        if (this.mutationBatchTimer !== null) {
            clearTimeout(this.mutationBatchTimer);
            this.mutationBatchTimer = null;
        }
        if (this.pendingMutationRoots.length > 0 || this.mutationQueueRequiresFullRescan) {
            this.mutationWorkDeferredByInitialScan = true;
            this.mutationBatchesDeferredByInitialScan += 1;
        }

        this.lastScanStatus = 'running';
        this.lastScanErrorCode = null;
        const scanConfiguration = this.beginScanConfiguration();
        const startTime = performance.now();
        this.resetStats();
        this.recentFindings = [];
        this.resetFindingState();
        this.resetCandidateStats();
        this.beginCandidateBatch(
            this.maxInitialCandidates,
            this.maxInitialNormalizedCharacters,
            this.maxInitialRuleEvaluations,
            this.maxInitialElements,
            this.initialScanTimeBudgetMs,
            'initial'
        );

        const initialScanState = this.createInitialScanState(document.documentElement, scanConfiguration);
        this.initialScanState = initialScanState;

        try {
            let scanResult = 'complete';
            do {
                if (!this.isScanConfigurationCurrent(scanConfiguration)) {
                    this.lastScanStatus = 'aborted';
                    return;
                }

                this.beginInitialScanSlice(initialScanState);
                scanResult = this.collectCandidatesFromRoot(
                    initialScanState.root,
                    initialScanState.pendingElements,
                    initialScanState
                );
                this.finishWorkSlice();

                if (scanResult === 'yield') {
                    this.incrementPerformanceCounter('yieldCount');
                    await this.waitForInitialScanYield();
                }
            } while (scanResult === 'yield');

            // 10.5: реконсиляция гоняет mutation-батч, а beginCandidateBatch внутри него обнуляет
            // candidatesAnalyzed, currentElementsVisited, currentRuleEvaluations и
            // normalizedCharactersAnalyzed. Управление возвращается сюда уже с цифрами крошечного
            // батча реконсиляции, и лог с getStats() описывали ими первичный скан. Счётчики
            // снимаются ДО реконсиляции и возвращаются перед отчётом.
            const initialScanCounters = {
                candidatesAnalyzed: this.candidatesAnalyzed,
                currentElementsVisited: this.currentElementsVisited,
                currentRuleEvaluations: this.currentRuleEvaluations,
                normalizedCharactersAnalyzed: this.normalizedCharactersAnalyzed
            };
            const reconciliationResult = await this.reconcileInitialMutationQueue(
                initialScanState,
                scanConfiguration,
                startTime,
                reconciliationRescanCount
            );
            if (reconciliationResult === 'rescanned' || reconciliationResult === 'deferred') {
                return;
            }

            if (!this.isScanConfigurationCurrent(scanConfiguration)) {
                this.lastScanStatus = 'aborted';
                return;
            }

            // Отчёт ниже описывает первичный скан, а не батч реконсиляции (10.5).
            this.candidatesAnalyzed = initialScanCounters.candidatesAnalyzed;
            this.currentElementsVisited = initialScanCounters.currentElementsVisited;
            this.currentRuleEvaluations = initialScanCounters.currentRuleEvaluations;
            this.normalizedCharactersAnalyzed = initialScanCounters.normalizedCharactersAnalyzed;
            const duration = performance.now() - startTime;
            this.stats.lastScanTime = duration;
            // Накапливается, а не перезаписывается (10.5): «суммарное время сканирования»,
            // равное длительности последнего скана, - это не сумма, а второе имя lastScanTime.
            this.stats.totalScanTime += duration;
            this.logCandidateLimitWarning();
            this.lastScanStatus = this.getFindingSnapshotState().partialResult ? 'partial' : 'complete';
            Logger.info(`[${this.moduleName}] Candidate scan completed: ${this.stats.elementsScanned} elements, ${this.candidatesAnalyzed} candidates, ${duration.toFixed(2)}ms`);
        } catch {
            this.recordRuntimeError('initial-scan-failed', 'system');
            this.lastScanStatus = 'error';
            this.lastScanErrorCode = 'scan-failed';
            Logger.error(`[${this.moduleName}] Candidate scan failed`);
        } finally {
            this.finishWorkSlice();
            if (this.initialScanState === initialScanState) {
                this.initialScanState = null;
            }
            this.processedCandidateElements.clear();
            this.completePerformanceTelemetry(startTime);
            this.finishScanConfiguration(scanConfiguration);
            if (this.isEnabled
                && (this.pendingMutationRoots.length > 0 || this.mutationQueueRequiresFullRescan)) {
                this.mutationWorkDeferredByInitialScan = false;
                this.scheduleMutationBatch();
            } else if (!this.initialScanState) {
                this.mutationWorkDeferredByInitialScan = false;
            }
        }
    }

    async reconcileInitialMutationQueue(initialScanState, scanConfiguration, startTime, reconciliationRescanCount) {
        if (!this.isScanConfigurationCurrent(scanConfiguration)) {
            return 'aborted';
        }

        const roots = this.takePendingMutationRoots();
        const requiresFullRescan = this.mutationQueueRequiresFullRescan;
        this.mutationQueueRequiresFullRescan = false;
        if (roots.length === 0 && !requiresFullRescan) {
            return 'none';
        }

        if (this.initialScanState === initialScanState) {
            this.initialScanState = null;
        }
        this.completePerformanceTelemetry(startTime);

        if (requiresFullRescan) {
            if (reconciliationRescanCount >= 1) {
                this.mutationQueueRequiresFullRescan = true;
                this.lastScanStatus = 'partial';
                return 'deferred';
            }

            this.mutationFullRescans += 1;
            await this.firstScan(reconciliationRescanCount + 1);
            return 'rescanned';
        }

        this.processMutationBatch(roots);
        this.onMutationsProcessed(roots);
        return 'reconciled';
    }

    async performScan() {
        // Gate plus the level-2 error handler, shared by every module (C7.3).
        await this.runExplicitScan();
        // Форма снапшота живёт в ядре (C1).
        return this.buildScanSnapshot();
    }

    getFindingCount() {
        return this.activeFindings.size;
    }

    // Этот модуль публикует НЕ recentFindings, а копию активных findings со своей диагностикой -
    // именно из-за неё js/content.js держал особый случай, захардкоженный по ID модуля.
    getSerializedFindings() {
        const { findings, findingsTruncated, ...extra } = this.serializeActiveFindings();
        return {
            findings,
            findingsTruncated,
            revision: Math.max(0, Math.trunc(Number(this.findingRevision) || 0)),
            extra
        };
    }

    scanElement(element) {
        const prefilterStartTime = performance.now();
        if (!(element instanceof Element) || !this.isEnabled || this.processedCandidateElements.has(element)) {
            this.recordPerformanceStage('candidatePrefilterMs', prefilterStartTime);
            return;
        }
        if (this.isScanTimeBudgetReached()) {
            this.recordPerformanceStage('candidatePrefilterMs', prefilterStartTime);
            return;
        }

        // Loop-safety (C4): наша собственная метка не кандидат. Проверка стоит рядом с техническими
        // и приватными исключениями, потому что вопрос тот же - «это вообще контент страницы?».
        if (this.isExtensionOwnedElement(element)
            || this.isTechnicalElement(element)
            || this.isPrivacyExcluded(element)) {
            this.clearFindingsForElement(element);
            this.recordPerformanceStage('candidatePrefilterMs', prefilterStartTime);
            return;
        }
        this.processedCandidateElements.add(element);
        this.clearFindingsForElement(element);
        this.recordPerformanceStage('candidatePrefilterMs', prefilterStartTime);
        this.incrementPerformanceCounter('candidateElements');

        const extractionStartTime = performance.now();
        const candidates = this.getElementCandidates(element);
        this.recordPerformanceStage('textExtractionMs', extractionStartTime);
        this.incrementPerformanceCounter('candidatesExtracted', candidates.length);
        for (const candidate of candidates) {
            if (this.candidatesAnalyzed >= this.currentCandidateLimit) {
                this.candidatesSkippedByLimit += 1;
                continue;
            }

            this.candidatesAnalyzed += 1;
            this.inspectCandidate(candidate);
        }
    }

    createInitialScanState(root, scanConfiguration) {
        return {
            root,
            scanConfiguration,
            pendingElements: root instanceof Element && root.isConnected ? [root] : [],
            sliceDeadline: Number.POSITIVE_INFINITY,
            sliceElementsVisited: 0,
            sliceCandidatesAnalyzed: 0,
            sliceNormalizedCharacters: 0,
            sliceRuleEvaluations: 0
        };
    }

    beginInitialScanSlice(scanState) {
        scanState.sliceDeadline = performance.now() + this.initialScanSliceTimeBudgetMs;
        scanState.sliceElementsVisited = this.currentElementsVisited;
        scanState.sliceCandidatesAnalyzed = this.candidatesAnalyzed;
        scanState.sliceNormalizedCharacters = this.normalizedCharactersAnalyzed;
        scanState.sliceRuleEvaluations = this.currentRuleEvaluations;
        this.beginWorkSlice();
    }

    isInitialScanSliceBudgetReached(scanState) {
        // shouldYieldSlice() - это общий потолок куска на вкладку и реакция на длинные таски
        // (C2). Он стоит первым: собственные лимиты модуля могут быть щедрее, чем то, что сейчас
        // может позволить себе страница.
        return this.shouldYieldSlice()
            || performance.now() >= scanState.sliceDeadline
            || this.currentElementsVisited - scanState.sliceElementsVisited >= this.initialScanSliceElementLimit
            || this.candidatesAnalyzed - scanState.sliceCandidatesAnalyzed >= this.initialScanSliceCandidateLimit
            || this.normalizedCharactersAnalyzed - scanState.sliceNormalizedCharacters >= this.initialScanSliceNormalizedCharacterBudget
            || this.currentRuleEvaluations - scanState.sliceRuleEvaluations >= this.initialScanSliceRuleEvaluationLimit;
    }

    // Ядро зовёт этот хук, когда уступает event-loop. У модуля он отменяемый: таймер и резолвер
    // снимаются при остановке, иначе продолжение просыпалось бы уже после уничтожения скана.
    scheduleSliceContinuation() {
        return this.waitForInitialScanYield();
    }

    waitForInitialScanYield() {
        return new Promise((resolve) => {
            this.initialScanYieldResolver = resolve;
            this.initialScanTimer = setTimeout(() => {
                this.initialScanTimer = null;
                this.initialScanYieldResolver = null;
                resolve();
            }, 0);
        });
    }

    collectCandidatesFromRoot(root, pendingElements = null, initialScanState = null) {
        if (!(root instanceof Element) || !root.isConnected || !this.isEnabled) {
            return 'complete';
        }

        const elements = pendingElements || [root];
        while (elements.length > 0) {
            const traversalStartTime = performance.now();
            if (initialScanState && this.isInitialScanSliceBudgetReached(initialScanState)) {
                this.recordPerformanceStage('domTraversalMs', traversalStartTime);
                return 'yield';
            }
            if (this.currentElementsVisited >= this.currentElementLimit) {
                this.elementsSkippedByLimit += elements.length;
                this.recordPerformanceStage('domTraversalMs', traversalStartTime);
                return 'budget';
            }
            if (this.isScanTimeBudgetReached()) {
                this.elementsSkippedByTime += elements.length;
                this.recordPerformanceStage('domTraversalMs', traversalStartTime);
                return 'budget';
            }

            const element = elements.pop();
            if (!element.isConnected) {
                this.recordPerformanceStage('domTraversalMs', traversalStartTime);
                continue;
            }

            this.currentElementsVisited += 1;
            this.stats.elementsScanned += 1;
            this.incrementPerformanceCounter('traversedElements');
            if (this.isTechnicalElement(element)) {
                if (this.activeFindings.size > 0) {
                    this.clearFindingsForSubtree(element);
                }
                this.recordPerformanceStage('domTraversalMs', traversalStartTime);
                continue;
            }

            if (this.isPrivacyExcluded(element)) {
                if (this.activeFindings.size > 0) {
                    this.clearFindingsForSubtree(element);
                }
                this.privacySubtreesSkipped += 1;
                this.recordPerformanceStage('domTraversalMs', traversalStartTime);
                continue;
            }

            this.recordPerformanceStage('domTraversalMs', traversalStartTime);
            this.scanElement(element);
            const childQueueStartTime = performance.now();
            for (let index = element.children.length - 1; index >= 0; index -= 1) {
                elements.push(element.children[index]);
            }
            this.recordPerformanceStage('domTraversalMs', childQueueStartTime);
        }

        return 'complete';
    }

    getElementCandidates(element) {
        const candidates = [];
        const seenTexts = new Set();
        const addCandidate = (source, rawText) => {
            if (typeof rawText !== 'string') {
                return;
            }

            const boundedText = rawText.length > this.maxCandidateRawCharacters
                ? rawText.slice(0, this.maxCandidateRawCharacters)
                : rawText;
            if (boundedText.length !== rawText.length) {
                this.candidateTextsTruncated += 1;
            }
            if (!this.hasEligibleCandidateText(boundedText) || seenTexts.has(boundedText)) {
                return;
            }

            seenTexts.add(boundedText);

            candidates.push({
                source,
                rawText: boundedText,
                element,
                context: this.getCandidateContext(element)
            });
        };

        if (this.isTextCandidateElement(element)) {
            addCandidate('text', this.getOwnCandidateText(element));
        }

        if (element.hasAttribute('title')) {
            addCandidate('title', element.getAttribute('title'));
        }
        if (element.hasAttribute('aria-label')) {
            addCandidate('aria-label', element.getAttribute('aria-label'));
        }
        if (['img', 'area'].includes(element.localName) && element.hasAttribute('alt')) {
            addCandidate('alt', element.getAttribute('alt'));
        }

        return candidates;
    }

    hasEligibleCandidateText(rawText) {
        return typeof rawText === 'string'
            && rawText.trim() !== ''
            && /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(rawText);
    }

    getOwnCandidateText(element) {
        if (this.ownCandidateTextCache.has(element)) {
            return this.ownCandidateTextCache.get(element);
        }

        const textParts = [];
        const pendingNodes = [];
        let collectedCharacters = 0;
        for (let index = element.childNodes.length - 1; index >= 0; index -= 1) {
            pendingNodes.push(element.childNodes[index]);
        }

        while (pendingNodes.length > 0 && !this.isScanTimeBudgetReached()) {
            const node = pendingNodes.pop();
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent || '';
                const remainingCharacters = this.maxCandidateRawCharacters - collectedCharacters;
                if (remainingCharacters <= 0) {
                    this.candidateTextsTruncated += 1;
                    break;
                }

                if (text.length > remainingCharacters) {
                    textParts.push(text.slice(0, remainingCharacters));
                    collectedCharacters += remainingCharacters;
                    this.candidateTextsTruncated += 1;
                    break;
                }

                textParts.push(text);
                collectedCharacters += text.length;
                continue;
            }

            if (!(node instanceof Element) || this.isTechnicalElement(node) || this.isPrivacyExcluded(node)) {
                continue;
            }

            if (this.isNestedTextBoundary(element, node)) {
                continue;
            }

            for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
                pendingNodes.push(node.childNodes[index]);
            }
        }

        const candidateText = textParts.join('');
        this.ownCandidateTextCache.set(element, candidateText);
        return candidateText;
    }

    isNestedTextBoundary(owner, element) {
        const tagName = element.localName;
        if (PRIMARY_TEXT_CONTAINERS.has(owner.localName)) {
            return PRIMARY_TEXT_CONTAINERS.has(tagName);
        }

        return PRIMARY_TEXT_CONTAINERS.has(tagName)
            || INTERACTIVE_TEXT_CONTAINERS.has(tagName)
            || FALLBACK_TEXT_CONTAINERS.has(tagName);
    }

    getCandidateContext(element) {
        if (this.candidateContextCache.has(element)) {
            return this.candidateContextCache.get(element);
        }

        const uncachedPath = [];
        let current = element;
        let context = { code: false, quote: false };
        while (current instanceof Element) {
            if (this.candidateContextCache.has(current)) {
                context = this.candidateContextCache.get(current);
                break;
            }

            uncachedPath.push(current);
            current = current.parentElement;
        }

        for (let index = uncachedPath.length - 1; index >= 0; index -= 1) {
            const pathElement = uncachedPath[index];
            context = {
                code: context.code || pathElement.matches('pre, code'),
                quote: context.quote || pathElement.matches('blockquote, q')
            };
            this.candidateContextCache.set(pathElement, context);
        }
        return this.candidateContextCache.get(element) || context;
    }

    isTextCandidateElement(element) {
        if (!(element instanceof Element) || this.isTechnicalElement(element) || this.isPrivacyExcluded(element)) {
            return false;
        }

        if (this.textCandidateCache.has(element)) {
            return this.textCandidateCache.get(element);
        }

        const tagName = element.localName;
        let isCandidate = false;
        if (PRIMARY_TEXT_CONTAINERS.has(tagName)) {
            isCandidate = true;
        } else if (INTERACTIVE_TEXT_CONTAINERS.has(tagName)) {
            isCandidate = !this.hasPrimaryContainerAncestor(element);
        } else if (FALLBACK_TEXT_CONTAINERS.has(tagName)) {
            isCandidate = !this.hasPrimaryContainerAncestor(element)
                && this.hasOwnCandidateText(element);
        }

        this.textCandidateCache.set(element, isCandidate);
        return isCandidate;
    }

    hasPrimaryContainerAncestor(element) {
        if (this.primaryAncestorCache.has(element)) {
            return this.primaryAncestorCache.get(element);
        }

        const uncachedPath = [element];
        let ancestor = element.parentElement;
        let hasPrimaryAncestor = false;
        while (ancestor instanceof Element) {
            if (PRIMARY_TEXT_CONTAINERS.has(ancestor.localName)) {
                hasPrimaryAncestor = true;
                break;
            }
            if (this.primaryAncestorCache.has(ancestor)) {
                hasPrimaryAncestor = this.primaryAncestorCache.get(ancestor);
                break;
            }
            uncachedPath.push(ancestor);
            ancestor = ancestor.parentElement;
        }

        for (const pathElement of uncachedPath) {
            this.primaryAncestorCache.set(pathElement, hasPrimaryAncestor);
        }
        return hasPrimaryAncestor;
    }

    hasOwnCandidateText(element) {
        return this.hasEligibleCandidateText(this.getOwnCandidateText(element));
    }

    isTechnicalElement(element) {
        return TECHNICAL_TAGS.has(element.localName);
    }

    isPrivacyExcluded(element) {
        if (!(element instanceof Element)) {
            return false;
        }
        if (this.privacyExcludedCache.has(element)) {
            return this.privacyExcludedCache.get(element);
        }

        const uncachedPath = [];
        let current = element;
        let privacyExcluded = false;
        while (current instanceof Element) {
            if (this.privacyExcludedCache.has(current)) {
                privacyExcluded = this.privacyExcludedCache.get(current);
                break;
            }

            uncachedPath.push(current);
            if (current.matches(PRIVACY_ROOT_SELECTOR)) {
                privacyExcluded = true;
                break;
            }
            current = current.parentElement;
        }

        for (const pathElement of uncachedPath) {
            this.privacyExcludedCache.set(pathElement, privacyExcluded);
        }
        return privacyExcluded;
    }

    inspectCandidate(candidate) {
        const candidateAssessments = [];
        if (this.isScanTimeBudgetReached()
            || this.normalizedCharactersAnalyzed >= this.currentNormalizedCharacterBudget) {
            this.normalizedSegmentsSkippedByBudget += 1;
            return candidateAssessments;
        }
        if (this.currentRuleEvaluations >= this.currentRuleEvaluationLimit) {
            this.ruleEvaluationsSkippedByBudget += 1;
            return candidateAssessments;
        }

        try {
            const candidateSegments = this.splitCandidateText(candidate.rawText);
            this.incrementPerformanceCounter('normalizedSegments', candidateSegments.length);
            for (let segmentIndex = 0; segmentIndex < candidateSegments.length; segmentIndex += 1) {
                if (this.isScanTimeBudgetReached()) {
                    this.normalizedSegmentsSkippedByBudget += 1;
                    break;
                }

                const ruleFamilyEvaluations = this.activeCustomPatterns.length > 0 ? 2 : 1;
                if (this.currentRuleEvaluations + ruleFamilyEvaluations > this.currentRuleEvaluationLimit) {
                    this.ruleEvaluationsSkippedByBudget += ruleFamilyEvaluations;
                    break;
                }

                const analysis = analyzeSemanticCandidate({
                    text: candidateSegments[segmentIndex],
                    sourceType: candidate.source,
                    context: candidate.context,
                    longCandidateSegmented: candidateSegments.length > 1,
                    segmentIndex
                }, {
                    caseSensitive: this.currentScanConfiguration?.effectiveConfig.caseSensitive ?? this.effectiveConfig.caseSensitive,
                    sensitivity: this.currentScanConfiguration?.effectiveConfig.sensitivity ?? this.effectiveConfig.sensitivity,
                    customLiteralCatalog: this.activeCustomPatterns,
                    maxSemanticMatches: this.maxSemanticMatchesPerSegment,
                    maxCustomMatches: this.maxCustomMatchesPerSegment,
                    maxCandidateCharacters: this.maxCandidateRawCharacters,
                    maxCustomLiteralPatterns: this.maxActiveCustomPatterns,
                    maxNormalizedCharacters: this.currentNormalizedCharacterBudget - this.normalizedCharactersAnalyzed,
                    shouldStop: () => this.isScanTimeBudgetReached()
                });
                const diagnostics = analysis.diagnostics;
                const performanceStartTime = performance.now();
                this.recordPerformanceStage('normalizationMs', performanceStartTime - diagnostics.normalizationMs);
                this.recordPerformanceStage('ruleMatchingMs', performanceStartTime - diagnostics.ruleMatchingMs);
                this.recordPerformanceStage('riskEvaluationMs', performanceStartTime - diagnostics.riskEvaluationMs);
                if (analysis.status === 'error') {
                    this.normalizationFailures += 1;
                    this.recordRuntimeError('semantic-analysis-failed', 'rule');
                    continue;
                }

                const normalizedCharacterCount = diagnostics.normalizedCharacters;
                if (this.normalizedCharactersAnalyzed + normalizedCharacterCount > this.currentNormalizedCharacterBudget) {
                    // 10.7: бюджет только убывает, поэтому ни один следующий сегмент этого
                    // кандидата в него уже не поместится. `continue` прогонял каждый оставшийся
                    // сегмент через NFC/NFKC и токенизацию Intl.Segmenter только затем, чтобы
                    // упереться в ту же проверку: до ~16 впустую выполненных нормализаций на
                    // кандидате в 65 КБ. Счётчик доначисляется на весь остаток, чтобы
                    // диагностика осталась ровно прежней.
                    this.normalizedSegmentsSkippedByBudget += candidateSegments.length - segmentIndex;
                    break;
                }

                this.normalizedCharactersAnalyzed += normalizedCharacterCount;
                this.currentRuleEvaluations += ruleFamilyEvaluations;
                this.incrementPerformanceCounter('ruleRoutingCalls', ruleFamilyEvaluations);
                this.semanticMatchesCurrentScan += diagnostics.semanticMatches;
                this.customPatternMatchesCurrentScan += diagnostics.customMatches;
                this.incrementPerformanceCounter('customLiteralComparisons', diagnostics.customLiteralComparisons);
                if (analysis.status === 'partial' && !diagnostics.normalizedCharacterBudgetExceeded) {
                    this.customPatternsSkippedByTime += 1;
                }

                const assessments = analysis.assessments;
                this.riskAssessmentsCurrentScan += assessments.length;
                this.suppressedAssessmentsCurrentScan += assessments.filter((assessment) => !assessment.sensitivityEligible).length;
                this.incrementPerformanceCounter('riskEvaluations', assessments.length);
                candidateAssessments.push(...assessments);
                const deduplicationStartTime = performance.now();
                for (const assessment of assessments) {
                    try {
                        this.upsertFinding(candidate, assessment);
                    } catch {
                        this.recordRuntimeError('finding-update-failed', 'candidate');
                    }
                }
                this.recordPerformanceStage('deduplicationMs', deduplicationStartTime);
                this.incrementPerformanceCounter('deduplicationOperations', assessments.length);
            }
        } catch {
            this.recordRuntimeError('candidate-analysis-failed', 'candidate');
        }
        return candidateAssessments;
    }

    resetFindingState() {
        this.activeFindings.clear();
        this.findingKeysByCandidateId.clear();
        this.candidateIds = new WeakMap();
        this.nextCandidateId = 1;
        this.activeFindingsAdded = 0;
        this.activeFindingsRemoved = 0;
        this.activeFindingsUpdated = 0;
        this.deduplicatedFindingMatches = 0;
        this.findingsSkippedByCapacity = 0;
        this.activeFindingCapacityReached = false;
        this.findingRevision += 1;
        this.stats.threatsDetected = 0;
    }

    hasActiveFindingCapacity() {
        if (this.activeFindings.size < this.maxActiveFindings) {
            return true;
        }

        this.findingsSkippedByCapacity += 1;
        this.activeFindingCapacityReached = true;
        return false;
    }

    getFindingSnapshotState() {
        const candidateBudgetReached = this.candidatesSkippedByLimit > 0
            || this.normalizedSegmentsSkippedByBudget > 0
            || this.mutationsSkippedByLimit > 0
            || this.mutationNodesSkippedByLimit > 0
            || this.elementsSkippedByLimit > 0
            || this.elementsSkippedByTime > 0
            || this.candidateTextsTruncated > 0
            || this.scanTimeBudgetReached > 0
            || this.cleanupElementsSkipped > 0
            || this.customPatternsSkippedByTime > 0
            || this.ruleEvaluationsSkippedByBudget > 0
            || this.runtimeErrorCount > 0;
        const budgetReached = candidateBudgetReached || this.activeFindingCapacityReached;
        const terminalStatus = ['error', 'aborted', 'disabled'].includes(this.lastScanStatus)
            ? this.lastScanStatus
            : budgetReached
                ? 'partial'
                : this.lastScanStatus === 'idle'
                    ? 'idle'
                    : 'complete';
        return {
            revision: this.findingRevision,
            status: terminalStatus,
            partialResult: terminalStatus === 'partial',
            budgetReached,
            activeFindingCapacityReached: this.activeFindingCapacityReached,
            errorCode: terminalStatus === 'error' ? this.lastScanErrorCode : null
        };
    }

    getCandidateId(element) {
        if (!element || (typeof element !== 'object' && typeof element !== 'function')) {
            return null;
        }

        let candidateId = this.candidateIds.get(element);
        if (!candidateId) {
            candidateId = `candidate-${this.nextCandidateId}`;
            this.nextCandidateId += 1;
            this.candidateIds.set(element, candidateId);
        }

        return candidateId;
    }

    createFindingFromAssessment(candidate, assessment) {
        if (!assessment.sensitivityEligible) {
            return null;
        }

        const ruleId = assessment.contributingRuleIds[0];
        const category = assessment.primaryCategory || assessment.supportingCategories[0] || 'unknown';
        const timestamp = Date.now();
        return {
            schemaVersion: this.findingSchemaVersion,
            type: 'trigger-phrase',
            detector: this.moduleName,
            ruleId,
            supportingRuleIds: assessment.contributingRuleIds.slice(1),
            category,
            subtype: assessment.primarySubtype || null,
            supportingCategories: [...assessment.supportingCategories],
            severity: assessment.severity,
            impact: assessment.impact,
            evidenceStrength: assessment.evidenceStrength,
            sourceType: candidate.source,
            reasonCodes: [...assessment.reasonCodes],
            mitigationCodes: [...assessment.mitigationCodes],
            normalizationPath: assessment.normalizationPath,
            details: {
                schemaVersion: this.findingSchemaVersion,
                category,
                subtype: assessment.primarySubtype || null,
                sourceType: candidate.source,
                impact: assessment.impact,
                evidenceStrength: assessment.evidenceStrength,
                reasonCodes: [...assessment.reasonCodes],
                mitigationCodes: [...assessment.mitigationCodes]
            },
            occurrenceCount: 1,
            firstDetectedAt: timestamp,
            lastDetectedAt: timestamp,
            summary: globalThis.chrome?.i18n?.getMessage('findingTriggerPhraseSummary') || 'Suspicious trigger phrase detected'
        };
    }

    getFindingKey(candidateId, candidate, assessment) {
        const actionGroup = assessment.actionGroup
            || assessment.primaryCategory
            || assessment.supportingCategories[0]
            || 'unknown';
        return `${candidateId}|${candidate.source}|${actionGroup}`;
    }

    upsertFinding(candidate, assessment) {
        const finding = this.createFindingFromAssessment(candidate, assessment);
        const candidateId = this.getCandidateId(candidate.element);
        if (!finding || !candidateId) {
            return;
        }

        const findingKey = this.getFindingKey(candidateId, candidate, assessment);
        const existingFinding = this.activeFindings.get(findingKey);
        if (existingFinding) {
            existingFinding.occurrenceCount += 1;
            existingFinding.lastDetectedAt = Date.now();
            this.activeFindingsUpdated += 1;
            this.deduplicatedFindingMatches += 1;
            this.findingRevision += 1;
            return;
        }

        if (!this.hasActiveFindingCapacity()) {
            return;
        }

        this.activeFindings.set(findingKey, finding);
        const candidateFindingKeys = this.findingKeysByCandidateId.get(candidateId) || new Set();
        candidateFindingKeys.add(findingKey);
        this.findingKeysByCandidateId.set(candidateId, candidateFindingKeys);
        this.stats.threatsDetected = this.activeFindings.size;
        this.activeFindingsAdded += 1;
        this.findingRevision += 1;
        this.recordFinding(finding);
    }

    clearFindingsForElement(element) {
        const candidateId = element && (typeof element === 'object' || typeof element === 'function')
            ? this.candidateIds.get(element)
            : null;
        if (!candidateId) {
            return;
        }

        const findingKeys = this.findingKeysByCandidateId.get(candidateId);
        if (!findingKeys) {
            return;
        }

        let removedCount = 0;
        for (const findingKey of findingKeys) {
            if (this.activeFindings.delete(findingKey)) {
                removedCount += 1;
            }
        }
        this.findingKeysByCandidateId.delete(candidateId);
        this.stats.threatsDetected = this.activeFindings.size;
        if (removedCount > 0) {
            this.activeFindingsRemoved += removedCount;
            this.findingRevision += 1;
        }
    }

    clearFindingsForSubtree(root, elementLimit = this.maxMutationCleanupElements, respectScanTimeBudget = true) {
        if (!(root instanceof Element)) {
            return { elementsVisited: 0, complete: true };
        }

        const pendingElements = [root];
        let elementsVisited = 0;
        while (pendingElements.length > 0) {
            if (elementsVisited >= elementLimit
                || (respectScanTimeBudget && this.isScanTimeBudgetReached())) {
                this.cleanupElementsSkipped += pendingElements.length;
                return { elementsVisited, complete: false };
            }

            const element = pendingElements.pop();
            this.clearFindingsForElement(element);
            elementsVisited += 1;
            for (let index = element.children.length - 1; index >= 0; index -= 1) {
                pendingElements.push(element.children[index]);
            }
        }
        return { elementsVisited, complete: true };
    }

    clearFindingsForRemovedNodes(removedNodes) {
        const nodeLimit = Math.min(removedNodes.length, this.maxMutationNodesPerRecord);
        let hasRemovedText = false;
        if (removedNodes.length > nodeLimit) {
            this.mutationNodesSkippedByLimit += removedNodes.length - nodeLimit;
            this.requestMutationFullRescan();
        }

        for (let index = 0; index < nodeLimit; index += 1) {
            const node = removedNodes[index];
            if (node.nodeType === Node.TEXT_NODE) {
                hasRemovedText = true;
            }
            if (!(node instanceof Element)) {
                continue;
            }

            // Недоделанная очистка не теряется молча: она просит полный рескан, иначе получаем
            // залипшие findings - тот же исход, что в 10.1.
            if (this.remainingCleanupBudget <= 0) {
                this.requestMutationFullRescan();
                break;
            }

            const cleanupResult = this.clearFindingsForSubtree(
                node,
                this.remainingCleanupBudget,
                false
            );
            this.remainingCleanupBudget -= cleanupResult.elementsVisited;
            if (!cleanupResult.complete) {
                this.requestMutationFullRescan();
                break;
            }
        }
        return hasRemovedText;
    }

    serializeActiveFindings() {
        const serializationStartTime = performance.now();
        const activeFindings = [...this.activeFindings.values()];
        const findings = activeFindings.slice(0, this.maxSerializedFindings).map((finding) => ({
            ...finding,
            supportingRuleIds: [...finding.supportingRuleIds],
            supportingCategories: [...finding.supportingCategories],
            reasonCodes: [...finding.reasonCodes],
            mitigationCodes: [...finding.mitigationCodes],
            details: {
                ...finding.details,
                reasonCodes: [...finding.details.reasonCodes],
                mitigationCodes: [...finding.details.mitigationCodes]
            }
        }));
        const payloadTruncated = activeFindings.length > findings.length;
        const result = {
            findings,
            findingsTruncated: payloadTruncated,
            payloadTruncated,
            omittedFindings: Math.max(0, activeFindings.length - findings.length),
            ...this.getFindingSnapshotState()
        };
        this.recordPerformanceStage('serializationMs', serializationStartTime);
        this.incrementPerformanceCounter('serializedFindings', findings.length);
        return result;
    }

    buildActiveCustomPatternCatalog(catalog, effectiveConfig = this.effectiveConfig) {
        return prepareCustomLiteralCatalog(catalog, effectiveConfig, {
            maxPatterns: this.maxActiveCustomPatterns,
            maxCharacters: this.maxActiveCustomPatternCharacters
        });
    }

    createEffectiveConfig(config) {
        const sourceConfig = config && typeof config === 'object' && !Array.isArray(config)
            ? config
            : {};
        return Object.freeze({
            caseSensitive: Object.hasOwn(sourceConfig, 'caseSensitive') && sourceConfig.caseSensitive === true,
            sensitivity: Object.hasOwn(sourceConfig, 'sensitivity')
                && ['low', 'medium', 'high'].includes(sourceConfig.sensitivity)
                ? sourceConfig.sensitivity
                : 'medium'
        });
    }

    beginScanConfiguration() {
        const scanConfiguration = Object.freeze({
            revision: this.configRevision,
            lifecycleRevision: this.lifecycleRevision,
            effectiveConfig: this.effectiveConfig
        });
        this.currentScanConfiguration = scanConfiguration;
        return scanConfiguration;
    }

    isScanConfigurationCurrent(scanConfiguration) {
        return this.isEnabled
            && this.configRevision === scanConfiguration.revision
            && this.lifecycleRevision === scanConfiguration.lifecycleRevision
            && this.effectiveConfig === scanConfiguration.effectiveConfig;
    }

    finishScanConfiguration(scanConfiguration) {
        if (this.currentScanConfiguration === scanConfiguration) {
            this.currentScanConfiguration = null;
        }
    }

    onConfigUpdate(oldConfig, newConfig) {
        const nextEffectiveConfig = this.createEffectiveConfig(newConfig);
        let nextActiveCustomPatterns = [];
        try {
            nextActiveCustomPatterns = this.buildActiveCustomPatternCatalog(
                newConfig.customPatterns,
                nextEffectiveConfig
            );
        } catch {
            this.recordRuntimeError('custom-catalog-build-failed', 'rule');
        }
        const catalogChanged = nextActiveCustomPatterns.length !== this.activeCustomPatterns.length
            || nextActiveCustomPatterns.some((pattern, index) => {
                const current = this.activeCustomPatterns[index];
                return !current
                    || current.id !== pattern.id
                    || current.comparisonText !== pattern.comparisonText
                    || current.requiresExactComparison !== pattern.requiresExactComparison
                    || current.shortPattern !== pattern.shortPattern;
            });
        const effectiveConfigChanged = this.effectiveConfig.caseSensitive !== nextEffectiveConfig.caseSensitive
            || this.effectiveConfig.sensitivity !== nextEffectiveConfig.sensitivity;
        if (catalogChanged || effectiveConfigChanged) {
            this.effectiveConfig = nextEffectiveConfig;
            this.activeCustomPatterns = nextActiveCustomPatterns;
            this.configRevision += 1;
        }

        if (newConfig.customPatterns?.version === 1) {
            this.config.customPatterns = {
                version: 1,
                items: newConfig.customPatterns.items.map(({ id, enabled, mode }) => ({ id, enabled, mode }))
            };
        }

        return { requiresDetectionRefresh: catalogChanged || effectiveConfigChanged };
    }

    splitCandidateText(rawText) {
        if (Array.from(rawText).length <= this.segmentLength) {
            return [rawText];
        }

        const sentenceParts = this.getSentenceParts(rawText);
        const segments = [];
        let buffer = '';
        sentenceParts.forEach((part) => {
            if (Array.from(part).length > this.segmentLength) {
                if (buffer) {
                    segments.push(buffer);
                    buffer = '';
                }
                segments.push(...this.createOverlappingWindows(part));
                return;
            }

            if (Array.from(`${buffer}${part}`).length > this.segmentLength && buffer) {
                segments.push(buffer);
                buffer = part;
                return;
            }
            buffer += part;
        });

        if (buffer) {
            segments.push(buffer);
        }
        return segments.length > 0 ? segments : [rawText];
    }

    getSentenceParts(text) {
        if (this.sentenceSegmenter) {
            const segments = Array.from(this.sentenceSegmenter.segment(text), ({ segment }) => segment).filter(Boolean);
            if (segments.length > 0) {
                return segments;
            }
        }

        return text.split(/(?<=[.!?])\s+/u).filter(Boolean);
    }

    createOverlappingWindows(text) {
        const characters = Array.from(text);
        const windows = [];
        let start = 0;
        while (start < characters.length) {
            let end = Math.min(characters.length, start + this.segmentLength);
            if (end < characters.length) {
                end = this.findWindowBreak(characters, start, end);
            }
            windows.push(characters.slice(start, end).join(''));
            if (end >= characters.length) {
                break;
            }
            start = Math.max(end - this.segmentOverlap, start + 1);
        }
        return windows;
    }

    findWindowBreak(characters, start, preferredEnd) {
        for (let index = preferredEnd; index > start + (this.segmentLength - this.segmentOverlap); index -= 1) {
            if (/\s|[.,;:!?]/u.test(characters[index - 1])) {
                return index;
            }
        }
        return preferredEnd;
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

        // 10.3: бюджет очистки - ОДИН на батч, а не на запись. Он переинициализировался в
        // clearFindingsForRemovedNodes, то есть на каждую childList-запись, а записей в батче
        // до maxPendingMutationRoots: страница, сносящая много крупных поддеревьев за один тик
        // (виртуализованный список, смена маршрута в SPA), получала до 200 x 1000 = 200 000
        // посещений элементов синхронно внутри одного колбэка observer. README всё это время
        // обещал «не более 1000 элементов на batch» - код реализовывал «на запись».
        this.remainingCleanupBudget = this.maxMutationCleanupElements;

        const recordLimit = Math.min(mutations.length, this.maxPendingMutationRoots);
        if (mutations.length > recordLimit) {
            this.mutationsSkippedByLimit += mutations.length - recordLimit;
            this.requestMutationFullRescan();
        }
        for (let index = 0; index < recordLimit; index += 1) {
            this.enqueueMutationRecord(mutations[index]);
        }

        if (!this.initialScanState
            && (this.pendingMutationRoots.length > 0 || this.mutationQueueRequiresFullRescan)) {
            this.scheduleMutationBatch();
        } else if (this.initialScanState) {
            this.mutationWorkDeferredByInitialScan = true;
            this.mutationBatchesDeferredByInitialScan += 1;
        }
    }

    enqueueMutationRecord(mutation) {
        if (mutation.type === 'childList') {
            const hasRemovedText = this.clearFindingsForRemovedNodes(mutation.removedNodes);
            const target = mutation.target instanceof Element && mutation.target.isConnected
                ? mutation.target
                : null;
            const addedNodeLimit = Math.min(mutation.addedNodes.length, this.maxMutationNodesPerRecord);
            if (mutation.addedNodes.length > addedNodeLimit) {
                this.mutationNodesSkippedByLimit += mutation.addedNodes.length - addedNodeLimit;
                this.requestMutationFullRescan();
            }

            for (let index = 0; index < addedNodeLimit; index += 1) {
                const node = mutation.addedNodes[index];
                if (node instanceof Element && node.isConnected) {
                    this.enqueueMutationRoot(this.resolveMutationRoot(node));
                } else if (node.nodeType === Node.TEXT_NODE && target) {
                    this.enqueueMutationRoot(this.resolveMutationRoot(target));
                }
            }

            // Удаление ЭЛЕМЕНТА возвращает владельца в очередь наравне с удалением текстового
            // узла (10.1). Раньше сюда попадал только hasRemovedText, а удалённый <span>
            // текстовым узлом не является: finding, записанный на абзац, жил до конца жизни
            // страницы - прямо вопреки обещанию README снимать findings с удалённых поддеревьев.
            if (target && (hasRemovedText || mutation.removedNodes.length > 0)) {
                this.enqueueMutationRoot(this.resolveMutationRoot(target));
            }
            return;
        }

        if (mutation.type === 'characterData') {
            const parent = mutation.target.parentElement;
            if (parent?.isConnected) {
                // Тот же вопрос владения: правка текста внутри <span> принадлежит абзацу.
                this.enqueueMutationRoot(this.resolveMutationRoot(parent));
            }
            return;
        }

        if (mutation.type === 'attributes' && mutation.target instanceof Element && mutation.target.isConnected) {
            this.enqueueMutationRoot(mutation.target);
        }
    }

    // 10.1: кандидат принадлежит ближайшему КОНТЕЙНЕРУ, а в очередь клался сам изменённый узел.
    // Внедрённый в абзац <span> не входит ни в один набор контейнеров, поэтому не сканировалось
    // ничего: ни span (не кандидат), ни p (заново не посещался) - внедрение inline-элемента в
    // существующий абзац не детектилось вообще, до случайного полного рескана по другой причине.
    // Подъём идёт ПО ТЕГУ, а не через isTextCandidateElement(): проверка собственного текста дала
    // бы разные ответы до и после правки DOM, а вопрос здесь один - «кто владеет этим текстом».
    // Узел, который сам является контейнером, не поднимается: иначе каждый добавленный <div>
    // уезжал бы корнем в body и превращал любую мутацию в полный скан страницы.
    resolveMutationRoot(node) {
        if (!(node instanceof Element)) {
            return node;
        }

        let current = node;
        for (let depth = 0; depth < this.maxMutationRootAscent; depth += 1) {
            if (!(current instanceof Element)) {
                break;
            }
            if (CANDIDATE_CONTAINER_TAGS.has(current.localName)) {
                return current;
            }
            current = current.parentElement;
        }

        // Владельца в пределах лимита нет - поведение прежнее, узел ставится как есть.
        return node;
    }

    // 10.8: обе проверки родства были проходами по всей очереди с Node.contains(), то есть O(n²)
    // на батч внутри колбэка observer - на том же тике, где работает очистка из 10.3.
    // Вопрос «предок уже в очереди» дешевле задавать снизу вверх: подъём по цепочке родителей
    // стоит O(глубины) и не зависит от длины очереди.
    // Обратный проход, снимающий уже стоящих потомков нового корня, не убран, а перенесён: раз на
    // батч и перед самым переполнением. Полностью перенести дедупликацию на обработку батча
    // нельзя - очередь тогда временно держала бы потомков, maxPendingMutationRoots срабатывал бы
    // чаще, и изменилась бы частота полных рескансов. Это поведение, а не только стоимость.
    enqueueMutationRoot(root) {
        if (!(root instanceof Element) || !root.isConnected) {
            return false;
        }

        if (this.pendingMutationRootSet.has(root)) {
            this.coalescedMutationRoots += 1;
            return true;
        }

        for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
            if (this.pendingMutationRootSet.has(ancestor)) {
                this.coalescedMutationRoots += 1;
                return true;
            }
        }

        if (this.pendingMutationRoots.length >= this.maxPendingMutationRoots) {
            // Последний шанс до переполнения: часть очереди могла стать вложенной в корни,
            // добавленные позже.
            // Считая и входящий корень: без него проход перед переполнением бесполезен ровно в
            // том случае, ради которого он существует, - когда очередь набита потомками того,
            // кто пришёл последним.
            this.collapseNestedMutationRoots(root);
        }

        if (this.pendingMutationRoots.length >= this.maxPendingMutationRoots) {
            this.mutationQueueOverflows += 1;
            this.mutationsSkippedByLimit += 1;
            this.requestMutationFullRescan();
            return false;
        }

        this.pendingMutationRoots.push(root);
        this.pendingMutationRootSet.add(root);
        this.mutationQueueHighWaterMark = Math.max(
            this.mutationQueueHighWaterMark,
            this.pendingMutationRoots.length
        );
        return true;
    }

    // Снимает из очереди корни, у которых предок тоже в очереди. Раз на батч, а не на каждую
    // постановку: результат тот же, а стоимость перестаёт быть квадратичной по длине очереди.
    collapseNestedMutationRoots(incomingRoot = null) {
        if (this.pendingMutationRoots.length === 0
            || (this.pendingMutationRoots.length < 2 && !incomingRoot)) {
            return;
        }

        const survivingRoots = this.pendingMutationRoots.filter((root) => {
            for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
                if (ancestor === incomingRoot || this.pendingMutationRootSet.has(ancestor)) {
                    return false;
                }
            }
            return true;
        });

        this.coalescedMutationRoots += this.pendingMutationRoots.length - survivingRoots.length;
        this.pendingMutationRoots = survivingRoots;
        this.pendingMutationRootSet = new Set(survivingRoots);
    }

    // Единственный способ забрать очередь: схлопывание раз на батч живёт здесь, поэтому его нельзя
    // забыть на одном из двух путей потребления.
    takePendingMutationRoots() {
        this.collapseNestedMutationRoots();
        const roots = this.pendingMutationRoots.splice(0);
        this.pendingMutationRootSet.clear();
        return roots;
    }

    requestMutationFullRescan() {
        this.mutationQueueRequiresFullRescan = true;
    }

    processMutation(mutation) {
        this.handleMutations([mutation]);
    }

    scheduleMutationBatch() {
        if (this.initialScanState) {
            this.mutationWorkDeferredByInitialScan = true;
            return;
        }
        if (this.mutationBatchTimer !== null || this.mutationBatchPromise !== null) {
            return;
        }

        const lifecycleRevision = this.lifecycleRevision;
        const delay = Math.max(0, this.mutationThrottle - (Date.now() - this.lastMutationTime));
        this.mutationBatchTimer = setTimeout(() => {
            this.mutationBatchTimer = null;
            if (!this.isEnabled || lifecycleRevision !== this.lifecycleRevision) {
                return;
            }
            const batchPromise = this.runQueuedMutationBatch(lifecycleRevision);
            this.mutationBatchPromise = batchPromise;
            batchPromise.catch(() => {
                if (lifecycleRevision !== this.lifecycleRevision) {
                    return;
                }
                this.recordRuntimeError('mutation-queue-failed', 'system');
                Logger.error(`[${this.moduleName}] Error running mutation queue`);
            }).finally(() => {
                if (lifecycleRevision !== this.lifecycleRevision) {
                    return;
                }
                if (this.mutationBatchPromise === batchPromise) {
                    this.mutationBatchPromise = null;
                }
                if (this.isEnabled
                    && !this.initialScanState
                    && (this.pendingMutationRoots.length > 0 || this.mutationQueueRequiresFullRescan)) {
                    this.scheduleMutationBatch();
                }
            });
        }, delay);
    }

    async runQueuedMutationBatch(lifecycleRevision = this.lifecycleRevision) {
        if (!this.isEnabled || lifecycleRevision !== this.lifecycleRevision) {
            return;
        }
        if (this.initialScanState) {
            this.mutationWorkDeferredByInitialScan = true;
            return;
        }

        const roots = this.takePendingMutationRoots();
        const requiresFullRescan = this.mutationQueueRequiresFullRescan;
        this.mutationQueueRequiresFullRescan = false;
        if (roots.length === 0 && !requiresFullRescan) {
            return;
        }

        this.lastMutationTime = Date.now();
        if (requiresFullRescan) {
            this.mutationFullRescans += 1;
            await this.firstScan();
            if (!this.isEnabled || lifecycleRevision !== this.lifecycleRevision) {
                return;
            }
            return;
        }

        this.processMutationBatch(roots);
        this.onMutationsProcessed(roots);
    }

    processMutationBatch(roots) {
        const scanConfiguration = this.beginScanConfiguration();
        const startTime = performance.now();
        this.beginCandidateBatch(
            this.maxMutationCandidates,
            this.maxMutationNormalizedCharacters,
            this.maxMutationRuleEvaluations,
            this.maxMutationElements,
            this.mutationScanTimeBudgetMs,
            'mutation'
        );
        this.beginWorkSlice();

        try {
            for (const root of roots) {
                this.collectCandidatesFromRoot(root);
            }

            if (!this.isScanConfigurationCurrent(scanConfiguration)) {
                return;
            }

            const duration = performance.now() - startTime;
            this.stats.totalScanTime += duration;
            this.stats.lastScanTime = duration;
            this.logCandidateLimitWarning();
        } catch {
            this.recordRuntimeError('mutation-batch-failed', 'system');
            Logger.error(`[${this.moduleName}] Error processing mutation batch`);
        } finally {
            this.finishWorkSlice();
            this.processedCandidateElements.clear();
            this.completePerformanceTelemetry(startTime);
            this.finishScanConfiguration(scanConfiguration);
        }
    }

    createPerformanceTelemetry(scanType) {
        return {
            scanType,
            elapsedMs: 0,
            activeProcessingMs: 0,
            maximumSliceMs: 0,
            yieldCount: 0,
            domTraversalMs: 0,
            candidatePrefilterMs: 0,
            textExtractionMs: 0,
            normalizationMs: 0,
            ruleMatchingMs: 0,
            riskEvaluationMs: 0,
            deduplicationMs: 0,
            serializationMs: 0,
            traversedElements: 0,
            candidateElements: 0,
            candidatesExtracted: 0,
            normalizedSegments: 0,
            ruleRoutingCalls: 0,
            customLiteralComparisons: 0,
            riskEvaluations: 0,
            deduplicationOperations: 0,
            serializedFindings: 0,
            candidateErrors: 0,
            ruleErrors: 0,
            systemErrors: 0,
            errorDiagnosticsDropped: 0,
            queueHighWaterMark: 0,
            coalescedMutationRoots: 0,
            mutationQueueOverflows: 0,
            forcedFullRescans: 0,
            deferredMutationBatches: 0
        };
    }

    recordPerformanceStage(stage, startTime) {
        const telemetry = this.currentPerformanceTelemetry || this.lastCompletedPerformanceTelemetry;
        if (!telemetry || !Object.hasOwn(telemetry, stage)) {
            return;
        }
        telemetry[stage] += Math.max(0, performance.now() - startTime);
    }

    incrementPerformanceCounter(counter, value = 1) {
        const telemetry = this.currentPerformanceTelemetry || this.lastCompletedPerformanceTelemetry;
        if (!telemetry || !Object.hasOwn(telemetry, counter)) {
            return;
        }
        telemetry[counter] += value;
    }

    recordRuntimeError(errorCode, category) {
        const counterByCategory = {
            candidate: 'candidateErrors',
            rule: 'ruleErrors',
            system: 'systemErrors'
        };
        const telemetryCounter = counterByCategory[category] || 'systemErrors';
        this.runtimeErrorCount += 1;
        this[telemetryCounter] += 1;
        this.incrementPerformanceCounter(telemetryCounter);

        if (this.runtimeErrorCounts.has(errorCode)) {
            this.runtimeErrorCounts.set(errorCode, this.runtimeErrorCounts.get(errorCode) + 1);
            return;
        }
        if (this.runtimeErrorCounts.size >= this.maxDiagnosticErrorCodes) {
            this.runtimeErrorDiagnosticsDropped += 1;
            this.incrementPerformanceCounter('errorDiagnosticsDropped');
            return;
        }

        this.runtimeErrorCounts.set(errorCode, 1);
        if (this.runtimeErrorLogEntries < this.maxErrorLogEntriesPerScan) {
            this.runtimeErrorLogEntries += 1;
            Logger.warn(`[${this.moduleName}] Runtime diagnostic: ${errorCode}`);
        }
    }

    completePerformanceTelemetry(startTime) {
        if (!this.currentPerformanceTelemetry) {
            return;
        }
        this.currentPerformanceTelemetry.elapsedMs = Math.max(0, performance.now() - startTime);
        if (this.currentPerformanceTelemetry.scanType === 'mutation') {
            this.currentPerformanceTelemetry.queueHighWaterMark = this.mutationQueueHighWaterMark;
            this.currentPerformanceTelemetry.coalescedMutationRoots = this.coalescedMutationRoots;
            this.currentPerformanceTelemetry.mutationQueueOverflows = this.mutationQueueOverflows;
            this.currentPerformanceTelemetry.forcedFullRescans = this.mutationFullRescans;
            this.currentPerformanceTelemetry.deferredMutationBatches = this.mutationBatchesDeferredByInitialScan;
        }
        // Публикуется КОПИЯ. serializeActiveFindings() вызывается и вне скана - из performScan сразу
        // после firstScan и из buildCurrentScanResponse() в js/content.js на каждой смене lifecycle и
        // обновлении popup, - а запись шла в тот же объект, который уже опубликован как телеметрия
        // завершённого скана: serializationMs и serializedFindings бесконечно накапливались в
        // «телеметрии первичного скана» и переставали её описывать (TASKS 10.6). Внесканные записи
        // теперь копятся в отдельном аккумуляторе lastCompletedPerformanceTelemetry.
        const publishedTelemetry = { ...this.currentPerformanceTelemetry };
        if (this.currentPerformanceTelemetry.scanType === 'initial') {
            this.lastInitialPerformanceTelemetry = publishedTelemetry;
        } else {
            this.lastMutationPerformanceTelemetry = publishedTelemetry;
        }
        this.lastCompletedPerformanceTelemetry = this.currentPerformanceTelemetry;
        this.currentPerformanceTelemetry = null;
    }

    beginCandidateBatch(candidateLimit, normalizedCharacterBudget, ruleEvaluationLimit, elementLimit, timeBudgetMs, scanType) {
        this.currentPerformanceTelemetry = this.createPerformanceTelemetry(scanType);
        this.currentCandidateLimit = candidateLimit;
        this.currentNormalizedCharacterBudget = normalizedCharacterBudget;
        this.currentRuleEvaluationLimit = ruleEvaluationLimit;
        this.currentElementLimit = elementLimit;
        this.currentElementsVisited = 0;
        this.currentRuleEvaluations = 0;
        this.currentScanTimeBudgetMs = timeBudgetMs;
        this.currentScanActiveProcessingMs = 0;
        this.currentWorkSliceStartedAt = null;
        this.currentScanDeadline = Number.POSITIVE_INFINITY;
        this.scanTimeBudgetReachedInBatch = false;
        this.candidatesAnalyzed = 0;
        this.normalizedCharactersAnalyzed = 0;
        this.processedCandidateElements.clear();
        this.textCandidateCache = new WeakMap();
        this.primaryAncestorCache = new WeakMap();
        this.privacyExcludedCache = new WeakMap();
        this.ownCandidateTextCache = new WeakMap();
        this.candidateContextCache = new WeakMap();
    }

    // Нарезка этого модуля появилась раньше ядерной и была богаче: лимиты куска не только по
    // времени, но и по элементам, кандидатам, символам и правилам. Поэтому она не заменена, а
    // СВЕДЕНА с ядерной (C2): учёт активного времени и потолок куска берутся у ядра - иначе рядом
    // жили бы два определения «сколько мы уже отработали», и общий потолок на вкладку до этого
    // модуля не доходил бы вовсе.
    beginWorkSlice() {
        super.beginWorkSlice();
        this.currentWorkSliceStartedAt = this.currentSliceStartedAt;
        // Дедлайн ОСТАТКА бюджета скана - отдельная величина от потолка куска: первый говорит
        // «работа закончилась», второй - «пора уступить и продолжить».
        const remainingTimeBudget = Math.max(0, this.currentScanTimeBudgetMs - this.currentScanActiveProcessingMs);
        this.currentScanDeadline = this.currentWorkSliceStartedAt + remainingTimeBudget;
    }

    finishWorkSlice() {
        if (this.currentWorkSliceStartedAt === null) {
            return 0;
        }

        const sliceDuration = super.finishWorkSlice();
        this.currentScanActiveProcessingMs += sliceDuration;
        const telemetry = this.currentPerformanceTelemetry || this.lastCompletedPerformanceTelemetry;
        if (telemetry) {
            telemetry.activeProcessingMs += sliceDuration;
            telemetry.maximumSliceMs = Math.max(telemetry.maximumSliceMs, sliceDuration);
        }
        this.currentWorkSliceStartedAt = null;
        this.currentScanDeadline = Number.POSITIVE_INFINITY;
        return sliceDuration;
    }

    isScanTimeBudgetReached() {
        if (performance.now() <= this.currentScanDeadline) {
            return false;
        }

        if (!this.scanTimeBudgetReachedInBatch) {
            this.scanTimeBudgetReached += 1;
            this.scanTimeBudgetReachedInBatch = true;
        }
        return true;
    }

    resetCandidateStats() {
        this.currentCandidateLimit = this.maxInitialCandidates;
        this.currentNormalizedCharacterBudget = this.maxInitialNormalizedCharacters;
        this.currentRuleEvaluationLimit = this.maxInitialRuleEvaluations;
        this.currentElementLimit = this.maxInitialElements;
        this.currentElementsVisited = 0;
        this.currentRuleEvaluations = 0;
        this.currentScanTimeBudgetMs = 0;
        this.currentScanActiveProcessingMs = 0;
        this.currentWorkSliceStartedAt = null;
        this.currentScanDeadline = Number.POSITIVE_INFINITY;
        this.runtimeErrorCounts = new Map();
        this.runtimeErrorCount = 0;
        this.candidateErrors = 0;
        this.ruleErrors = 0;
        this.systemErrors = 0;
        this.runtimeErrorDiagnosticsDropped = 0;
        this.runtimeErrorLogEntries = 0;
        this.scanTimeBudgetReachedInBatch = false;
        this.candidatesAnalyzed = 0;
        this.candidatesSkippedByLimit = 0;
        this.elementsSkippedByLimit = 0;
        this.elementsSkippedByTime = 0;
        this.candidateTextsTruncated = 0;
        this.scanTimeBudgetReached = 0;
        this.cleanupElementsSkipped = 0;
        this.customPatternsSkippedByTime = 0;
        this.normalizedCharactersAnalyzed = 0;
        this.normalizedSegmentsSkippedByBudget = 0;
        this.ruleEvaluationsSkippedByBudget = 0;
        this.normalizationFailures = 0;
        this.semanticMatchesCurrentScan = 0;
        this.customPatternMatchesCurrentScan = 0;
        this.riskAssessmentsCurrentScan = 0;
        this.suppressedAssessmentsCurrentScan = 0;
        this.mutationsSkippedByLimit = 0;
        this.mutationNodesSkippedByLimit = 0;
        this.privacySubtreesSkipped = 0;
    }

    logCandidateLimitWarning() {
        if (this.candidatesSkippedByLimit > 0
            || this.normalizedSegmentsSkippedByBudget > 0
            || this.mutationsSkippedByLimit > 0
            || this.mutationNodesSkippedByLimit > 0
            || this.elementsSkippedByLimit > 0
            || this.elementsSkippedByTime > 0
            || this.scanTimeBudgetReached > 0
            || this.ruleEvaluationsSkippedByBudget > 0) {
            // info, а не warn (2026-09-11): бюджет на тяжёлой странице - штатный исход, а не сбой.
            // visual и link сообщают о том же через info, неполнота скана видна в снапшоте
            // (partialResult). warn попадал на страницу ошибок расширения в chrome://extensions и
            // выглядел как поломка, заслоняя настоящие ошибки.
            Logger.info(`[${this.moduleName}] Scan budget reached: ${this.candidatesSkippedByLimit} candidates, ${this.normalizedSegmentsSkippedByBudget} normalized segments, ${this.ruleEvaluationsSkippedByBudget} rule families, ${this.mutationsSkippedByLimit} mutations, ${this.mutationNodesSkippedByLimit} mutation nodes, ${this.elementsSkippedByLimit} queued elements by count, ${this.elementsSkippedByTime} queued elements by time`);
        }
    }

    onDestroy() {
        this.stopScheduledWork();
        this.resetFindingState();
    }

    // Пауза оставляет находки и снимает всё остальное. Уходит то, что либо сработает в фоновой
    // вкладке (таймеры, очередь корней, отложенный первичный скан), либо верно лишь пока DOM заведомо
    // не двигался (кэши текста кандидатов, предков и приватных поддеревьев).
    // Остаются: активные находки, их ключи и - что важнее всего - `candidateIds`. Именно этот
    // WeakMap делает возврат без рескана безопасным: тот же элемент получит тот же id, поэтому
    // повторный разбор после мутации ОБНОВИТ существующую находку, а не заведёт вторую.
    // resetFindingState() зовётся только из onDestroy: там модуль действительно уходит.
    onPause() {
        this.stopScheduledWork();
    }

    stopScheduledWork() {
        if (this.mutationBatchTimer !== null) {
            clearTimeout(this.mutationBatchTimer);
            this.mutationBatchTimer = null;
        }
        if (this.initialScanTimer !== null) {
            clearTimeout(this.initialScanTimer);
            this.initialScanTimer = null;
        }
        if (this.initialScanYieldResolver) {
            const resolveInitialYield = this.initialScanYieldResolver;
            this.initialScanYieldResolver = null;
            resolveInitialYield();
        }
        this.pendingMutationRoots = [];
        // Зеркало очереди: проверка «этот корень уже стоит» за O(1) вместо прохода по массиву (10.8).
        this.pendingMutationRootSet = new Set();
        this.mutationQueueRequiresFullRescan = false;
        this.mutationBatchPromise = null;
        this.mutationWorkDeferredByInitialScan = false;
        this.initialScanState = null;
        this.processedCandidateElements.clear();
        this.textCandidateCache = new WeakMap();
        this.primaryAncestorCache = new WeakMap();
        this.privacyExcludedCache = new WeakMap();
        this.ownCandidateTextCache = new WeakMap();
        this.candidateContextCache = new WeakMap();
        this.activeCustomPatterns = [];
        this.currentScanConfiguration = null;
        this.currentPerformanceTelemetry = null;
        this.lastCompletedPerformanceTelemetry = null;
        this.currentWorkSliceStartedAt = null;
        this.currentScanDeadline = Number.NEGATIVE_INFINITY;
        if (this.lastScanStatus === 'running') {
            this.lastScanStatus = this.isEnabled ? 'aborted' : 'disabled';
        }
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
            candidatesAnalyzed: this.candidatesAnalyzed,
            candidatesSkippedByLimit: this.candidatesSkippedByLimit,
            elementsVisited: this.currentElementsVisited,
            elementsSkippedByLimit: this.elementsSkippedByLimit,
            elementsSkippedByTime: this.elementsSkippedByTime,
            candidateTextsTruncated: this.candidateTextsTruncated,
            scanTimeBudgetReached: this.scanTimeBudgetReached,
            cleanupElementsSkipped: this.cleanupElementsSkipped,
            customPatternsSkippedByTime: this.customPatternsSkippedByTime,
            normalizedCharactersAnalyzed: this.normalizedCharactersAnalyzed,
            normalizedSegmentsSkippedByBudget: this.normalizedSegmentsSkippedByBudget,
            ruleEvaluations: this.currentRuleEvaluations,
            ruleEvaluationsSkippedByBudget: this.ruleEvaluationsSkippedByBudget,
            normalizationFailures: this.normalizationFailures,
            runtimeErrorCount: this.runtimeErrorCount,
            candidateErrors: this.candidateErrors,
            ruleErrors: this.ruleErrors,
            systemErrors: this.systemErrors,
            runtimeErrorDiagnosticsDropped: this.runtimeErrorDiagnosticsDropped,
            runtimeErrorCodes: [...this.runtimeErrorCounts.entries()].map(([code, count]) => ({ code, count })),
            semanticMatchesCurrentScan: this.semanticMatchesCurrentScan,
            customPatternMatchesCurrentScan: this.customPatternMatchesCurrentScan,
            activeCustomPatternCount: this.activeCustomPatterns.length,
            activeFindingCount: this.activeFindings.size,
            maxActiveFindings: this.maxActiveFindings,
            findingRevision: this.findingRevision,
            maxSerializedFindings: this.maxSerializedFindings,
            payloadTruncated: this.activeFindings.size > this.maxSerializedFindings,
            activeFindingsAdded: this.activeFindingsAdded,
            activeFindingsRemoved: this.activeFindingsRemoved,
            activeFindingsUpdated: this.activeFindingsUpdated,
            deduplicatedFindingMatches: this.deduplicatedFindingMatches,
            findingsSkippedByCapacity: this.findingsSkippedByCapacity,
            ...this.getFindingSnapshotState(),
            riskAssessmentsCurrentScan: this.riskAssessmentsCurrentScan,
            suppressedAssessmentsCurrentScan: this.suppressedAssessmentsCurrentScan,
            mutationsSkippedByLimit: this.mutationsSkippedByLimit,
            mutationNodesSkippedByLimit: this.mutationNodesSkippedByLimit,
            pendingMutationRoots: this.pendingMutationRoots.length,
            mutationQueueHighWaterMark: this.mutationQueueHighWaterMark,
            coalescedMutationRoots: this.coalescedMutationRoots,
            mutationQueueOverflows: this.mutationQueueOverflows,
            mutationFullRescans: this.mutationFullRescans,
            mutationQueueRequiresFullRescan: this.mutationQueueRequiresFullRescan,
            mutationWorkDeferredByInitialScan: this.mutationWorkDeferredByInitialScan,
            mutationBatchesDeferredByInitialScan: this.mutationBatchesDeferredByInitialScan,
            privacySubtreesSkipped: this.privacySubtreesSkipped,
            initialPerformanceTelemetry: this.lastInitialPerformanceTelemetry
                ? { ...this.lastInitialPerformanceTelemetry }
                : null,
            mutationPerformanceTelemetry: this.lastMutationPerformanceTelemetry
                ? { ...this.lastMutationPerformanceTelemetry }
                : null
        };
    }
}
