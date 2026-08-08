import { I18n } from '../utils/i18n.js';
import { ConfigManager } from '../utils/config-manager.js';
import { ThemeManager } from '../utils/theme-manager.js';
import { Logger } from '../utils/logger.js';

const MODULE_ICONS = {
    'Hidden-Content-Visual-Manipulation': 'VM',
    'Link-Domain-Security': 'LD',
    'Trigger-Phrases': 'TP',
    'Prompt-Splitting': 'PS',
    'Api-Interceptor': 'API'
};
const API_INTERCEPTION_MODULE_ID = 'Api-Interceptor';
const API_PERMISSION_REQUEST = Object.freeze({
    permissions: ['webRequest'],
    origins: ['http://*/*', 'https://*/*']
});

class OptionsManager {
    constructor() {
        this.config = null;
        this.debounceTimer = null;
        this.moduleCardTemplate = '';
        this.init();
    }

    async init() {
        try {
            await ThemeManager.init();
            await this.loadConfig();
            await this.applySelectedLanguage();
            await this.loadComponents();
            this.populateForm();
            this.setupEventListeners();
            I18n.applyTranslations();
            await ThemeManager.applyThemeConfig(this.config.theme);
        } catch (error) {
            Logger.error('Error initializing options page:', error);
            this.showError(I18n.getMessage('optionsInitError'));
        }
    }

    async loadConfig() {
        try {
            this.config = await ConfigManager.getConfig();
        } catch (error) {
            Logger.error('Error loading config:', error);
            this.config = ConfigManager.getDefaultConfig();
            this.showNotification(I18n.getMessage('defaultConfigLoadWarning'), 'warn');
        }
    }

    getEffectiveLanguage() {
        return this.config.language === 'auto' ? I18n.getDefaultLanguage() : this.config.language;
    }

    async applySelectedLanguage() {
        const lang = this.getEffectiveLanguage();
        I18n.currentLanguage = lang;
        if (!I18n.localeMessages[lang]) {
            const response = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
            if (response.ok) {
                I18n.localeMessages[lang] = await response.json();
            }
        }
        I18n.clearCache();
        document.documentElement.lang = lang;
    }

    async loadComponents() {
        for (const component of [
            { id: 'header-container', path: '../ui/components/header.html' },
            { id: 'theme-container', path: '../ui/components/theme-switcher.html' }
        ]) {
            try {
                await this.loadComponent(component.id, component.path);
            } catch (error) {
                Logger.error(`Failed to load component ${component.id}:`, error);
                this.createComponentPlaceholder(component.id);
            }
        }
        await this.loadModuleCards();
    }

    async loadModuleCards() {
        try {
            const response = await fetch('../ui/components/module-card.html');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            this.moduleCardTemplate = await response.text();
            this.renderModuleCards();
        } catch (error) {
            Logger.error('Failed to load module cards template:', error);
            this.createComponentPlaceholder('modules-container');
        }
    }

    async loadComponent(elementId, filePath) {
        const response = await fetch(filePath);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const container = document.getElementById(elementId);
        if (!container) throw new Error(`Container #${elementId} not found`);
        container.innerHTML = await response.text();
        I18n.applyTranslations(container);
    }

    createComponentPlaceholder(elementId) {
        const container = document.getElementById(elementId);
        if (!container) return;
        container.innerHTML = `
            <div class="component-error">
                <p data-i18n="componentLoadError">Failed to load component</p>
                <button onclick="location.reload()" data-i18n="reloadPage">Reload Page</button>
            </div>
        `;
        I18n.applyTranslations(container);
    }

    renderModuleCards() {
        const container = document.getElementById('modules-container');
        if (!container || !this.config?.modules || !this.moduleCardTemplate) return;
        container.innerHTML = '';
        const lang = this.getEffectiveLanguage();

        Object.entries(this.config.modules).forEach(([moduleKey, moduleConfig]) => {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = this.moduleCardTemplate.trim();
            const card = wrapper.firstElementChild;
            if (!card) return;
            card.dataset.module = moduleKey;
            card.dataset.status = moduleConfig.enabled ? 'active' : 'inactive';
            this.fillModuleCard(card, moduleKey, moduleConfig, lang);
            container.appendChild(card);
        });

        I18n.applyTranslations(container);
    }

