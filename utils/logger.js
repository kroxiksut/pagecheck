// utils/logger.js
class Logger {
    static logLevel = 'info';
    static isProduction = false;
    static logHistory = [];
    static maxHistorySize = 1000;
    static sensitiveKeywords = ['password', 'token', 'key', 'secret', 'auth', 'custompatterns'];

    // Уровни логирования. Значение слева пропускает всё, что не больше по числу;
    // 'silent' обрабатывается отдельно в shouldLog.
    static levels = { error: 0, warn: 1, info: 2, debug: 3 };
    static validLevels = ['error', 'warn', 'info', 'debug', 'silent'];

    // Инициализация логгера
    static init(config = {}) {
        // init присваивал config.logLevel без проверки, в отличие от setLevel. Неизвестный уровень
        // давал levels[this.logLevel] === undefined, а сравнение 0 <= undefined - false, поэтому
        // глушились ВСЕ уровни, включая error: логгер отключал именно тот канал, по которому его
        // поломку можно было бы заметить. Валидируем как в setLevel и падаем на 'error', а не в
        // тишину (TASKS C6.8).
        if (config.logLevel !== undefined) {
            if (this.validLevels.includes(config.logLevel)) {
                this.logLevel = config.logLevel;
            } else {
                const rejectedLevel = config.logLevel;
                this.logLevel = 'error';
                // Именно error, а не warn: после отката уровня warn уже не проходит, и
                // единственное сообщение о причине потери логов исчезло бы вместе с ними.
                this.error(`Invalid log level: ${rejectedLevel}. Falling back to 'error'.`);
            }
        }
        this.isProduction = config.isProduction || false;
        this.maxHistorySize = config.maxHistorySize || 1000;

        if (config.sensitiveKeywords) {
            this.sensitiveKeywords = [...this.sensitiveKeywords, ...config.sensitiveKeywords];
        }

        this.info('Logger initialized', { level: this.logLevel, production: this.isProduction });
    }

    // Установка уровня логирования
    static setLevel(level) {
        const validLevels = this.validLevels;
        if (validLevels.includes(level)) {
            this.logLevel = level;
            this.debug(`Log level changed to: ${level}`);
        } else {
            this.warn(`Invalid log level: ${level}. Valid levels: ${validLevels.join(', ')}`);
        }
    }

    // Логирование ошибок
    static error(message, ...args) {
        if (!this.shouldLog('error')) return;

        const processed = this.processArguments(message, args);
        console.error(`%c[PageCheck ERROR] ${processed.message}`, 'color: #ff4444; font-weight: bold;', ...processed.rest);
        this.saveToHistory('error', processed.message, processed.rest);
    }

    // Логирование предупреждений
    static warn(message, ...args) {
        if (!this.shouldLog('warn')) return;

        const processed = this.processArguments(message, args);
        console.warn(`%c[PageCheck WARN] ${processed.message}`, 'color: #ffbb33; font-weight: bold;', ...processed.rest);
        this.saveToHistory('warn', processed.message, processed.rest);
    }

    // Логирование информации
    static info(message, ...args) {
        if (!this.shouldLog('info')) return;

        const processed = this.processArguments(message, args);
        console.info(`%c[PageCheck INFO] ${processed.message}`, 'color: #33b5e5;', ...processed.rest);
        this.saveToHistory('info', processed.message, processed.rest);
    }

    // Логирование отладки
    static debug(message, ...args) {
        if (!this.shouldLog('debug')) return;

        const processed = this.processArguments(message, args);
        console.debug(`%c[PageCheck DEBUG] ${processed.message}`, 'color: #aaa; font-style: italic;', ...processed.rest);
        this.saveToHistory('debug', processed.message, processed.rest);
    }

    // Группировка логов
    static group(label, collapsed = false) {
        if (collapsed) {
            console.groupCollapsed(`%c[PageCheck GROUP] ${label}`, 'color: #2BBBAD;');
        } else {
            console.group(`%c[PageCheck GROUP] ${label}`, 'color: #2BBBAD;');
        }
    }

    static groupEnd() {
        console.groupEnd();
    }

