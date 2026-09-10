import { Logger } from './logger.js';

export const I18n = {
    translationCache: new Map(),
    currentLanguage: null,
    localeMessages: {},
    supportedLanguages: ['en', 'ru'],

    getMessage(key, substitutions = []) {
        try {
            const cacheKey = this.getCacheKey(key, substitutions);
            if (this.translationCache.has(cacheKey)) {
                return this.translationCache.get(cacheKey);
            }

            const currentLang = this.getCurrentLanguage();
            const languageMessages = this.localeMessages[currentLang];
            let message = '';

            let safeSubstitutions = substitutions;
            if (safeSubstitutions !== undefined && safeSubstitutions !== null) {
                if (!Array.isArray(safeSubstitutions)) {
                    safeSubstitutions = [safeSubstitutions];
                }
                safeSubstitutions = safeSubstitutions.map(value => String(value));
                if (safeSubstitutions.length === 0) {
                    safeSubstitutions = undefined;
                }
            } else {
                safeSubstitutions = undefined;
            }

            if (languageMessages && languageMessages[key] && typeof languageMessages[key].message === 'string') {
                message = languageMessages[key].message;
                if (safeSubstitutions && safeSubstitutions.length > 0) {
                    message = message.replace(/\$(\d+)/g, (match, index) => {
                        const replacement = safeSubstitutions[Number(index) - 1];
                        return replacement !== undefined ? replacement : match;
                    });
                }
            } else {
                message = safeSubstitutions === undefined
                    ? chrome.i18n.getMessage(key)
                    : chrome.i18n.getMessage(key, safeSubstitutions);
            }

            if (message === '') {
                Logger.debug(`Translation not found for key: ${key}`);

                this.translationCache.set(cacheKey, key);
                return key;
            }

            this.translationCache.set(cacheKey, message);
            return message;

        } catch (error) {
            Logger.error(`Error getting message for key ${key}:`, error);
            return key;
        }
    },

    getCacheKey(key, substitutions) {
        return `${this.getCurrentLanguage()}-${key}-${JSON.stringify(substitutions)}`;
    },

    applyTranslations(element = document) {
        try {
            this.applyTextTranslations(element);
            this.applyAttributeTranslations(element);
            this.applyHTMLTranslations(element);

            Logger.debug('Translations applied successfully');

        } catch (error) {
            Logger.error('Error applying translations:', error);
        }
    },

    applyTextTranslations(element) {
        element.querySelectorAll('[data-i18n]').forEach(el => {
            try {
                const key = el.getAttribute('data-i18n');
                const args = el.getAttribute('data-i18n-args');

                let substitutions;
                if (args) {
                    try {
                        substitutions = JSON.parse(args);
                        if (!Array.isArray(substitutions)) {
                            substitutions = [substitutions];
                        }
                    } catch (parseError) {
                        Logger.warn(`Invalid JSON in data-i18n-args for key ${key}:`, args);
                        substitutions = [];
                    }
                }

                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                    el.value = this.getMessage(key, substitutions);
                } else {
                    el.textContent = this.getMessage(key, substitutions);
                }

            } catch (error) {
                Logger.error('Error applying text translation:', error);
            }
        });
    },

    applyAttributeTranslations(element) {
        const attributeMap = {
            'data-i18n-placeholder': 'placeholder',
            'data-i18n-title': 'title',
            'data-i18n-alt': 'alt',
            'data-i18n-aria-label': 'aria-label',
            'data-i18n-value': 'value',
            'data-i18n-tooltip': 'data-tooltip'
        };

        Object.entries(attributeMap).forEach(([dataAttr, htmlAttr]) => {
            element.querySelectorAll(`[${dataAttr}]`).forEach(el => {
                try {
                    const key = el.getAttribute(dataAttr);
                    const value = this.getMessage(key);

                    if (htmlAttr === 'value' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                        el.value = value;
                    } else {
                        el.setAttribute(htmlAttr, value);
                    }

                } catch (error) {
                    Logger.error(`Error applying ${htmlAttr} translation:`, error);
                }
            });
        });
    },

    applyHTMLTranslations(element) {
        element.querySelectorAll('[data-i18n-html]').forEach(el => {
            try {
                const key = el.getAttribute('data-i18n-html');
                const args = el.getAttribute('data-i18n-html-args');

                let substitutions;
                if (args) {
                    try {
                        substitutions = JSON.parse(args);
                    } catch (parseError) {
                        Logger.warn(`Invalid JSON in data-i18n-html-args for key ${key}:`, args);
                        substitutions = [];
                    }
                }

                el.innerHTML = this.getMessage(key, substitutions);

            } catch (error) {
                Logger.error('Error applying HTML translation:', error);
            }
        });
    },

    getBrowserLanguage() {
        try {
            return chrome.i18n.getUILanguage();
        } catch (error) {
            Logger.error('Error getting browser language:', error);
            return 'en';
        }
    },

    isLanguageSupported(langCode) {
        try {
            if (!langCode || typeof langCode !== 'string') {
                return false;
            }

            const normalized = langCode.toLowerCase();
            const base = normalized.split('-')[0];
            return this.supportedLanguages.includes(normalized) || this.supportedLanguages.includes(base);
        } catch (error) {
            Logger.error(`Error checking language support for ${langCode}:`, error);
            return false;
        }
    },

    getDefaultLanguage() {
        try {
            const browserLang = this.getBrowserLanguage();
            const baseLang = browserLang.split('-')[0]; // en-US → en

            if (this.isLanguageSupported(baseLang)) {
                this.currentLanguage = baseLang;
                return baseLang;
            }
            if (this.isLanguageSupported(browserLang)) {
                this.currentLanguage = browserLang;
                return browserLang;
            }

            Logger.warn(`No supported translation found for ${browserLang}, falling back to English`);
            this.currentLanguage = 'en';
            return 'en';

        } catch (error) {
            Logger.error('Error getting default language:', error);
            return 'en';
        }
    },

    getCurrentLanguage() {
        return this.currentLanguage || this.getDefaultLanguage();
    },

    clearCache() {
        this.translationCache.clear();
        Logger.debug('Translation cache cleared');
    },

    refreshTranslations(element = document) {
        this.clearCache();
        this.applyTranslations(element);
    }
};
