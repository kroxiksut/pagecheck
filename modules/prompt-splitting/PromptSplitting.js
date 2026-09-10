import ModuleCore from '../ModuleCore.js';
import { Logger } from '../../utils/logger.js';
import PromptCandidateCollector from './collectors/PromptCandidateCollector.js';
import PromptReconstructionEngine from './reconstruction/PromptReconstructionEngine.js';
import PromptDecisionEngine from './reconstruction/PromptDecisionEngine.js';
import PromptFindingState from './reconstruction/PromptFindingState.js';
import PromptMutationQueue from './runtime/PromptMutationQueue.js';
import { prepareCustomLiteralCatalog } from '../semantic-analysis/SemanticAnalysisCore.js';

export default class PromptSplitting extends ModuleCore {
    constructor() {
        super('Prompt-Splitting', false);
        this.usesMutationObserver = true;
        // Пауза сохраняет находки (см. onPause), поэтому рантайм имеет право вернуть модуль без
        // рескана, когда документ за время паузы не менялся (C2, контракт resume в ModuleCore).
        this.keepsStateWhilePaused = true;
        this.maxRecordedFindings = 20;
        this.maxSerializedFindings = 10;
        this.maxInitialElements = 10000;
        this.maxInitialCandidates = 2000;
        this.maxInitialFragments = 5000;
        this.maxInitialCharacters = 250000;
        this.maxMutationElements = 1000;
        this.maxMutationCandidates = 300;
        this.maxMutationFragments = 1000;
        this.maxMutationCharacters = 50000;
        this.maxChildNodesInspectedPerContainer = 128;
        this.maxCharactersPerContainer = 4096;
        this.maxPendingMutationRecords = 200;
        this.maxMutationNodesPerRecord = 100;
        this.maxMutationNodesPerBatch = 1000;
        this.maxPendingMutationRoots = 100;
        this.maxRemovedCandidateIds = 200;
        this.maxRemovedElementsPerBatch = 1000;
        this.maxMutationRegionsPerBatch = 8;
        this.initialScanTimeBudgetMs = 100;
        this.mutationScanTimeBudgetMs = 25;
        this.mutationThrottle = 500;
        // Длина собственного куска этого модуля. Мельче ядерного потолка намеренно: коллектор и
        // движок реконструкции работают длиннее на единицу работы, чем обход DOM.
        this.workSliceMs = 8;
        this.initialReconstructionLimits = {
            maxRegions: 80,
            maxCandidatesPerRegion: 16,
            maxStartsPerRegion: 16,
            maxCandidatesPerWindow: 4,
            maxWindowsPerRegion: 48,
            maxWindows: 1000,
            maxAssemblyVariants: 3,
            maxCharactersPerWindow: 4096,
            maxTotalCharacters: 100000,
            maxStructuralTransitions: 3,
            maxDedupeKeys: 1024,
            maxElapsedMs: 35
        };
        this.mutationReconstructionLimits = {
            ...this.initialReconstructionLimits,
            maxRegions: 8,
            maxWindows: 96,
            maxTotalCharacters: 20000,
            maxElapsedMs: 10
        };
        this.initialDecisionLimits = {
            maxSemanticAnalyses: 5,
            maxSourceFragmentAnalyses: 4,
            maxAssessments: 4,
            maxDecisions: 4,
            maxMappedCandidates: 4,
            maxMappedFragments: 4,
            maxCodesPerDecision: 12,
            maxElapsedMs: 25
        };
        this.mutationDecisionLimits = {
            ...this.initialDecisionLimits,
            maxElapsedMs: 10
        };
        this.decisionPolicy = {
            minimumConfidence: 'moderate',
            sensitivity: 'medium',
            customLiteralCatalog: [],
            eligibleAssemblyPaths: ['boundary-aware', 'spaced'],
            allowAttributeOnly: false
        };
        this.findingStateLimits = {
            maxActiveFindings: 200,
            maxReverseIndexEntries: 1000,
            maxPendingFindings: 200,
            maxCandidateIdsPerFinding: 8,
            maxSupportingRules: 8,
            maxCodes: 12,
            maxHistoryEntries: 20,
            maxSerializedFindings: this.maxSerializedFindings
        };
        this.recentFindings = [];
        this.mutationQueue = new PromptMutationQueue({
            maxRoots: this.maxPendingMutationRoots,
            maxRemovedCandidateIds: this.maxRemovedCandidateIds
        });
        this.mutationBatchTimer = null;
        this.mutationBatchPromise = null;
        this.initialScanInProgress = false;
        this.reconciliationPassPending = false;
        this.reconciliationPasses = 0;
        // 11.4: «ровно один полный рескан на запрошенную реконсиляцию».
        this.reconciliationRescanScheduled = false;
        this.reconciliationRescans = 0;
        this.configRevision = 0;
        this.runtimeRevision = 0;
        this.currentScanConfiguration = null;
        this.lastPublishedFindingSignature = '';
        this.candidateCollector = new PromptCandidateCollector();
        this.reconstructionEngine = new PromptReconstructionEngine();
        this.decisionEngine = new PromptDecisionEngine();
        this.findingState = new PromptFindingState(this.findingStateLimits);
        this.lastCollectorStatus = 'idle';
        this.lastCollectorDiagnostics = null;
        this.lastReconstructionStatus = 'idle';
        this.lastReconstructionDiagnostics = null;
        this.lastDecisionStatus = 'idle';
        this.lastDecisionDiagnostics = null;
        this.lastFindingStatus = 'idle';
        this.lastFindingDiagnostics = null;
        this.candidateElementIds = new WeakMap();
        this.regionAnchorIds = new WeakMap();
        // C4.3: обратная связь «id региона -> его якорь», нужная слою вмешательства. Развилка
        // «регион из многих узлов -> какой узел» решена в пользу ЯКОРЯ: это тот самый контейнер,
        // который коллектор уже считает границей региона, он один на регион и не зависит от того,
        // какой фрагмент оказался первым. Ссылки живут только внутри скана и стираются в
        // finishScanConfiguration - тот же контракт, по которому очередь намерений слоя не переживает
        // скан. Карта наполняется ТОЛЬКО при открытом гейте: при закрытом ссылок на узлы здесь нет.
        this.scanRegionAnchors = new Map();
        this.maxScanRegionAnchors = 200;
        this.nextCandidateElementId = 1;
        this.nextRegionAnchorId = 1;
        this.scanRevision = 0;
        // Расширяем дефолт ядра, а не перезаписываем его: перезапись молча теряет любое поле,
        // которое ядро добавит позже (C1, разбор 2026-09-09).
        this.observerConfig = {
            ...this.observerConfig,
            attributes: true,
            characterData: true,
            attributeFilter: ['title', 'aria-label', 'alt', 'contenteditable', 'role', 'aria-multiline']
        };
        this.currentElementLimit = this.maxInitialElements;
        this.currentCandidateLimit = this.maxInitialCandidates;
        this.currentFragmentLimit = this.maxInitialFragments;
        this.currentCharacterLimit = this.maxInitialCharacters;
        this.currentElementsVisited = 0;
        this.currentCandidatesAnalyzed = 0;
        this.currentFragmentsCollected = 0;
        this.currentCharactersCollected = 0;
        this.resetWorkStats();
    }

