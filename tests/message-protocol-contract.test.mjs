// Щит протокола сообщений между popup/options/content и background.
//
// ЗАЧЕМ. Действия - это строки на обеих сторонах, и никто их не сверял. Ошибка в одну букву даёт
// `{ error: 'Unknown action' }`, который никто не читает: отправитель получает ответ, тихо считает
// его неудачей и живёт дальше. Обратная сторона хуже: обработчик, которого никто не зовёт, остаётся
// доступным ЛЮБОМУ отправителю из контекста расширения. Проект уже защищался ровно от этого - см.
// комментарий у `handleScanPage` в `js/background.js`: до правки любой отправитель мог заставить
// произвольную фоновую вкладку выполнить полную работу детекторов в обход foreground-only.
//
// Две проверки:
//   1. Каждое отправляемое действие обрабатывается. Опечатка перестаёт быть тихой.
//   2. Каждый обработчик либо имеет отправителя в репозитории, либо ЯВНО объявлен ниже с причиной.
//      Список - не разрешение оставить мёртвый код, а способ не дать ему расти незаметно.
// Запуск: node tests/message-protocol-contract.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Файлы, которые участвуют в протоколе: отправляют, обрабатывают или и то и другое.
const SENDER_FILES = ['js/background.js', 'js/content.js', 'js/popup.js', 'js/options.js', 'utils/config-manager.js', 'utils/theme-manager.js'];
const HANDLER_FILES = ['js/background.js', 'js/content.js'];

// Обработчики без отправителя в репозитории. Каждый - с причиной, потому что «просто так исторически»
// это и есть то, что здесь ловится.
//
// Четыре ПИШУЩИХ обработчика без отправителей удалены 2026-09-10: `saveConfig`, `updateConfig`
// (дубликаты друг друга; конфигурация сохраняется напрямую через ConfigManager и доезжает до вкладок
// через storage.onChanged), `executeModuleAction` (вызывал произвольный метод модуля по имени) и
// `updateModules` (конфигурация доезжает через setPageLifecycle). Ниже остались только читающие.
const DECLARED_WITHOUT_SENDER = {
    runConfigSmokeCheck: 'Точка ручной диагностики: зовётся из консоли service worker, документирована в AI_CONTEXT.',
    getStats: 'Интроспекция только на чтение для отладки.',
    getTabModules: 'Интроспекция только на чтение для отладки.',
    getModuleState: 'Интроспекция только на чтение для отладки.',
    apiPermissionState: 'Интроспекция только на чтение: текущее состояние разрешения без транзакции.'
};

function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// Отрицательный просмотр назад обязателен: без него `transaction: 'idle'` читается как
// `action: 'idle'`, и щит сообщает о несуществующем действии. Первая версия этой проверки так и
// сделала.
const SENT_PATTERN = /(?<![A-Za-z])action:\s*'([A-Za-z0-9_]+)'/g;
const HANDLED_PATTERN = /case\s+'([A-Za-z0-9_]+)':/g;

function collect(files, pattern) {
    const found = new Map();
    for (const file of files) {
        const source = stripComments(readFileSync(join(ROOT, file), 'utf8'));
        for (const match of source.matchAll(pattern)) {
            if (!found.has(match[1])) found.set(match[1], new Set());
            found.get(match[1]).add(file);
        }
    }
    return found;
}

const sent = collect(SENDER_FILES, SENT_PATTERN);
const handled = collect(HANDLER_FILES, HANDLED_PATTERN);

assert.ok(sent.size > 5, `отправляемых действий найдено подозрительно мало (${sent.size}) - разбор сломан`);
assert.ok(handled.size > 5, `обработчиков найдено подозрительно мало (${handled.size}) - разбор сломан`);
assert.ok(sent.has('performScan'), 'разбор обязан видеть performScan - это опорное действие протокола');
assert.ok(handled.has('performScan'), 'performScan обязан иметь обработчик');

// --- 1. Отправляемое действие обрабатывается ----------------------------------------------------

for (const [action, senders] of sent) {
    assert.ok(
        handled.has(action),
        `действие ${action} отправляется (${[...senders].join(', ')}), но его никто не обрабатывает - отправитель получит { error: 'Unknown action' } и промолчит`
    );
}

// --- 2. Обработчик либо востребован, либо объявлен ------------------------------------------------

const orphanHandlers = [...handled.keys()].filter((action) => !sent.has(action));
for (const action of orphanHandlers) {
    assert.ok(
        Object.hasOwn(DECLARED_WITHOUT_SENDER, action),
        `обработчик ${action} (${[...handled.get(action)].join(', ')}) не имеет отправителя и не объявлен в списке - мёртвый обработчик остаётся доступным любому отправителю из контекста расширения`
    );
}

// Список не имеет права устаревать в другую сторону: действие, у которого появился отправитель,
// перестаёт быть «без отправителя», и запись о нём вводит в заблуждение.
for (const action of Object.keys(DECLARED_WITHOUT_SENDER)) {
    assert.ok(
        handled.has(action),
        `${action} объявлен как обработчик без отправителя, но обработчика уже нет - убери запись`
    );
    assert.equal(
        sent.has(action),
        false,
        `${action} объявлен как обработчик без отправителя, но отправитель появился (${[...(sent.get(action) || [])].join(', ')}) - убери запись`
    );
}

// --- 3. Неизвестное действие получает ответ, а не тишину -----------------------------------------
// Ветка default обязана существовать в обоих обработчиках: молчание вместо ответа оставляет
// отправителя ждать, а в MV3 это ещё и висящий порт.

for (const file of HANDLER_FILES) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    assert.ok(
        /default:\s*\n\s*response = \{ error: 'Unknown action'/.test(source),
        `${file}: у switch по действиям обязана быть ветка default с ответом об ошибке`
    );
}

console.log(`message protocol: отправляемых ${sent.size}, обработчиков ${handled.size}, без отправителя ${orphanHandlers.length} (все объявлены)`);
