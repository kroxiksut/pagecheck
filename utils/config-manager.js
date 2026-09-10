import { Logger } from './logger.js';

import { extensionStorage } from '../platform/browser.js';

const MODULE_IDS = {
    VISUAL_MANIPULATION: 'Hidden-Content-Visual-Manipulation',
    LINK_DOMAIN_SECURITY: 'Link-Domain-Security',
    TRIGGER_PHRASES: 'Trigger-Phrases',
    PROMPT_SPLITTING: 'Prompt-Splitting',
    API_INTERCEPTOR: 'Api-Interceptor'
};
export const CONFIG_STORAGE_KEYS = {
    EXTENSION_CONFIG: 'extensionConfig',
    TRIGGER_PHRASES_CUSTOM_PATTERNS: 'pagecheck.triggerPhrases.customPatterns.v1',
    // Признак «последняя запись конфигурации ушла только в local». Пишется той же local-операцией,
    // что и сам конфиг, поэтому лишней записи в storage не создаёт. Читается на холодном пути
    // getConfig и решает, какая копия авторитетна (TASKS C6.3).
    CONFIG_LOCAL_AUTHORITATIVE: 'pagecheck.config.localAuthoritative.v1'
};

const CUSTOM_PATTERN_CATALOG_VERSION = 1;
const CUSTOM_PATTERN_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const DISALLOWED_PATTERN_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u;
const MEANINGFUL_PATTERN_CHARACTER = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;
const MAX_CUSTOM_PATTERN_SOURCE_LENGTH = 4096;
const MAX_CUSTOM_PATTERN_ITEM_COUNT = 500;
const MAX_CUSTOM_PATTERN_TOTAL_SOURCE_LENGTH = 65536;

function createEmptyCustomPatternCatalog() {
    return { version: CUSTOM_PATTERN_CATALOG_VERSION, items: [] };
}

