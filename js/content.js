// js/content.js
let VisualManipulationDetectorClass = null;
let LinkDomainSecurityDetectorClass = null;
let TriggerPhrasesClass = null;
let PromptSplittingClass = null;
const VISUAL_MANIPULATION_MODULE_ID = 'Hidden-Content-Visual-Manipulation';
const LINK_DOMAIN_SECURITY_MODULE_ID = 'Link-Domain-Security';
const TRIGGER_PHRASES_MODULE_ID = 'Trigger-Phrases';
const PROMPT_SPLITTING_MODULE_ID = 'Prompt-Splitting';

let Logger = {
    info: (...args) => console.info('[PageCheck]', ...args),
    warn: (...args) => console.warn('[PageCheck]', ...args),
    error: (...args) => console.error('[PageCheck]', ...args),
    debug: (...args) => console.debug('[PageCheck]', ...args)
};

let dependenciesLoaded = false;

async function loadDependencies() {
    if (dependenciesLoaded) return;

    const [
        visualManipulationModule,
        linkDomainSecurityModule,
        triggerModule,
        promptModule,
        loggerModule
    ] = await Promise.all([
        import(chrome.runtime.getURL('modules/visual-manipulation/VisualManipulationDetector.js')),
        import(chrome.runtime.getURL('modules/link-domain-security/LinkDomainSecurityDetector.js')),
        import(chrome.runtime.getURL('modules/trigger-phrases/TriggerPhrases.js')),
        import(chrome.runtime.getURL('modules/prompt-splitting/PromptSplitting.js')),
        import(chrome.runtime.getURL('utils/logger.js'))
    ]);

    VisualManipulationDetectorClass = visualManipulationModule.default;
    LinkDomainSecurityDetectorClass = linkDomainSecurityModule.default;
    TriggerPhrasesClass = triggerModule.default;
    PromptSplittingClass = promptModule.default;
    Logger = loggerModule.Logger || Logger;
    dependenciesLoaded = true;
}

class ModuleManager {
    constructor() {
        this.modules = new Map();
        this.isInitialized = false;
        this.currentConfig = null;
        this.activeModuleNames = new Set();
        this.lifecycleState = 'paused';
        this.lifecycleRequestRevision = 0;
        this.requestedLifecycleSignature = 'paused:';
        this.runtimeOperationQueue = Promise.resolve();
        this.pendingModuleStatusPublish = new Set();
        this.moduleStatusPublishScheduled = false;

        this.init();
    }

    async init() {
        try {
            await loadDependencies();
            Logger.info('Content script initializing');

            this.setupMessageListener();

            if (document.readyState === 'loading') {
                await new Promise((resolve) => {
                    document.addEventListener('DOMContentLoaded', resolve, { once: true });
                });
                await this.initializeModules();
            } else {
                await this.initializeModules();
            }

            const lifecycle = await this.sendMessageToBackground({ action: 'getPageLifecycle' });
            const lifecycleState = lifecycle?.state === 'active' ? 'active' : 'paused';
            const lifecycleModules = Array.isArray(lifecycle?.modules)
                ? lifecycle.modules.filter((moduleName) => typeof moduleName === 'string').sort()
                : [];
            const lifecycleSignature = `${lifecycleState}:${lifecycleModules.join('\u001f')}`;
            if (lifecycleSignature !== this.requestedLifecycleSignature) {
                this.requestedLifecycleSignature = lifecycleSignature;
                this.lifecycleRequestRevision += 1;
            }
            const lifecycleRevision = this.lifecycleRequestRevision;
            await this.enqueueRuntimeOperation(() => this.handlePageLifecycle(
                lifecycleState,
                lifecycleModules,
                lifecycle?.config || this.currentConfig,
                lifecycleRevision
            ));
            this.isInitialized = true;
            Logger.info('Content script initialized successfully');
        } catch (error) {
            Logger.error('Failed to initialize content script:', error);
        }
    }

    async loadContentCSS() {
        try {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = chrome.runtime.getURL('styles/content.css');
            link.className = 'pagecheck-styles';
            document.head.appendChild(link);
        } catch (error) {
            Logger.error('Failed to load content CSS:', error);
        }
    }

