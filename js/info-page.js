import { I18n } from '../utils/i18n.js';
import { ConfigManager } from '../utils/config-manager.js';
import { ThemeManager } from '../utils/theme-manager.js';
import { Logger } from '../utils/logger.js';

async function initInfoPage() {
    try {
        await ThemeManager.init();

        const config = await ConfigManager.getConfig();
        const effectiveLanguage = config.language === 'auto'
            ? I18n.getDefaultLanguage()
            : config.language;

        I18n.currentLanguage = effectiveLanguage;
        if (!I18n.localeMessages[effectiveLanguage]) {
            const response = await fetch(chrome.runtime.getURL(`_locales/${effectiveLanguage}/messages.json`));
            if (response.ok) {
                I18n.localeMessages[effectiveLanguage] = await response.json();
            }
        }

        I18n.clearCache();
        document.documentElement.lang = effectiveLanguage;
        I18n.applyTranslations();
        await ThemeManager.applyThemeConfig(config.theme);

        const versionNode = document.getElementById('current-version-value');
        if (versionNode) {
            const manifest = chrome.runtime.getManifest();
            versionNode.textContent = manifest.version_name || manifest.version;
        }

        const openSettingsBtn = document.getElementById('open-settings-btn');
        if (openSettingsBtn) {
            openSettingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
        }
    } catch (error) {
        Logger.error('Failed to initialize info page:', error);
    }
}

document.addEventListener('DOMContentLoaded', initInfoPage);