    fillModuleCard(card, moduleKey, moduleConfig, lang) {
        const title = card.querySelector('.module-title h3');
        const desc = card.querySelector('.module-description');
        const badge = card.querySelector('.status-badge');
        const icon = card.querySelector('.module-icon');
        const groups = card.querySelector('.module-settings-groups');

        if (title) {
            title.textContent = moduleConfig.name?.[lang] || moduleConfig.name?.en || moduleKey;
            title.removeAttribute('data-i18n');
        }
        if (desc) {
            desc.textContent = moduleConfig.description?.[lang] || moduleConfig.description?.en || I18n.getMessage('moduleDescription');
            desc.removeAttribute('data-i18n');
        }
        if (badge) {
            const active = Boolean(moduleConfig.enabled);
            badge.dataset.status = active ? 'active' : 'inactive';
            badge.textContent = active ? I18n.getMessage('active') : I18n.getMessage('inactive');
            badge.setAttribute('data-i18n', active ? 'active' : 'inactive');
        }
        if (icon) icon.textContent = MODULE_ICONS[moduleKey] || 'PC';
        if (groups) groups.innerHTML = this.renderSettings(moduleKey);
    }

    renderSettings(moduleKey) {
        return this.getSchema(moduleKey).map((group) => `
            <div class="setting-group">
                <h5 data-i18n="${group.title}">${I18n.getMessage(group.title)}</h5>
                ${group.fields.map((field) => this.renderField(field)).join('')}
            </div>
        `).join('');
    }

    renderField(field) {
        if (field.type === 'checkbox') {
            return `
                <div class="setting-row">
                    <label>
                        <input type="checkbox" data-setting="${field.key}">
                        <span data-i18n="${field.label}">${I18n.getMessage(field.label)}</span>
                    </label>
                </div>
            `;
        }
        if (field.type === 'number') {
            return `
                <div class="setting-row">
                    <label data-i18n="${field.label}">${I18n.getMessage(field.label)}</label>
                    <input type="number" data-setting="${field.key}" min="${field.min}" max="${field.max}" step="${field.step}">
                </div>
            `;
        }
        return `
            <div class="setting-row">
                <label data-i18n="${field.label}">${I18n.getMessage(field.label)}</label>
                <select data-setting="${field.key}">
                    ${field.options.map((option) => `<option value="${option.value}" data-i18n="${option.label}">${I18n.getMessage(option.label)}</option>`).join('')}
                </select>
            </div>
        `;
    }

