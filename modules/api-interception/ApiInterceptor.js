import ModuleCore from '../ModuleCore.js';
import { Logger } from '../../utils/logger.js';

export default class ApiInterceptor extends ModuleCore {
    constructor() {
        super('Api-Interceptor', false);
        this.usesMutationObserver = true;
        // 14.1: наблюдатель обязан видеть те же атрибуты, которые ищет scanElement. Без этого
        // подменённый НА МЕСТЕ `src` или `action` в DOM-путь не попадал вовсе: childList такой
        // мутации не порождает. Фильтр узкий по той же причине, что и в link-domain-security:
        // `attributes: true` прогнал бы через конвейер каждое изменение class/style анимированной
        // страницы.
        this.observerConfig = {
            ...this.observerConfig,
            attributes: true,
            attributeFilter: ['action', 'src', 'data-api', 'data-endpoint']
        };
        this.maxRecordedFindings = 20;
        this.maxSerializedFindings = 10;
        this.maxInitialElements = 10000;
        this.maxInitialCandidates = 2000;
        this.maxMutationElements = 1000;
        this.maxMutationCandidates = 300;
        this.maxPendingMutationRecords = 200;
        this.maxMutationNodesPerRecord = 100;
        this.maxMutationNodesPerBatch = 1000;
        this.maxPendingMutationRoots = 100;
        this.maxRawTargetCharacters = 8192;
        this.maxFindingTargetCharacters = 256;
        this.maxFindingDetailsCharacters = 320;
        this.initialScanTimeBudgetMs = 100;
        this.mutationScanTimeBudgetMs = 25;
        this.mutationThrottle = 500;
        this.recentFindings = [];
        this.pendingMutationRoots = new Set();
        this.mutationBatchTimer = null;
        this.processedCandidateElements = new WeakSet();
        this.scanRevision = 0;
        this.currentElementLimit = this.maxInitialElements;
        this.currentCandidateLimit = this.maxInitialCandidates;
        this.currentElementsVisited = 0;
        this.currentCandidatesAnalyzed = 0;
        this.currentScanBudgetMs = Number.POSITIVE_INFINITY;
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
        this.resetWorkStats();
        this.beginScanBatch(
            this.maxInitialElements,
            this.maxInitialCandidates,
            this.initialScanTimeBudgetMs
        );

        try {
            await this.collectElementsFromRoot(document.documentElement);
            this.scanRevision += 1;
            this.finishWorkSlice();
            const duration = performance.now() - startTime;
            this.stats.lastScanTime = duration;
            this.stats.totalScanTime = duration;
            Logger.info(`[${this.moduleName}] Bounded stub scan completed: ${this.currentElementsVisited} elements, ${this.currentCandidatesAnalyzed} candidates, ${duration.toFixed(2)}ms`);
        } catch (error) {
            Logger.error(`[${this.moduleName}] Bounded stub scan failed:`, error);
            throw error;
        } finally {
            this.processedCandidateElements = new WeakSet();
        }
    }

    async performScan() {
        // Gate plus the level-2 error handler, shared by every module (C7.3).
        await this.runExplicitScan();
        // Форма снапшота живёт в ядре (C1).
        return this.buildScanSnapshot();
    }

