import { ConfigManager } from '../utils/config-manager.js';
import { Logger } from '../utils/logger.js';
import { CONFIG_STORAGE_KEYS } from '../utils/config-manager.js';
import ApiResourceObserver from '../modules/api-interception/runtime/ApiResourceObserver.js';
import ApiFindingState from '../modules/api-interception/runtime/ApiFindingState.js';
import { evaluateImageMimeObservation } from '../modules/api-interception/decision/apiMimeDecision.js';
import ApiPermissionCoordinator from '../modules/api-interception/permissions/ApiPermissionCoordinator.js';
import { API_PERMISSION_MODULE_ID, isApiPermissionDescriptorRelevant } from '../modules/api-interception/permissions/apiPermissionContract.js';
import { createRateLimiter, createRefusal, handleFindingsApiRequest } from './findings-api.js';

const PAGE_STATUS_SESSION_KEY = 'pagecheckPageStatusCache';
const PAGE_STATUS_CACHE_SCHEMA_VERSION = 7;
const PAGE_STATUS_CACHE_WRITE_DELAY_MS = 250;
const VISUAL_MANIPULATION_MODULE_ID = 'Hidden-Content-Visual-Manipulation';
const LINK_DOMAIN_SECURITY_MODULE_ID = 'Link-Domain-Security';
const TRIGGER_PHRASES_MODULE_ID = 'Trigger-Phrases';
const PROMPT_SPLITTING_MODULE_ID = 'Prompt-Splitting';
const API_INTERCEPTION_MODULE_ID = API_PERMISSION_MODULE_ID;

export class BackgroundManager {
    constructor() {
        this.config = null;
        this.activeTabs = new Map(); // tabId -> { modules: [], url: string }
        this.moduleStates = new Map();
        this.pageStatusByTab = new Map(); // tabId -> { url, status, totalFindings, frames: Map<frameId, snapshot> }
        this.foregroundTabId = null;
        this.focusedWindowId = chrome.windows.WINDOW_ID_NONE;
        this.requestedFocusedWindowId = chrome.windows.WINDOW_ID_NONE;
        this.foregroundTransitionRevision = 0;
        this.foregroundTransitionQueue = Promise.resolve();
        this.apiObservationRevision = 0;
        this.apiObserverSignature = '';
        this.apiObservationState = null;
        this.apiResourceObserver = null;
        this.apiFindingState = null;
        this.apiPermissionCoordinator = null;
        this.apiPermissionState = null;
        this.pageStatusCacheWriteTimer = null;
        this.findingsApiRateLimiter = createRateLimiter();
        this.configChangeInFlight = null;
        this.configChangePending = false;
        this.foreignSyncChangeSeen = false;
        this.apiPermissionReconcilePending = false;

        // Слушатели регистрируются СИНХРОННО, до любого await. В MV3 событие, разбудившее worker,
        // диспатчится сразу после того, как вычисление скрипта завершилось; раньше регистрация
        // жила внутри init() за `await ConfigManager.getConfig()`, поэтому вычисление завершалось с
        // нулём слушателей и разбудившее событие терялось - переключение вкладки после простоя не
        // активировало новую foreground-вкладку, а sendMessage из popup получал «Receiving end does
        // not exist» (TASKS C6.1). Асинхронная часть теперь ждёт ВНУТРИ обработчика: обработчик
        // ждёт готовности конфигурации, а не наоборот.
        this.setupMessageListeners();
        this.setupEventListeners();
        this.setupPermissionListeners();
        this.setupStorageListeners();

        this.readyPromise = this.init();
    }

    // Единственная точка ожидания готовности. Ошибка инициализации не должна навсегда запирать
    // обработчики: init() ловит собственные ошибки, а здесь стоит второй рубеж.
    whenReady() {
        return (this.readyPromise || Promise.resolve()).catch(() => undefined);
    }

    async init() {
        try {
            Logger.info('Background service worker starting...');

            this.config = await ConfigManager.getConfig();
            Logger.debug('Configuration loaded', {
                moduleCount: Object.keys(this.config?.modules || {}).length
            });
            this.apiFindingState = new ApiFindingState();
            this.apiResourceObserver = new ApiResourceObserver({
                // webRequest сюда БОЛЬШЕ НЕ ПЕРЕДАЁТСЯ: разрешение опциональное, при чистом старте
                // service worker его ещё нет, и захваченный undefined жил бы до перезапуска SW
                // (TASKS 13.2). Наблюдатель резолвит namespace лениво, в момент активации.
                onStateChange: (state) => {
                    this.apiObservationState = state;
                    if (state.partial === true) {
                        this.apiFindingState?.applyDecisions([], {
                            navigationRevision: state.revision,
                            partial: true
                        });
                    }
                },
                onObservationBatch: (observations, context) => {
                    this.applyApiObservationBatch(observations, context);
                }
            });
            this.apiPermissionCoordinator = new ApiPermissionCoordinator({
                permissionsApi: chrome.permissions,
                readDesiredEnabled: () => this.config?.modules?.[API_INTERCEPTION_MODULE_ID]?.enabled === true,
                commitDesiredEnabled: (enabled) => this.commitApiDesiredEnabled(enabled),
                pauseObserver: () => this.invalidateApiObserver(),
                reconcileObserver: () => this.syncApiObserverForForeground(),
                onStateChange: (state) => {
                    this.apiPermissionState = state;
                }
            });

            await this.restorePageStatusCache();
            await this.restoreActiveTabs();
            await this.apiPermissionCoordinator.reconcile();
            await this.enqueueForegroundTransition(
                (foregroundRevision) => this.refreshForegroundTab(null, foregroundRevision)
            );

            Logger.info('Background service worker started successfully');

        } catch (error) {
            Logger.error('Failed to initialize background service worker:', error);
        }
    }

    setupMessageListeners() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            Logger.debug('Message received:', {
                action: request.action,
                from: sender.tab ? `tab:${sender.tab.id}` : 'popup/options'
            });

            const handleAsync = async () => {
                try {
                    // Сообщение могло разбудить worker: сначала дожидаемся конфигурации и
                    // наблюдателей, потом отвечаем (TASKS C6.1).
                    await this.whenReady();

                    let response;

                    switch (request.action) {
                        case 'getConfig':
                            response = this.config;
                            break;
                        case 'getPageLifecycle':
                            response = this.getPageLifecycle(sender);
                            break;

                        // `saveConfig` и `updateConfig` удалены 2026-09-10: два пишущих обработчика
                        // одного действия, у которых не было ни одного отправителя. popup и options
                        // сохраняют конфигурацию напрямую через ConfigManager, а до вкладок она
                        // доезжает через storage.onChanged -> handleConfigChange. Пишущий
                        // обработчик без отправителя доступен любому отправителю из контекста
                        // расширения - это поверхность, за которую никто не платил.
                        case 'runConfigSmokeCheck':
                            response = this.handleRunConfigSmokeCheck();
                            break;

                        case 'toggleModule':
                            response = await this.handleToggleModule(request.moduleId, request.enabled, sender.tab?.id);
                            break;

                        case 'apiPermissionBegin':
                            response = await this.handleApiPermissionBegin();
                            break;
                        case 'apiPermissionCommit':
                            response = await this.handleApiPermissionCommit(request.transactionId, request.granted === true);
                            break;
                        case 'apiPermissionDisable':
                            response = await this.handleApiPermissionDisable();
                            break;
                        case 'apiPermissionState':
                            response = this.getApiPermissionState();
                            break;

                        case 'getTabModules':
                            response = this.getTabModules(sender.tab?.id);
                            break;

                        case 'scanPage':
                            response = await this.handleScanPage(request.tabId || request.tab?.id || sender.tab?.id, sender);
                            break;
                        case 'pageStatusUpdate':
                            response = this.handlePageStatusUpdate(request.data, sender);
                            break;

                        case 'getStats':
                            response = this.getStats();
                            break;

                        case 'getModuleState':
                            response = this.getModuleState(request.moduleId);
                            break;

                        // `executeModuleAction` удалён 2026-09-10 вместе со своей заглушкой: в
                        // background он не выполнял ничего, кроме записи в лог ПЕРЕДАННЫХ
                        // вызывающим данных, и отправителя у него не было.

                        default:
                            response = { error: 'Unknown action', action: request.action };
                    }

                    sendResponse(response);

                } catch (error) {
                    Logger.error('Error handling message:', error);
                    sendResponse({
                        error: error.message,
                        action: request.action
                    });
                }
            };

