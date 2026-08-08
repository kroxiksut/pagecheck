// utils/theme-manager.js
import { Logger } from './logger.js';

export const ThemeManager = {
    currentTheme: null,
    styleElement: null,
    themeCache: new Map(),
    isInitialized: false,

    // Инициализация менеджера тем
    async init() {
        if (this.isInitialized) {
            Logger.debug('Theme manager already initialized');
            return;
        }

        try {
            this.styleElement = document.getElementById('dynamic-theme');
            if (!this.styleElement) {
                this.styleElement = document.createElement('style');
                this.styleElement.id = 'dynamic-theme';
                this.styleElement.setAttribute('data-theme', 'none');
                document.head.appendChild(this.styleElement);
            }

            // Настраиваем слушатель системной темы
            this.setupSystemThemeListener();

            this.isInitialized = true;
            Logger.debug('Theme manager initialized successfully');

        } catch (error) {
            Logger.error('Failed to initialize theme manager:', error);
            throw error;
        }
    },

    // Валидация имени темы
    isValidTheme(themeName) {
        const validThemes = ['light', 'dark', 'auto'];
        return validThemes.includes(themeName);
    },

    // Загрузка и применение темы
    async loadTheme(themeName) {
        if (!this.isInitialized) {
            await this.init();
        }

        if (!this.isValidTheme(themeName)) {
            Logger.warn(`Invalid theme name: ${themeName}. Using 'auto' instead.`);
            themeName = 'auto';
        }

        if (this.currentTheme === themeName) {
            Logger.debug(`Theme ${themeName} is already active`);
            return;
        }

        try {
            Logger.info(`Loading theme: ${themeName}`);

            if (themeName === 'light' || themeName === 'dark') {
                await this.loadSpecificTheme(themeName);
            } else if (themeName === 'auto') {
                await this.loadAutoTheme();
            }

            this.currentTheme = themeName;
            this.styleElement.setAttribute('data-theme', themeName);
            Logger.info(`Theme ${themeName} applied successfully`);

        } catch (error) {
            Logger.error('Error loading theme:', error);
            await this.loadFallbackTheme();
        }
    },

    // Загрузка конкретной темы
    async loadSpecificTheme(themeName) {
        // Проверяем кэш
        if (this.themeCache.has(themeName)) {
            this.styleElement.textContent = this.themeCache.get(themeName);
            this.updateBodyClasses(themeName);
            return;
        }

        // Загружаем из файла
        const themePath = `styles/themes/${themeName}.css`;
        const response = await fetch(chrome.runtime.getURL(themePath));

        if (!response.ok) {
            throw new Error(`Failed to load theme: ${response.status} ${response.statusText}`);
        }

        const css = await response.text();

        // Кэшируем и применяем
        this.themeCache.set(themeName, css);
        this.styleElement.textContent = css;
        this.updateBodyClasses(themeName);
    },

    // Загрузка auto-темы
    async loadAutoTheme() {
        const systemTheme = this.getSystemTheme();
        this.styleElement.textContent = '';
        this.updateBodyClasses('auto');

        // Загружаем соответствующую тему для auto-режима
        await this.loadSpecificTheme(systemTheme);
    },

    // Загрузка fallback-темы
    async loadFallbackTheme() {
        Logger.warn('Loading fallback theme');
        this.styleElement.textContent = '';
        this.updateBodyClasses('auto');
        this.currentTheme = 'auto';
    },

    // Обновление классов body для применения темы
    updateBodyClasses(themeName) {
        // Удаляем все theme классы
        document.body.classList.remove(
            'pagecheck-theme-light',
            'pagecheck-theme-dark',
            'pagecheck-theme-auto'
        );

        // Добавляем соответствующий класс
        if (themeName === 'light' || themeName === 'dark') {
            document.body.classList.add(`pagecheck-theme-${themeName}`);
        } else {
            document.body.classList.add('pagecheck-theme-auto');
        }
    },

    // Получение текущей темы системы
    getSystemTheme() {
        try {
            if (typeof window.matchMedia !== 'function') {
                Logger.warn('matchMedia not available, defaulting to light theme');
                return 'light';
            }

            return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        } catch (error) {
            Logger.error('Error getting system theme:', error);
            return 'light';
        }
    },

    // Применение темы based на настройках
    async applyThemeConfig(themeConfig) {
        if (!themeConfig || themeConfig === 'auto') {
            await this.loadTheme('auto');
        } else {
            await this.loadTheme(themeConfig);
        }
    },

    // Слушатель изменений системной темы (для auto режима)
    setupSystemThemeListener() {
        try {
            if (typeof window.matchMedia !== 'function') {
                Logger.warn('matchMedia not available, cannot setup theme listener');
                return;
            }

            const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

            const themeChangeHandler = (e) => {
                if (this.currentTheme === 'auto') {
                    Logger.debug('System theme changed, updating auto theme');
                    const newTheme = e.matches ? 'dark' : 'light';
                    this.loadSpecificTheme(newTheme);
                }
            };

            mediaQuery.addEventListener('change', themeChangeHandler);

            // Сохраняем ссылку для возможного удаления
            this.themeChangeHandler = themeChangeHandler;

            Logger.debug('System theme listener setup successfully');

        } catch (error) {
            Logger.error('Failed to setup system theme listener:', error);
        }
    },

    // Очистка ресурсов
    destroy() {
        if (this.themeChangeHandler) {
            const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
            mediaQuery.removeEventListener('change', this.themeChangeHandler);
        }

        this.themeCache.clear();
        this.isInitialized = false;
        Logger.debug('Theme manager destroyed');
    },

    // Получение текущей активной темы
    getCurrentTheme() {
        return this.currentTheme;
    },

    // Проверка, инициализирован ли менеджер
    isReady() {
        return this.isInitialized;
    }
};