    scanElement(element) {
        if (!(element instanceof Element)
            || !this.isEnabled
            || this.processedCandidateElements.has(element)
            || this.isTimeBudgetReached()) {
            return;
        }

        // Loop-safety (C4): узел, вставленный расширением, кандидатом быть не может - иначе
        // наша собственная метка становится находкой, а находка - поводом для следующей метки.
        if (this.isExtensionOwnedElement(element)) {
            return;
        }

        if (!element.hasAttribute('action')
            && !element.hasAttribute('src')
            && !element.hasAttribute('data-api')
            && !element.hasAttribute('data-endpoint')) {
            return;
        }

        this.processedCandidateElements.add(element);
        if (element.localName === 'input'
            && String(element.getAttribute('type') || '').toLowerCase() === 'password') {
            this.passwordElementsSkipped += 1;
            return;
        }
        if (this.currentCandidatesAnalyzed >= this.currentCandidateLimit) {
            this.candidatesSkippedByLimit += 1;
            return;
        }

        const target = element.getAttribute('action')
            || element.getAttribute('src')
            || element.getAttribute('data-api')
            || element.getAttribute('data-endpoint');
        if (!target) {
            return;
        }
        if (target.length > this.maxRawTargetCharacters) {
            this.targetsSkippedByLength += 1;
            return;
        }

        this.currentCandidatesAnalyzed += 1;
        const normalizedTarget = target.toLowerCase();
        if (!normalizedTarget.includes('api')
            && !normalizedTarget.includes('/v1/')
            && !normalizedTarget.includes('/graphql')) {
            return;
        }

        this.stats.threatsDetected += 1;
        const findingSummary = typeof chrome !== 'undefined' && chrome?.i18n
            ? (chrome.i18n.getMessage('findingApiSurfaceSummary') || 'Potential page-side API interaction surface detected')
            : 'Potential page-side API interaction surface detected';
        const tagName = element.tagName.toLowerCase();
        const boundedTarget = target.slice(0, this.maxFindingTargetCharacters);
        const findingDetailsFallback = `${tagName}: ${boundedTarget}`;
        const findingDetails = typeof chrome !== 'undefined' && chrome?.i18n
            ? (chrome.i18n.getMessage('findingApiSurfaceDetails', [tagName, boundedTarget]) || findingDetailsFallback)
            : findingDetailsFallback;

        this.recordFinding({
            type: 'api-surface',
            summary: findingSummary,
            details: String(findingDetails).slice(0, this.maxFindingDetailsCharacters)
        });
    }