    async initializeModules() {
        try {
            this.currentConfig = await this.sendMessageToBackground({ action: 'getConfig' });
            if (!this.currentConfig) {
                throw new Error('Failed to get configuration from background');
            }

            Logger.debug('Configuration received', {
                moduleCount: Object.keys(this.currentConfig?.modules || {}).length
            });

            const moduleInstances = [
                new VisualManipulationDetectorClass(),
                new LinkDomainSecurityDetectorClass(),
                new TriggerPhrasesClass(),
                new PromptSplittingClass()
            ];

            moduleInstances.forEach(module => {
                const moduleConfig = this.currentConfig.modules[module.moduleName];
                if (!moduleConfig) return;

                module.updateConfig(moduleConfig);
                module.isEnabled = false;
                this.modules.set(module.moduleName, module);
                if (module.moduleName === PROMPT_SPLITTING_MODULE_ID) {
                    module.on('findingStateChanged', () => {
                        this.scheduleModuleStatusPublish(module.moduleName);
                    });
                }
            });

            Logger.info(`Modules prepared: ${this.modules.size}; active modules wait for foreground lifecycle`);
        } catch (error) {
            Logger.error('Error initializing modules:', error);
        }
    }

    setupMessageListener() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            Logger.debug('Message received in content script:', request);

            const handleRequest = async () => {
                try {
                    let response;

                    switch (request.action) {
                        case 'updateModules': {
                            this.invalidatePromptSplittingForIncomingConfig(request.config);
                            const lifecycleRevision = this.lifecycleRequestRevision;
                            response = await this.enqueueRuntimeOperation(() => this.handleUpdateModules(
                                request.modules,
                                request.config,
                                lifecycleRevision
                            ));
                            break;
                        }
                        case 'setPageLifecycle': {
                            this.invalidatePromptSplittingForIncomingConfig(request.config);
                            const lifecycleState = request.state === 'active' ? 'active' : 'paused';
                            const lifecycleModules = Array.isArray(request.modules)
                                ? request.modules.filter((moduleName) => typeof moduleName === 'string').sort()
                                : [];
                            const lifecycleSignature = `${lifecycleState}:${lifecycleModules.join('\u001f')}`;
                            if (lifecycleSignature !== this.requestedLifecycleSignature) {
                                this.requestedLifecycleSignature = lifecycleSignature;
                                this.lifecycleRequestRevision += 1;
                            }
                            const lifecycleRevision = this.lifecycleRequestRevision;
                            response = await this.enqueueRuntimeOperation(() => this.handlePageLifecycle(
                                lifecycleState,
                                lifecycleModules,
                                request.config,
                                lifecycleRevision
                            ));
                            break;
                        }
                        case 'performScan': {
                            const lifecycleRevision = this.lifecycleRequestRevision;
                            response = await this.enqueueRuntimeOperation(
                                () => this.handlePerformScan(lifecycleRevision)
                            );
                            break;
                        }
                        case 'toggleModule': {
                            const lifecycleRevision = this.lifecycleRequestRevision;
                            response = await this.enqueueRuntimeOperation(() => this.handleToggleModule(
                                request.moduleId,
                                request.enabled,
                                lifecycleRevision
                            ));
                            break;
                        }
                        case 'getModuleState':
                            response = this.getModuleState(request.moduleId);
                            break;
                        case 'executeModuleAction': {
                            response = await this.enqueueRuntimeOperation(() => this.handleModuleAction(
                                request.moduleId,
                                request.actionName,
                                request.data
                            ));
                            break;
                        }
                        default:
                            response = { error: 'Unknown action', action: request.action };
                    }

                    sendResponse(response);
                } catch (error) {
                    Logger.error('Error handling message:', error);
                    sendResponse({ success: false, error: error.message });
                }
            };