    createEffectiveConfig(config) {
        const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
        const threshold = Number.isFinite(source.detectionThreshold)
            && source.detectionThreshold >= 0
            && source.detectionThreshold <= 1
            ? source.detectionThreshold
            : 0.8;
        const minimumConfidence = threshold <= 0.33
            ? 'weak'
            : threshold <= 0.66
                ? 'moderate'
                : 'strong';
        return Object.freeze({
            sensitivity: ['low', 'medium', 'high'].includes(source.sensitivity) ? source.sensitivity : 'medium',
            minimumConfidence,
            detectionThreshold: threshold
        });
    }

    beginScanConfiguration() {
        const configuration = Object.freeze({
            configRevision: this.configRevision,
            runtimeRevision: this.runtimeRevision,
            lifecycleRevision: this.lifecycleRevision,
            decisionPolicy: Object.freeze({
                ...this.decisionPolicy,
                customLiteralCatalog: [...this.decisionPolicy.customLiteralCatalog]
            })
        });
        this.currentScanConfiguration = configuration;
        return configuration;
    }

    isScanConfigurationCurrent(configuration) {
        return this.isEnabled
            && configuration?.configRevision === this.configRevision
            && configuration?.runtimeRevision === this.runtimeRevision
            && configuration?.lifecycleRevision === this.lifecycleRevision;
    }

    finishScanConfiguration(configuration) {
        if (this.currentScanConfiguration === configuration) {
            this.currentScanConfiguration = null;
        }
        // Ссылки на якоря не переживают скан - тот же контракт, по которому снапшот не содержит узлов.
        this.scanRegionAnchors.clear();
    }

    invalidatePendingWork() {
        this.runtimeRevision += 1;
    }

    hasDetectionConfigChange(config) {
        const effectiveConfig = this.createEffectiveConfig(config);
        const catalog = prepareCustomLiteralCatalog(config?.customPatterns, effectiveConfig, {
            maxPatterns: 500,
            maxCharacters: 65536
        });
        return this.decisionPolicy.minimumConfidence !== effectiveConfig.minimumConfidence
            || this.decisionPolicy.sensitivity !== effectiveConfig.sensitivity
            || this.decisionPolicy.customLiteralCatalog.length !== catalog.length
            || this.decisionPolicy.customLiteralCatalog.some((pattern, index) => (
                pattern.id !== catalog[index]?.id
                || pattern.comparisonText !== catalog[index]?.comparisonText
            ));
    }

    onConfigUpdate(oldConfig, newConfig) {
        const effectiveConfig = this.createEffectiveConfig(newConfig);
        let customLiteralCatalog = [];
        try {
            customLiteralCatalog = prepareCustomLiteralCatalog(newConfig.customPatterns, effectiveConfig, {
                maxPatterns: 500,
                maxCharacters: 65536
            });
        } catch {
            this.lastDecisionStatus = 'error';
        }
        const nextPolicy = {
            ...this.decisionPolicy,
            minimumConfidence: effectiveConfig.minimumConfidence,
            sensitivity: effectiveConfig.sensitivity,
            customLiteralCatalog
        };
        const changed = this.decisionPolicy.minimumConfidence !== nextPolicy.minimumConfidence
            || this.decisionPolicy.sensitivity !== nextPolicy.sensitivity
            || this.decisionPolicy.customLiteralCatalog.length !== nextPolicy.customLiteralCatalog.length
            || this.decisionPolicy.customLiteralCatalog.some((pattern, index) => (
                pattern.id !== nextPolicy.customLiteralCatalog[index]?.id
                || pattern.comparisonText !== nextPolicy.customLiteralCatalog[index]?.comparisonText
            ));
        if (changed) {
            this.decisionPolicy = Object.freeze(nextPolicy);
            this.configRevision += 1;
        }
        if (newConfig.customPatterns?.version === 1) {
            this.config.customPatterns = {
                version: 1,
                items: newConfig.customPatterns.items.map(({ id, enabled, mode }) => ({ id, enabled, mode }))
            };
        }
        return { requiresDetectionRefresh: changed };
    }