    async collectElementsFromRoot(root) {
        if (!(root instanceof Element) || !root.isConnected || !this.isEnabled) {
            return;
        }

        const pendingElements = [root];
        while (pendingElements.length > 0) {
            // Frontier counters are a LOWER BOUND on the skipped work - see C5.3 in the root TASKS.
            // `traversalAborted` carries "we do not know how much is left"; the same contract is
            // implemented in link-domain-security, which carries a verbatim copy of this loop.
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
            // Потолок синхронного куска отдельно от бюджета скана (C2): бюджет отвечает «сколько
            // работы всего», потолок - «сколько работы подряд».
            if (this.shouldYieldSlice()) {
                await this.yieldSlice();
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
            this.stats.elementsScanned += 1;
            try {
                this.scanElement(element);
            } catch (error) {
                // Level 1 (C5.6): a swallowed error used to be invisible - the candidate was gone
                // and the page still called itself fully analysed.
                this.recordUnitError('api-surface-candidate', error);
            }

            const availableQueueSlots = Math.max(
                0,
                this.currentElementLimit - this.currentElementsVisited - pendingElements.length
            );
            const childLimit = Math.min(element.children.length, availableQueueSlots);
            if (element.children.length > childLimit) {
                this.elementsSkippedByLimit += element.children.length - childLimit;
            }
            for (let index = childLimit - 1; index >= 0; index -= 1) {
                pendingElements.push(element.children[index]);
            }
        }
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

            // 14.1: правка атрибута на месте. Элемент ставится корнем сам - поддерево тут ни при
            // чём, изменился он.
            if (mutation.type === 'attributes') {
                const target = mutation.target;
                if (!(target instanceof Element) || !target.isConnected) {
                    continue;
                }
                if (this.pendingMutationRoots.size >= this.maxPendingMutationRoots) {
                    this.mutationRootsSkippedByLimit += 1;
                    this.mutationRecordsSkippedByLimit += Math.max(0, recordLimit - mutationIndex - 1);
                    break mutationLoop;
                }
                // Развилка, записанная при заведении пункта, решается здесь: без снятия отметки
                // ветка бесполезна. `processedCandidateElements` отвечает на вопрос «этот элемент уже
                // разобран», а после подмены атрибута прежний ответ описывает прежнее значение.
                this.processedCandidateElements.delete(target);
                this.addMutationRoot(target);
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
                    // One unit of work, one counter, once (C5.3).
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

    addMutationRoot(root) {
        for (const pendingRoot of this.pendingMutationRoots) {
            if (pendingRoot.contains(root)) {
                return;
            }
        }

        for (const pendingRoot of [...this.pendingMutationRoots]) {
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
            // Через гейт C5.1: батч уступает event-loop и теперь может чередоваться со сканом.
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
                await this.collectElementsFromRoot(root);
            }
            this.scanRevision += 1;
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
        // Бюджет измеряет АКТИВНУЮ работу, а не стенные часы: обход уступает event-loop, и часы
        // включали бы в бюджет чужое время - слайсинг выключал бы сам себя на первой уступке (C2).
        this.currentScanBudgetMs = timeBudgetMs;
        this.resetSliceAccounting();
        this.beginWorkSlice();
        this.scanTimeBudgetReachedInBatch = false;
        this.processedCandidateElements = new WeakSet();
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

    resetWorkStats() {
        this.traversalAborted = false;
        this.candidatesSkippedByLimit = 0;
        this.elementsSkippedByLimit = 0;
        this.elementsSkippedByTime = 0;
        this.targetsSkippedByLength = 0;
        this.passwordElementsSkipped = 0;
        this.mutationRecordsSkippedByLimit = 0;
        this.mutationNodesSkippedByLimit = 0;
        this.mutationRootsSkippedByLimit = 0;
        this.mutationRootsSkippedByTime = 0;
        this.scanTimeBudgetReached = 0;
    }

    // Same three-signal shape as the other DOM-walking modules (C5.2 in the root TASKS):
    // budgetReached is about limits and time, partialResult is about coverage, contentTruncated is
    // about analysing a unit on shortened data. A target skipped for being over the length cap was
    // never analysed, so it belongs to coverage; the truncation flag reports it separately.
    getSnapshotState() {
        const budgetReached = this.candidatesSkippedByLimit > 0
            || this.elementsSkippedByLimit > 0
            || this.elementsSkippedByTime > 0
            || this.mutationRecordsSkippedByLimit > 0
            || this.mutationNodesSkippedByLimit > 0
            || this.mutationRootsSkippedByLimit > 0
            || this.mutationRootsSkippedByTime > 0
            || this.scanTimeBudgetReached > 0;
        // A unit skipped because it threw is a coverage gap like any other (C5.6).
        const partialResult = budgetReached
            || this.traversalAborted
            || this.scanFailed
            || this.unitErrorCount > 0
            || this.targetsSkippedByLength > 0;

        return {
            status: partialResult ? 'partial' : 'complete',
            partialResult,
            budgetReached,
            contentTruncated: this.targetsSkippedByLength > 0,
            traversalAborted: this.traversalAborted
        };
    }

    onDestroy() {
        if (this.mutationBatchTimer !== null) {
            clearTimeout(this.mutationBatchTimer);
            this.mutationBatchTimer = null;
        }
        this.pendingMutationRoots.clear();
        this.processedCandidateElements = new WeakSet();
        this.currentScanBudgetMs = 0;
        this.recentFindings = [];
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
            scanRevision: this.scanRevision,
            elementsVisited: this.currentElementsVisited,
            candidatesAnalyzed: this.currentCandidatesAnalyzed,
            candidatesSkippedByLimit: this.candidatesSkippedByLimit,
            elementsSkippedByLimit: this.elementsSkippedByLimit,
            elementsSkippedByTime: this.elementsSkippedByTime,
            targetsSkippedByLength: this.targetsSkippedByLength,
            passwordElementsSkipped: this.passwordElementsSkipped,
            mutationRecordsSkippedByLimit: this.mutationRecordsSkippedByLimit,
            mutationNodesSkippedByLimit: this.mutationNodesSkippedByLimit,
            mutationRootsSkippedByLimit: this.mutationRootsSkippedByLimit,
            mutationRootsSkippedByTime: this.mutationRootsSkippedByTime,
            scanTimeBudgetReached: this.scanTimeBudgetReached,
            findingsTruncated: this.recentFindings.length > this.maxSerializedFindings,
            ...this.getSnapshotState()
        };
    }
}