    getSchema(moduleKey) {
        const sensitivity = {
            type: 'select',
            key: 'sensitivity',
            label: 'sensitivity',
            options: [
                { value: 'low', label: 'sensitivityLow' },
                { value: 'medium', label: 'sensitivityMedium' },
                { value: 'high', label: 'sensitivityHigh' }
            ]
        };
        const action = {
            type: 'select',
            key: 'actionOnDetect',
            label: 'actionOnDetect',
            options: [
                { value: 'log', label: 'actionLog' },
                { value: 'block', label: 'actionBlock' },
                { value: 'notify', label: 'actionNotify' }
            ]
        };
        const hiddenTextDisplayMode = {
            type: 'select',
            key: 'hiddenTextDisplayMode',
            label: 'hiddenTextDisplayMode',
            options: [
                { value: 'ancestors', label: 'hiddenTextDisplayModeAncestors' },
                { value: 'self', label: 'hiddenTextDisplayModeSelf' }
            ]
        };

        if (moduleKey === 'Hidden-Content-Visual-Manipulation') {
            return [
                { title: 'generalSettings', fields: [
                    { type: 'checkbox', key: 'detectHiddenText', label: 'detectHiddenText' },
                    { type: 'checkbox', key: 'detectHiddenInputs', label: 'detectHiddenInputs' },
                    { type: 'checkbox', key: 'detectOverlays', label: 'detectOverlays' },
                    { type: 'checkbox', key: 'detectDeceptiveCapture', label: 'detectDeceptiveCapture' },
                    { type: 'checkbox', key: 'detectStyleObfuscation', label: 'detectStyleObfuscation' }
                ] },
                { title: 'performanceSettings', fields: [
                    { type: 'number', key: 'scanInterval', label: 'scanInterval', min: 100, max: 5000, step: 100 },
                    { type: 'number', key: 'maxElements', label: 'maxElements', min: 10, max: 5000, step: 10 }
                ] },
                { title: 'detectionSettings', fields: [sensitivity, hiddenTextDisplayMode, action] },
                { title: 'advancedSettings', fields: [
                    { type: 'checkbox', key: 'trackRemovedBlocks', label: 'trackRemovedBlocks' },
                    { type: 'checkbox', key: 'allowIntervention', label: 'allowIntervention' }
                ] }
            ];
        }

        if (moduleKey === 'Link-Domain-Security') {
            return [
                { title: 'generalSettings', fields: [
                    { type: 'checkbox', key: 'detectHomographs', label: 'detectHomographs' },
                    { type: 'checkbox', key: 'detectLinkMismatch', label: 'detectLinkMismatch' },
                    { type: 'checkbox', key: 'detectRedirectPatterns', label: 'detectRedirectPatterns' },
                    { type: 'checkbox', key: 'detectUnsafeProtocols', label: 'detectUnsafeProtocols' }
                ] },
                { title: 'detectionSettings', fields: [sensitivity, action] },
                { title: 'advancedSettings', fields: [
                    { type: 'checkbox', key: 'allowIntervention', label: 'allowIntervention' }
                ] }
            ];
        }

        if (moduleKey === 'Trigger-Phrases') {
            return [
                { title: 'generalSettings', fields: [
                    { type: 'checkbox', key: 'caseSensitive', label: 'caseSensitive' },
                    { type: 'checkbox', key: 'allowIntervention', label: 'allowIntervention' }
                ] },
                { title: 'detectionSettings', fields: [sensitivity, action] }
            ];
        }

        if (moduleKey === 'Prompt-Splitting') {
            return [
                { title: 'generalSettings', fields: [
                    { type: 'checkbox', key: 'allowIntervention', label: 'allowIntervention' }
                ] },
                { title: 'detectionSettings', fields: [
                    { type: 'number', key: 'detectionThreshold', label: 'detectionThreshold', min: 0.1, max: 1, step: 0.1 },
                    action
                ] }
            ];
        }

        return [
            { title: 'generalSettings', fields: [
                { type: 'checkbox', key: 'monitorOnly', label: 'monitorOnly' },
                { type: 'checkbox', key: 'allowIntervention', label: 'allowIntervention' }
            ] },
            { title: 'detectionSettings', fields: [action] }
        ];
    }

    populateForm() {
        this.populateSelect('language-select', this.config?.language);
        this.populateThemeSwitch();
        this.populateFindingsApiSettings();
        this.populateModuleSettings();
    }

    populateFindingsApiSettings() {
        const enabledInput = document.getElementById('findings-api-enabled');
        if (enabledInput) {
            enabledInput.checked = this.config?.settings?.findingsApiEnabled === true;
        }

        const allowlistInput = document.getElementById('findings-api-allowlist');
        if (allowlistInput) {
            const allowlist = this.config?.settings?.findingsApiAllowedExtensionIds;
            allowlistInput.value = Array.isArray(allowlist) ? allowlist.join(', ') : '';
        }
    }

