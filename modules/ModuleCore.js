// modules/ModuleCore.js
import { Logger } from '../utils/logger.js';

export default class ModuleCore {
    constructor(moduleName, defaultEnabled = true) {
        this.moduleName = moduleName;
        this.isEnabled = defaultEnabled;
        this.observer = null;
        this.usesMutationObserver = false;
        this.isInitialized = false;
        this.lifecycleRevision = 0;
        this.initializationPromise = null;
        this.config = {};
        this.stats = {
            elementsScanned: 0,
            threatsDetected: 0,
            lastScanTime: 0,
            totalScanTime: 0
        };
        this.lastMutationTime = 0;
        this.mutationThrottle = 100; // ms
        this.observerConfig = {
            childList: true,
            subtree: true,
            attributes: false,
            characterData: false,
            attributeOldValue: false,
            characterDataOldValue: false
        };
    }

    // Инициализация модуля
    async init() {
        if (!this.isEnabled) {
            Logger.debug(`[${this.moduleName}] Module disabled, skipping initialization`);
            return false;
        }

        if (this.initializationPromise) {
            return this.initializationPromise;
        }

        const lifecycleRevision = ++this.lifecycleRevision;
        this.isInitialized = false;
        const initializationPromise = (async () => {
            try {
                Logger.info(`[${this.moduleName}] Initializing module`);

                await this.beforeInit();
                if (!this.isEnabled || lifecycleRevision !== this.lifecycleRevision) {
                    return false;
                }

                if (this.usesMutationObserver) {
                    this.setupMutationObserver();
                }
                await this.firstScan();
                if (!this.isEnabled || lifecycleRevision !== this.lifecycleRevision) {
                    return false;
                }

                await this.afterInit();
                if (!this.isEnabled || lifecycleRevision !== this.lifecycleRevision) {
                    return false;
                }

                this.isInitialized = true;
                Logger.info(`[${this.moduleName}] Module initialized successfully`);
                return true;

            } catch (error) {
                Logger.error(`[${this.moduleName}] Failed to initialize:`, error);
                if (lifecycleRevision === this.lifecycleRevision) {
                    this.destroy();
                }
                return false;
            }
        })();

        this.initializationPromise = initializationPromise;

        try {
            return await initializationPromise;
        } finally {
            if (this.initializationPromise === initializationPromise) {
                this.initializationPromise = null;
            }
        }
    }

    // Хук перед инициализацией
    async beforeInit() {
        // Переопределить в дочерних классах
    }

    // Хук после инициализации
    async afterInit() {
        // Переопределить в дочерних классах
    }

    // Настройка наблюдателя за DOM
    setupMutationObserver() {
        try {
            if (!this.usesMutationObserver) {
                if (this.observer) {
                    this.observer.takeRecords();
                    this.observer.disconnect();
                    this.observer = null;
                }
                Logger.debug(`[${this.moduleName}] MutationObserver skipped: explicit opt-in is required`);
                return;
            }

            if (this.observer) {
                this.observer.disconnect();
            }
            this.observer = new MutationObserver(this.handleMutations.bind(this));
            this.observer.observe(document.documentElement, this.observerConfig);

            Logger.debug(`[${this.moduleName}] MutationObserver setup completed`);

        } catch (error) {
            Logger.error(`[${this.moduleName}] Failed to setup MutationObserver:`, error);
        }
    }

    // Обработка мутаций по умолчанию отключена
    handleMutations(mutations) {
        // Safe default: subclasses must provide their own bounded mutation pipeline.
    }

    // Проверка релевантности мутации
    isRelevantMutation(mutation) {
        return false;
    }

    // Базовая обработка конкретной мутации отключена
    processMutation(mutation) {
        // Safe default: never traverse added subtrees implicitly.
    }

    // Хук после обработки мутаций
    onMutationsProcessed(mutations) {
        // Переопределить в дочерних классах
        Logger.debug(`[${this.moduleName}] Processed ${mutations.length} mutations`);
    }

