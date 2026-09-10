// js/popup.js
import { I18n } from '../utils/i18n.js';
import { ConfigManager } from '../utils/config-manager.js';
import { ThemeManager } from '../utils/theme-manager.js';
import { Logger } from '../utils/logger.js';

const API_INTERCEPTION_MODULE_ID = 'Api-Interceptor';
const API_PERMISSION_REQUEST = Object.freeze({
    permissions: ['webRequest'],
    origins: ['http://*/*', 'https://*/*']
});

class PopupManager {
    constructor() {
        this.config = null;
        this.init();
    }

    async init() {
        try {
            Logger.info('Initializing popup');

            await ThemeManager.init();
            await this.loadConfig();
            const effectiveLanguage = this.config.language === 'auto'
                ? I18n.getDefaultLanguage()
                : this.config.language;
            I18n.currentLanguage = effectiveLanguage;
            if (!I18n.localeMessages[effectiveLanguage]) {
                const localeResponse = await fetch(chrome.runtime.getURL(`_locales/${effectiveLanguage}/messages.json`));
                if (localeResponse.ok) {
                    I18n.localeMessages[effectiveLanguage] = await localeResponse.json();
                }
            }
            I18n.clearCache();
            await ThemeManager.applyThemeConfig(this.config.theme);

            I18n.applyTranslations();
            document.documentElement.lang = effectiveLanguage;

            this.updateUI();
            this.setupEventListeners();
            await this.refreshData();

            Logger.info('Popup initialized successfully');
        } catch (error) {
            Logger.error('Error initializing popup:', error);
            this.showError(I18n.getMessage('popupInitError'));
        }
    }

    async loadConfig() {
        this.config = await ConfigManager.getConfig();
    }

    updateUI() {
        this.updateModuleStatuses();
        this.updateStats();
        const versionNode = document.getElementById('version-number');
        if (versionNode) {
            const manifest = chrome.runtime.getManifest();
            versionNode.textContent = manifest.version_name || manifest.version;
        }
    }

    updateModuleStatuses() {
        const list = document.querySelector('.modules-list');
        if (!list || !this.config?.modules) return;

        list.innerHTML = '';

        Object.entries(this.config.modules).forEach(([moduleKey, module]) => {
            const isEnabled = Boolean(module.enabled);
            const moduleLanguage = this.config.language === 'auto'
                ? I18n.getCurrentLanguage()
                : this.config.language;
            const moduleName = module.name?.[moduleLanguage] || module.name?.en || moduleKey;

            const row = document.createElement('div');
            row.className = 'module-status';
            row.dataset.module = moduleKey;
            row.innerHTML = `
                <span class="module-name">${moduleName}</span>
                <span class="module-state ${isEnabled ? 'active' : 'inactive'}">
                    ${isEnabled ? I18n.getMessage('active') : I18n.getMessage('inactive')}
                </span>
            `;

            list.appendChild(row);
        });
    }

    updateStats() {
        const statNodes = document.querySelectorAll('.scan-stats .stat');
        if (statNodes.length < 2) return;

        const threatsBlocked = this.config?.statistics?.threatsBlocked || 0;
        const lastScanDate = this.config?.statistics?.lastScanDate || '-';

        statNodes[0].textContent = `${I18n.getMessage('threatsBlocked')} ${threatsBlocked}`;
        statNodes[1].textContent = `${I18n.getMessage('lastScan')} ${lastScanDate}`;
    }