    async firstScan(reconciliationPass = 0) {
        if (!this.isEnabled) {
            return;
        }

        const scanConfiguration = this.beginScanConfiguration();
        const startTime = performance.now();
        this.resetSliceAccounting();
        this.beginWorkSlice();
        this.initialScanInProgress = true;
        this.reconciliationPassPending = false;
        this.resetStats();
        this.recentFindings = [];
        this.resetWorkStats();
        try {
            await this.collectCandidateBatch(document.documentElement, {
                maxElements: this.maxInitialElements,
                maxCandidates: this.maxInitialCandidates,
                maxFragments: this.maxInitialFragments,
                maxCharacters: this.maxInitialCharacters,
                maxCharactersPerCandidate: this.maxCharactersPerContainer,
                maxChildNodesPerElement: this.maxChildNodesInspectedPerContainer,
                maxElapsedMs: this.initialScanTimeBudgetMs,
                reconstructionLimits: this.initialReconstructionLimits,
                decisionLimits: this.initialDecisionLimits,
                findingScope: 'full',
                scanConfiguration
            });
            if (!this.isScanConfigurationCurrent(scanConfiguration)) {
                return;
            }
            await this.reconcileInitialMutationQueue(scanConfiguration, reconciliationPass);
            if (!this.isScanConfigurationCurrent(scanConfiguration)) {
                return;
            }
            this.scanRevision += 1;
            const duration = performance.now() - startTime;
            this.stats.lastScanTime = duration;
            this.stats.totalScanTime = duration;
            Logger.info(`[${this.moduleName}] Candidate collection completed: ${this.currentElementsVisited} elements, ${this.currentCandidatesAnalyzed} candidates, ${duration.toFixed(2)}ms`);
        } catch (error) {
            Logger.error(`[${this.moduleName}] Candidate collection failed:`, error);
            throw error;
        } finally {
            this.initialScanInProgress = false;
            this.finishScanConfiguration(scanConfiguration);
            if (this.isEnabled && this.mutationQueue.hasPendingWork()) {
                this.scheduleMutationBatch();
            }
        }
    }

    async performScan() {
        // Gate plus the level-2 error handler, shared by every module (C7.3).
        await this.runExplicitScan();
        return {
            module: this.moduleName,
            threatsDetected: this.stats.threatsDetected,
            findings: this.recentFindings.slice(0, this.maxSerializedFindings),
            findingsTruncated: this.findingState.getSnapshot().findingsTruncated,
            revision: this.findingState.getSnapshot().findingRevision,
            ...this.getSnapshotState(),
            stats: this.getStats()
        };
    }