            handleAsync();
            return true; // indicates async response
        });

        this.setupExternalMessageListener();
    }

    // Deliberately a SEPARATE listener from the one above. The internal switch carries saveConfig,
    // toggleModule, apiPermission* and executeModuleAction; routing external callers through it
    // would hand configuration and permission control to any allowlisted extension. This one is
    // read-only by construction - see js/findings-api.js for the full gate rationale.
    setupExternalMessageListener() {
        if (!chrome.runtime.onMessageExternal) {
            return;
        }

        chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
            // Ответ откладывается до готовности: иначе запрос, разбудивший worker, получал бы отказ
            // просто потому, что конфигурация ещё не прочитана (TASKS C6.1). Гейты findings-API от
            // этого не меняются - решение по-прежнему принимает handleFindingsApiRequest.
            this.whenReady().then(() => {
                let response;
                try {
                    response = handleFindingsApiRequest(request, sender, {
                        config: this.config,
                        extensionVersion: chrome.runtime.getManifest().version,
                        rateLimiter: this.findingsApiRateLimiter,
                        now: Date.now(),
                        getForegroundSnapshot: () => this.getForegroundFindingsSnapshot()
                    });
                } catch (error) {
                    // Never surface internal failures to an external caller: an error message is itself
                    // information about our state. Log locally, refuse uniformly.
                    Logger.error('Findings API request failed:', error);
                    response = createRefusal();
                }

                sendResponse(response);
            });
            return true;
        });
    }

    // Foreground tab of the FOCUSED window only. Anything else would let a caller poll tabs the user
    // is not looking at, which the runtime does not even scan.
    getForegroundFindingsSnapshot() {
        const tabId = this.foregroundTabId;
        if (tabId === null || this.focusedWindowId === chrome.windows.WINDOW_ID_NONE) {
            return null;
        }

        const pageStatus = this.pageStatusByTab.get(tabId);
        if (!pageStatus) {
            return null;
        }

        return {
            tabId,
            url: pageStatus.url || this.activeTabs.get(tabId)?.url || '',
            status: pageStatus.status,
            totalFindings: pageStatus.totalFindings,
            stale: pageStatus.stale === true,
            updatedAt: pageStatus.updatedAt,
            frameSnapshot: pageStatus.frames?.get(0) || null
        };
    }

    setupEventListeners() {
        chrome.runtime.onInstalled.addListener(async (details) => {
            await this.whenReady();
            if (details.reason === 'install') {
                Logger.info('Extension installed');
                this.showWelcomeNotification();
                this.initializeFirstRun();
            } else if (details.reason === 'update') {
                Logger.info(`Extension updated from ${details.previousVersion} to ${chrome.runtime.getManifest().version}`);
                this.handleUpdate(details.previousVersion);
            }
        });

        chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            if (changeInfo.status === 'complete' && tab.url) {
                this.whenReady()
                    .then(() => this.handleTabUpdated(tabId, tab))
                    .catch((error) => {
                        Logger.error(`Failed to process tab update for ${tabId}:`, error);
                    });
            }
        });

        chrome.tabs.onRemoved.addListener((tabId) => {
            this.whenReady().then(() => this.handleTabRemoved(tabId));
        });

        chrome.tabs.onActivated.addListener((activeInfo) => {
            this.whenReady()
                .then(() => this.handleTabActivated(activeInfo))
                .catch((error) => {
                    Logger.error(`Failed to process tab activation for ${activeInfo.tabId}:`, error);
                });
        });

        chrome.windows.onFocusChanged.addListener((windowId) => {
            this.whenReady()
                .then(() => this.handleWindowFocusChanged(windowId))
                .catch((error) => {
                    Logger.error(`Failed to process window focus change for ${windowId}:`, error);
                });
        });

        chrome.webNavigation.onCommitted.addListener((details) => {
            if (details.frameId === 0) { // main frame only
                this.whenReady().then(() => this.handleNavigation(details.tabId, details.url));
            }
        });
    }

    setupStorageListeners() {
        chrome.storage.onChanged.addListener((changes, area) => {
            const generalConfigChanged = changes[CONFIG_STORAGE_KEYS.EXTENSION_CONFIG]
                && ['sync', 'local'].includes(area);
            const customPatternCatalogChanged = area === 'local'
                && changes[CONFIG_STORAGE_KEYS.TRIGGER_PHRASES_CUSTOM_PATTERNS];
            if (generalConfigChanged || customPatternCatalogChanged) {
                this.whenReady()
                    .then(() => this.handleConfigChange({ area }))
                    .catch((error) => {
                        Logger.error('Failed to refresh external configuration:', error);
                    });
            }
        });
    }

    handleRunConfigSmokeCheck() {
        try {
            const report = ConfigManager.runConfigSmokeCheck();
            return {
                success: true,
                report
            };
        } catch (error) {
            Logger.error('Config smoke check failed:', error);
            return {
                success: false,
                error: String(error?.message || error)
            };
        }
    }

    async applyConfigToAllTabs(oldConfig, newConfig) {
        this.invalidateApiObserver();
        for (const [tabId, tabInfo] of this.activeTabs.entries()) {
            this.resetPageStatusForTab(tabId, tabInfo.url);
            this.applyIndicatorForTab(tabId);
        }

        if (this.foregroundTabId !== null) {
            await this.enqueueForegroundTransition(
                (foregroundRevision) => {
                    const foregroundTabId = this.foregroundTabId;
                    const tabInfo = this.activeTabs.get(foregroundTabId);
                    return this.updateTabModules(
                        foregroundTabId,
                        tabInfo?.url,
                        foregroundRevision
                    );
                },
                false
            );
        }
    }

    async handleToggleModule(moduleId, enabled, tabId = null) {
        Logger.info(`Toggling module ${moduleId} to ${enabled} for tab ${tabId || 'all'}`);

        if (!this.config.modules[moduleId]) {
            throw new Error(`Module ${moduleId} not found in config`);
        }

        if (moduleId === API_INTERCEPTION_MODULE_ID) {
            if (enabled === true) {
                return { success: false, reason: 'permission-required', state: this.getApiPermissionState() };
            }
            return this.handleApiPermissionDisable();
        }

        this.config.modules[moduleId].enabled = enabled;
        await ConfigManager.saveConfig(this.config);

        await this.applyConfigToAllTabs(this.config, this.config);

        return { success: true };
    }

    async commitApiDesiredEnabled(enabled) {
        if (!this.config?.modules?.[API_INTERCEPTION_MODULE_ID]) {
            return;
        }
        this.config.modules[API_INTERCEPTION_MODULE_ID].enabled = enabled === true;
        this.config = await ConfigManager.saveConfig(this.config);
        await this.applyConfigToAllTabs(this.config, this.config);
    }

    async handleApiPermissionBegin() {
        const result = await this.apiPermissionCoordinator?.beginEnable();
        return result
            ? { success: true, transactionId: result.transactionId, revision: result.revision, state: result.state }
            : { success: false, reason: 'permission-unavailable', state: this.getApiPermissionState() };
    }

    async handleApiPermissionCommit(transactionId, granted) {
        if (typeof transactionId !== 'string' || !/^api-\d{1,12}$/.test(transactionId)) {
            return { success: false, stale: true, state: this.getApiPermissionState() };
        }
        const result = await this.apiPermissionCoordinator?.commitEnable(transactionId, granted);
        await this.flushPendingApiPermissionReconcile();
        return result || { success: false, reason: 'permission-unavailable', state: this.getApiPermissionState() };
    }

    async handleApiPermissionDisable() {
        const result = await this.apiPermissionCoordinator?.disable();
        await this.flushPendingApiPermissionReconcile();
        return result || { success: false, reason: 'permission-unavailable', state: this.getApiPermissionState() };
    }

    getApiPermissionState() {
        return this.apiPermissionCoordinator?.getState()
            || Object.freeze({ capability: 'unavailable', transaction: 'idle', desiredEnabled: false, revision: 0, removalFailed: false });
    }

    async handleTabUpdated(tabId, tab) {
        if (!tab.url) {
            return;
        }

        Logger.debug(`Tab updated: ${tabId} - ${tab.url}`);

        if (!this.isScannableUrl(tab.url)) {
            this.activeTabs.delete(tabId);
            this.resetPageStatusForTab(tabId, tab.url);
            this.applyIndicatorForTab(tabId);
            return;
        }

        if (!this.activeTabs.has(tabId)) {
            this.activeTabs.set(tabId, {
                url: tab.url,
                modules: [],
                lastUpdated: Date.now()
            });
        } else {
            this.activeTabs.get(tabId).url = tab.url;
        }

        if (tabId === this.foregroundTabId) {
            await this.enqueueForegroundTransition(
                (foregroundRevision) => this.updateTabModules(tabId, tab.url, foregroundRevision),
                false
            );
        }
    }

    async updateTabModules(
        tabId,
        url,
        foregroundRevision = this.foregroundTransitionRevision
    ) {
        try {
            if (!this.isForegroundTransitionCurrent(foregroundRevision)) {
                return { success: false, skipped: 'stale-foreground' };
            }
            // Вкладка могла исчезнуть, пока операция стояла в очереди (TASKS C6.7).
            if (!Number.isInteger(tabId)) {
                return { success: false, skipped: 'no-foreground-tab' };
            }

            const enabledModules = this.getEnabledModulesForUrl(url);

            const isForeground = this.isForegroundScanAllowed(tabId, url);
            this.syncApiObserverForForeground(foregroundRevision);
            const response = await chrome.tabs.sendMessage(tabId, {
                action: 'setPageLifecycle',
                state: isForeground ? 'active' : 'paused',
                modules: enabledModules,
                config: this.config
            }).catch(error => {
                Logger.debug(`Content script not ready in tab ${tabId}:`, error.message);
            });

            if (!this.isForegroundTransitionCurrent(foregroundRevision)) {
                return { success: false, skipped: 'stale-foreground' };
            }

            if (response?.success) {
                const tabInfo = this.activeTabs.get(tabId);
                if (tabInfo) {
                    tabInfo.modules = isForeground ? enabledModules : [];
                }
                Logger.debug(`Lifecycle updated for tab ${tabId}: ${isForeground ? 'active' : 'paused'}`);
            }

            return response || { success: false, error: 'Content script unavailable' };

        } catch (error) {
            Logger.error(`Error updating modules for tab ${tabId}:`, error);
            return { success: false, error: String(error?.message || error) };
        }
    }

    getEnabledModulesForUrl(url) {
        const enabledModules = [];

        for (const [moduleId, moduleConfig] of Object.entries(this.config.modules)) {
            if (moduleId !== API_INTERCEPTION_MODULE_ID
                && moduleConfig.enabled
                && this.isModuleAllowedForUrl(moduleId, url)) {
                enabledModules.push(moduleId);
            }
        }

        return enabledModules;
    }

    getPageLifecycle(sender) {
        const tab = sender?.tab;
        if (tab?.id && this.isScannableUrl(tab.url)) {
            const existing = this.activeTabs.get(tab.id) || { modules: [], lastUpdated: Date.now() };
            existing.url = tab.url;
            this.activeTabs.set(tab.id, existing);
        }

        // Дополнительно к общему правилу: только главный фрейм и только окно, которое сейчас в
        // фокусе. Фрейм здесь спрашивает сам, поэтому проверка окна делается по его собственному
        // windowId, а не по доверию к foregroundTabId.
        const isForeground = sender?.frameId === 0
            && tab?.windowId === this.focusedWindowId
            && this.isForegroundScanAllowed(tab?.id, tab?.url);

        return {
            state: isForeground ? 'active' : 'paused',
            modules: isForeground ? this.getEnabledModulesForUrl(tab?.url) : [],
            config: this.config
        };
    }

    enqueueForegroundTransition(operation, supersede = true) {
        const foregroundRevision = supersede
            ? ++this.foregroundTransitionRevision
            : this.foregroundTransitionRevision;
        let cancellationPromise = Promise.resolve();
        if (supersede && this.foregroundTabId !== null) {
            this.invalidateApiObserver();
            const previousTabId = this.foregroundTabId;
            this.foregroundTabId = null;
            const previousTabInfo = this.activeTabs.get(previousTabId);
            if (previousTabInfo) {
                previousTabInfo.modules = [];
            }
            cancellationPromise = this.sendPageLifecycle(
                previousTabId,
                'paused',
                foregroundRevision
            );
        }

        const runTransition = async () => {
            await cancellationPromise;
            if (!this.isForegroundTransitionCurrent(foregroundRevision)) {
                return { success: false, skipped: 'stale-foreground' };
            }
            return operation(foregroundRevision);
        };
        const queuedTransition = this.foregroundTransitionQueue.then(
            runTransition,
            runTransition
        );
        this.foregroundTransitionQueue = queuedTransition.then(
            () => undefined,
            () => undefined
        );
        return queuedTransition;
    }

    isForegroundTransitionCurrent(foregroundRevision) {
        return foregroundRevision === this.foregroundTransitionRevision;
    }

    async refreshForegroundTab(
        windowId = null,
        foregroundRevision = this.foregroundTransitionRevision
    ) {
        try {
            if (!this.isForegroundTransitionCurrent(foregroundRevision)) {
                return { success: false, skipped: 'stale-foreground' };
            }

            let targetWindow;
            if (Number.isInteger(windowId) && windowId !== chrome.windows.WINDOW_ID_NONE) {
                targetWindow = await chrome.windows.get(windowId);
            } else {
                targetWindow = await chrome.windows.getLastFocused();
            }

            if (!this.isForegroundTransitionCurrent(foregroundRevision)) {
                return { success: false, skipped: 'stale-foreground' };
            }
            if (!targetWindow?.focused || targetWindow.id === chrome.windows.WINDOW_ID_NONE) {
                this.requestedFocusedWindowId = chrome.windows.WINDOW_ID_NONE;
                return this.setForegroundTab(
                    null,
                    chrome.windows.WINDOW_ID_NONE,
                    foregroundRevision
                );
            }

            const [activeTab] = await chrome.tabs.query({
                active: true,
                windowId: targetWindow.id
            });
            if (!this.isForegroundTransitionCurrent(foregroundRevision)) {
                return { success: false, skipped: 'stale-foreground' };
            }
            this.requestedFocusedWindowId = targetWindow.id;
            return this.setForegroundTab(
                activeTab?.id || null,
                targetWindow.id,
                foregroundRevision
            );
        } catch (error) {
            Logger.warn('Failed to resolve foreground tab:', error);
            if (!this.isForegroundTransitionCurrent(foregroundRevision)) {
                return { success: false, skipped: 'stale-foreground' };
            }
            return this.setForegroundTab(
                null,
                chrome.windows.WINDOW_ID_NONE,
                foregroundRevision
            );
        }
    }

    async setForegroundTab(
        tabId,
        windowId,
        foregroundRevision = this.foregroundTransitionRevision
    ) {
        if (!this.isForegroundTransitionCurrent(foregroundRevision)) {
            return { success: false, skipped: 'stale-foreground' };
        }

        const previousTabId = this.foregroundTabId;
        const foregroundChanged = previousTabId !== tabId || this.focusedWindowId !== windowId;
        if (!foregroundChanged) {
            return { success: true, skipped: 'unchanged-foreground' };
        }

        if (previousTabId !== null && foregroundChanged) {
            await this.sendPageLifecycle(previousTabId, 'paused', foregroundRevision);
        }

        if (!this.isForegroundTransitionCurrent(foregroundRevision)) {
            if (this.foregroundTabId === previousTabId) {
                this.foregroundTabId = null;
                this.focusedWindowId = chrome.windows.WINDOW_ID_NONE;
            }
            return { success: false, skipped: 'stale-foreground' };
        }

        this.foregroundTabId = tabId;
        this.focusedWindowId = windowId;
        this.requestedFocusedWindowId = windowId;
        this.syncApiObserverForForeground(foregroundRevision);

        if (tabId !== null) {
            await this.sendPageLifecycle(tabId, 'active', foregroundRevision);
            if (!this.isForegroundTransitionCurrent(foregroundRevision)) {
                return { success: false, skipped: 'stale-foreground' };
            }
            this.applyIndicatorForTab(tabId);
        }

        return { success: true, tabId, windowId };
    }

    // ЕДИНСТВЕННОЕ место, где написано «этой вкладке разрешено работать» (C2). Раньше правило было
    // написано трижды разными руками и с разной строгостью: один из трёх вариантов не спрашивал про
    // фокус окна вовсе, другой не спрашивал про сканируемость URL.
    // Правило: работает только foreground-вкладка СФОКУСИРОВАННОГО окна. `tabs.Tab.active` для этого
    // недостаточно - активная вкладка есть в КАЖДОМ окне, включая свёрнутые и фоновые, и ровно так
    // и получается «скан всех вкладок»: 54 активные вкладки в разных окнах.
    // Старт браузера, восстановление сессии и перезапуск service worker сюда не попадают вовсе:
    // restoreActiveTabs() только регистрирует вкладки и рисует индикатор из кэша, а разрешение
    // спрашивается один раз - для той вкладки, которую пользователь действительно смотрит.
    isForegroundScanAllowed(tabId, url) {
        return Number.isInteger(tabId)
            && tabId === this.foregroundTabId
            && this.focusedWindowId !== chrome.windows.WINDOW_ID_NONE
            && this.isScannableUrl(url)
            && this.config?.settings?.autoScan !== false;
    }

    async sendPageLifecycle(
        tabId,
        state,
        foregroundRevision = this.foregroundTransitionRevision
    ) {
        if (!this.isForegroundTransitionCurrent(foregroundRevision)) {
            return { success: false, skipped: 'stale-foreground' };
        }

        const tabInfo = this.activeTabs.get(tabId);
        const canActivate = state === 'active' && this.isForegroundScanAllowed(tabId, tabInfo?.url);
        const modules = canActivate
            ? this.getEnabledModulesForUrl(tabInfo?.url)
            : [];

        const response = await chrome.tabs.sendMessage(tabId, {
            action: 'setPageLifecycle',
            state: canActivate ? 'active' : 'paused',
            modules,
            config: this.config
        }).catch((error) => {
            Logger.debug(`Content script not ready for lifecycle update in tab ${tabId}:`, error.message);
            return null;
        });

        if (!this.isForegroundTransitionCurrent(foregroundRevision)) {
            return { success: false, skipped: 'stale-foreground' };
        }

        if (response?.success && tabInfo) {
            tabInfo.modules = state === 'active' ? modules : [];
        }

        return response;
    }

    isModuleAllowedForUrl(moduleId, url) {
        return true;
    }

    handleTabRemoved(tabId) {
        Logger.debug(`Tab removed: ${tabId}`);
        this.activeTabs.delete(tabId);
        this.pageStatusByTab.delete(tabId);
        if (tabId === this.foregroundTabId) {
            this.invalidateApiObserver();
            this.foregroundTabId = null;
            // Очередь foreground-переходов проверяет foregroundTabId при ПОСТАНОВКЕ, а операция
            // перечитывает поле при ВЫПОЛНЕНИИ. Раньше закрытие вкладки обнуляло поле, не поднимая
            // ревизию, поэтому уже стоявший в очереди переход доезжал до sendMessage(null, ...) и
            // обычное закрытие вкладки давало Logger.error - шум, за которым хуже видно настоящие
            // ошибки (TASKS C6.7). Поднятая ревизия делает такие переходы устаревшими.
            this.foregroundTransitionRevision += 1;
        }
        this.schedulePageStatusCacheWrite();

    }

    async handleTabActivated(activeInfo) {
        Logger.debug(`Tab activated: ${activeInfo.tabId}`);
        this.applyIndicatorForTab(activeInfo.tabId);
        if (activeInfo.windowId === this.requestedFocusedWindowId) {
            if (activeInfo.tabId === this.foregroundTabId) {
                return { success: true, skipped: 'unchanged-foreground' };
            }
            return this.enqueueForegroundTransition(
                (foregroundRevision) => this.setForegroundTab(
                    activeInfo.tabId,
                    activeInfo.windowId,
                    foregroundRevision
                )
            );
        }
        return { success: true, skipped: 'unfocused-window' };
    }

    async handleWindowFocusChanged(windowId) {
        this.requestedFocusedWindowId = windowId;
        if (windowId === chrome.windows.WINDOW_ID_NONE) {
            return this.enqueueForegroundTransition(
                (foregroundRevision) => this.setForegroundTab(
                    null,
                    chrome.windows.WINDOW_ID_NONE,
                    foregroundRevision
                )
            );
        }

        if (windowId === this.focusedWindowId && this.foregroundTabId !== null) {
            return { success: true, skipped: 'unchanged-foreground' };
        }

        return this.enqueueForegroundTransition(
            (foregroundRevision) => this.refreshForegroundTab(windowId, foregroundRevision)
        );
    }

    handleNavigation(tabId, url) {
        Logger.debug(`Navigation committed: ${tabId} - ${url}`);
        if (tabId === this.foregroundTabId) {
            this.invalidateApiObserver();
        }
        if (!this.isScannableUrl(url)) {
            this.activeTabs.delete(tabId);
            this.resetPageStatusForTab(tabId, url);
            this.applyIndicatorForTab(tabId);
            return;
        }

        const tabInfo = this.activeTabs.get(tabId) || { modules: [], lastUpdated: Date.now() };
        tabInfo.modules = [];
        tabInfo.url = url;
        tabInfo.lastUpdated = Date.now();
        this.activeTabs.set(tabId, tabInfo);

        this.resetPageStatusForTab(tabId, url);
        this.applyIndicatorForTab(tabId);
    }

    // Раньше handleScanPage не проверял ни foreground, ни владение вкладкой, а content.js при
    // lifecycleState === 'paused' откатывается к configuredModuleNames и one-shot включает КАЖДЫЙ
    // сконфигурированный детектор. То есть любой отправитель из контекста расширения мог заставить
    // произвольную фоновую вкладку выполнить полную работу детекторов - в обход foreground-only
    // контракта, который остальной файл выдерживает через foregroundTransitionRevision (TASKS C6.6).
    // Разрешено ровно две цели: своя вкладка отправителя и активная вкладка сфокусированного окна.
    async isScanTargetAllowed(tabId, sender) {
        if (sender?.tab?.id === tabId) {
            return true;
        }
        if (tabId === this.foregroundTabId) {
            return true;
        }
        try {
            const tab = await chrome.tabs.get(tabId);
            if (tab?.active !== true) {
                return false;
            }
            // getLastFocused, а не focusedWindowId: пока открыт popup, окно может считаться
            // расфокусированным, и ручной скан по кнопке не должен от этого отказывать.
            const lastFocusedWindow = await chrome.windows.getLastFocused();
            return lastFocusedWindow?.id === tab.windowId;
        } catch (error) {
            Logger.debug(`Failed to verify scan target ${tabId}:`, error?.message || error);
            return false;
        }
    }

    async handleScanPage(tabId, sender = null) {
        try {
            if (!tabId) {
                return { success: false, error: 'No active tab available for scan' };
            }

            if (!await this.isScanTargetAllowed(tabId, sender)) {
                Logger.warn(`Scan refused for tab ${tabId}: not the sender tab and not the foreground tab`);
                return { success: false, error: 'Scan target is neither the sender tab nor the foreground tab' };
            }

            const tabInfo = this.activeTabs.get(tabId);
            if (tabInfo?.url && !this.isScannableUrl(tabInfo.url)) {
                this.resetPageStatusForTab(tabId, tabInfo.url);
                this.applyIndicatorForTab(tabId);
                return { success: false, error: 'Page is not scannable' };
            }

            Logger.info(`Initiating scan for tab ${tabId}`);

            const response = await chrome.tabs.sendMessage(tabId, {
                action: 'performScan'
            });

            const settings = this.getPageStatusSettings();
            if (!settings.snapshotMode && response?.success) {
                this.updatePageStatusFromScanResponse(tabId, response);
            }

            return response || { success: false, error: 'No scan response from content script' };

        } catch (error) {
            const message = String(error?.message || error);
            if (message.includes('Receiving end does not exist')) {
                Logger.warn(`Scan skipped for tab ${tabId}: content script is not available on this page`);
                return { success: false, error: 'Content script is not available on this page' };
            }

            Logger.error(`Scan failed for tab ${tabId}:`, error);
            return { success: false, error: message };
        }
    }

    updatePageStatusFromScanResponse(tabId, response) {
        const moduleCounts = {};
        let totalFindings = 0;

        if (response?.results && typeof response.results === 'object') {
            for (const [moduleId, moduleResult] of Object.entries(response.results)) {
                const moduleCount = Number.isFinite(moduleResult?.threatsDetected)
                    ? Math.max(0, Math.trunc(moduleResult.threatsDetected))
                    : Array.isArray(moduleResult?.findings)
                        ? moduleResult.findings.length
                        : 0;
                moduleCounts[moduleId] = moduleCount;
                totalFindings += moduleCount;
            }
        } else if (Number.isFinite(response?.threatsDetected)) {
            totalFindings = Math.max(0, Math.trunc(response.threatsDetected));
        }

        const tabUrl = this.activeTabs.get(tabId)?.url || '';
        const tabStatus = this.createEmptyPageStatus(tabUrl);
        tabStatus.frames.set(0, {
            scanId: `${Date.now()}`,
            url: tabUrl,
            frameId: 0,
            moduleCounts,
            visualFindings: this.normalizeVisualFindings(
                response?.results?.[VISUAL_MANIPULATION_MODULE_ID]?.findings
            ),
            linkFindings: this.normalizeLinkFindings(
                response?.results?.[LINK_DOMAIN_SECURITY_MODULE_ID]?.findings
            ),
            linkRevision: this.normalizeRevision(
                response?.results?.[LINK_DOMAIN_SECURITY_MODULE_ID]?.revision
                    ?? response?.results?.[LINK_DOMAIN_SECURITY_MODULE_ID]?.stats?.scanRevision
            ),
            promptSplittingFindings: this.normalizePromptSplittingFindings(
                response?.results?.[PROMPT_SPLITTING_MODULE_ID]?.findings
            ),
            promptSplittingRevision: this.normalizeRevision(
                response?.results?.[PROMPT_SPLITTING_MODULE_ID]?.revision
                    ?? response?.results?.[PROMPT_SPLITTING_MODULE_ID]?.stats?.scanRevision
            ),
            linkFindingsTruncated: response?.results?.[LINK_DOMAIN_SECURITY_MODULE_ID]?.findingsTruncated === true,
            promptSplittingFindingsTruncated: response?.results?.[PROMPT_SPLITTING_MODULE_ID]?.findingsTruncated === true,
            triggerFindings: this.normalizeTriggerFindings(
                response?.results?.[TRIGGER_PHRASES_MODULE_ID]?.findings
            ),
            triggerRevision: this.normalizeRevision(
                response?.results?.[TRIGGER_PHRASES_MODULE_ID]?.revision
                    ?? response?.results?.[TRIGGER_PHRASES_MODULE_ID]?.stats?.findingRevision
            ),
            partialModules: this.normalizePartialModules(
                Object.entries(response?.results || {})
                    .filter(([, result]) => result?.partialResult === true || result?.stats?.partialResult === true)
                    .map(([moduleId]) => moduleId)
            ),
            totalFindings,
            status: totalFindings > 0 ? 'issues' : 'clean',
            timestamp: Date.now()
        });
        tabStatus.totalFindings = totalFindings;
        tabStatus.status = totalFindings > 0 ? 'issues' : 'clean';
        tabStatus.stale = false;
        tabStatus.updatedAt = Date.now();

        this.pageStatusByTab.set(tabId, tabStatus);
        this.applyIndicatorForTab(tabId);
        this.schedulePageStatusCacheWrite();
    }

    getPageStatusSettings() {
        const settings = this.config?.settings || {};
        return {
            rescanOnNavigation: settings.pageStatusRescanOnNavigation !== false,
            snapshotMode: settings.pageStatusSnapshotMode !== false,
            trackByFrame: settings.pageStatusTrackByFrame !== false,
            dedupeByFrameSnapshot: settings.pageStatusDedupeByFrameSnapshot !== false
        };
    }

    isScannableUrl(url) {
        return typeof url === 'string' && /^https?:\/\//i.test(url);
    }

    createEmptyPageStatus(url = '') {
        return {
            url,
            status: 'clean',
            totalFindings: 0,
            frames: new Map(),
            stale: true,
            updatedAt: Date.now()
        };
    }

    resetPageStatusForTab(tabId, url = '') {
        this.pageStatusByTab.set(tabId, this.createEmptyPageStatus(url));
        this.schedulePageStatusCacheWrite();
    }

    async restorePageStatusCache() {
        if (!chrome.storage?.session) {
            return;
        }

        try {
            const stored = await chrome.storage.session.get(PAGE_STATUS_SESSION_KEY);
            const cache = stored?.[PAGE_STATUS_SESSION_KEY];
            if (!cache
                || typeof cache !== 'object'
                || cache.schemaVersion !== PAGE_STATUS_CACHE_SCHEMA_VERSION
                || !cache.tabs
                || typeof cache.tabs !== 'object') {
                return;
            }

            for (const [rawTabId, cachedStatus] of Object.entries(cache.tabs)) {
                const tabId = Number.parseInt(rawTabId, 10);
                if (!Number.isInteger(tabId) || !cachedStatus || typeof cachedStatus !== 'object') {
                    continue;
                }

                const frames = new Map();
                for (const snapshot of Array.isArray(cachedStatus.frames) ? cachedStatus.frames.slice(0, 1) : []) {
                    if (!snapshot || !Number.isInteger(snapshot.frameId)) {
                        continue;
                    }
                    frames.set(snapshot.frameId, {
                        ...snapshot,
                        visualFindings: this.normalizeVisualFindings(snapshot.visualFindings),
                        linkFindings: this.normalizeLinkFindings(snapshot.linkFindings),
                        linkRevision: this.normalizeRevision(snapshot.linkRevision),
                        linkFindingsTruncated: snapshot.linkFindingsTruncated === true,
                        promptSplittingFindings: this.normalizePromptSplittingFindings(snapshot.promptSplittingFindings),
                        promptSplittingRevision: this.normalizeRevision(snapshot.promptSplittingRevision),
                        promptSplittingFindingsTruncated: snapshot.promptSplittingFindingsTruncated === true,
                        triggerFindings: this.normalizeTriggerFindings(snapshot.triggerFindings),
                        triggerRevision: this.normalizeRevision(snapshot.triggerRevision),
                        partialModules: this.normalizePartialModules(snapshot.partialModules)
                    });
                }

                this.pageStatusByTab.set(tabId, {
                    url: '',
                    urlIdentity: typeof cachedStatus.urlIdentity === 'string' ? cachedStatus.urlIdentity : '',
                    status: cachedStatus.status === 'issues' ? 'issues' : 'clean',
                    totalFindings: Number.isFinite(cachedStatus.totalFindings)
                        ? Math.max(0, Math.trunc(cachedStatus.totalFindings))
                        : 0,
                    frames,
                    stale: cachedStatus.stale === true,
                    updatedAt: Number.isFinite(cachedStatus.updatedAt) ? cachedStatus.updatedAt : 0
                });
            }
        } catch (error) {
            Logger.warn('Failed to restore page status session cache:', error);
        }
    }

    schedulePageStatusCacheWrite() {
        if (!chrome.storage?.session || this.pageStatusCacheWriteTimer !== null) {
            return;
        }

        this.pageStatusCacheWriteTimer = setTimeout(() => {
            this.pageStatusCacheWriteTimer = null;
            this.persistPageStatusCache();
        }, PAGE_STATUS_CACHE_WRITE_DELAY_MS);
    }

    async persistPageStatusCache() {
        if (!chrome.storage?.session) {
            return;
        }

        const tabs = {};
        for (const [tabId, status] of this.pageStatusByTab.entries()) {
            tabs[String(tabId)] = {
                urlIdentity: this.getCacheUrlIdentity(status.url),
                status: status.status,
                totalFindings: status.totalFindings,
                stale: status.stale === true,
                updatedAt: status.updatedAt,
                frames: Array.from(status.frames.values()).slice(0, 1).map((snapshot) => ({
                    scanId: String(snapshot.scanId || ''),
                    urlIdentity: this.getCacheUrlIdentity(snapshot.url),
                    frameId: Number.isInteger(snapshot.frameId) ? snapshot.frameId : 0,
                    moduleCounts: snapshot.moduleCounts && typeof snapshot.moduleCounts === 'object'
                        ? snapshot.moduleCounts
                        : {},
                    visualFindings: Array.isArray(snapshot.visualFindings)
                        ? snapshot.visualFindings.slice(0, 10)
                        : [],
                    linkFindings: this.normalizeLinkFindings(snapshot.linkFindings),
                    linkRevision: this.normalizeRevision(snapshot.linkRevision),
                    linkFindingsTruncated: snapshot.linkFindingsTruncated === true,
                    promptSplittingFindings: this.normalizePromptSplittingFindings(snapshot.promptSplittingFindings),
                    promptSplittingRevision: this.normalizeRevision(snapshot.promptSplittingRevision),
                    promptSplittingFindingsTruncated: snapshot.promptSplittingFindingsTruncated === true,
                    triggerFindings: this.normalizeTriggerFindings(snapshot.triggerFindings),
                    triggerRevision: this.normalizeRevision(snapshot.triggerRevision),
                    partialModules: this.normalizePartialModules(snapshot.partialModules),
                    // Перезапуск service worker не должен превращать «страница снимала наши метки»
                    // и «эту вкладку смотрит автоматизированный браузер» в отсутствие сигнала.
                    context: this.normalizePageContext(snapshot.context),
                    intervention: this.normalizeInterventionReport(snapshot.intervention),
                    totalFindings: Number.isFinite(snapshot.totalFindings)
                        ? Math.max(0, Math.trunc(snapshot.totalFindings))
                        : 0,
                    status: snapshot.status === 'issues' ? 'issues' : 'clean',
                    timestamp: Number.isFinite(snapshot.timestamp) ? snapshot.timestamp : 0
                }))
            };
        }

        try {
            await chrome.storage.session.set({
                [PAGE_STATUS_SESSION_KEY]: {
                    schemaVersion: PAGE_STATUS_CACHE_SCHEMA_VERSION,
                    tabs
                }
            });
        } catch (error) {
            Logger.warn('Failed to persist page status session cache:', error);
        }
    }

    // C4: контекст страницы приходит из content-скрипта, то есть из контекста страницы, и
    // нормализуется так же строго, как всё остальное оттуда: три известных поля, флаг и два числа.
    normalizePageContext(context) {
        if (!context || typeof context !== 'object') {
            return null;
        }
        const count = (value) => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);
        return {
            automation: context.automation === true,
            longTasksObserved: count(context.longTasksObserved),
            sliceBackoffSteps: count(context.sliceBackoffSteps),
            framesPresent: Math.min(count(context.framesPresent), 100),
            framesAnalyzed: Math.min(count(context.framesAnalyzed), 100),
            scanBudgetExhausted: context.scanBudgetExhausted === true,
            lastScanActiveMs: Number.isFinite(context.lastScanActiveMs)
                ? Math.max(0, Math.round(context.lastScanActiveMs * 100) / 100)
                : 0
        };
    }

    // C4.4: отчёт слоя вмешательства приходит из content-скрипта, то есть из контекста страницы, -
    // поэтому нормализуется так же строго, как находки: только known-поля, только числа и наш
    // собственный словарь типов находок. Ни узлов, ни текста страницы здесь быть не может.
    normalizeInterventionReport(report) {
        if (!report || typeof report !== 'object') {
            return null;
        }
        const count = (value) => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);
        return {
            enabled: report.enabled === true,
            action: ['annotate', 'reveal', 'neutralize'].includes(report.action) ? report.action : 'annotate',
            appliedEdits: count(report.appliedEdits),
            annotationsApplied: count(report.annotationsApplied),
            revealsApplied: count(report.revealsApplied),
            neutralizationsApplied: count(report.neutralizationsApplied),
            tamperedEdits: count(report.tamperedEdits),
            tamperedFindingTypes: Array.isArray(report.tamperedFindingTypes)
                ? report.tamperedFindingTypes
                    .filter((type) => typeof type === 'string')
                    .slice(0, 8)
                    .map((type) => type.slice(0, 96))
                : [],
            intentionsDropped: count(report.intentionsDropped)
        };
    }

    handlePageStatusUpdate(data, sender) {
        const tabId = sender?.tab?.id;
        if (!tabId) {
            return { success: false, error: 'Missing tab context for pageStatusUpdate' };
        }
        if (sender?.frameId !== 0) {
            return { success: true, skipped: 'non-main-frame' };
        }

        const senderUrl = sender?.tab?.url || '';
        const payloadUrl = typeof data?.url === 'string' ? data.url : '';
        const effectiveUrl = payloadUrl || senderUrl;
        if (!this.isScannableUrl(effectiveUrl)) {
            this.resetPageStatusForTab(tabId, effectiveUrl);
            this.applyIndicatorForTab(tabId);
            return { success: true, tabId, totalFindings: 0, status: 'clean' };
        }

        const settings = this.getPageStatusSettings();
        if (!settings.snapshotMode) {
            return { success: true, tabId, skipped: 'snapshot-mode-disabled' };
        }

        const frameKey = settings.trackByFrame
            ? (Number.isInteger(sender?.frameId) ? sender.frameId : 0)
            : 0;

        const incomingCounts = data?.moduleCounts && typeof data.moduleCounts === 'object'
            ? data.moduleCounts
            : {};
        const moduleCounts = {};
        let computedTotal = 0;
        for (const [moduleId, rawCount] of Object.entries(incomingCounts)) {
            const normalizedCount = Number.isFinite(rawCount)
                ? Math.max(0, Math.trunc(rawCount))
                : 0;
            moduleCounts[moduleId] = normalizedCount;
            computedTotal += normalizedCount;
        }

        const payloadTotal = Number.isFinite(data?.totalFindings)
            ? Math.max(0, Math.trunc(data.totalFindings))
            : computedTotal;
        const visualFindings = this.normalizeVisualFindings(data?.visualFindings);
        const linkFindings = this.normalizeLinkFindings(data?.linkFindings);
        const linkRevision = this.normalizeRevision(data?.linkRevision);
        const promptSplittingFindings = this.normalizePromptSplittingFindings(data?.promptSplittingFindings);
        const promptSplittingRevision = this.normalizeRevision(data?.promptSplittingRevision);
        const linkFindingsTruncated = data?.linkFindingsTruncated === true;
        const promptSplittingFindingsTruncated = data?.promptSplittingFindingsTruncated === true;
        const triggerFindings = this.normalizeTriggerFindings(data?.triggerFindings);
        const triggerRevision = this.normalizeRevision(data?.triggerRevision);
        const partialModules = this.normalizePartialModules(data?.partialModules);

        const normalizedSnapshot = {
            scanId: String(data?.scanId || `${Date.now()}`),
            url: effectiveUrl,
            frameId: frameKey,
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
            context: this.normalizePageContext(data?.context),
            intervention: this.normalizeInterventionReport(data?.intervention),
            totalFindings: payloadTotal,
            status: payloadTotal > 0 ? 'issues' : 'clean',
            timestamp: Number.isFinite(data?.timestamp) ? data.timestamp : Date.now()
        };

        const tabStatus = this.pageStatusByTab.get(tabId) || this.createEmptyPageStatus(effectiveUrl);
        const previousSnapshot = tabStatus.frames.get(frameKey);

        if (!settings.dedupeByFrameSnapshot && previousSnapshot) {
            const mergedCounts = { ...(previousSnapshot.moduleCounts || {}) };
            for (const [moduleId, count] of Object.entries(moduleCounts)) {
                mergedCounts[moduleId] = (mergedCounts[moduleId] || 0) + count;
            }
            normalizedSnapshot.moduleCounts = mergedCounts;
            normalizedSnapshot.totalFindings = Math.max(0, previousSnapshot.totalFindings + normalizedSnapshot.totalFindings);
            normalizedSnapshot.status = normalizedSnapshot.totalFindings > 0 ? 'issues' : 'clean';
        }

        tabStatus.url = effectiveUrl;
        tabStatus.frames.set(frameKey, normalizedSnapshot);

        let totalFindings = 0;
        for (const frameSnapshot of tabStatus.frames.values()) {
            const count = Number.isFinite(frameSnapshot?.totalFindings)
                ? Math.max(0, Math.trunc(frameSnapshot.totalFindings))
                : 0;
            totalFindings += count;
        }

        tabStatus.totalFindings = totalFindings;
        tabStatus.status = totalFindings > 0 ? 'issues' : 'clean';
        tabStatus.stale = false;
        tabStatus.updatedAt = Date.now();

        this.pageStatusByTab.set(tabId, tabStatus);
        this.applyIndicatorForTab(tabId);
        this.schedulePageStatusCacheWrite();

        return {
            success: true,
            tabId,
            frameId: frameKey,
            totalFindings: tabStatus.totalFindings,
            status: tabStatus.status
        };
    }

    normalizeVisualFindings(findings) {
        return Array.isArray(findings)
            ? findings.slice(0, 10).map((finding) => ({
                type: typeof finding?.type === 'string' ? finding.type.slice(0, 96) : 'unknown',
                summary: typeof finding?.summary === 'string' ? finding.summary.slice(0, 300) : '',
                details: typeof finding?.details === 'string' ? finding.details.slice(0, 600) : '',
                severity: ['low', 'medium', 'high', 'critical'].includes(finding?.severity)
                    ? finding.severity
                    : 'medium',
                detector: typeof finding?.detector === 'string' ? finding.detector.slice(0, 96) : 'unknown'
            }))
            : [];
    }

    normalizeLinkFindings(findings) {
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

    normalizePromptSplittingFindings(findings) {
        return Array.isArray(findings)
            ? findings.slice(0, 10).map((finding) => ({
                type: typeof finding?.type === 'string' ? finding.type.slice(0, 96) : 'prompt-splitting',
                summary: typeof finding?.summary === 'string' ? finding.summary.slice(0, 300) : ''
            }))
            : [];
    }

    normalizeTriggerFindings(findings) {
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

    normalizePartialModules(moduleIds) {
        return Array.isArray(moduleIds)
            ? [...new Set(moduleIds
                .filter((moduleId) => typeof moduleId === 'string')
                .map((moduleId) => moduleId.slice(0, 128)))]
                .slice(0, 16)
            : [];
    }

    normalizeRevision(revision) {
        return Number.isFinite(revision) ? Math.max(0, Math.trunc(revision)) : 0;
    }

    getCacheUrlIdentity(url) {
        try {
            const parsed = new URL(url);
            return `${parsed.origin}${parsed.pathname}`.slice(0, 2048);
        } catch {
            return '';
        }
    }

    getBadgeText(totalFindings) {
        if (totalFindings <= 0) {
            return '';
        }

        if (totalFindings > 99) {
            return '99+';
        }

        return String(totalFindings);
    }

    applyIndicatorForTab(tabId) {
        const pageStatus = this.pageStatusByTab.get(tabId) || this.createEmptyPageStatus();
        const badgeText = this.getBadgeText(pageStatus.totalFindings);

        chrome.action.setBadgeText({
            tabId,
            text: badgeText
        }).catch(() => {});

        chrome.action.setBadgeBackgroundColor({
            tabId,
            color: '#d93025'
        }).catch(() => {});

        if (typeof chrome.action.setBadgeTextColor === 'function') {
            chrome.action.setBadgeTextColor({
                tabId,
                color: '#ffffff'
            }).catch(() => {});
        }
    }

    getTabModules(tabId) {
        const tabInfo = this.activeTabs.get(tabId);
        return tabInfo ? tabInfo.modules : [];
    }

    getStats() {
        return {
            activeTabs: this.activeTabs.size,
            foregroundTabId: this.foregroundTabId,
            focusedWindowId: this.focusedWindowId,
            totalModules: Object.keys(this.config.modules).length,
            enabledModules: Object.values(this.config.modules).filter(m => m.enabled).length,
            tabInfo: Object.fromEntries(this.activeTabs),
            pageStatusByTab: Object.fromEntries(
                Array.from(this.pageStatusByTab.entries()).map(([tabId, status]) => [
                    tabId,
                    {
                        url: status.url,
                        status: status.status,
                        totalFindings: status.totalFindings,
                        frameCount: status.frames.size,
                        stale: status.stale === true,
                        updatedAt: status.updatedAt
                    }
                ])
            )
        };
    }

    getModuleState(moduleId) {
        const state = {
            enabled: this.config.modules[moduleId]?.enabled || false,
            config: this.config.modules[moduleId] || {}
        };
        if (moduleId === API_INTERCEPTION_MODULE_ID) {
            state.observation = this.apiResourceObserver?.getObservationState()
                || { revision: 0, status: 'unavailable', partial: true, counters: {}, overflowCounters: {} };
            state.permission = this.getApiPermissionState();
        }
        return state;
    }

    syncApiObserverForForeground(foregroundRevision = this.foregroundTransitionRevision) {
        if (!this.apiResourceObserver || !this.isForegroundTransitionCurrent(foregroundRevision)) {
            return;
        }
        const moduleConfig = this.config?.modules?.[API_INTERCEPTION_MODULE_ID] || {};
        const tabInfo = this.activeTabs.get(this.foregroundTabId);
        const canObserve = this.foregroundTabId !== null
            && this.focusedWindowId !== chrome.windows.WINDOW_ID_NONE
            && this.isScannableUrl(tabInfo?.url)
            && this.config?.settings?.autoScan !== false
            && moduleConfig.enabled === true
            && moduleConfig.monitorOnly === true
            && this.getApiPermissionState().capability === 'granted';
        // Без идентичности навигации сигнатура не менялась при переходе в той же вкладке, и
        // syncApiObserverForForeground выходил раньше apiFindingState.reset(): кандидат со страницы A
        // продолжал отдаваться в снапшоте уже на странице B, вопреки контракту «снапшоты кэшируются
        // по tab/frame + идентичность навигации» (TASKS 13.4). Выбран модуль-локальный вариант:
        // инвалидация в handleTabUpdated задела бы общий lifecycle-путь, а не только этот модуль.
        const signature = canObserve
            ? `${this.foregroundTabId}:${foregroundRevision}:${this.getCacheUrlIdentity(tabInfo?.url)}:enabled`
            : 'inactive';
        if (signature === this.apiObserverSignature) {
            return;
        }
        this.apiObserverSignature = signature;
        const revision = ++this.apiObservationRevision;
        this.apiFindingState?.reset({ navigationRevision: revision });
        if (!canObserve) {
            this.apiResourceObserver.pause(revision);
            return;
        }
        this.apiResourceObserver.activate({
            tabId: this.foregroundTabId,
            revision,
            enabled: true,
            autoScan: true,
            monitorOnly: true
        });
    }

    setupPermissionListeners() {
        if (typeof chrome.permissions?.onAdded?.addListener !== 'function'
            || typeof chrome.permissions?.onRemoved?.addListener !== 'function') {
            return;
        }
        chrome.permissions.onAdded.addListener((change) => {
            if (isApiPermissionDescriptorRelevant(change)) {
                this.reconcileApiPermissionWhenIdle();
            }
        });
        chrome.permissions.onRemoved.addListener((change) => {
            if (!isApiPermissionDescriptorRelevant(change)) {
                return;
            }
            this.invalidateApiObserver();
            this.reconcileApiPermissionWhenIdle();
        });
    }

    // Chrome поднимает permissions.onAdded РАНЬШЕ, чем до нас доходит apiPermissionCommit. Слушатель
    // звал reconcile(), первый оператор которого - ++revision, поэтому: (а) транзакция включения
    // становилась устаревшей и commitDesiredEnabled(true) не выполнялся, (б) тот же reconcile видел
    // desiredEnabled === false (commit-то не отработал) при capability === 'granted' и немедленно
    // вызывал permissions.remove() - каждая попытка включения выдавала разрешение и тут же сама его
    // отзывала. Тем же механизмом disable() рапортовал stale на фактически успешном отключении и
    // пользователь видел ошибку вместо успеха (TASKS 13.1 и 13.3).
    // Гейт по образцу handleConfigChange, но событие НЕ отбрасывается: reconcile откладывается до
    // конца транзакции, иначе гейт превратился бы в игнорирование настоящего внешнего отзыва
    // разрешения.
    reconcileApiPermissionWhenIdle() {
        if (this.getApiPermissionState().transaction !== 'idle') {
            this.apiPermissionReconcilePending = true;
            return Promise.resolve();
        }
        this.apiPermissionReconcilePending = false;
        return (this.apiPermissionCoordinator?.reconcile() || Promise.resolve()).catch(() => {});
    }

    // Вызывается после завершения транзакции: отложенное событие обязано доехать.
    flushPendingApiPermissionReconcile() {
        if (!this.apiPermissionReconcilePending) {
            return Promise.resolve();
        }
        return this.reconcileApiPermissionWhenIdle();
    }

    invalidateApiObserver() {
        this.apiObserverSignature = '';
        const revision = ++this.apiObservationRevision;
        this.apiFindingState?.reset({ navigationRevision: revision });
        this.apiResourceObserver?.pause(revision);
    }

    applyApiObservationBatch(observations, context) {
        const navigationRevision = context?.sessionRevision;
        try {
            const decisions = observations
                .map((observation) => evaluateImageMimeObservation(observation))
                .filter(Boolean);
            this.apiFindingState?.applyDecisions(decisions, {
                navigationRevision,
                partial: context?.partial === true
            });
        } catch (error) {
            this.apiFindingState?.applyDecisions([], {
                navigationRevision,
                partial: true
            });
            throw error;
        }
    }

    // Одно сохранение конфигурации поднимает storage.onChanged дважды (ключ пишется и в sync, и в
    // local), а одно переключение модуля в popup сохраняется ещё и в самом popup - до четырёх
    // событий на одно нажатие, и раньше каждое из них шло в полное переприменение по ВСЕМ вкладкам
    // (сброс page status и очистка бейджа на каждой). Стоимость умножалась и на число вкладок, и на
    // четыре - при том, что проект уже имел инцидент с фризом на 54 вкладках (TASKS C6.5).
    // События схлопываются: пока обработка идёт, новые лишь поднимают флаг, и после неё выполняется
    // ровно один догоняющий проход.
    handleConfigChange({ area } = {}) {
        if (area === 'sync') {
            this.foreignSyncChangeSeen = true;
        }
        this.configChangePending = true;

        if (this.configChangeInFlight) {
            return this.configChangeInFlight;
        }

        this.configChangeInFlight = (async () => {
            try {
                while (this.configChangePending) {
                    this.configChangePending = false;
                    await this.applyConfigChange();
                }
            } finally {
                this.configChangeInFlight = null;
            }
        })();

        return this.configChangeInFlight;
    }

    async applyConfigChange() {
        // Появление ЧУЖОГО значения в sync снимает признак «авторитетен local»: без этого один
        // отказ записи в sync навсегда отрезал бы устройство от синхронизации (TASKS C6.3).
        // Признак «чужое» здесь консервативный: если своей отложенной записи нет, значение в sync
        // не старше нашего. Конфликт двух устройств MVP разрешает как «последний писавший в sync
        // выигрывает».
        if (this.foreignSyncChangeSeen && ConfigManager.pendingSyncConfig === null) {
            this.foreignSyncChangeSeen = false;
            await ConfigManager.releaseLocalAuthoritative();
        }

        const oldConfig = this.config;
        this.config = await ConfigManager.refreshConfig();

        // Второй рубеж того же контракта: событие, не несущее изменения содержимого, дальше не идёт.
        if (JSON.stringify(oldConfig) === JSON.stringify(this.config)) {
            Logger.debug('Configuration event carried no change - reapply skipped');
            return;
        }

        Logger.info('Configuration changed externally');
        await this.applyConfigToAllTabs(oldConfig, this.config);
        if (this.getApiPermissionState().transaction === 'idle') {
            await this.apiPermissionCoordinator?.reconcile();
        }

        for (const tabId of this.pageStatusByTab.keys()) {
            this.applyIndicatorForTab(tabId);
        }
    }

    async restoreActiveTabs() {
        try {
            const tabs = await chrome.tabs.query({});
            const restoredTabIds = new Set();

            for (const tab of tabs) {
                if (this.isScannableUrl(tab.url)) {
                    restoredTabIds.add(tab.id);
                    this.activeTabs.set(tab.id, {
                        url: tab.url,
                        modules: [],
                        lastUpdated: Date.now()
                    });

                    const cachedStatus = this.pageStatusByTab.get(tab.id);
                    if (!cachedStatus || cachedStatus.urlIdentity !== this.getCacheUrlIdentity(tab.url)) {
                        this.resetPageStatusForTab(tab.id, tab.url);
                    } else {
                        cachedStatus.url = tab.url;
                        delete cachedStatus.urlIdentity;
                        for (const snapshot of cachedStatus.frames.values()) {
                            snapshot.url = tab.url;
                            delete snapshot.urlIdentity;
                        }
                    }
                    this.applyIndicatorForTab(tab.id);
                }
            }

            for (const cachedTabId of this.pageStatusByTab.keys()) {
                if (!restoredTabIds.has(cachedTabId)) {
                    this.pageStatusByTab.delete(cachedTabId);
                }
            }
            this.schedulePageStatusCacheWrite();

            Logger.info(`Restored metadata for ${this.activeTabs.size} scannable tabs without starting detectors`);

        } catch (error) {
            Logger.error('Error restoring active tabs:', error);
        }
    }

    showWelcomeNotification() {
        try {
            chrome.notifications.create('welcome-notification', {
                type: 'basic',
                iconUrl: chrome.runtime.getURL('assets/icons/icon-128.png'),
                title: chrome.i18n.getMessage('extName'),
                message: chrome.i18n.getMessage('welcomeMessage'),
                priority: 1
            });

            setTimeout(() => {
                chrome.notifications.clear('welcome-notification');
            }, 10000);

        } catch (error) {
            Logger.error('Failed to show welcome notification:', error);
        }
    }

    initializeFirstRun() {
        Logger.info('Performing first-run initialization');
    }

    handleUpdate(previousVersion) {
        Logger.info(`Handling update from ${previousVersion}`);
    }

    async healthCheck() {
        return {
            status: 'healthy',
            activeTabs: this.activeTabs.size,
            configLoaded: !!this.config,
            timestamp: Date.now()
        };
    }
}

const backgroundManager = globalThis.__PAGECHECK_BACKGROUND_TEST__ === true
    ? null
    : new BackgroundManager();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { BackgroundManager };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'healthCheck' && backgroundManager) {
        backgroundManager.healthCheck().then(sendResponse);
        return true;
    }
});
