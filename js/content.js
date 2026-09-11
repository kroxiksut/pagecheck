// js/content.js
let VisualManipulationDetectorClass = null;
let LinkDomainSecurityDetectorClass = null;
let TriggerPhrasesClass = null;
let PromptSplittingClass = null;
let InterventionLayerClass = null;
const VISUAL_MANIPULATION_MODULE_ID = 'Hidden-Content-Visual-Manipulation';
const LINK_DOMAIN_SECURITY_MODULE_ID = 'Link-Domain-Security';
const TRIGGER_PHRASES_MODULE_ID = 'Trigger-Phrases';
const PROMPT_SPLITTING_MODULE_ID = 'Prompt-Splitting';
// Потолок счёта фреймов: точное число сверх сотни ничего не добавляет к факту «фреймы есть, мы их
// не смотрели», а страница не должна уметь заставить нас считать бесконечно.
const MAX_COUNTED_FRAMES = 100;
// Суммарный потолок АКТИВНОЙ работы всех модулей на один скан вкладки (корневой TASKS C2).
// Потолок куска (16 мс) отвечает на вопрос «насколько длинным может быть один синхронный кусок»,
// но пять модулей по 16 мс подряд - это всё ещё пять модулей подряд. Здесь ограничивается СУММА.
//
// Почему 600 мс и почему это не окончательное число: измеренный на стендах скан самого дорогого
// модуля на странице в 400 узлов укладывается в единицы миллисекунд активного времени, поэтому 600
// мс - это не рабочий предел, а предохранитель против патологической страницы. Настоящая калибровка
// требует браузера (C3): на стабах не воспроизводится ни реальный layout, ни реальная стоимость
// getComputedStyle, а именно они и составляют цену скана.
//
// Что происходит при исчерпании - решение, а не деталь: модули, до которых не дошло, НЕ
// сканируются, но снапшот об этом ГОВОРИТ (`budgetExhausted` + попадание в `partialModules`).
// Молчаливый пропуск здесь означал бы «чисто» о странице, часть которой мы не смотрели, - ровно та
// же ошибка, что и молчание про фреймы.
const TAB_SCAN_ACTIVE_BUDGET_MS = 600;

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
        loggerModule,
        interventionModule
    ] = await Promise.all([
        import(chrome.runtime.getURL('modules/visual-manipulation/VisualManipulationDetector.js')),
        import(chrome.runtime.getURL('modules/link-domain-security/LinkDomainSecurityDetector.js')),
        import(chrome.runtime.getURL('modules/trigger-phrases/TriggerPhrases.js')),
        import(chrome.runtime.getURL('modules/prompt-splitting/PromptSplitting.js')),
        import(chrome.runtime.getURL('utils/logger.js')),
        import(chrome.runtime.getURL('js/intervention-layer.js'))
    ]);

    VisualManipulationDetectorClass = visualManipulationModule.default;
    LinkDomainSecurityDetectorClass = linkDomainSecurityModule.default;
    TriggerPhrasesClass = triggerModule.default;
    PromptSplittingClass = promptModule.default;
    Logger = loggerModule.Logger || Logger;
    InterventionLayerClass = interventionModule.default;
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
        // Modules stopped by a foreground transition rather than by configuration. They are alive
        // and keep whatever state they are allowed to keep; `activeModuleNames` stays the set of
        // modules that are actually working.
        this.pausedModuleNames = new Set();
        this.documentChangeTripwire = null;
        // Fail-safe: until a tripwire has watched an uninterrupted pause, the document counts as
        // changed and everyone rescans. Every path that cannot prove otherwise leaves it true.
        this.documentChangedWhilePaused = true;
        // ОБЩИЙ ПОТОЛОК КУСКА НА ВКЛАДКУ (C2). Модуль нарезает свою работу сам, но потолок общий:
        // иначе пять модулей с потолком по 16 мс каждый складываются в один длинный таск, и
        // страница не может отличить это от одного модуля, работающего 80 мс подряд.
        this.sliceCapMs = 16;
        this.minimumSliceCapMs = 4;
        // SELF-INSTRUMENTATION (C2): меряем СВОЙ overhead, а не нагрузку страницы. Единственный
        // сигнал - in-page performance, никаких новых разрешений.
        this.longTasksObserved = 0;
        this.sliceBackoffSteps = 0;
        // C2: суммарный бюджет активной работы на скан вкладки и факт его исчерпания.
        this.tabScanBudgetMs = TAB_SCAN_ACTIVE_BUDGET_MS;
        this.scanBudgetExhausted = false;
        this.modulesSkippedByTabBudget = [];
        this.lastScanActiveMs = 0;
        this.longTaskObserver = null;

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
                        // `updateModules` удалён 2026-09-10: отправителя у него не было ни одного, а
                        // конфигурация доезжает до вкладки через `setPageLifecycle`. Сам метод
                        // `handleUpdateModules()` остаётся - его зовёт путь жизненного цикла.
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
                        // C4.3: откат правок вмешательства по требованию человека. Через ту же
                        // очередь операций, что и остальной lifecycle: писать в DOM посреди скана
                        // нельзя ровно по той причине, по которой правки применяются ПОСЛЕ него.
                        case 'revertIntervention':
                            response = await this.enqueueRuntimeOperation(
                                () => this.revertInterventionEdits()
                            );
                            break;
                        // `executeModuleAction` удалён 2026-09-10 вместе с методом: он вызывал
                        // ПРОИЗВОЛЬНЫЙ метод модуля по имени из сообщения, а отправителя не имел ни
                        // одного. Такая ветка доступна любому отправителю из контекста расширения -
                        // тот же класс, от которого уже защищали `handleScanPage`.
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
                // Гейт вмешательства обязан сдвигаться вместе с настройкой, а не ждать
                // следующего скана: выключение - это откат уже внесённых правок (C4.3).
                this.syncInterventionGate();
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
                    // Coming back from a foreground pause is a resume, not a fresh start - unless
                    // the configuration changed underneath, in which case the kept state describes
                    // a configuration that no longer applies and the module starts over.
                    if (this.pausedModuleNames.has(moduleName) && !requiresDetectionRefresh) {
                        await this.resumeModule(moduleName, lifecycleRevision);
                    } else {
                        await this.enableModule(moduleName, lifecycleRevision);
                    }
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

    // Длинный таск в main-thread страницы - единственный честный признак того, что наша нарезка
    // всё ещё слишком крупная для ЭТОЙ страницы. Реакция консервативная: потолок куска уполовинивается
    // до пола, но никогда не растёт обратно внутри одного жизненного цикла - страница, которая уже
    // показала, что ей тяжело, второго шанса подтормозить не получает.
    setupWorkloadObserver() {
        if (this.longTaskObserver || typeof PerformanceObserver !== 'function') {
            return;
        }

        try {
            this.longTaskObserver = new PerformanceObserver((list) => {
                const entries = list.getEntries();
                if (entries.length === 0) {
                    return;
                }
                this.longTasksObserved += entries.length;
                this.applySliceBackoff();
            });
            this.longTaskObserver.observe({ type: 'longtask', buffered: true });
        } catch {
            // Тип не поддержан этим браузером - просто остаёмся с базовым потолком.
            this.longTaskObserver = null;
        }
    }

    applySliceBackoff() {
        const nextCap = Math.max(this.minimumSliceCapMs, Math.floor(this.sliceCapMs / 2));
        if (nextCap === this.sliceCapMs) {
            return;
        }
        this.sliceCapMs = nextCap;
        this.sliceBackoffSteps += 1;
        this.applySliceCapToModules();
        Logger.debug(`Slice cap lowered to ${this.sliceCapMs}ms after ${this.longTasksObserved} long tasks`);
    }

    // C4.3: гейт открывает пользователь, и до этого момента детекторы не отдают ни одного узла.
    // Sink ставится ровно тогда, когда гейт открыт, и снимается вместе с ним - это и есть граница,
    // за которую ссылки на DOM не выходят.
    syncInterventionGate() {
        if (!this.interventionLayer && InterventionLayerClass) {
            this.interventionLayer = new InterventionLayerClass({
                getMessage: (key) => {
                    try {
                        return chrome.i18n?.getMessage?.(key) || '';
                    } catch {
                        return '';
                    }
                }
            });
        }
        if (!this.interventionLayer) {
            return;
        }

        const enabled = this.currentConfig?.settings?.activeRemediationEnabled === true;
        this.interventionLayer.setAction(this.currentConfig?.settings?.activeRemediationAction);
        this.interventionLayer.setEnabled(enabled);
        const sink = enabled
            ? (finding, node, moduleName) => this.interventionLayer.collectFindingNode(finding, node, moduleName)
            : null;
        for (const module of this.modules.values()) {
            if (module) {
                module.findingNodeSink = sink;
            }
        }
    }

    // Правки применяются ПОСЛЕ скана, а не во время: запись в середине обхода ломала бы scan-local
    // кэши и порождала бы мутации внутри собственного прохода.
    applyInterventionQueue() {
        if (!this.interventionLayer?.isEnabled) {
            return 0;
        }
        try {
            // C4.4: сначала проверяем, цело ли применённое. Страница, снявшая нашу правку, получает
            // не вторую попытку, а строку в отчёте.
            const tampered = this.interventionLayer.verifyAppliedEdits();
            if (tampered > 0) {
                Logger.warn('The page removed PageCheck remediation marks', { tampered });
            }
            return this.interventionLayer.applyQueued();
        } catch (error) {
            Logger.error('Intervention layer failed to apply queued edits:', error);
            return 0;
        }
    }

    // C4: КОНТЕКСТ страницы - не находка и не вердикт. Две вещи, которые нужны и человеку, и
    // кооперативному агенту, но ни одна из них не является утверждением о вредоносности:
    //  - `automation`: страницу смотрит автоматизированный браузер (`navigator.webdriver`).
    //    Ограничения зафиксированы намеренно: сигнал СЕССИОННЫЙ, а не про вкладку; он НЕ ловит
    //    агента-расширение (у того обычный браузер); его тривиально подделать в обе стороны.
    //    Поэтому это контекст, а не гейт: ни одно решение детекторов от него не зависит.
    //  - `longTasks`/`sliceBackoffSteps`: страница отнимает главный поток. Считаем СВОЙ backoff, а
    //    не «нагрузку страницы на систему» (вариант A, явно вне scope): нам нужен ответ на вопрос
    //    «почему наш скан режется мельче», а не роль диспетчера задач.
    // C2, iframe как threat model: анализ идёт только в главном фрейме, и настоящая угроза здесь -
    // не пропущенный детект, а ЛОЖНОЕ «чисто» о странице, часть которой мы не смотрели. Пока это
    // было умолчанием, снапшот выглядел как полный отчёт о странице. Теперь это факт: столько-то
    // фреймов на странице, проанализировано ноль.
    // Считаем ТОЛЬКО количество и только в главном документе: одна выборка на скан, ограниченная
    // потолком. Ни адресов, ни атрибутов - содержимое cross-origin фрейма нам всё равно недоступно,
    // а его URL - это данные страницы, которым в снапшоте не место.
    countFrames() {
        try {
            const frames = document.querySelectorAll('iframe, frame');
            return Math.min(frames.length, MAX_COUNTED_FRAMES);
        } catch (error) {
            Logger.error('Failed to count frames:', error);
            return 0;
        }
    }

    buildPageContext() {
        let automation = false;
        try {
            automation = globalThis.navigator?.webdriver === true;
        } catch {
            automation = false;
        }
        const framesPresent = this.countFrames();
        return {
            automation,
            longTasksObserved: Math.max(0, Math.trunc(this.longTasksObserved || 0)),
            sliceBackoffSteps: Math.max(0, Math.trunc(this.sliceBackoffSteps || 0)),
            framesPresent,
            // C2: суммарный бюджет вкладки исчерпан, и часть модулей не сканировалась вовсе.
            // Их имена лежат в `partialModules` - здесь только сам факт.
            scanBudgetExhausted: this.scanBudgetExhausted === true,
            lastScanActiveMs: Math.max(0, Number(this.lastScanActiveMs) || 0),
            // Ноль не «пока не реализовано», а описание сегодняшнего контракта: foreground-only и
            // main-frame-only, принудительно на двух уровнях (handshake по frameId и
            // isForegroundScanAllowed). Решение «сканировать ли фреймы вообще» принимается до
            // введения бюджета на них, а не после (корневой TASKS, C2).
            framesAnalyzed: 0
        };
    }

    // C4.3: откат по требованию человека. Отдельно от выключения настройки: пользователь может
    // захотеть вернуть страницу как есть, не трогая режим, - и это должно быть одно действие, а не
    // «сходи в настройки, выключи, вернись». Возвращает число снятых правок, чтобы popup мог
    // отличить «нечего откатывать» от «откатили».
    revertInterventionEdits() {
        if (!this.interventionLayer) {
            return { success: true, reverted: 0 };
        }
        const before = this.interventionLayer.getStats().appliedEdits;
        try {
            this.interventionLayer.revertAll();
        } catch (error) {
            Logger.error('Intervention layer failed to revert edits:', error);
            return { success: false, reverted: 0 };
        }
        return { success: true, reverted: before };
    }

    // C4.4: факт «страница снимала наши метки» до этого доходил только до Logger.warn, то есть
    // никуда: консоль пользователь не открывает, а getStats() слоя не читал никто, кроме теста.
    // Отчёт компактный по privacy-контракту: счётчики и ТИПЫ находок (наш собственный словарь),
    // ни узлов, ни текста страницы.
    buildInterventionReport() {
        if (!this.interventionLayer) {
            return null;
        }
        const stats = this.interventionLayer.getStats();
        if (!stats.enabled && stats.appliedEdits === 0 && stats.tamperedEdits === 0) {
            // Гейт закрыт и следов нет - блока в снапшоте тоже нет: молчание честнее нулей.
            return null;
        }
        return {
            enabled: stats.enabled === true,
            action: typeof stats.action === 'string' ? stats.action.slice(0, 32) : 'annotate',
            appliedEdits: Math.max(0, Math.trunc(stats.appliedEdits || 0)),
            annotationsApplied: Math.max(0, Math.trunc(stats.annotationsApplied || 0)),
            revealsApplied: Math.max(0, Math.trunc(stats.revealsApplied || 0)),
            neutralizationsApplied: Math.max(0, Math.trunc(stats.neutralizationsApplied || 0)),
            tamperedEdits: Math.max(0, Math.trunc(stats.tamperedEdits || 0)),
            tamperedFindingTypes: Array.isArray(stats.tamperedFindingTypes)
                ? stats.tamperedFindingTypes.slice(0, 8).map((type) => String(type).slice(0, 96))
                : [],
            intentionsDropped: Math.max(0, Math.trunc(stats.intentionsDropped || 0))
        };
    }

    applySliceCapToModules() {
        for (const module of this.modules.values()) {
            if (module) {
                module.maxSliceMs = this.sliceCapMs;
            }
        }
    }

    async enableModule(moduleName, lifecycleRevision = this.lifecycleRequestRevision) {
        const module = this.modules.get(moduleName);
        if (!module) throw new Error(`Module ${moduleName} not found`);
        if (this.activeModuleNames.has(moduleName)) {
            return this.isLifecycleRevisionCurrent(lifecycleRevision);
        }

        try {
            // A full enable starts from nothing. If the module was merely paused, its kept state
            // belongs to the previous configuration and must not survive into this one - that is the
            // difference between resumeModule() and this path.
            if (this.pausedModuleNames.has(moduleName)) {
                module.destroy();
                this.pausedModuleNames.delete(moduleName);
            }

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
            this.pausedModuleNames.delete(moduleName);
            Logger.error(`Error enabling module ${moduleName}:`, error);
            return false;
        }
    }

    // A tripwire, not an analyser: it answers one yes/no question - did anything in the document
    // change while the tab was in the background - and it stops watching the moment the answer
    // becomes "yes". At most one callback per pause, then disconnect. That is what lets it coexist
    // with the foreground-only contract: a paused tab does no ANALYSIS, and this does none.
    // It watches attributes and character data as well as the tree, because `href` swapped in place
    // (C5.4) and text rewritten in place are exactly the changes a rescan must not miss.
    installDocumentChangeTripwire() {
        this.removeDocumentChangeTripwire();

        if (typeof MutationObserver !== 'function' || !document.documentElement) {
            // Cannot watch, so cannot prove anything: everyone rescans on resume.
            this.documentChangedWhilePaused = true;
            return;
        }

        this.documentChangedWhilePaused = false;
        try {
            this.documentChangeTripwire = new MutationObserver(() => {
                this.documentChangedWhilePaused = true;
                this.removeDocumentChangeTripwire();
            });
            this.documentChangeTripwire.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true
            });
        } catch (error) {
            Logger.error('Failed to install the document change tripwire:', error);
            this.documentChangedWhilePaused = true;
            this.documentChangeTripwire = null;
        }
    }

    removeDocumentChangeTripwire() {
        if (!this.documentChangeTripwire) {
            return;
        }
        try {
            // takeRecords() before disconnect: records already queued are still changes.
            if (this.documentChangeTripwire.takeRecords().length > 0) {
                this.documentChangedWhilePaused = true;
            }
            this.documentChangeTripwire.disconnect();
        } catch (error) {
            Logger.error('Failed to remove the document change tripwire:', error);
            this.documentChangedWhilePaused = true;
        }
        this.documentChangeTripwire = null;
    }

    // The foreground pause. Every working module stops, and the tripwire takes over watching the
    // document so the next activation knows whether anything actually needs re-analysing.
    // Configuration is deliberately NOT applied here: a paused tab does no work, and the transition
    // back to active runs handleUpdateModules(), which applies the config and starts a module over
    // if the change touched detection.
    async pauseActiveModules(lifecycleRevision = this.lifecycleRequestRevision) {
        try {
            for (const moduleName of [...this.activeModuleNames]) {
                if (!this.isLifecycleRevisionCurrent(lifecycleRevision)) {
                    return { success: false, skipped: 'stale-lifecycle' };
                }
                await this.pauseModule(moduleName);
            }

            this.installDocumentChangeTripwire();

            return {
                success: true,
                pausedModules: Array.from(this.pausedModuleNames),
                activeModules: Array.from(this.activeModuleNames)
            };
        } catch (error) {
            Logger.error('Error pausing modules:', error);
            return { success: false, error: error.message };
        }
    }

    async pauseModule(moduleName) {
        const module = this.modules.get(moduleName);
        if (!module) throw new Error(`Module ${moduleName} not found`);

        try {
            module.pause();
            this.activeModuleNames.delete(moduleName);
            this.pausedModuleNames.add(moduleName);
            return true;
        } catch (error) {
            Logger.error(`Error pausing module ${moduleName}:`, error);
            // A module that could not be paused cleanly must not be left half-running.
            module.destroy();
            this.activeModuleNames.delete(moduleName);
            this.pausedModuleNames.delete(moduleName);
            return false;
        }
    }

    async resumeModule(moduleName, lifecycleRevision = this.lifecycleRequestRevision) {
        const module = this.modules.get(moduleName);
        if (!module) throw new Error(`Module ${moduleName} not found`);

        // Skipping the scan needs BOTH: a document that provably did not change, and a module that
        // kept its findings across the pause. Either one missing means a full rescan, which is what
        // every module did before pause existed.
        const rescan = this.documentChangedWhilePaused || module.keepsStateWhilePaused !== true;

        try {
            const resumed = await module.resume({ rescan });
            if (!this.isLifecycleRevisionCurrent(lifecycleRevision)) {
                module.destroy();
                this.pausedModuleNames.delete(moduleName);
                this.activeModuleNames.delete(moduleName);
                return false;
            }
            if (!resumed) {
                module.destroy();
                this.pausedModuleNames.delete(moduleName);
                this.activeModuleNames.delete(moduleName);
                return false;
            }
            this.pausedModuleNames.delete(moduleName);
            this.activeModuleNames.add(moduleName);
            return true;
        } catch (error) {
            Logger.error(`Error resuming module ${moduleName}:`, error);
            module.destroy();
            this.pausedModuleNames.delete(moduleName);
            this.activeModuleNames.delete(moduleName);
            return false;
        }
    }

    async disableModule(moduleName) {
        const module = this.modules.get(moduleName);
        if (!module) throw new Error(`Module ${moduleName} not found`);
        // A paused module is not a disabled one: it still holds state that disabling must clear, so
        // the early exit does not apply to it.
        if (!this.activeModuleNames.has(moduleName)
            && !this.pausedModuleNames.has(moduleName)
            && !module.isEnabled
            && !(typeof module.isActive === 'function' && module.isActive())) {
            return true;
        }

        try {
            module.destroy();
            this.activeModuleNames.delete(moduleName);
            this.pausedModuleNames.delete(moduleName);
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
            const updateResult = await this.pauseActiveModules(lifecycleRevision);
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

        // Stop watching and read the verdict BEFORE any module resumes: from here on the modules
        // observe the document themselves, and records queued during the pause still count as
        // changes (takeRecords inside).
        this.removeDocumentChangeTripwire();

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

            this.setupWorkloadObserver();
            this.applySliceCapToModules();
            this.syncInterventionGate();
            this.scanBudgetExhausted = false;
            this.modulesSkippedByTabBudget = [];
            let tabActiveMs = 0;

            for (const moduleName of scanModuleNames) {
                // C2: бюджет проверяется ПЕРЕД модулем, а не внутри него. Обрывать модуль на середине
                // означало бы половину прохода, выдаваемую за целую; пропуск целого модуля виден и
                // называется по имени.
                if (tabActiveMs >= this.tabScanBudgetMs) {
                    this.scanBudgetExhausted = true;
                    if (this.modulesSkippedByTabBudget.length < 16) {
                        this.modulesSkippedByTabBudget.push(moduleName);
                    }
                    continue;
                }
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
                // Активное время, а не стенные часы: уступка планировщику длится столько, сколько
                // решит планировщик, и по стенным часам бюджет съедался бы ожиданием, а не работой.
                tabActiveMs += Math.max(0, Number(module.getScanActiveMs?.()) || 0);

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

            this.applyInterventionQueue();

            // C2, transparency: сколько АКТИВНОЙ работы стоил этот скан. Это наша собственная цена,
            // а не «нагрузка страницы» - мерить чужую нагрузку мы отказались осознанно. После
            // инцидента с 54 вкладками доверие восстанавливается числом, а не обещанием.
            this.lastScanActiveMs = Math.round(tabActiveMs * 100) / 100;

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

        // Тот же снапшот, что отдаёт performScan, и собирает его то же место - ModuleCore
        // (C1). Здесь форма собиралась ЗАНОВО и собиралась иначе: свой предел findings, угадывание
        // числа находок по цепочке имён полей stats, отсутствие полей getSnapshotState() и особый
        // случай для одного модуля, захардкоженный по его ID. Popup видел разный снапшот одного
        // состояния в зависимости от того, каким путём тот построен.
        for (const moduleName of this.activeModuleNames) {
            const module = this.modules.get(moduleName);
            if (typeof module?.buildScanSnapshot !== 'function') {
                continue;
            }

            const snapshot = module.buildScanSnapshot();
            const threatCount = Number.isFinite(snapshot?.threatsDetected)
                ? Math.max(0, Math.trunc(snapshot.threatsDetected))
                : 0;

            moduleCounts[moduleName] = threatCount;
            totalThreats += threatCount;
            results[moduleName] = snapshot;
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
        const linkFindingsTruncated = results?.[LINK_DOMAIN_SECURITY_MODULE_ID]?.findingsTruncated === true;
        // Модуль, до которого не дошёл суммарный бюджет вкладки, попадает сюда наравне с модулем,
        // оборвавшим собственный обход: с точки зрения человека и агента это одно и то же -
        // покрытие неполно (C5.2).
        const partialModules = [...new Set([
            ...Object.entries(results)
                .filter(([, result]) => result?.partialResult === true || result?.stats?.partialResult === true)
                .map(([moduleId]) => moduleId),
            ...this.modulesSkippedByTabBudget
        ])].slice(0, 16);

        return {
            scanId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            url: window.location.href,
            frameId: 0,
            moduleCounts,
            visualFindings,
            linkFindings,
            linkRevision,
            linkFindingsTruncated,
            promptSplittingFindings,
            promptSplittingRevision,
            promptSplittingFindingsTruncated,
            triggerFindings,
            triggerRevision,
            partialModules,
            context: this.buildPageContext(),
            intervention: this.buildInterventionReport(),
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