    async collectCandidateBatch(root, limits) {
        const scanConfiguration = limits.scanConfiguration || this.beginScanConfiguration();
        // Свой кусок у этого модуля мельче ядерного (8 мс против 16), и это остаётся так - но
        // потолок вкладки может опуститься ниже при длинных тасках, и тогда решает он (C2).
        const workSliceMs = Math.min(this.workSliceMs, this.maxSliceMs);
        const ownsScanConfiguration = !limits.scanConfiguration;
        const isCurrent = () => this.isScanConfigurationCurrent(scanConfiguration);
        const collection = await this.candidateCollector.collect(root, {
            limits: { ...limits, workSliceMs },
            isCurrent,
            // Уступка через ядро (C2): свой setTimeout не знал ни про общий потолок куска на
            // вкладку, ни про backoff по длинным таскам, ни про учёт активного времени.
            yieldControl: () => this.yieldSlice(),
            isExtensionOwned: (element) => this.isExtensionOwnedElement(element),
            getCandidateId: (element) => {
                let id = this.candidateElementIds.get(element);
                if (!id) {
                    id = `candidate-${this.nextCandidateElementId++}`;
                    this.candidateElementIds.set(element, id);
                }
                return id;
            },
            getRegionId: (element) => {
                let id = this.regionAnchorIds.get(element);
                if (!id) {
                    id = `region-${this.nextRegionAnchorId++}`;
                    this.regionAnchorIds.set(element, id);
                }
                if (this.findingNodeSink && this.scanRegionAnchors.size < this.maxScanRegionAnchors) {
                    this.scanRegionAnchors.set(id, element);
                }
                return id;
            }
        });
        const diagnostics = collection.diagnostics;
        this.currentElementsVisited = diagnostics.elementsVisited;
        this.currentCandidatesAnalyzed = diagnostics.candidatesCreated;
        this.currentFragmentsCollected = diagnostics.fragmentsCreated;
        this.currentCharactersCollected = diagnostics.charactersRead;
        // 11.9: одно значение прибавлялось к двум разным именам, и отбраковка кандидата по лимиту
        // кандидатов считалась ещё и пропуском элемента. У коллектора есть собственный счётчик -
        // одна единица работы, ровно один счётчик, ровно один раз (C5.3).
        this.candidatesSkippedByLimit += diagnostics.candidatesSkippedByLimit;
        this.elementsSkippedByLimit += diagnostics.elementsSkippedByLimit;
        this.directNodesSkippedByLimit += diagnostics.childNodesSkippedByLimit;
        this.charactersSkippedByLimit += diagnostics.charactersSkippedByLimit;
        this.privacySubtreesSkipped += diagnostics.privacySubtreesSkipped;
        this.technicalSubtreesSkipped += diagnostics.technicalSubtreesSkipped;
        this.scanTimeBudgetReached += diagnostics.elapsedBudgetReached ? 1 : 0;
        this.lastCollectorStatus = collection.status;
        this.lastCollectorDiagnostics = {
            elementsVisited: diagnostics.elementsVisited,
            candidatesCreated: diagnostics.candidatesCreated,
            fragmentsCreated: diagnostics.fragmentsCreated,
            charactersRead: diagnostics.charactersRead,
            regionsCreated: diagnostics.regionsCreated,
            workSlices: diagnostics.workSlices,
            partial: diagnostics.partial,
            lifecycleCancelled: diagnostics.lifecycleCancelled
        };
        this.stats.elementsScanned = diagnostics.elementsVisited;
        this.stats.threatsDetected = 0;
        this.recentFindings = [];
        const findingBatch = this.findingState.beginBatch({
            scope: limits.findingScope,
            lifecycleRevision: this.scanRevision + 1,
            regionIds: collection.regions.map((region) => region.id),
            partial: collection.partial || limits.forcePartial === true
        });
        const decisionSummary = {
            reconstructedCandidatesEvaluated: 0,
            decisionsCreated: 0,
            eligibleDecisions: 0,
            suppressedDecisions: 0,
            partial: false,
            error: false
        };
        let decisionStatus = 'complete';
        const reconstruction = await this.reconstructionEngine.reconstruct(collection, {
            limits: { ...limits.reconstructionLimits, workSliceMs },
            isCurrent,
            yieldControl: () => this.yieldSlice(),
            onCandidate: async (reconstructedCandidate) => {
                const decisionResult = await this.decisionEngine.evaluate(reconstructedCandidate, scanConfiguration.decisionPolicy, {
                    limits: limits.decisionLimits,
                    isCurrent,
                    onEligibleDecision: async (decision, evidence) => {
                        const accepted = this.findingState.recordDecision(findingBatch, decision, evidence);
                        // C4.3: узел отдаётся только по ПРИНЯТОЙ находке и только пока идёт скан.
                        // Длинный регион режется на куски с id вида `region-3#1`, а якорь у всех
                        // кусков один - поэтому ключ берётся до решётки.
                        if (accepted === true && this.findingNodeSink) {
                            const anchorId = String(evidence?.regionId || '').split('#')[0];
                            const anchor = this.scanRegionAnchors.get(anchorId);
                            if (anchor) {
                                this.emitFindingNode({ type: 'prompt-splitting' }, anchor);
                            }
                        }
                    }
                });
                decisionSummary.reconstructedCandidatesEvaluated += 1;
                decisionSummary.decisionsCreated += decisionResult.decisions.length;
                decisionSummary.eligibleDecisions += decisionResult.decisions
                    .filter((decision) => decision.eligibility === 'eligible').length;
                decisionSummary.suppressedDecisions += decisionResult.diagnostics.decisionsSuppressed;
                decisionSummary.partial = decisionSummary.partial || decisionResult.partial;
                decisionSummary.error = decisionSummary.error || decisionResult.status === 'error';
                if (decisionResult.status === 'error') decisionStatus = 'error';
                else if (decisionResult.status === 'partial' && decisionStatus !== 'error') decisionStatus = 'partial';
                decisionResult.dispose();
            }
        });
        this.lastReconstructionStatus = reconstruction.status;
        this.lastReconstructionDiagnostics = {
            regionsProcessed: reconstruction.diagnostics.regionsProcessed,
            regionsDeduplicated: reconstruction.diagnostics.regionsDeduplicated,
            windowsConsidered: reconstruction.diagnostics.windowsConsidered,
            windowsEmitted: reconstruction.diagnostics.windowsEmitted,
            variantsBuilt: reconstruction.diagnostics.variantsBuilt,
            charactersReconstructed: reconstruction.diagnostics.charactersReconstructed,
            partial: reconstruction.diagnostics.partial,
            lifecycleCancelled: reconstruction.diagnostics.lifecycleCancelled
        };
        this.lastDecisionStatus = decisionStatus;
        this.lastDecisionDiagnostics = { ...decisionSummary };
        findingBatch.partial = findingBatch.partial || reconstruction.partial || decisionSummary.partial;
        findingBatch.error = decisionSummary.error || reconstruction.status === 'error';
        const findingCommit = this.findingState.commitBatch(findingBatch, {
            isCurrent
        });
        const findingSnapshot = this.findingState.getSnapshot();
        this.lastFindingStatus = findingCommit.status;
        this.lastFindingDiagnostics = {
            activeCount: findingSnapshot.activeCount,
            findingRevision: findingSnapshot.findingRevision,
            findingsTruncated: findingSnapshot.findingsTruncated,
            partial: findingSnapshot.partialResult,
            materiallyChanged: findingCommit.materiallyChanged === true
        };
        this.stats.threatsDetected = findingSnapshot.activeCount;
        this.recentFindings = findingSnapshot.findings;
        this.publishFindingStateIfChanged(findingSnapshot, findingCommit);
        reconstruction.dispose();
        collection.dispose();
        if (ownsScanConfiguration) this.finishScanConfiguration(scanConfiguration);
        return reconstruction.status === 'error' ? reconstruction.status : collection.status;
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
            this.mutationQueue.markOverflow();
        }