    // Проверка необходимости логирования
    static shouldLog(level) {
        if (this.logLevel === 'silent') return false;

        const levels = this.levels;
        // Второй рубеж на случай прямого присваивания полю в обход init/setLevel: неизвестный
        // уровень не должен глушить ошибки.
        const threshold = Object.hasOwn(levels, this.logLevel) ? levels[this.logLevel] : levels.error;

        return levels[level] <= threshold;
    }

    // Обработка аргументов
    static processArguments(message, args) {
        let processedMessage = this.sanitizeData(message);
        const processedArgs = args.map(arg => this.sanitizeData(arg));

        // Обработка объектов Error
        if (typeof message === 'object' && message instanceof Error) {
            processedMessage = this.formatError(message);
            return { message: processedMessage, rest: processedArgs };
        }

        // Обработка остальных аргументов
        return { message: processedMessage, rest: processedArgs };
    }

    // Санитизация чувствительных данных
    static sanitizeData(data) {
        if (typeof data !== 'object' || data === null) {
            return this.sanitizeString(String(data));
        }

        if (data instanceof Error) {
            return data;
        }

        // Глубокое копирование и санитизация объекта
        try {
            const sanitized = JSON.parse(JSON.stringify(data));
            return this.sanitizeObject(sanitized);
        } catch {
            return '[Circular or unserializable object]';
        }
    }

    // Санитизация объекта
    static sanitizeObject(obj) {
        if (Array.isArray(obj)) {
            return obj.map(item => this.sanitizeData(item));
        }

        if (typeof obj === 'object' && obj !== null) {
            const result = {};
            for (const [key, value] of Object.entries(obj)) {
                if (this.sensitiveKeywords.some(kw =>
                    key.toLowerCase().includes(kw.toLowerCase()))) {
                    result[key] = '***REDACTED***';
                } else {
                    result[key] = this.sanitizeData(value);
                }
            }
            return result;
        }

        return obj;
    }

    // Санитизация строки
    static sanitizeString(str) {
        this.sensitiveKeywords.forEach(keyword => {
            const regex = new RegExp(`(${keyword}=)([^&\\s]+)`, 'gi');
            str = str.replace(regex, `$1***REDACTED***`);
        });
        return str;
    }

    // Форматирование ошибок
    static formatError(error) {
        if (!(error instanceof Error)) {
            return String(error);
        }

        return `${error.name}: ${error.message}\n${this.cleanStack(error.stack)}`;
    }

    // Очистка stack trace
    static cleanStack(stack) {
        if (!stack) return 'No stack trace';

        // Убираем лишние детали для production
        if (this.isProduction) {
            return stack.split('\n')
                .slice(0, 3) // Только первые 3 строки
                .join('\n');
        }

        return stack;
    }

    // Сохранение в историю
    static saveToHistory(level, message, args) {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            args: args.length > 0 ? args : undefined
        };

        this.logHistory.push(entry);

        // Ограничение размера истории
        if (this.logHistory.length > this.maxHistorySize) {
            this.logHistory = this.logHistory.slice(-this.maxHistorySize);
        }
    }

    // Получение истории логов
    static getHistory(limit = 50) {
        return this.logHistory.slice(-limit);
    }

    // Очистка истории
    static clearHistory() {
        this.logHistory = [];
        this.debug('Log history cleared');
    }

    // Экспорт логов
    static exportLogs(format = 'json') {
        try {
            switch (format) {
                case 'json':
                    return JSON.stringify(this.logHistory, null, 2);
                case 'text':
                    return this.logHistory.map(entry =>
                        `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`
                    ).join('\n');
                default:
                    throw new Error(`Unsupported format: ${format}`);
            }
        } catch (error) {
            this.error('Failed to export logs:', error);
            return null;
        }
    }

    // Производительность
    static time(label) {
        if (this.shouldLog('debug')) {
            console.time(`[PageCheck TIMER] ${label}`);
        }
    }

    static timeEnd(label) {
        if (this.shouldLog('debug')) {
            console.timeEnd(`[PageCheck TIMER] ${label}`);
        }
    }
}

// Автоматическая инициализация
Logger.init();

export { Logger };