            handleRequest();
            return true;
        });
    }

    enqueueRuntimeOperation(operation) {
        const queuedOperation = this.runtimeOperationQueue.then(operation, operation);
        this.runtimeOperationQueue = queuedOperation.then(
            () => undefined,
            () => undefined
        );
        return queuedOperation;
    }

    isLifecycleRevisionCurrent(lifecycleRevision) {
        return lifecycleRevision === this.lifecycleRequestRevision;
    }

    invalidatePromptSplittingForIncomingConfig(config) {
        const incomingConfig = config?.modules?.[PROMPT_SPLITTING_MODULE_ID];
        const module = this.modules.get(PROMPT_SPLITTING_MODULE_ID);
        if (!incomingConfig || typeof module?.hasDetectionConfigChange !== 'function') {
            return;
        }
        if (module.hasDetectionConfigChange(incomingConfig)) {
            module.invalidatePendingWork();
        }
    }

    scheduleModuleStatusPublish(moduleName) {
        if (moduleName !== PROMPT_SPLITTING_MODULE_ID
            || this.lifecycleState !== 'active'
            || !this.activeModuleNames.has(moduleName)) {
            return;
        }
        this.pendingModuleStatusPublish.add(moduleName);
        if (this.moduleStatusPublishScheduled) return;
        this.moduleStatusPublishScheduled = true;
        const lifecycleRevision = this.lifecycleRequestRevision;
        this.enqueueRuntimeOperation(async () => {
            this.moduleStatusPublishScheduled = false;
            const pending = [...this.pendingModuleStatusPublish];
            this.pendingModuleStatusPublish.clear();
            if (pending.length === 0
                || !this.isLifecycleRevisionCurrent(lifecycleRevision)
                || this.lifecycleState !== 'active'
                || !this.activeModuleNames.has(PROMPT_SPLITTING_MODULE_ID)) {
                return;
            }
            await this.publishPageStatus(this.buildCurrentScanResponse());
        }).catch((error) => {
            Logger.error('Error publishing module status:', error);
        });
    }

    async handleUpdateModules(moduleNames, config, lifecycleRevision = this.lifecycleRequestRevision) {
        try {
            if (!this.isLifecycleRevisionCurrent(lifecycleRevision)) {
                return { success: false, skipped: 'stale-lifecycle' };
            }
            if (config) {
                this.currentConfig = config;
            }
            const requestedModuleNames = Array.isArray(moduleNames) ? moduleNames : [];
            const effectiveModuleNames = this.lifecycleState === 'active' ? requestedModuleNames : [];

            const allModuleNames = Array.from(this.modules.keys());
            const configUpdateResults = new Map();
            for (const moduleName of allModuleNames) {
                if (!this.isLifecycleRevisionCurrent(lifecycleRevision)) {
                    if (this.requestedLifecycleSignature.startsWith('paused:')) {
                        for (const activeModuleName of [...this.activeModuleNames]) {
                            await this.disableModule(activeModuleName);
                        }
                    }
                    return { success: false, skipped: 'stale-lifecycle' };
                }

                if (this.currentConfig?.modules?.[moduleName]) {
                    const updateResult = this.modules.get(moduleName).updateConfig(
                        this.currentConfig.modules[moduleName]
                    );
                    configUpdateResults.set(moduleName, updateResult);
                }
            }

            for (const moduleName of allModuleNames) {
                if (!this.isLifecycleRevisionCurrent(lifecycleRevision)) {
                    if (this.requestedLifecycleSignature.startsWith('paused:')) {
                        for (const activeModuleName of [...this.activeModuleNames]) {
                            await this.disableModule(activeModuleName);
                        }
                    }
                    return { success: false, skipped: 'stale-lifecycle' };
                }

                const shouldBeEnabled = effectiveModuleNames.includes(moduleName);
                const isCurrentlyEnabled = this.activeModuleNames.has(moduleName);
                const requiresDetectionRefresh = configUpdateResults.get(moduleName)?.requiresDetectionRefresh === true;

                if (shouldBeEnabled && !isCurrentlyEnabled) {
                    await this.enableModule(moduleName, lifecycleRevision);
                } else if (!shouldBeEnabled && isCurrentlyEnabled) {
                    await this.disableModule(moduleName);
                } else if (shouldBeEnabled && isCurrentlyEnabled && requiresDetectionRefresh) {
                    await this.disableModule(moduleName);
                    if (!this.isLifecycleRevisionCurrent(lifecycleRevision)) {
                        return { success: false, skipped: 'stale-lifecycle' };
                    }
                    if (this.currentConfig?.modules?.[moduleName]) {
                        this.modules.get(moduleName).updateConfig(this.currentConfig.modules[moduleName]);
                    }
                    await this.enableModule(moduleName, lifecycleRevision);
                }
            }

            if (!this.isLifecycleRevisionCurrent(lifecycleRevision)) {
                if (this.requestedLifecycleSignature.startsWith('paused:')) {
                    for (const activeModuleName of [...this.activeModuleNames]) {
                        await this.disableModule(activeModuleName);
                    }
                }
                return { success: false, skipped: 'stale-lifecycle' };
            }

            return {
                success: true,
                activeModules: Array.from(this.activeModuleNames),
                totalModules: allModuleNames.length
            };
        } catch (error) {
            Logger.error('Error updating modules:', error);
            return { success: false, error: error.message };
        }
    }

    async enableModule(moduleName, lifecycleRevision = this.lifecycleRequestRevision) {
        const module = this.modules.get(moduleName);
        if (!module) throw new Error(`Module ${moduleName} not found`);
        if (this.activeModuleNames.has(moduleName)) {
            return this.isLifecycleRevisionCurrent(lifecycleRevision);
        }

        try {
            module.isEnabled = true;
            const success = await module.init();
            if (!this.isLifecycleRevisionCurrent(lifecycleRevision)) {
                module.destroy();
                this.activeModuleNames.delete(moduleName);
                return false;
            }
            if (success && module.isEnabled) {
                this.activeModuleNames.add(moduleName);
                return true;
            }
            module.destroy();
            return false;
        } catch (error) {
            module.destroy();
            this.activeModuleNames.delete(moduleName);
            Logger.error(`Error enabling module ${moduleName}:`, error);
            return false;
        }
    }

    async disableModule(moduleName) {
        const module = this.modules.get(moduleName);
        if (!module) throw new Error(`Module ${moduleName} not found`);
        if (!this.activeModuleNames.has(moduleName)
            && !module.isEnabled
            && !(typeof module.isActive === 'function' && module.isActive())) {
            return true;
        }

        try {
            module.destroy();
            this.activeModuleNames.delete(moduleName);
            return true;
        } catch (error) {
            Logger.error(`Error disabling module ${moduleName}:`, error);
            return false;
        }
    }

    async handleToggleModule(moduleId, enabled, lifecycleRevision = this.lifecycleRequestRevision) {
        try {
            if (!this.isLifecycleRevisionCurrent(lifecycleRevision)) {
                return { success: false, skipped: 'stale-lifecycle', moduleId, enabled };
            }
            if (enabled && this.lifecycleState === 'active') {
                await this.enableModule(moduleId, lifecycleRevision);
            } else {
                await this.disableModule(moduleId);
            }
            return {
                success: this.isLifecycleRevisionCurrent(lifecycleRevision),
                moduleId,
                enabled,
                skipped: this.isLifecycleRevisionCurrent(lifecycleRevision) ? undefined : 'stale-lifecycle'
            };
        } catch (error) {
            Logger.error(`Error toggling module ${moduleId}:`, error);
            return { success: false, error: error.message };
        }
    }

    async handlePageLifecycle(
        state,
        moduleNames = [],
        config = null,
        lifecycleRevision = this.lifecycleRequestRevision
    ) {
        if (!this.isLifecycleRevisionCurrent(lifecycleRevision)) {
            return {
                success: false,
                skipped: 'stale-lifecycle',
                state: this.lifecycleState,
                activeModules: Array.from(this.activeModuleNames)
            };
        }

        const nextState = state === 'active' ? 'active' : 'paused';
        this.lifecycleState = nextState;

        if (config) {
            this.currentConfig = config;
        }

        if (nextState === 'paused') {
            const pauseSnapshotResponse = this.activeModuleNames.size > 0
                ? this.buildCurrentScanResponse()
                : null;
            const updateResult = await this.handleUpdateModules(
                [],
                this.currentConfig,
                lifecycleRevision
            );
            if (!this.isLifecycleRevisionCurrent(lifecycleRevision) || updateResult?.skipped) {
                return {
                    success: false,
                    skipped: 'stale-lifecycle',
                    state: this.lifecycleState,
                    activeModules: Array.from(this.activeModuleNames)
                };
            }
            if (pauseSnapshotResponse) {
                await this.publishPageStatus(pauseSnapshotResponse);
            }
            return {
                success: true,
                state: this.lifecycleState,
                activeModules: Array.from(this.activeModuleNames),
                pageStatus: pauseSnapshotResponse?.pageStatus || null
            };
        }

        const updateResult = await this.handleUpdateModules(
            moduleNames,
            this.currentConfig,
            lifecycleRevision
        );
        if (!this.isLifecycleRevisionCurrent(lifecycleRevision) || updateResult?.skipped) {
            return {
                success: false,
                skipped: 'stale-lifecycle',
                state: this.lifecycleState,
                activeModules: Array.from(this.activeModuleNames)
            };
        }
        const response = this.buildCurrentScanResponse();
        await this.publishPageStatus(response);
        return {
            success: true,
            state: this.lifecycleState,
            activeModules: Array.from(this.activeModuleNames),
            pageStatus: response.pageStatus
        };
    }

    async handlePerformScan(lifecycleRevision = this.lifecycleRequestRevision) {
        try {
            if (!this.isLifecycleRevisionCurrent(lifecycleRevision)) {
                return { success: false, skipped: 'stale-lifecycle' };
            }

            const results = {};
            let totalThreats = 0;
            const moduleCounts = {};
            const configuredModuleNames = Object.entries(this.currentConfig?.modules || {})
                .filter(([, moduleConfig]) => moduleConfig?.enabled)
                .map(([moduleName]) => moduleName);
            const scanModuleNames = this.lifecycleState === 'active'
                ? Array.from(this.activeModuleNames)
                : configuredModuleNames;

            for (const moduleName of scanModuleNames) {
                if (!this.isLifecycleRevisionCurrent(lifecycleRevision)) {
                    return { success: false, skipped: 'stale-lifecycle' };
                }

                const module = this.modules.get(moduleName);
                if (!module?.performScan) continue;

                const oneShot = !this.activeModuleNames.has(moduleName);
                if (oneShot) {
                    module.isEnabled = true;
                }

                let moduleResults;
                try {
                    moduleResults = await module.performScan();
                } finally {
                    if (oneShot) {
                        module.destroy();
                    }
                }

                if (!this.isLifecycleRevisionCurrent(lifecycleRevision)) {
                    return { success: false, skipped: 'stale-lifecycle' };
                }
                results[moduleName] = moduleResults;

                const moduleThreatCount = Number.isFinite(moduleResults?.threatsDetected)
                    ? Math.max(0, Number(moduleResults.threatsDetected))
                    : Array.isArray(moduleResults?.findings)
                        ? moduleResults.findings.length
                        : 0;

                moduleCounts[moduleName] = moduleThreatCount;
                totalThreats += moduleThreatCount;
            }

            if (!this.isLifecycleRevisionCurrent(lifecycleRevision)) {
                return { success: false, skipped: 'stale-lifecycle' };
            }

            const snapshot = this.createPageStatusSnapshot(moduleCounts, totalThreats, results);

            await this.publishPageStatus({ pageStatus: snapshot });

            return {
                success: true,
                threatsDetected: totalThreats,
                results,
                pageStatus: snapshot,
                timestamp: Date.now()
            };
        } catch (error) {
            Logger.error('Error performing scan:', error);
            return { success: false, error: error.message };
        }
    }

    buildCurrentScanResponse() {
        const results = {};
        const moduleCounts = {};
        let totalThreats = 0;

        for (const moduleName of this.activeModuleNames) {
            const module = this.modules.get(moduleName);
            const stats = module?.getStats ? module.getStats() : {};
            const threatCount = Number.isFinite(stats?.activeFindingCount)
                ? Math.max(0, Math.trunc(stats.activeFindingCount))
                : Number.isFinite(stats?.totalFindingsCurrentScan)
                    ? Math.max(0, Math.trunc(stats.totalFindingsCurrentScan))
                    : Number.isFinite(stats?.threatsDetected)
                        ? Math.max(0, Math.trunc(stats.threatsDetected))
                        : 0;

            moduleCounts[moduleName] = threatCount;
            totalThreats += threatCount;
            const serializedFindings = moduleName === TRIGGER_PHRASES_MODULE_ID
                && typeof module?.serializeActiveFindings === 'function'
                ? module.serializeActiveFindings()
                : null;
            results[moduleName] = {
                module: moduleName,
                threatsDetected: threatCount,
                revision: Number.isFinite(stats?.findingRevision)
                    ? Math.max(0, Math.trunc(stats.findingRevision))
                    : Number.isFinite(stats?.scanRevision)
                        ? Math.max(0, Math.trunc(stats.scanRevision))
                        : 0,
                findings: Array.isArray(serializedFindings?.findings)
                    ? serializedFindings.findings
                    : Array.isArray(module?.recentFindings)
                        ? module.recentFindings.slice(0, 10)
                        : [],
                partialResult: Boolean(serializedFindings?.partialResult || stats?.partialResult),
                findingsTruncated: Boolean(serializedFindings?.findingsTruncated || stats?.findingsTruncated),
                stats
            };
        }

        return {
            success: true,
            threatsDetected: totalThreats,
            results,
            pageStatus: this.createPageStatusSnapshot(moduleCounts, totalThreats, results),
            timestamp: Date.now()
        };
    }

    createPageStatusSnapshot(moduleCounts, totalThreats, results = {}) {
        const visualFindings = Array.isArray(results?.[VISUAL_MANIPULATION_MODULE_ID]?.findings)
            ? results[VISUAL_MANIPULATION_MODULE_ID].findings.slice(0, 10).map((finding) => ({
                type: typeof finding?.type === 'string' ? finding.type.slice(0, 96) : 'unknown',
                summary: typeof finding?.summary === 'string' ? finding.summary.slice(0, 300) : '',
                details: typeof finding?.details === 'string' ? finding.details.slice(0, 600) : '',
                severity: ['low', 'medium', 'high', 'critical'].includes(finding?.severity)
                    ? finding.severity
                    : 'medium',
                detector: typeof finding?.detector === 'string' ? finding.detector.slice(0, 96) : 'unknown'
            }))
            : [];
        const triggerFindings = this.sanitizeTriggerFindings(results?.[TRIGGER_PHRASES_MODULE_ID]?.findings);
        const triggerRevisionSource = results?.[TRIGGER_PHRASES_MODULE_ID]?.revision
            ?? results?.[TRIGGER_PHRASES_MODULE_ID]?.stats?.findingRevision;
        const triggerRevision = Number.isFinite(triggerRevisionSource)
            ? Math.max(0, Math.trunc(triggerRevisionSource))
            : 0;
        const linkFindings = this.sanitizeLinkFindings(results?.[LINK_DOMAIN_SECURITY_MODULE_ID]?.findings);
        const linkRevisionSource = results?.[LINK_DOMAIN_SECURITY_MODULE_ID]?.revision
            ?? results?.[LINK_DOMAIN_SECURITY_MODULE_ID]?.stats?.scanRevision;
        const linkRevision = Number.isFinite(linkRevisionSource)
            ? Math.max(0, Math.trunc(linkRevisionSource))
            : 0;
        const promptSplittingFindings = this.sanitizePromptSplittingFindings(
            results?.[PROMPT_SPLITTING_MODULE_ID]?.findings
        );
        const promptSplittingRevisionSource = results?.[PROMPT_SPLITTING_MODULE_ID]?.revision
            ?? results?.[PROMPT_SPLITTING_MODULE_ID]?.stats?.scanRevision;
        const promptSplittingRevision = Number.isFinite(promptSplittingRevisionSource)
            ? Math.max(0, Math.trunc(promptSplittingRevisionSource))
            : 0;
        const promptSplittingFindingsTruncated = results?.[PROMPT_SPLITTING_MODULE_ID]?.findingsTruncated === true;
        const partialModules = Object.entries(results)
            .filter(([, result]) => result?.partialResult === true || result?.stats?.partialResult === true)
            .map(([moduleId]) => moduleId)
            .slice(0, 16);

        return {
            scanId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            url: window.location.href,
            frameId: 0,
            moduleCounts,
            visualFindings,
            linkFindings,
            linkRevision,
            promptSplittingFindings,
            promptSplittingRevision,
            promptSplittingFindingsTruncated,
            triggerFindings,
            triggerRevision,
            partialModules,
            totalFindings: totalThreats,
            status: totalThreats > 0 ? 'issues' : 'clean',
            timestamp: Date.now()
        };
    }

    sanitizePromptSplittingFindings(findings) {
        return Array.isArray(findings)
            ? findings.slice(0, 10).map((finding) => {
                const summaryKey = typeof finding?.summaryKey === 'string' ? finding.summaryKey : '';
                const localizedSummary = summaryKey && chrome.i18n?.getMessage
                    ? chrome.i18n.getMessage(summaryKey)
                    : '';
                return {
                    type: typeof finding?.type === 'string' ? finding.type.slice(0, 96) : 'prompt-splitting',
                    summary: typeof localizedSummary === 'string' && localizedSummary
                        ? localizedSummary.slice(0, 300)
                        : typeof finding?.summary === 'string'
                            ? finding.summary.slice(0, 300)
                            : ''
                };
            })
            : [];
    }

    sanitizeLinkFindings(findings) {
        return Array.isArray(findings)
            ? findings.slice(0, 10).map((finding) => ({
                type: typeof finding?.type === 'string' ? finding.type.slice(0, 96) : 'unknown',
                summary: typeof finding?.summary === 'string' ? finding.summary.slice(0, 300) : '',
                severity: ['low', 'medium', 'high', 'critical'].includes(finding?.severity)
                    ? finding.severity
                    : 'medium',
                detector: typeof finding?.detector === 'string' ? finding.detector.slice(0, 96) : 'unknown'
            }))
            : [];
    }

    sanitizeTriggerFindings(findings) {
        const normalizeStrings = (values, limit) => Array.isArray(values)
            ? values
                .filter((value) => typeof value === 'string')
                .slice(0, limit)
                .map((value) => value.slice(0, 128))
            : [];

        return Array.isArray(findings)
            ? findings.slice(0, 10).map((finding) => ({
                schemaVersion: Number.isFinite(finding?.schemaVersion)
                    ? Math.max(0, Math.trunc(finding.schemaVersion))
                    : 0,
                type: typeof finding?.type === 'string' ? finding.type.slice(0, 64) : 'trigger-phrase',
                detector: typeof finding?.detector === 'string' ? finding.detector.slice(0, 96) : TRIGGER_PHRASES_MODULE_ID,
                ruleId: typeof finding?.ruleId === 'string' ? finding.ruleId.slice(0, 160) : 'unknown',
                supportingRuleIds: normalizeStrings(finding?.supportingRuleIds, 8),
                category: typeof finding?.category === 'string' ? finding.category.slice(0, 96) : 'unknown',
                subtype: typeof finding?.subtype === 'string' ? finding.subtype.slice(0, 96) : null,
                supportingCategories: normalizeStrings(finding?.supportingCategories, 8),
                severity: ['low', 'medium', 'high', 'critical'].includes(finding?.severity)
                    ? finding.severity
                    : 'medium',
                impact: typeof finding?.impact === 'string' ? finding.impact.slice(0, 64) : 'unknown',
                evidenceStrength: typeof finding?.evidenceStrength === 'string'
                    ? finding.evidenceStrength.slice(0, 64)
                    : 'unknown',
                sourceType: typeof finding?.sourceType === 'string' ? finding.sourceType.slice(0, 64) : 'unknown',
                reasonCodes: normalizeStrings(finding?.reasonCodes, 12),
                mitigationCodes: normalizeStrings(finding?.mitigationCodes, 12),
                normalizationPath: typeof finding?.normalizationPath === 'string'
                    ? finding.normalizationPath.slice(0, 96)
                    : 'unknown',
                occurrenceCount: Number.isFinite(finding?.occurrenceCount)
                    ? Math.max(1, Math.trunc(finding.occurrenceCount))
                    : 1,
                firstDetectedAt: Number.isFinite(finding?.firstDetectedAt) ? finding.firstDetectedAt : 0,
                lastDetectedAt: Number.isFinite(finding?.lastDetectedAt) ? finding.lastDetectedAt : 0,
                summary: typeof finding?.summary === 'string' ? finding.summary.slice(0, 300) : ''
            }))
            : [];
    }

    async publishPageStatus(response) {
        if (!response?.pageStatus) {
            return;
        }

        await this.sendMessageToBackground({
            action: 'pageStatusUpdate',
            data: response.pageStatus
        });
    }

    getModuleState(moduleId) {
        const module = this.modules.get(moduleId);
        if (!module) return { error: `Module ${moduleId} not found` };

        return {
            enabled: this.activeModuleNames.has(moduleId),
            config: module.config,
            stats: module.getStats ? module.getStats() : null
        };
    }

    async handleModuleAction(moduleId, actionName, data) {
        const module = this.modules.get(moduleId);
        if (!module) return { error: `Module ${moduleId} not found` };
        if (typeof module[actionName] !== 'function') {
            return { error: `Action ${actionName} not found in module ${moduleId}` };
        }

        try {
            const result = await module[actionName](data);
            return { success: true, result };
        } catch (error) {
            Logger.error(`Error executing action ${actionName} on module ${moduleId}:`, error);
            return { success: false, error: error.message };
        }
    }

    async sendMessageToBackground(message) {
        try {
            return await chrome.runtime.sendMessage(message);
        } catch (error) {
            Logger.error('Error sending message to background:', error);
            return null;
        }
    }
}

let moduleManager;

try {
    moduleManager = new ModuleManager();
    window.PageCheckModuleManager = moduleManager;
} catch (error) {
    Logger.error('Failed to create ModuleManager:', error);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ModuleManager };
}