    // Первичное сканирование по умолчанию отключено
    async firstScan() {
        Logger.debug(`[${this.moduleName}] Initial scan skipped: subclass must provide a bounded implementation`);
    }

    // Базовое сканирование отдельного элемента отключено
    scanElement(element) {
        // Safe default: subclasses decide what constitutes a bounded scan unit.
    }

    // Включение/выключение модуля
    async setEnabled(state) {
        if (this.isEnabled === state) return;

        this.isEnabled = state;
        Logger.info(`[${this.moduleName}] Module ${state ? 'enabled' : 'disabled'}`);

        if (state) {
            await this.init();
        } else {
            this.destroy();
        }

        // Отправляем событие о изменении состояния
        this.dispatchEvent('moduleStateChanged', {
            module: this.moduleName,
            enabled: state
        });
    }

    // Остановка модуля
    destroy() {
        this.lifecycleRevision += 1;
        this.isEnabled = false;
        this.isInitialized = false;

        try {
            if (this.observer) {
                this.observer.takeRecords();
                this.observer.disconnect();
                this.observer = null;
            }

            this.onDestroy();
            Logger.info(`[${this.moduleName}] Module destroyed`);

        } catch (error) {
            Logger.error(`[${this.moduleName}] Error during destruction:`, error);
        }
    }

    // Хук при уничтожении модуля
    onDestroy() {
        // Переопределить в дочерних классах для cleanup
    }

    // Обновление конфигурации
    updateConfig(newConfig) {
        const oldConfig = { ...this.config };
        this.config = { ...this.config, ...newConfig };

        Logger.debug(`[${this.moduleName}] Config updated`, {
            changedFields: [...new Set([
                ...Object.keys(oldConfig),
                ...Object.keys(this.config)
            ])].sort()
        });

        const updateResult = this.onConfigUpdate(oldConfig, this.config);

        // Отправляем событие о изменении конфигурации
        this.dispatchEvent('configUpdated', {
            module: this.moduleName,
            config: this.config
        });

        return updateResult && typeof updateResult === 'object'
            ? updateResult
            : { requiresDetectionRefresh: false };
    }

    // Хук при обновлении конфигурации
    onConfigUpdate(oldConfig, newConfig) {
        // May return { requiresDetectionRefresh: boolean } for the content lifecycle.
    }

    // Получение статистики
    getStats() {
        return {
            ...this.stats,
            module: this.moduleName,
            enabled: this.isEnabled,
            config: this.config
        };
    }

    // Сброс статистики
    resetStats() {
        this.stats = {
            elementsScanned: 0,
            threatsDetected: 0,
            lastScanTime: 0,
            totalScanTime: 0
        };
        Logger.debug(`[${this.moduleName}] Statistics reset`);
    }

    // Система событий для межмодульного взаимодействия
    eventHandlers = new Map();

    // Подписка на события
    on(eventName, handler) {
        if (!this.eventHandlers.has(eventName)) {
            this.eventHandlers.set(eventName, new Set());
        }
        this.eventHandlers.get(eventName).add(handler);
    }

    // Отписка от событий
    off(eventName, handler) {
        if (this.eventHandlers.has(eventName)) {
            this.eventHandlers.get(eventName).delete(handler);
        }
    }

    // Отправка события
    dispatchEvent(eventName, data) {
        if (this.eventHandlers.has(eventName)) {
            this.eventHandlers.get(eventName).forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    Logger.error(`[${this.moduleName}] Error in event handler for ${eventName}:`, error);
                }
            });
        }
    }

    // Утилита для безопасного выполнения
    async executeSafely(operationName, operation) {
        try {
            return await operation();
        } catch (error) {
            Logger.error(`[${this.moduleName}] Error in ${operationName}:`, error);
            return null;
        }
    }

    // Проверка, активен ли модуль
    isActive() {
        return this.isEnabled
            && this.isInitialized
            && (!this.usesMutationObserver || this.observer !== null);
    }
}