    // Accepts commas, spaces or newlines so a pasted list works either way. Malformed entries are
    // dropped again by ConfigManager.validateConfig - this is convenience, not the security gate.
    parseExtensionIdList(rawValue) {
        return typeof rawValue === 'string'
            ? [...new Set(rawValue.split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean))]
            : [];
    }

    populateSelect(selectId, value) {
        const select = document.getElementById(selectId);
        if (select && value !== undefined) select.value = value;
    }

    populateThemeSwitch() {
        const themeValue = this.config?.theme || 'auto';
        const themeRadio = document.querySelector(`input[name="theme"][value="${themeValue}"]`);
        if (themeRadio) themeRadio.checked = true;
    }

    populateModuleSettings() {
        if (!this.config?.modules) return;
        Object.keys(this.config.modules).forEach((moduleKey) => {
            const moduleElement = document.querySelector(`[data-module="${moduleKey}"]`);
            if (!moduleElement) return;
            const moduleConfig = this.config.modules[moduleKey];
            Object.keys(moduleConfig).forEach((setting) => {
                const input = moduleElement.querySelector(`[data-setting="${setting}"]`);
                if (!input) return;
                if (input.type === 'checkbox') input.checked = Boolean(moduleConfig[setting]);
                else input.value = moduleConfig[setting];
            });
            this.restoreModuleSettingsState(moduleElement, moduleKey);
            this.setupModuleSettingsToggle(moduleElement);
        });
    }

    restoreModuleSettingsState(moduleElement, moduleKey) {
        const settingsPanel = moduleElement.querySelector('.module-settings');
        const toggleBtn = moduleElement.querySelector('.settings-toggle');
        if (!settingsPanel || !toggleBtn) return;
        const isExpanded = localStorage.getItem(`module-${moduleKey}-expanded`) === 'true';
        settingsPanel.hidden = !isExpanded;
        this.updateToggleLabel(toggleBtn, isExpanded);
    }

    setupModuleSettingsToggle(moduleElement) {
        const toggleBtn = moduleElement.querySelector('.settings-toggle');
        const settingsPanel = moduleElement.querySelector('.module-settings');
        const closeBtn = moduleElement.querySelector('.settings-close');
        const moduleKey = moduleElement.dataset.module;
        if (toggleBtn && settingsPanel && !toggleBtn.dataset.bound) {
            toggleBtn.dataset.bound = 'true';
            toggleBtn.addEventListener('click', () => {
                const isExpanded = !settingsPanel.hidden;
                settingsPanel.hidden = isExpanded;
                this.updateToggleLabel(toggleBtn, !isExpanded);
                localStorage.setItem(`module-${moduleKey}-expanded`, String(!isExpanded));
            });
        }
        if (closeBtn && settingsPanel && !closeBtn.dataset.bound) {
            closeBtn.dataset.bound = 'true';
            closeBtn.addEventListener('click', () => {
                settingsPanel.hidden = true;
                this.updateToggleLabel(toggleBtn, false);
                localStorage.setItem(`module-${moduleKey}-expanded`, 'false');
            });
        }
    }

    updateToggleLabel(toggleBtn, isExpanded) {
        const label = I18n.getMessage(isExpanded ? 'hideSettings' : 'showSettings');
        toggleBtn.innerHTML = `<span class="toggle-text">${label}</span><span class="toggle-icon">${isExpanded ? '^' : 'v'}</span>`;
    }

    setupEventListeners() {
        this.setupListener('save-btn', 'click', () => this.saveSettings());
        this.setupListener('reset-btn', 'click', () => this.resetSettings());
        this.setupListener('export-btn', 'click', () => this.exportSettings());
        this.setupListener('import-btn', 'click', () => this.importSettings());
        this.setupListener('toggle-all-modules', 'click', () => this.toggleAllModules());
        this.setupListener('language-select', 'change', async (e) => {
            this.config.language = e.target.value;
            await this.applySelectedLanguage();
            this.renderModuleCards();
            this.populateModuleSettings();
            this.setupModuleEventListeners();
            I18n.applyTranslations();
            this.scheduleAutoSave();
        });
        this.setupListener('findings-api-enabled', 'change', () => {
            this.collectFindingsApiSettings();
            this.scheduleAutoSave();
        });
        this.setupListener('findings-api-allowlist', 'change', () => {
            this.collectFindingsApiSettings();
            // Reflect the normalized list back, so the user sees what was actually stored.
            this.populateFindingsApiSettings();
            this.scheduleAutoSave();
        });
        document.querySelectorAll('input[name="theme"]').forEach((input) => {
            input.addEventListener('change', async (e) => {
                if (!e.target.checked) return;
                this.config.theme = e.target.value;
                await ThemeManager.applyThemeConfig(this.config.theme);
                this.scheduleAutoSave();
            });
        });
        this.setupModuleEventListeners();
        this.setupAutoSave();
    }

    setupListener(id, event, handler) {
        const element = document.getElementById(id);
        if (element) element.addEventListener(event, handler);
    }

    setupModuleEventListeners() {
        document.querySelectorAll('.module-card input, .module-card select').forEach((input) => {
            if (input.dataset.bound === 'true') return;
            input.dataset.bound = 'true';
            input.addEventListener('change', (e) => {
                const moduleElement = e.target.closest('[data-module]');
                if (!moduleElement) return;
                const moduleId = moduleElement.dataset.module;
                const setting = e.target.dataset.setting || e.target.name;
                if (moduleId === API_INTERCEPTION_MODULE_ID && setting === 'enabled') {
                    e.stopPropagation();
                    this.handleApiInterceptionToggle(e.target, moduleElement);
                    return;
                }
                const value = e.target.type === 'checkbox'
                    ? e.target.checked
                    : e.target.type === 'number'
                        ? Number(e.target.value)
                        : e.target.value;
                if (moduleId && setting && this.config.modules[moduleId]) {
                    this.config.modules[moduleId][setting] = value;
                    if (setting === 'enabled') {
                        moduleElement.dataset.status = value ? 'active' : 'inactive';
                        const badge = moduleElement.querySelector('.status-badge');
                        if (badge) {
                            badge.dataset.status = value ? 'active' : 'inactive';
                            badge.textContent = value ? I18n.getMessage('active') : I18n.getMessage('inactive');
                            badge.setAttribute('data-i18n', value ? 'active' : 'inactive');
                        }
                    }
                    this.scheduleAutoSave();
                }
            });
        });
    }

    setupAutoSave() {
        let saveTimeout;
        const scheduleSave = () => {
            clearTimeout(saveTimeout);
            saveTimeout = setTimeout(() => this.saveSettings(false), 2000);
        };
        document.addEventListener('input', scheduleSave);
        document.addEventListener('change', scheduleSave);
    }

    scheduleAutoSave() {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.saveSettings(true), 1000);
    }

    async toggleAllModules() {
        const moduleKeys = Object.keys(this.config.modules || {});
        if (moduleKeys.length === 0) return;
        const nonApiModuleKeys = moduleKeys.filter((key) => key !== API_INTERCEPTION_MODULE_ID);
        const nextState = !nonApiModuleKeys.every((key) => this.config.modules[key].enabled);
        nonApiModuleKeys.forEach((key) => { this.config.modules[key].enabled = nextState; });
        if (!nextState && this.config.modules[API_INTERCEPTION_MODULE_ID]?.enabled) {
            const apiInput = document.querySelector(`[data-module="${API_INTERCEPTION_MODULE_ID}"] [data-setting="enabled"]`);
            if (apiInput) {
                apiInput.checked = false;
                await this.handleApiInterceptionToggle(apiInput, apiInput.closest('[data-module]'));
            }
        }
        this.renderModuleCards();
        this.populateModuleSettings();
        this.setupModuleEventListeners();
        this.scheduleAutoSave();
    }

    collectFormSettings() {
        this.collectSelectValue('language-select', 'language');
        const selectedTheme = document.querySelector('input[name="theme"]:checked');
        if (selectedTheme) this.config.theme = selectedTheme.value;
        this.collectFindingsApiSettings();
        document.querySelectorAll('[data-module]').forEach((card) => {
            const moduleId = card.dataset.module;
            if (!moduleId || !this.config.modules[moduleId]) return;
            if (moduleId === API_INTERCEPTION_MODULE_ID) return;
            card.querySelectorAll('[data-setting]').forEach((input) => {
                const setting = input.dataset.setting;
                this.config.modules[moduleId][setting] = input.type === 'checkbox'
                    ? input.checked
                    : input.type === 'number'
                        ? Number(input.value)
                        : input.value;
            });
        });
    }

    collectFindingsApiSettings() {
        if (!this.config) return;
        this.config.settings = this.config.settings || {};

        const enabledInput = document.getElementById('findings-api-enabled');
        if (enabledInput) {
            this.config.settings.findingsApiEnabled = enabledInput.checked === true;
        }

        const allowlistInput = document.getElementById('findings-api-allowlist');
        if (allowlistInput) {
            this.config.settings.findingsApiAllowedExtensionIds = this.parseExtensionIdList(allowlistInput.value);
        }
    }

    async handleApiInterceptionToggle(input, moduleElement) {
        const requestedEnabled = input.checked === true;
        input.disabled = true;
        let response;
        try {
            if (requestedEnabled) {
                const beginPromise = chrome.runtime.sendMessage({ action: 'apiPermissionBegin' });
                const requestPromise = typeof chrome.permissions?.request === 'function'
                    ? chrome.permissions.request(API_PERMISSION_REQUEST)
                    : Promise.resolve(false);
                const [begin, granted] = await Promise.all([beginPromise, requestPromise]);
                response = begin?.success
                    ? await chrome.runtime.sendMessage({
                        action: 'apiPermissionCommit',
                        transactionId: begin.transactionId,
                        granted: granted === true
                    })
                    : begin;
            } else {
                response = await chrome.runtime.sendMessage({ action: 'apiPermissionDisable' });
            }
            const desiredEnabled = response?.state?.desiredEnabled === true;
            this.config.modules[API_INTERCEPTION_MODULE_ID].enabled = desiredEnabled;
            input.checked = desiredEnabled;
            moduleElement.dataset.status = desiredEnabled ? 'active' : 'inactive';
            const badge = moduleElement.querySelector('.status-badge');
            if (badge) {
                badge.dataset.status = desiredEnabled ? 'active' : 'inactive';
                badge.textContent = desiredEnabled ? I18n.getMessage('active') : I18n.getMessage('inactive');
            }
            if (response?.success) {
                this.showNotification(`${I18n.getMessage('module')} ${I18n.getMessage(desiredEnabled ? 'enabled' : 'disabled')}`, 'success');
            } else if (response?.state?.capability === 'unavailable') {
                this.showNotification(I18n.getMessage('apiPermissionUnavailable'), 'error');
            } else if (response?.reason === 'permission-required') {
                this.showNotification(I18n.getMessage('apiPermissionRequired'), 'error');
            } else {
                this.showNotification(I18n.getMessage('apiPermissionDenied'), 'error');
            }
            if (response?.removalFailed) {
                this.showNotification(I18n.getMessage('apiPermissionRemovalFailed'), 'error');
            }
        } catch {
            input.checked = this.config.modules[API_INTERCEPTION_MODULE_ID].enabled === true;
            this.showNotification(I18n.getMessage('apiPermissionUnavailable'), 'error');
        } finally {
            input.disabled = false;
        }
    }

    collectSelectValue(selectId, configKey) {
        const select = document.getElementById(selectId);
        if (select && this.config[configKey] !== undefined) this.config[configKey] = select.value;
    }

    async saveSettings(showNotification = true) {
        try {
            this.collectFormSettings();
            await ConfigManager.saveConfig(this.config);
            await this.applySelectedLanguage();
            I18n.applyTranslations();
            if (showNotification) this.showNotification(I18n.getMessage('settingsSaved'), 'success');
        } catch (error) {
            Logger.error('Error saving settings:', error);
            this.showNotification(I18n.getMessage('saveError'), 'error');
        }
    }

    async resetSettings() {
        if (!confirm(I18n.getMessage('confirmReset'))) return;
        try {
            this.config = ConfigManager.getDefaultConfig();
            await ConfigManager.saveConfig(this.config);
            await this.applySelectedLanguage();
            this.renderModuleCards();
            this.populateForm();
            this.setupModuleEventListeners();
            I18n.applyTranslations();
            await ThemeManager.applyThemeConfig(this.config.theme);
            this.showNotification(I18n.getMessage('settingsReset'), 'success');
        } catch (error) {
            Logger.error('Error resetting settings:', error);
            this.showNotification(I18n.getMessage('resetError'), 'error');
        }
    }

    async exportSettings() {
        try {
            const blob = new Blob([JSON.stringify(this.config, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'pagecheck-settings.json';
            a.click();
            URL.revokeObjectURL(url);
            this.showNotification(I18n.getMessage('settingsExported'), 'success');
        } catch (error) {
            Logger.error('Error exporting settings:', error);
            this.showNotification(I18n.getMessage('exportError'), 'error');
        }
    }

    async importSettings() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const config = JSON.parse(await file.text());
                if (!this.validateConfig(config)) throw new Error(I18n.getMessage('invalidConfigFile'));
                this.config = ConfigManager.validateConfig(config);
                await ConfigManager.saveConfig(this.config);
                await this.applySelectedLanguage();
                this.renderModuleCards();
                this.populateForm();
                this.setupModuleEventListeners();
                this.showNotification(I18n.getMessage('settingsImported'), 'success');
            } catch (error) {
                Logger.error('Error importing settings:', error);
                this.showNotification(I18n.getMessage('importError'), 'error');
            }
        };
        input.click();
    }

    validateConfig(config) {
        return config && typeof config === 'object' && config.modules && typeof config.modules === 'object';
    }

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.innerHTML = `<span>${message}</span><button class="notification-close" onclick="this.parentElement.remove()">X</button>`;
        notification.style.cssText = 'position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:4px;color:white;z-index:1000;animation:slideIn 0.3s ease;display:flex;align-items:center;gap:10px;';
        notification.style.background = ({ success: '#137333', error: '#d93025', warn: '#f29900', info: '#1a73e8' }[type]) || '#1a73e8';
        document.body.appendChild(notification);
        setTimeout(() => {
            if (!notification.parentElement) return;
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, 5000);
    }

    showError(message) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'global-error';
        errorDiv.innerHTML = `<h3>${I18n.getMessage('globalErrorTitle')}</h3><p>${message}</p><button onclick="location.reload()">${I18n.getMessage('reloadPage')}</button>`;
        document.body.innerHTML = '';
        document.body.appendChild(errorDiv);
    }
}

const styles = document.createElement('style');
styles.textContent = '@keyframes slideIn{from{transform:translateX(100%);opacity:0;}to{transform:translateX(0);opacity:1;}}@keyframes slideOut{from{transform:translateX(0);opacity:1;}to{transform:translateX(100%);opacity:0;}}.notification{box-shadow:0 2px 10px rgba(0,0,0,0.2);}.notification-close{background:none;border:none;color:inherit;font-size:18px;cursor:pointer;padding:0;margin:0;line-height:1;}.global-error{padding:40px;text-align:center;font-family:sans-serif;}.component-error{padding:20px;border:2px dashed #ccc;text-align:center;margin:10px 0;}.component-error button{margin-top:10px;padding:8px 16px;background:#1a73e8;color:#fff;border:none;border-radius:4px;cursor:pointer;}';
document.head.appendChild(styles);

document.addEventListener('DOMContentLoaded', () => { new OptionsManager(); });
window.addEventListener('error', (event) => { Logger.error('Global error:', event.error); });