    setupEventListeners() {
        const scanBtn = document.getElementById('quick-scan-btn');
        if (scanBtn && !scanBtn.dataset.bound) {
            scanBtn.dataset.bound = 'true';
            scanBtn.addEventListener('click', () => this.scanCurrentPage());
        }

        const settingsBtn = document.querySelector('.settings-btn');
        if (settingsBtn && !settingsBtn.dataset.bound) {
            settingsBtn.dataset.bound = 'true';
            settingsBtn.addEventListener('click', () => this.openSettings());
        }

        const modulesList = document.querySelector('.modules-list');
        if (modulesList && !modulesList.dataset.bound) {
            modulesList.dataset.bound = 'true';
            modulesList.addEventListener('click', (e) => {
                const moduleElement = e.target.closest('.module-status');
                const moduleKey = moduleElement?.dataset.module;
                if (moduleKey) {
                    this.toggleModule(moduleKey);
                }
            });
        }

        document.querySelectorAll('.action-btn').forEach(btn => {
            if (btn.dataset.bound) return;
            btn.dataset.bound = 'true';
            btn.addEventListener('click', () => this.handleQuickAction(btn.dataset.action));
        });

        document.querySelectorAll('.footer-links a').forEach((link) => {
            if (link.dataset.bound) return;
            link.dataset.bound = 'true';
            link.addEventListener('click', async (e) => {
                e.preventDefault();
                const page = link.dataset.page;
                if (page === 'settings') {
                    this.openSettings();
                    return;
                }

                if (page === 'help') {
                    await chrome.tabs.create({ url: chrome.runtime.getURL('ui/help.html') });
                    return;
                }

                if (page === 'about') {
                    await chrome.tabs.create({ url: chrome.runtime.getURL('ui/about.html') });
                }
            });
        });

        if (!document.body.dataset.visibilityBound) {
            document.body.dataset.visibilityBound = 'true';
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) {
                    this.refreshData();
                }
            });
        }
    }

    async handleQuickAction(action) {
        if (action === 'enableAll') {
            await this.toggleAllModules(true);
        } else if (action === 'disableAll') {
            await this.toggleAllModules(false);
        } else if (action === 'viewReport') {
            this.openSettings();
        } else if (action === 'revertIntervention') {
            await this.revertIntervention();
        }
    }

    async toggleAllModules(enabled) {
        try {
            const moduleKeys = Object.keys(this.config.modules || {});
            for (const moduleKey of moduleKeys) {
                if (moduleKey === API_INTERCEPTION_MODULE_ID) {
                    if (!enabled && this.config.modules[moduleKey].enabled) {
                        await this.toggleApiInterception(false);
                    }
                    continue;
                }
                this.config.modules[moduleKey].enabled = enabled;
                await chrome.runtime.sendMessage({
                    action: 'toggleModule',
                    moduleId: moduleKey,
                    enabled
                });
            }

            await ConfigManager.saveConfig(this.config);
            this.updateUI();
            this.setupEventListeners();
        } catch (error) {
            Logger.error('Failed to toggle all modules:', error);
        }
    }

    async scanCurrentPage() {
        try {
            Logger.info('Initiating page scan');
            this.setLoadingState(true);

            const tab = await this.getCurrentTab();
            if (!this.isScannableTab(tab)) {
                this.showNotification(I18n.getMessage('pageNotScannable'), 'error');
                return;
            }

            const response = await chrome.runtime.sendMessage({
                action: 'scanPage',
                tabId: tab?.id
            });

            if (response?.success) {
                // C2, transparency: показываем СВОЮ цену на этой странице. Доверие после инцидента с
                // 54 вкладками восстанавливается числом, которое пользователь видит сам.
                const activeMs = response?.pageStatus?.context?.lastScanActiveMs;
                const costMessage = Number.isFinite(activeMs) && activeMs > 0
                    ? I18n.getMessage('scanCompletedWithCost', [String(activeMs)])
                    : '';
                this.showNotification(costMessage || I18n.getMessage('scanCompleted'), 'success');
                // C4.4: страница, снявшая наши метки, - это факт о странице, и он должен доходить
                // до человека, а не оставаться в консоли. Восстанавливать метку мы не будем: война
                // правок в main-thread пользователя защитой не является.
                this.updateInterventionControls(response?.pageStatus?.intervention);
                const applied = response?.pageStatus?.intervention?.appliedEdits;
                if (Number.isFinite(applied) && applied > 0) {
                    this.showNotification(I18n.getMessage('interventionApplied', [String(applied)]), 'success');
                }
                const tampered = response?.pageStatus?.intervention?.tamperedEdits;
                if (Number.isFinite(tampered) && tampered > 0) {
                    this.showNotification(I18n.getMessage('interventionTamperedNotice'), 'error');
                }
                // C4: усиленное предупреждение ровно в том случае, где цена ошибки выше обычной -
                // страницу с находками читает автоматизированный браузер, а не только человек.
                // Предупреждение и ничего больше: детекторы от этого сигнала не меняются, потому что
                // подделать его тривиально в обе стороны.
                const context = response?.pageStatus?.context;
                const findingsCount = response?.pageStatus?.totalFindings;
                if (context?.automation === true && Number.isFinite(findingsCount) && findingsCount > 0) {
                    this.showNotification(I18n.getMessage('automationFindingsNotice'), 'error');
                }
            } else {
                throw new Error(response?.error || 'Scan failed');
            }
        } catch (error) {
            const message = String(error?.message || error);
            if (message.includes('Content script is not available')) {
                Logger.warn('Scan skipped: content script is not available on this page');
            } else {
                Logger.error('Scan error:', error);
            }
            this.showNotification(I18n.getMessage('scanFailed'), 'error');
        } finally {
            this.setLoadingState(false);
        }
    }

    // Кнопка существует только тогда, когда есть что откатывать: активное вмешательство выключено
    // по умолчанию, и предлагать «вернуть страницу» там, где мы её не трогали, значит обещать
    // действие, которого не было.
    updateInterventionControls(intervention) {
        const button = document.getElementById('revert-intervention-btn');
        if (!button) {
            return;
        }
        const applied = Number.isFinite(intervention?.appliedEdits) ? intervention.appliedEdits : 0;
        button.hidden = applied <= 0;
        this.lastAppliedInterventionEdits = applied;
    }

    async revertIntervention() {
        try {
            const tab = await this.getCurrentTab();
            if (!this.isScannableTab(tab)) {
                this.showNotification(I18n.getMessage('pageNotScannable'), 'error');
                return;
            }

            const response = await chrome.tabs.sendMessage(tab.id, { action: 'revertIntervention' });
            if (response?.success !== true) {
                throw new Error('Revert failed');
            }
            this.showNotification(I18n.getMessage('interventionReverted'), 'success');
            this.updateInterventionControls({ appliedEdits: 0 });
        } catch (error) {
            Logger.error('Revert error:', error);
            this.showNotification(I18n.getMessage('interventionRevertFailed'), 'error');
        }
    }

    isScannableTab(tab) {
        const url = tab?.url || '';
        return /^https?:\/\//i.test(url);
    }

    async getCurrentTab() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return tab;
    }

    async toggleModule(moduleKey) {
        try {
            if (moduleKey === API_INTERCEPTION_MODULE_ID) {
                await this.toggleApiInterception(!this.config.modules[moduleKey]?.enabled);
                return;
            }
            const currentState = this.config.modules[moduleKey]?.enabled;
            const newState = !currentState;

            this.config.modules[moduleKey].enabled = newState;
            await ConfigManager.saveConfig(this.config);

            await chrome.runtime.sendMessage({
                action: 'toggleModule',
                moduleId: moduleKey,
                enabled: newState
            });

            this.updateUI();
            this.setupEventListeners();

            this.showNotification(
                `${I18n.getMessage('module')} ${newState ? I18n.getMessage('enabled') : I18n.getMessage('disabled')}`,
                'success'
            );
        } catch (error) {
            Logger.error('Error toggling module:', error);
            this.showNotification(I18n.getMessage('toggleFailed'), 'error');
        }
    }

    async toggleApiInterception(enable) {
        try {
            let response;
            if (enable) {
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
            this.updateUI();
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
            this.showNotification(I18n.getMessage('apiPermissionUnavailable'), 'error');
        }
    }

    openSettings() {
        chrome.runtime.openOptionsPage();
    }

    async refreshData() {
        try {
            await this.loadConfig();
            const effectiveLanguage = this.config.language === 'auto'
                ? I18n.getDefaultLanguage()
                : this.config.language;
            I18n.currentLanguage = effectiveLanguage;
            if (!I18n.localeMessages[effectiveLanguage]) {
                const localeResponse = await fetch(chrome.runtime.getURL(`_locales/${effectiveLanguage}/messages.json`));
                if (localeResponse.ok) {
                    I18n.localeMessages[effectiveLanguage] = await localeResponse.json();
                }
            }
            I18n.clearCache();
            I18n.applyTranslations();
            document.documentElement.lang = effectiveLanguage;
            this.updateUI();
            this.updateCurrentPageInfo();
            this.setupEventListeners();
        } catch (error) {
            Logger.error('Error refreshing data:', error);
        }
    }

    async updateCurrentPageInfo() {
        const pageUrlNode = document.getElementById('current-page-url');
        if (!pageUrlNode) return;

        const tab = await this.getCurrentTab();
        pageUrlNode.textContent = tab?.url || 'about:blank';
    }

    setLoadingState(isLoading) {
        const buttons = document.querySelectorAll('button');
        buttons.forEach(btn => {
            btn.disabled = isLoading;
        });
    }

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `popup-notification ${type}`;
        notification.textContent = message;
        notification.style.cssText = `
            position: absolute;
            top: 10px;
            left: 50%;
            transform: translateX(-50%);
            padding: 8px 16px;
            border-radius: 4px;
            color: white;
            font-size: 12px;
            z-index: 1000;
            animation: fadeIn 0.3s ease;
        `;

        if (type === 'success') notification.style.background = 'var(--success, #137333)';
        else if (type === 'error') notification.style.background = 'var(--error, #d93025)';
        else notification.style.background = 'var(--primary-color, #1a73e8)';

        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), 3000);
    }

    showError(message) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.textContent = message;
        errorDiv.style.cssText = `
            padding: 20px;
            text-align: center;
            color: var(--error, #d93025);
        `;

        document.body.innerHTML = '';
        document.body.appendChild(errorDiv);
    }
}

const popupStyles = document.createElement('style');
popupStyles.textContent = `
    @keyframes fadeIn {
        from { opacity: 0; transform: translate(-50%, -10px); }
        to { opacity: 1; transform: translate(-50%, 0); }
    }
`;
document.head.appendChild(popupStyles);

document.addEventListener('DOMContentLoaded', () => {
    new PopupManager();
});