        let mutationNodesInspected = 0;
        for (let mutationIndex = 0; mutationIndex < recordLimit; mutationIndex += 1) {
            const mutation = mutations[mutationIndex];
            mutationNodesInspected = this.enqueueMutationRecord(mutation, mutationNodesInspected);
            if (mutationNodesInspected >= this.maxMutationNodesPerBatch) {
                this.mutationRecordsSkippedByLimit += Math.max(0, recordLimit - mutationIndex - 1);
                this.mutationQueue.markOverflow();
                break;
            }
        }

        if (!this.initialScanInProgress && this.mutationQueue.hasPendingWork()) {
            this.scheduleMutationBatch();
        }
    }

    processMutation(mutation) {
        this.handleMutations([mutation]);
    }

    enqueueMutationRecord(mutation, nodesInspected) {
        if (mutation?.type === 'characterData') {
            this.enqueueMutationRoot(mutation.target?.parentElement);
            return nodesInspected;
        }
        if (mutation?.type === 'attributes' && mutation.target instanceof Element) {
            const root = mutation.target;
            if (this.isPrivacyRoot(root)) {
                const cleanup = this.collectKnownCandidateIds(root, this.maxRemovedElementsPerBatch - nodesInspected);
                this.mutationQueue.enqueueRemovedCandidateIds(cleanup.candidateIds);
                if (cleanup.partial) this.mutationQueue.markOverflow();
            } else {
                this.enqueueMutationRoot(root);
            }
            return nodesInspected;
        }
        if (mutation?.type !== 'childList') {
            return nodesInspected;
        }

        const remainingNodes = Math.max(0, this.maxMutationNodesPerBatch - nodesInspected);
        const addedNodeLimit = Math.min(mutation.addedNodes.length, this.maxMutationNodesPerRecord, remainingNodes);
        if (mutation.addedNodes.length > addedNodeLimit) {
            this.mutationNodesSkippedByLimit += mutation.addedNodes.length - addedNodeLimit;
            this.mutationQueue.markOverflow();
        }
        for (let index = 0; index < addedNodeLimit; index += 1) {
            const node = mutation.addedNodes[index];
            nodesInspected += 1;
            this.enqueueMutationRoot(node instanceof Element ? node : node.parentElement);
        }
        let cleanupBudget = Math.max(0, this.maxRemovedElementsPerBatch - nodesInspected);
        for (const node of mutation.removedNodes) {
            const cleanup = this.collectKnownCandidateIds(node, cleanupBudget);
            this.mutationQueue.enqueueRemovedCandidateIds(cleanup.candidateIds);
            if (cleanup.partial) this.mutationQueue.markOverflow();
            cleanupBudget = Math.max(0, cleanupBudget - cleanup.visited);
        }
        this.enqueueMutationRoot(mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement);
        return nodesInspected;
    }

    enqueueMutationRoot(root) {
        // 11.7, правило 4 из C5.2: отказ по НЕРЕЛЕВАНТНОСТИ (узел не Element либо уже не в
        // документе) - это не пропущенная работа. Раньше он шёл в тот же счётчик, что и потеря по
        // лимиту, а тот транслируется в partial: одна мутация с текстовым узлом делала страницу
        // «частично просканированной» навсегда, до конца её жизни.
        const isRelevantRoot = root instanceof Element && root.isConnected;
        const accepted = this.mutationQueue.enqueueRoot(root, (candidate) => candidate instanceof Element && candidate.isConnected);
        if (!accepted) {
            if (isRelevantRoot) {
                this.mutationRootsSkippedByLimit += 1;
            } else {
                this.mutationRootsRejectedAsIrrelevant += 1;
            }
        }
        return accepted;
    }

    isPrivacyRoot(element) {
        if (!(element instanceof Element)) return false;
        const tagName = element.localName;
        if (['input', 'textarea', 'select', 'option', 'optgroup'].includes(tagName)) return true;
        return (element.hasAttribute('contenteditable')
                && element.getAttribute('contenteditable')?.toLowerCase() !== 'false')
            || element.getAttribute('role')?.toLowerCase() === 'textbox'
            || element.getAttribute('aria-multiline')?.toLowerCase() === 'true';
    }

    collectKnownCandidateIds(root, maxElements) {
        const candidateIds = [];
        const pending = [];
        if (root instanceof Element) pending.push(root);
        else if (root?.parentElement instanceof Element) pending.push(root.parentElement);
        let visited = 0;
        while (pending.length > 0 && visited < Math.max(0, maxElements)) {
            const element = pending.pop();
            visited += 1;
            const candidateId = this.candidateElementIds.get(element);
            if (candidateId) candidateIds.push(candidateId);
            for (let index = element.children.length - 1; index >= 0; index -= 1) {
                pending.push(element.children[index]);
            }
        }
        return { candidateIds, visited, partial: pending.length > 0 };
    }

    // 11.4: корни, не поместившиеся в батч, исчезали навсегда - takeBatch() опустошает очередь, а
    // срез до maxMutationRegionsPerBatch выбрасывал остаток. Страница просто оставалась помеченной
    // partial, и на этом всё: внедрение, попавшее в хвост крупного батча, не анализировалось
    // никогда. Возврат корней в очередь потребовал бы собственного потолка и рисковал
    // неограниченной догоняющей очередью, прямо запрещённой контрактом Priority 5, поэтому
    // переполнение планирует РОВНО ОДИН полный рескан: повторные запросы, пока он не отработал,
    // новых не создают.
    scheduleReconciliationRescan() {
        this.reconciliationPassPending = true;
        if (this.reconciliationRescanScheduled) {
            return false;
        }
        this.reconciliationRescanScheduled = true;
        return true;
    }

    scheduleMutationBatch() {
        if (this.initialScanInProgress || this.mutationBatchTimer !== null || this.mutationBatchPromise !== null) {
            return;
        }

        const runtimeRevision = this.runtimeRevision;
        const lifecycleRevision = this.lifecycleRevision;
        const delay = Math.max(0, this.mutationThrottle - (Date.now() - this.lastMutationTime));
        this.mutationBatchTimer = setTimeout(() => {
            this.mutationBatchTimer = null;
            if (!this.isEnabled || runtimeRevision !== this.runtimeRevision || lifecycleRevision !== this.lifecycleRevision) {
                return;
            }
            // Через гейт C5.1: батч мутаций и полный скан не должны чередоваться на общем
            // состоянии, а этот путь идёт из setTimeout мимо очереди js/content.js.
            const batchPromise = this.runGuardedScan(
                'mutation-batch',
                () => this.processQueuedMutationBatch(runtimeRevision, lifecycleRevision)
            );
            this.mutationBatchPromise = batchPromise;
            batchPromise.catch((error) => {
                Logger.error(`[${this.moduleName}] Error processing mutation roots:`, error);
            }).finally(() => {
                if (this.mutationBatchPromise === batchPromise) this.mutationBatchPromise = null;
                if (!this.isEnabled
                    || runtimeRevision !== this.runtimeRevision
                    || lifecycleRevision !== this.lifecycleRevision) {
                    return;
                }
                // Запрошенная реконсиляция важнее следующего батча: корни, которые в него не
                // поместились, живут только в этом запросе (11.4).
                if (this.reconciliationRescanScheduled) {
                    this.reconciliationRescanScheduled = false;
                    this.reconciliationRescans += 1;
                    this.runGuardedScan('reconciliation-rescan', () => this.firstScan())
                        .catch((error) => {
                            Logger.error(`[${this.moduleName}] Error running reconciliation rescan:`, error);
                        });
                    return;
                }
                if (this.mutationQueue.hasPendingWork()) {
                    this.scheduleMutationBatch();
                }
            });
        }, delay);
    }

    async processQueuedMutationBatch(runtimeRevision, lifecycleRevision) {
        if (!this.isEnabled || runtimeRevision !== this.runtimeRevision || lifecycleRevision !== this.lifecycleRevision) return;
        const batch = this.mutationQueue.takeBatch();
        if (batch.removedCandidateIds.length > 0 && this.findingState.removeCandidates(batch.removedCandidateIds)) {
            const snapshot = this.findingState.getSnapshot();
            this.stats.threatsDetected = snapshot.activeCount;
            this.recentFindings = snapshot.findings;
            this.publishFindingStateIfChanged(snapshot, { materiallyChanged: true, status: snapshot.status });
        }
        if (batch.roots.length === 0) {
            if (batch.partial || batch.reconciliationRequested) {
                this.reconciliationPassPending = true;
                this.lastFindingStatus = 'partial';
                const snapshot = this.findingState.getSnapshot();
                this.publishFindingStateIfChanged({ ...snapshot, partialResult: true }, { materiallyChanged: true, status: 'partial' });
            }
            return;
        }
        if (batch.reconciliationRequested) this.reconciliationPassPending = true;
        const roots = batch.roots.slice(0, this.maxMutationRegionsPerBatch);
        if (batch.roots.length > roots.length) {
            this.mutationRootsSkippedByLimit += batch.roots.length - roots.length;
            this.mutationQueue.markOverflow();
            // Остаток корней уже не в очереди: единственное, что вернёт их работу, - полный рескан.
            this.scheduleReconciliationRescan();
        }
        this.lastMutationTime = Date.now();
        await this.processMutationRoots(roots, batch.partial || batch.reconciliationRequested);
        if (batch.reconciliationRequested && this.mutationQueue.hasPendingWork()) {
            this.reconciliationPassPending = true;
        }
    }

    async processMutationRoots(roots, forcePartial = false) {
        const startTime = performance.now();
        let scanConfiguration = null;
        try {
            scanConfiguration = this.beginScanConfiguration();
            for (const root of roots) {
                if (!this.isScanConfigurationCurrent(scanConfiguration)) return;
                await this.collectCandidateBatch(root, {
                    maxElements: this.maxMutationElements,
                    maxCandidates: this.maxMutationCandidates,
                    maxFragments: this.maxMutationFragments,
                    maxCharacters: this.maxMutationCharacters,
                    maxCharactersPerCandidate: this.maxCharactersPerContainer,
                    maxChildNodesPerElement: this.maxChildNodesInspectedPerContainer,
                    maxElapsedMs: this.mutationScanTimeBudgetMs,
                    reconstructionLimits: this.mutationReconstructionLimits,
                    decisionLimits: this.mutationDecisionLimits,
                    findingScope: 'region',
                    forcePartial,
                    scanConfiguration
                });
            }
            this.scanRevision += 1;
            const duration = performance.now() - startTime;
            this.stats.totalScanTime += duration;
            this.stats.lastScanTime = duration;
        } catch (error) {
            Logger.error(`[${this.moduleName}] Error processing mutation roots:`, error);
        } finally {
            if (scanConfiguration) this.finishScanConfiguration(scanConfiguration);
        }
    }

    async reconcileInitialMutationQueue(scanConfiguration, reconciliationPass) {
        if (!this.isScanConfigurationCurrent(scanConfiguration)) return;
        if (!this.mutationQueue.hasPendingWork()) return;
        if (reconciliationPass >= 1) {
            this.reconciliationPassPending = true;
            this.lastFindingStatus = 'partial';
            const snapshot = this.findingState.getSnapshot();
            this.publishFindingStateIfChanged({ ...snapshot, partialResult: true }, { materiallyChanged: true, status: 'partial' });
            return;
        }
        this.reconciliationPasses += 1;
        const batch = this.mutationQueue.takeBatch();
        if (batch.removedCandidateIds.length > 0 && this.findingState.removeCandidates(batch.removedCandidateIds)) {
            const snapshot = this.findingState.getSnapshot();
            this.stats.threatsDetected = snapshot.activeCount;
            this.recentFindings = snapshot.findings;
            this.publishFindingStateIfChanged(snapshot, { materiallyChanged: true, status: snapshot.status });
        }
        const roots = batch.roots.slice(0, this.maxMutationRegionsPerBatch);
        if (batch.roots.length > roots.length) {
            this.mutationRootsSkippedByLimit += batch.roots.length - roots.length;
            this.scheduleReconciliationRescan();
        }
        if (roots.length === 0) {
            if (batch.partial || batch.reconciliationRequested) {
                this.reconciliationPassPending = true;
                this.lastFindingStatus = 'partial';
                const snapshot = this.findingState.getSnapshot();
                this.publishFindingStateIfChanged({ ...snapshot, partialResult: true }, { materiallyChanged: true, status: 'partial' });
            }
            return;
        }
        await this.processMutationRoots(roots, batch.partial || batch.reconciliationRequested);
        if (this.mutationQueue.hasPendingWork()) {
            await this.reconcileInitialMutationQueue(scanConfiguration, reconciliationPass + 1);
        }
    }

    publishFindingStateIfChanged(snapshot, commit) {
        const signature = [
            snapshot.findingRevision,
            snapshot.activeCount,
            snapshot.partialResult ? 'partial' : 'complete',
            snapshot.findingsTruncated ? 'truncated' : 'full'
        ].join(':');
        if (signature === this.lastPublishedFindingSignature
            && commit?.materiallyChanged !== true) {
            return;
        }
        this.lastPublishedFindingSignature = signature;
        this.dispatchEvent('findingStateChanged', {
            module: this.moduleName,
            findingRevision: snapshot.findingRevision,
            activeCount: snapshot.activeCount,
            partialResult: snapshot.partialResult,
            findingsTruncated: snapshot.findingsTruncated,
            materiallyChanged: commit?.materiallyChanged === true
        });
    }

    resetWorkStats() {
        this.candidatesSkippedByLimit = 0;
        this.elementsSkippedByLimit = 0;
        this.elementsSkippedByTime = 0;
        this.directNodesSkippedByLimit = 0;
        this.fragmentsSkippedByLimit = 0;
        this.fragmentBatchesSkippedByLimit = 0;
        this.charactersSkippedByLimit = 0;
        this.privacySubtreesSkipped = 0;
        this.technicalSubtreesSkipped = 0;
        this.mutationRecordsSkippedByLimit = 0;
        this.mutationNodesSkippedByLimit = 0;
        this.mutationRootsSkippedByLimit = 0;
        this.mutationRootsSkippedByTime = 0;
        // Диагностика, а не пропущенная работа: в partial не транслируется (11.7).
        this.mutationRootsRejectedAsIrrelevant = 0;
        this.scanTimeBudgetReached = 0;
        this.mutationQueueHighWaterMark = 0;
        this.mutationQueueOverflows = 0;
    }

    getSnapshotState() {
        const partialResult = this.candidatesSkippedByLimit > 0
            || this.elementsSkippedByLimit > 0
            || this.elementsSkippedByTime > 0
            || this.directNodesSkippedByLimit > 0
            || this.fragmentsSkippedByLimit > 0
            || this.fragmentBatchesSkippedByLimit > 0
            || this.charactersSkippedByLimit > 0
            || this.mutationRecordsSkippedByLimit > 0
            || this.mutationNodesSkippedByLimit > 0
            || this.mutationRootsSkippedByLimit > 0
            || this.mutationRootsSkippedByTime > 0
            || this.scanTimeBudgetReached > 0
            || this.reconciliationPassPending
            || this.mutationQueue.partial
            || this.lastCollectorStatus === 'partial'
            || this.lastReconstructionStatus === 'partial'
            || this.lastDecisionStatus === 'partial'
            || this.lastFindingStatus === 'partial';

        return {
            status: this.lastCollectorStatus === 'error' || this.lastReconstructionStatus === 'error' || this.lastDecisionStatus === 'error' || this.lastFindingStatus === 'error'
                ? 'error'
                : partialResult ? 'partial' : 'complete',
            partialResult: partialResult || this.lastCollectorStatus === 'error' || this.lastReconstructionStatus === 'error' || this.lastDecisionStatus === 'error' || this.lastFindingStatus === 'error',
            budgetReached: partialResult
        };
    }

    onDestroy() {
        this.stopScheduledWork();
        this.recentFindings = [];
        this.lastCollectorStatus = 'disabled';
        this.lastReconstructionStatus = 'disabled';
        this.lastDecisionStatus = 'disabled';
        this.findingState.clear();
        this.lastFindingStatus = 'disabled';
        // Идентичность кандидатов и регионов уходит вместе с находками: без находок она ничего не
        // описывает, а следующая жизнь модуля начнётся с нуля.
        this.candidateElementIds = new WeakMap();
        this.regionAnchorIds = new WeakMap();
        this.nextCandidateElementId = 1;
        this.nextRegionAnchorId = 1;
    }

    // Пауза оставляет находки и снимает всё остальное. Уходит то, что сработало бы в фоновой вкладке
    // (таймер батча, очередь мутаций, признак идущего скана) и ссылки на узлы, которых слой всё
    // равно не переживает.
    // Остаются: findingState и `candidateElementIds`/`regionAnchorIds`. Идентичность обязана
    // пережить паузу вместе с находками: без неё после возврата тот же элемент получил бы новый id,
    // и мутация завела бы ВТОРУЮ находку о том же регионе вместо обновления первой.
    onPause() {
        this.stopScheduledWork();
    }

    stopScheduledWork() {
        if (this.mutationBatchTimer !== null) {
            clearTimeout(this.mutationBatchTimer);
            this.mutationBatchTimer = null;
        }
        this.mutationQueue.clear();
        this.mutationBatchPromise = null;
        this.initialScanInProgress = false;
        this.reconciliationPassPending = false;
        this.currentScanConfiguration = null;
        this.scanRegionAnchors.clear();
        this.lastCollectorDiagnostics = null;
        this.lastReconstructionDiagnostics = null;
        this.lastDecisionDiagnostics = null;
        this.lastFindingDiagnostics = null;
    }

    getStats() {
        return {
            ...super.getStats(),
            recentFindings: this.recentFindings.slice(0, 5),
            scanRevision: this.scanRevision,
            elementsVisited: this.currentElementsVisited,
            candidatesAnalyzed: this.currentCandidatesAnalyzed,
            fragmentsCollected: this.currentFragmentsCollected,
            charactersCollected: this.currentCharactersCollected,
            candidatesSkippedByLimit: this.candidatesSkippedByLimit,
            elementsSkippedByLimit: this.elementsSkippedByLimit,
            elementsSkippedByTime: this.elementsSkippedByTime,
            directNodesSkippedByLimit: this.directNodesSkippedByLimit,
            fragmentsSkippedByLimit: this.fragmentsSkippedByLimit,
            fragmentBatchesSkippedByLimit: this.fragmentBatchesSkippedByLimit,
            charactersSkippedByLimit: this.charactersSkippedByLimit,
            privacySubtreesSkipped: this.privacySubtreesSkipped,
            technicalSubtreesSkipped: this.technicalSubtreesSkipped,
            mutationRecordsSkippedByLimit: this.mutationRecordsSkippedByLimit,
            mutationNodesSkippedByLimit: this.mutationNodesSkippedByLimit,
            mutationRootsSkippedByLimit: this.mutationRootsSkippedByLimit,
            mutationRootsRejectedAsIrrelevant: this.mutationRootsRejectedAsIrrelevant,
            reconciliationRescans: this.reconciliationRescans,
            mutationRootsSkippedByTime: this.mutationRootsSkippedByTime,
            scanTimeBudgetReached: this.scanTimeBudgetReached,
            collectorStatus: this.lastCollectorStatus,
            collectorDiagnostics: this.lastCollectorDiagnostics ? { ...this.lastCollectorDiagnostics } : null,
            reconstructionStatus: this.lastReconstructionStatus,
            reconstructionDiagnostics: this.lastReconstructionDiagnostics ? { ...this.lastReconstructionDiagnostics } : null,
            decisionStatus: this.lastDecisionStatus,
            decisionDiagnostics: this.lastDecisionDiagnostics ? { ...this.lastDecisionDiagnostics } : null,
            findingStatus: this.lastFindingStatus,
            findingDiagnostics: this.lastFindingDiagnostics ? { ...this.lastFindingDiagnostics } : null,
            activeFindingCount: this.findingState.getSnapshot().activeCount,
            findingRevision: this.findingState.getSnapshot().findingRevision,
            findingsTruncated: this.findingState.getSnapshot().findingsTruncated,
            mutationQueueHighWaterMark: this.mutationQueue.highWaterMark,
            mutationQueueOverflows: this.mutationQueue.overflowCount,
            coalescedMutationRoots: this.mutationQueue.coalescedRoots,
            reconciliationPasses: this.reconciliationPasses,
            configRevision: this.configRevision,
            ...this.getSnapshotState()
        };
    }
}