function isPlainRecord(value) {
    return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

// Settings used to be validated by `typeof value === typeof defaultValue` alone, which is blind to
// arrays (`typeof [] === 'object'`, so any object passed). The findings API stores an allowlist of
// extension IDs there, and an allowlist that accepts malformed input is a security hole, not a
// cosmetic one - hence a per-field rule.
const SETTINGS_ARRAY_ITEM_RULES = {
    // Chrome extension IDs are exactly 32 characters from a-p.
    findingsApiAllowedExtensionIds: { pattern: /^[a-p]{32}$/, maxItems: 32 }
};

// Enum-valued settings. The intervention modes landed (TASKS C4.2/C4.3), and until this rule existed
// `activeRemediationAction` accepted ANY string: a hand-edited or corrupted profile could store
// something that is not an action at all. The runtime survived it only because InterventionLayer
// falls back to `annotate` for an unknown value - that is a last line of defence, not a reason to
// hand it garbage. Validation belongs here, where the profile is read.
// The list is duplicated on purpose: `js/intervention-layer.js` owns the runtime meaning of these
// values, but importing it here would drag DOM-facing code into the service worker and the options
// page. The shield below (`invalid-activeRemediationAction-fallback` in runConfigSmokeCheck) is what
// keeps the two copies honest.
const SETTINGS_ENUM_RULES = {
    activeRemediationAction: ['annotate', 'reveal', 'neutralize']
};

function validateSettingsValue(field, value, defaultValue) {
    if (Array.isArray(defaultValue)) {
        const rule = SETTINGS_ARRAY_ITEM_RULES[field];
        if (!rule || !Array.isArray(value)) {
            return [...defaultValue];
        }

        const seen = new Set();
        for (const item of value) {
            if (typeof item !== 'string' || !rule.pattern.test(item) || seen.has(item)) {
                continue;
            }
            if (seen.size >= rule.maxItems) {
                break;
            }
            seen.add(item);
        }
        return [...seen];
    }

    const allowedValues = SETTINGS_ENUM_RULES[field];
    if (allowedValues) {
        return allowedValues.includes(value) ? value : defaultValue;
    }

    return typeof value === typeof defaultValue ? value : defaultValue;
}

function isWellFormedUnicode(value) {
    if (typeof value.isWellFormed === 'function') {
        return value.isWellFormed();
    }
    return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

export const ConfigManager = {
    configCache: null,
    lastSaveTime: 0,
    saveDebounce: 1000,
    // Отложенная запись в sync: последнее состояние и таймер. Пока pendingSyncConfig не null,
    // авторитетной копией считается local - в sync лежит более старое значение.
    pendingSyncConfig: null,
    syncWriteTimer: null,
    localAuthoritative: null,

    async getConfig() {
        if (this.configCache) {
            return this.configCache;
        }

        // Резерв обязан читаться так же, как пишется. Раньше local писался при отказе sync, но
        // читался только если ЧТЕНИЕ sync бросило, поэтому успешное чтение устаревшего sync
        // выигрывало у свежего local и молча откатывало изменение пользователя (TASKS C6.3).
        if (await this.isLocalAuthoritative()) {
            return this.getFromLocalStorage();
        }

        try {
            const result = await extensionStorage.get('sync', CONFIG_STORAGE_KEYS.EXTENSION_CONFIG);
            const validatedConfig = this.validateConfig(result[CONFIG_STORAGE_KEYS.EXTENSION_CONFIG] || {});
            this.configCache = await this.attachCustomPatternCatalog(validatedConfig);
            return this.configCache;
        } catch (error) {
            Logger.warn('Sync storage failed, trying local storage...', error);
            return this.getFromLocalStorage();
        }
    },

    async isLocalAuthoritative() {
        if (this.pendingSyncConfig !== null) {
            return true;
        }
        if (this.localAuthoritative !== null) {
            return this.localAuthoritative;
        }
        try {
            const result = await extensionStorage.get('local', CONFIG_STORAGE_KEYS.CONFIG_LOCAL_AUTHORITATIVE);
            this.localAuthoritative = result[CONFIG_STORAGE_KEYS.CONFIG_LOCAL_AUTHORITATIVE] === true;
        } catch (error) {
            Logger.warn('Failed to read the local-authoritative flag, assuming sync:', error);
            this.localAuthoritative = false;
        }
        return this.localAuthoritative;
    },

    // Вызывается, когда в области sync появилось ЧУЖОЕ значение (другое устройство или другой
    // контекст расширения): sync снова свежий, залипший признак снимается. Без этого один отказ
    // записи в sync навсегда отрезал бы устройство от синхронизации.
    async releaseLocalAuthoritative() {
        if (this.localAuthoritative === false) {
            return;
        }
        this.localAuthoritative = false;
        try {
            await extensionStorage.remove('local', CONFIG_STORAGE_KEYS.CONFIG_LOCAL_AUTHORITATIVE);
        } catch (error) {
            Logger.warn('Failed to clear the local-authoritative flag:', error);
        }
    },

    async getFromLocalStorage() {
        try {
            const result = await extensionStorage.get('local', CONFIG_STORAGE_KEYS.EXTENSION_CONFIG);
            const validatedConfig = this.validateConfig(result[CONFIG_STORAGE_KEYS.EXTENSION_CONFIG] || {});
            this.configCache = await this.attachCustomPatternCatalog(validatedConfig);
            return this.configCache;
        } catch (error) {
            Logger.error('Local storage also failed, using default config:', error);
            this.configCache = await this.attachCustomPatternCatalog(this.getDefaultConfig());
            return this.configCache;
        }
    },

    // Раньше debounce не откладывал запись, а ВЫБРАСЫВАЛ её: вызывающему возвращался обновлённый
    // кэш, то есть сохранение выглядело успешным, а до storage не доходило ничего. Потерянное
    // состояние жило только в памяти и откатывалось при следующей выгрузке service worker
    // (TASKS C6.2). Теперь:
    //   - local пишется всегда и сразу (у него нет квоты на число записей) - это делает сохранение
    //     долговечным независимо от таймеров;
    //   - sync (квота chrome.storage.sync - 120 записей в минуту) ограничивается по частоте, но
    //     ограничение ОТКЛАДЫВАЕТ последнюю версию, а не теряет её;
    //   - пока отложенная запись не ушла, в local лежит признак «авторитетен local», поэтому даже
    //     выгрузка worker до срабатывания таймера не приводит к откату настроек.
    async saveConfig(config, immediate = false) {
        try {
            const validatedConfig = this.validateConfig(config);
            this.configCache = await this.attachCustomPatternCatalog(validatedConfig);

            this.pendingSyncConfig = validatedConfig;
            await this.saveToLocalStorage(validatedConfig, { syncPending: true });
            await this.scheduleSyncWrite(immediate);

            Logger.debug('Config saved successfully');
            return this.configCache;
        } catch (error) {
            Logger.error('Failed to save config:', error);
            throw error;
        }
    },

    scheduleSyncWrite(immediate = false) {
        const elapsed = Date.now() - this.lastSaveTime;
        if (immediate || elapsed >= this.saveDebounce) {
            return this.flushSyncWrite();
        }
        if (this.syncWriteTimer === null) {
            this.syncWriteTimer = setTimeout(() => {
                this.syncWriteTimer = null;
                this.flushSyncWrite().catch((error) => {
                    Logger.warn('Deferred sync write failed:', error);
                });
            }, this.saveDebounce - elapsed);
        }
        return Promise.resolve();
    },

    async flushSyncWrite() {
        if (this.syncWriteTimer !== null) {
            clearTimeout(this.syncWriteTimer);
            this.syncWriteTimer = null;
        }
        const config = this.pendingSyncConfig;
        if (config === null) {
            return;
        }
        this.pendingSyncConfig = null;
        this.lastSaveTime = Date.now();

        try {
            await extensionStorage.set('sync', { [CONFIG_STORAGE_KEYS.EXTENSION_CONFIG]: config });
        } catch (error) {
            // Отказ sync - не потеря настроек: копия в local уже лежит и помечена авторитетной.
            Logger.warn('Sync storage failed, the local copy stays authoritative:', error);
            return;
        }
        await this.releaseLocalAuthoritative();
    },

    async saveToLocalStorage(config, { syncPending = false } = {}) {
        // Признак пишется той же операцией, что и конфиг: одна запись в storage, одно событие
        // storage.onChanged, никакой отдельной стоимости.
        const payload = { [CONFIG_STORAGE_KEYS.EXTENSION_CONFIG]: this.validateConfig(config) };
        if (syncPending) {
            payload[CONFIG_STORAGE_KEYS.CONFIG_LOCAL_AUTHORITATIVE] = true;
            this.localAuthoritative = true;
        }
        await extensionStorage.set('local', payload);
    },

    async getCustomPatternCatalog() {
        try {
            const result = await extensionStorage.get('local', CONFIG_STORAGE_KEYS.TRIGGER_PHRASES_CUSTOM_PATTERNS);
            return this.validateCustomPatternCatalog(result[CONFIG_STORAGE_KEYS.TRIGGER_PHRASES_CUSTOM_PATTERNS]).catalog;
        } catch (error) {
            Logger.error('Local custom pattern storage failed:', error);
            return createEmptyCustomPatternCatalog();
        }
    },

    async saveCustomPatternCatalog(catalog) {
        const validation = this.validateCustomPatternCatalog(catalog);
        if (!validation.isValid) {
            throw new Error('Invalid custom pattern catalog');
        }

        await extensionStorage.set('local', {
            [CONFIG_STORAGE_KEYS.TRIGGER_PHRASES_CUSTOM_PATTERNS]: validation.catalog
        });
        this.configCache = null;
        return validation.catalog;
    },

    async attachCustomPatternCatalog(config) {
        const customPatterns = await this.getCustomPatternCatalog();
        return {
            ...config,
            modules: {
                ...config.modules,
                [MODULE_IDS.TRIGGER_PHRASES]: {
                    ...config.modules[MODULE_IDS.TRIGGER_PHRASES],
                    customPatterns
                },
                [MODULE_IDS.PROMPT_SPLITTING]: {
                    ...config.modules[MODULE_IDS.PROMPT_SPLITTING],
                    customPatterns
                }
            }
        };
    },

    async refreshConfig() {
        this.configCache = null;
        return this.getConfig();
    },

    validateCustomPatternCatalog(catalog) {
        if (!isPlainRecord(catalog) || catalog.version !== CUSTOM_PATTERN_CATALOG_VERSION || !Array.isArray(catalog.items)) {
            return { catalog: createEmptyCustomPatternCatalog(), isValid: catalog === undefined };
        }

        const ids = new Set();
        let totalSourceLength = 0;
        let acceptedItemCount = 0;
        const items = catalog.items.flatMap((item) => {
            if (!isPlainRecord(item) || acceptedItemCount >= MAX_CUSTOM_PATTERN_ITEM_COUNT) {
                return [];
            }

            const sourceLength = typeof item.source === 'string' ? Array.from(item.source).length : 0;
            if (Object.keys(item).length !== 4
                || !Object.hasOwn(item, 'id')
                || !Object.hasOwn(item, 'enabled')
                || !Object.hasOwn(item, 'mode')
                || !Object.hasOwn(item, 'source')
                || typeof item.id !== 'string'
                || !CUSTOM_PATTERN_ID_PATTERN.test(item.id)
                || ids.has(item.id)
                || typeof item.enabled !== 'boolean'
                || item.mode !== 'literal'
                || typeof item.source !== 'string'
                || item.source.trim() === ''
                || !isWellFormedUnicode(item.source)
                || DISALLOWED_PATTERN_CONTROL_PATTERN.test(item.source)
                || !MEANINGFUL_PATTERN_CHARACTER.test(item.source)
                || sourceLength > MAX_CUSTOM_PATTERN_SOURCE_LENGTH
                || totalSourceLength + sourceLength > MAX_CUSTOM_PATTERN_TOTAL_SOURCE_LENGTH) {
                return [];
            }

            ids.add(item.id);
            totalSourceLength += sourceLength;
            acceptedItemCount += 1;
            return [{ id: item.id, enabled: item.enabled, mode: 'literal', source: item.source }];
        });
        return {
            catalog: { version: CUSTOM_PATTERN_CATALOG_VERSION, items },
            isValid: true
        };
    },

    validateConfig(config) {
        const normalizedConfig = this.normalizeLegacyConfig(isPlainRecord(config) ? config : {});
        const defaultConfig = this.getDefaultConfig();
        const sourceModules = isPlainRecord(normalizedConfig.modules) ? normalizedConfig.modules : {};
        const sourceSettings = isPlainRecord(normalizedConfig.settings) ? normalizedConfig.settings : {};
        const sourceStatistics = isPlainRecord(normalizedConfig.statistics) ? normalizedConfig.statistics : {};
        const result = {
            language: Object.hasOwn(normalizedConfig, 'language') && ['auto', 'en', 'ru'].includes(normalizedConfig.language)
                ? normalizedConfig.language
                : defaultConfig.language,
            theme: Object.hasOwn(normalizedConfig, 'theme') && ['auto', 'light', 'dark'].includes(normalizedConfig.theme)
                ? normalizedConfig.theme
                : defaultConfig.theme,
            modules: {},
            settings: {},
            statistics: {}
        };

        for (const [moduleKey, defaultModuleConfig] of Object.entries(defaultConfig.modules)) {
            const sourceModuleConfig = isPlainRecord(sourceModules[moduleKey]) ? sourceModules[moduleKey] : {};
            const validatedModuleConfig = {
                name: defaultModuleConfig.name,
                description: defaultModuleConfig.description
            };

            for (const [field, defaultValue] of Object.entries(defaultModuleConfig)) {
                if (field === 'name' || field === 'description') {
                    continue;
                }

                const value = Object.hasOwn(sourceModuleConfig, field)
                    ? sourceModuleConfig[field]
                    : defaultValue;
                const hasExpectedType = typeof defaultValue === 'number'
                    ? Number.isFinite(value)
                    : typeof value === typeof defaultValue;
                const hasValidEnum = (field !== 'sensitivity' || ['low', 'medium', 'high'].includes(value))
                    && (field !== 'actionOnDetect' || ['log', 'notify', 'block'].includes(value))
                    && (field !== 'hiddenTextDisplayMode' || ['self', 'ancestors'].includes(value))
                    && (field !== 'detectionThreshold' || value >= 0 && value <= 1);

                validatedModuleConfig[field] = hasExpectedType && hasValidEnum ? value : defaultValue;
            }

            result.modules[moduleKey] = validatedModuleConfig;
        }

        for (const [field, defaultValue] of Object.entries(defaultConfig.settings)) {
            const value = Object.hasOwn(sourceSettings, field) ? sourceSettings[field] : defaultValue;
            result.settings[field] = validateSettingsValue(field, value, defaultValue);
        }

        for (const [field, defaultValue] of Object.entries(defaultConfig.statistics)) {
            const value = Object.hasOwn(sourceStatistics, field) ? sourceStatistics[field] : defaultValue;
            const isValidValue = typeof defaultValue === 'number'
                ? Number.isFinite(value) && value >= 0
                : defaultValue === null
                    ? value === null || typeof value === 'string'
                    : typeof value === typeof defaultValue;
            result.statistics[field] = isValidValue ? value : defaultValue;
        }

        return result;
    },

    normalizeLegacyConfig(config = {}) {
        const sourceConfig = isPlainRecord(config) ? config : {};
        const sourceModules = isPlainRecord(sourceConfig.modules) ? sourceConfig.modules : {};
        const normalized = {
            ...sourceConfig,
            modules: { ...sourceModules }
        };

        const legacyVisual = normalized.modules['CSS-Sanitizer'];
        if (isPlainRecord(legacyVisual)) {
            normalized.modules[MODULE_IDS.VISUAL_MANIPULATION] = {
                enabled: legacyVisual.enabled,
                scanInterval: legacyVisual.scanInterval,
                sensitivity: legacyVisual.sensitivity,
                hiddenTextDisplayMode: legacyVisual.hiddenTextDisplayMode,
                trackRemovedBlocks: legacyVisual.trackRemovedBlocks,
                ...normalized.modules[MODULE_IDS.VISUAL_MANIPULATION]
            };
            delete normalized.modules['CSS-Sanitizer'];
        }

        const legacyLinkSecurity = normalized.modules['Homograph-Detector'];
        if (isPlainRecord(legacyLinkSecurity)) {
            normalized.modules[MODULE_IDS.LINK_DOMAIN_SECURITY] = {
                enabled: legacyLinkSecurity.enabled,
                actionOnDetect: this.mapLegacyActionMode(legacyLinkSecurity),
                ...normalized.modules[MODULE_IDS.LINK_DOMAIN_SECURITY]
            };
            delete normalized.modules['Homograph-Detector'];
        }

        return normalized;
    },

    mapLegacyActionMode(legacyModuleConfig = {}) {
        if (legacyModuleConfig.actionOnDetect) {
            return legacyModuleConfig.actionOnDetect;
        }
        if (legacyModuleConfig.autoBlock) {
            return 'block';
        }
        if (legacyModuleConfig.logOnly) {
            return 'log';
        }
        return 'notify';
    },

    getDefaultConfig() {
        return {
            language: 'auto',
            theme: 'auto',
            modules: {
                [MODULE_IDS.VISUAL_MANIPULATION]: {
                    enabled: true,
                    detectHiddenText: true,
                    detectHiddenInputs: true,
                    detectOverlays: true,
                    detectDeceptiveCapture: true,
                    detectStyleObfuscation: true,
                    hiddenTextDisplayMode: 'ancestors',
                    trackRemovedBlocks: true,
                    scanInterval: 1000,
                    maxElements: 250,
                    sensitivity: 'medium',
                    actionOnDetect: 'notify',
                    name: {
                        en: 'Hidden Content & Visual Manipulation',
                        ru: 'Скрытый контент и визуальные манипуляции'
                    },
                    description: {
                        en: 'Detects hidden text, hidden inputs, deceptive overlays, and CSS-based visual manipulation.',
                        ru: 'Выявляет скрытый текст, скрытые поля ввода, обманные overlay и CSS-манипуляции видимостью.'
                    }
                },
                [MODULE_IDS.LINK_DOMAIN_SECURITY]: {
                    enabled: true,
                    detectHomographs: true,
                    detectLinkMismatch: true,
                    detectRedirectPatterns: true,
                    detectUnsafeProtocols: true,
                    sensitivity: 'medium',
                    actionOnDetect: 'notify',
                    name: {
                        en: 'Link & Domain Security',
                        ru: 'Безопасность ссылок и доменов'
                    },
                    description: {
                        en: 'Analyzes links, domains, homographs, redirect patterns, and unsafe protocols.',
                        ru: 'Анализирует ссылки, домены, гомографы, redirect-паттерны и небезопасные протоколы.'
                    }
                },
                [MODULE_IDS.TRIGGER_PHRASES]: {
                    enabled: true,
                    caseSensitive: false,
                    sensitivity: 'medium',
                    actionOnDetect: 'notify',
                    name: {
                        en: 'Trigger Phrases Filter',
                        ru: 'Фильтр триггерных фраз'
                    },
                    description: {
                        en: 'Looks for risky phrases and prompt-injection fragments in visible page text.',
                        ru: 'Ищет рискованные фразы и фрагменты prompt injection в видимом тексте страницы.'
                    }
                },
                [MODULE_IDS.PROMPT_SPLITTING]: {
                    enabled: false,
                    sensitivity: 'medium',
                    detectionThreshold: 0.8,
                    actionOnDetect: 'log',
                    name: {
                        en: 'Prompt Splitting Detection',
                        ru: 'Обнаружение разделения промптов'
                    },
                    description: {
                        en: 'Tracks prompt fragments that may be distributed across multiple DOM nodes.',
                        ru: 'Отслеживает фрагменты промптов, которые могут быть распределены по нескольким DOM-узлам.'
                    }
                },
                [MODULE_IDS.API_INTERCEPTOR]: {
                    enabled: false,
                    monitorOnly: true,
                    actionOnDetect: 'log',
                    name: {
                        en: 'API Interception',
                        ru: 'Перехват API'
                    },
                    description: {
                        en: 'Reserved for passive monitoring of page-side API interaction surfaces.',
                        ru: 'Зарезервирован для пассивного мониторинга точек взаимодействия страницы с API.'
                    }
                }
            },
            settings: {
                autoScan: true,
                showNotifications: true,
                animationEnabled: true,
                debugMode: false,
                pageStatusRescanOnNavigation: true,
                pageStatusSnapshotMode: true,
                pageStatusTrackByFrame: true,
                pageStatusDedupeByFrameSnapshot: true,
                // Open findings API (TASKS C4.7). Off by default, and an empty allowlist means
                // nobody even when it is on - both gates must be opened deliberately by the user.
                findingsApiEnabled: false,
                findingsApiAllowedExtensionIds: [],
                // Активное вмешательство (TASKS C4.3). Выключено по умолчанию: оно пересекает
                // пассивную границу MVP, и включать его пользователь должен осознанно - вместе с
                // раскрытием антидетект-риска (C4.5).
                activeRemediationEnabled: false,
                // Что делать с находкой о скрытом от человека контенте, когда гейт открыт.
                // По умолчанию самое безопасное: аддитивная и полностью обратимая метка.
                activeRemediationAction: 'annotate'
            },
            statistics: {
                totalScans: 0,
                threatsBlocked: 0,
                lastScanDate: null
            }
        };
    },

    async clearConfig() {
        try {
            await Promise.all([
                extensionStorage.remove('sync', CONFIG_STORAGE_KEYS.EXTENSION_CONFIG),
                extensionStorage.remove('local', [
                    CONFIG_STORAGE_KEYS.EXTENSION_CONFIG,
                    CONFIG_STORAGE_KEYS.TRIGGER_PHRASES_CUSTOM_PATTERNS,
                    CONFIG_STORAGE_KEYS.CONFIG_LOCAL_AUTHORITATIVE
                ])
            ]);
            if (this.syncWriteTimer !== null) {
                clearTimeout(this.syncWriteTimer);
                this.syncWriteTimer = null;
            }
            this.pendingSyncConfig = null;
            this.localAuthoritative = false;
            this.configCache = null;
            Logger.info('Config cleared successfully');
        } catch (error) {
            Logger.error('Failed to clear config:', error);
            throw error;
        }
    },

    async exportConfig() {
        const config = await this.getConfig();
        return JSON.stringify(this.validateConfig(config), null, 2);
    },

    async importConfig(jsonString) {
        try {
            const importedConfig = JSON.parse(jsonString);
            const validatedConfig = this.validateConfig(importedConfig);
            await this.saveConfig(validatedConfig, true);
            return true;
        } catch (error) {
            Logger.error('Failed to import config:', error);
            throw new Error(chrome.i18n.getMessage('invalidConfigFile') || 'Invalid configuration file');
        }
    },

    runConfigSmokeCheck() {
        const checks = [];
        const defaultConfig = this.getDefaultConfig();
        const visualModuleKey = MODULE_IDS.VISUAL_MANIPULATION;

        const defaultMode = defaultConfig.modules?.[visualModuleKey]?.hiddenTextDisplayMode;
        checks.push({
            name: 'default-hiddenTextDisplayMode-is-ancestors',
            passed: defaultMode === 'ancestors',
            expected: 'ancestors',
            actual: defaultMode
        });

        const configWithoutMode = this.validateConfig({
            modules: {
                [visualModuleKey]: {
                    enabled: true
                }
            }
        });
        const withoutModeActual = configWithoutMode.modules?.[visualModuleKey]?.hiddenTextDisplayMode;
        checks.push({
            name: 'missing-hiddenTextDisplayMode-fallback',
            passed: withoutModeActual === 'ancestors',
            expected: 'ancestors',
            actual: withoutModeActual
        });

        // Активное вмешательство - единственная настройка проекта с перечислимым значением, и
        // проверять её нужно ровно там же, где остальные умолчания: профиль с мусором в этом поле
        // не должен доехать до слоя вмешательства (TASKS C4.2).
        const defaultAction = defaultConfig.settings?.activeRemediationAction;
        checks.push({
            name: 'default-activeRemediationAction-is-annotate',
            passed: defaultAction === 'annotate',
            expected: 'annotate',
            actual: defaultAction
        });

        const configWithInvalidAction = this.validateConfig({
            settings: { activeRemediationEnabled: true, activeRemediationAction: 'delete-everything' }
        });
        const invalidActionActual = configWithInvalidAction.settings?.activeRemediationAction;
        checks.push({
            name: 'invalid-activeRemediationAction-fallback',
            passed: invalidActionActual === 'annotate',
            expected: 'annotate',
            actual: invalidActionActual
        });

        const configWithNeutralizeAction = this.validateConfig({
            settings: { activeRemediationAction: 'neutralize' }
        });
        const neutralizeActionActual = configWithNeutralizeAction.settings?.activeRemediationAction;
        checks.push({
            name: 'valid-activeRemediationAction-preserved',
            passed: neutralizeActionActual === 'neutralize',
            expected: 'neutralize',
            actual: neutralizeActionActual
        });

        const configWithInvalidMode = this.validateConfig({
            modules: {
                [visualModuleKey]: {
                    hiddenTextDisplayMode: 'invalid-mode'
                }
            }
        });
        const invalidModeActual = configWithInvalidMode.modules?.[visualModuleKey]?.hiddenTextDisplayMode;
        checks.push({
            name: 'invalid-hiddenTextDisplayMode-fallback',
            passed: invalidModeActual === 'ancestors',
            expected: 'ancestors',
            actual: invalidModeActual
        });

        const configWithSelfMode = this.validateConfig({
            modules: {
                [visualModuleKey]: {
                    hiddenTextDisplayMode: 'self'
                }
            }
        });
        const selfModeActual = configWithSelfMode.modules?.[visualModuleKey]?.hiddenTextDisplayMode;
        checks.push({
            name: 'self-hiddenTextDisplayMode-preserved',
            passed: selfModeActual === 'self',
            expected: 'self',
            actual: selfModeActual
        });

        const exportImportCandidate = this.validateConfig({
            modules: {
                [visualModuleKey]: {
                    hiddenTextDisplayMode: 'self'
                }
            }
        });
        const serialized = JSON.stringify(exportImportCandidate);
        const restored = this.validateConfig(JSON.parse(serialized));
        const exportImportActual = restored.modules?.[visualModuleKey]?.hiddenTextDisplayMode;
        checks.push({
            name: 'export-import-hiddenTextDisplayMode-preserved',
            passed: exportImportActual === 'self',
            expected: 'self',
            actual: exportImportActual
        });

        const triggerModuleKey = MODULE_IDS.TRIGGER_PHRASES;
        const malformedTriggerConfig = this.validateConfig({
            modules: {
                [triggerModuleKey]: {
                    enabled: 'false',
                    caseSensitive: 'true',
                    sensitivity: 'invalid',
                    actionOnDetect: 'invalid',
                    unknownField: true
                },
                'Unknown-Module': { enabled: false }
            },
            settings: []
        });
        const malformedTrigger = malformedTriggerConfig.modules?.[triggerModuleKey];
        checks.push({
            name: 'trigger-malformed-fields-use-defaults-and-unknown-fields-are-dropped',
            passed: malformedTrigger?.enabled === defaultConfig.modules[triggerModuleKey].enabled
                && malformedTrigger?.caseSensitive === false
                && malformedTrigger?.sensitivity === 'medium'
                && malformedTrigger?.actionOnDetect === 'notify'
                && !Object.hasOwn(malformedTrigger, 'unknownField')
                && !Object.hasOwn(malformedTriggerConfig.modules, 'Unknown-Module'),
            expected: 'validated-trigger-defaults-without-unknown-fields',
            actual: malformedTrigger
        });

        const inheritedTrigger = Object.create({ caseSensitive: true, sensitivity: 'high' });
        inheritedTrigger.enabled = false;
        const inheritedTriggerConfig = this.validateConfig({
            modules: { [triggerModuleKey]: inheritedTrigger }
        });
        checks.push({
            name: 'trigger-prototype-values-are-ignored',
            passed: inheritedTriggerConfig.modules?.[triggerModuleKey]?.enabled === true
                && inheritedTriggerConfig.modules?.[triggerModuleKey]?.caseSensitive === false,
            expected: 'trigger-defaults',
            actual: inheritedTriggerConfig.modules?.[triggerModuleKey]
        });

        const rootArrayConfig = this.validateConfig([]);
        checks.push({
            name: 'non-record-root-config-uses-defaults',
            passed: rootArrayConfig.modules?.[triggerModuleKey]?.caseSensitive === false
                && rootArrayConfig.settings?.autoScan === true,
            expected: 'default-config',
            actual: {
                caseSensitive: rootArrayConfig.modules?.[triggerModuleKey]?.caseSensitive,
                autoScan: rootArrayConfig.settings?.autoScan
            }
        });

        checks.push({
            name: 'findings-api-defaults-are-closed',
            passed: defaultConfig.settings?.findingsApiEnabled === false
                && Array.isArray(defaultConfig.settings?.findingsApiAllowedExtensionIds)
                && defaultConfig.settings.findingsApiAllowedExtensionIds.length === 0,
            expected: 'disabled-with-empty-allowlist',
            actual: {
                enabled: defaultConfig.settings?.findingsApiEnabled,
                allowlist: defaultConfig.settings?.findingsApiAllowedExtensionIds
            }
        });

        // An allowlist that accepts malformed input is a security hole, so this pins the filtering
        // rather than the mere presence of the field.
        const validExtensionId = 'abcdefghijklmnopabcdefghijklmnop';
        const malformedApiConfig = this.validateConfig({
            settings: {
                findingsApiEnabled: 'yes',
                findingsApiAllowedExtensionIds: ['TOO-SHORT', validExtensionId, validExtensionId, 42, null, 'z'.repeat(32)]
            }
        });
        const malformedApiAllowlist = malformedApiConfig.settings?.findingsApiAllowedExtensionIds;
        checks.push({
            name: 'findings-api-allowlist-rejects-malformed-ids-and-dedupes',
            passed: malformedApiConfig.settings?.findingsApiEnabled === false
                && Array.isArray(malformedApiAllowlist)
                && malformedApiAllowlist.length === 1
                && malformedApiAllowlist[0] === validExtensionId,
            expected: `[${validExtensionId}]`,
            actual: { enabled: malformedApiConfig.settings?.findingsApiEnabled, allowlist: malformedApiAllowlist }
        });

        const nonArrayApiConfig = this.validateConfig({
            settings: { findingsApiAllowedExtensionIds: { [validExtensionId]: true } }
        });
        checks.push({
            name: 'findings-api-allowlist-rejects-non-array',
            passed: Array.isArray(nonArrayApiConfig.settings?.findingsApiAllowedExtensionIds)
                && nonArrayApiConfig.settings.findingsApiAllowedExtensionIds.length === 0,
            expected: '[]',
            actual: nonArrayApiConfig.settings?.findingsApiAllowedExtensionIds
        });

        return {
            ok: checks.every((check) => check.passed),
            checks
        };
    },

    // Раньше миграция ЗАМЕЩАЛА текущую конфигурацию: convertOldConfig стартовал с дефолтов, копировал
    // из легаси-ключа только language/theme и сохранялся поверх актуального extensionConfig. У любого
    // пользователя, у которого в sync ещё лежал pagecheck_settings, обновление расширения молча
    // сбрасывало настройки модулей и allowlist findings-API (TASKS C6.4).
    // Принятый приоритет источников: актуальный ключ ВСЕГДА главнее легаси. Если extensionConfig уже
    // есть - легаси-ключ это остатки, их надо убрать, а не применять.
    async migrateFromPreviousVersion(previousVersion) {
        try {
            const [legacyResult, syncResult, localResult] = await Promise.all([
                extensionStorage.get('sync', 'pagecheck_settings'),
                extensionStorage.get('sync', CONFIG_STORAGE_KEYS.EXTENSION_CONFIG).catch(() => ({})),
                extensionStorage.get('local', CONFIG_STORAGE_KEYS.EXTENSION_CONFIG).catch(() => ({}))
            ]);
            const oldConfig = legacyResult.pagecheck_settings;
            if (!isPlainRecord(oldConfig)) {
                return;
            }

            const currentConfig = isPlainRecord(localResult[CONFIG_STORAGE_KEYS.EXTENSION_CONFIG])
                ? localResult[CONFIG_STORAGE_KEYS.EXTENSION_CONFIG]
                : isPlainRecord(syncResult[CONFIG_STORAGE_KEYS.EXTENSION_CONFIG])
                    ? syncResult[CONFIG_STORAGE_KEYS.EXTENSION_CONFIG]
                    : null;

            if (currentConfig !== null) {
                await extensionStorage.remove('sync', 'pagecheck_settings');
                Logger.info('Legacy config key removed: the current configuration is authoritative');
                return;
            }

            const migratedConfig = this.convertOldConfig(oldConfig, previousVersion, this.getDefaultConfig());
            await this.saveConfig(migratedConfig, true);
            await extensionStorage.remove('sync', 'pagecheck_settings');
            Logger.info(`Migrated config from version ${previousVersion}`);
        } catch (error) {
            Logger.warn('Migration failed:', error);
        }
    },

    // baseConfig - то, поверх чего кладутся легаси-значения. Именно слияние, а не замена: значения
    // из легаси-ключа переносятся только там, где они есть.
    convertOldConfig(oldConfig, version, baseConfig = this.getDefaultConfig()) {
        const newConfig = this.validateConfig(baseConfig);

        // previousVersion приходит из chrome.runtime.onInstalled и в принципе может отсутствовать -
        // раньше version.startsWith() на этом бросал и миграция уходила в catch как «failed».
        if (typeof version !== 'string' || version.startsWith('0.')) {
            if (oldConfig.language) newConfig.language = oldConfig.language;
            if (oldConfig.theme) newConfig.theme = oldConfig.theme;
        }

        return this.validateConfig(newConfig);
    }
};

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'update') {
        ConfigManager.migrateFromPreviousVersion(details.previousVersion);
    }
});
