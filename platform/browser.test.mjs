// Щит для кроссбраузерного шима хранилища (корневой TASKS C3: чистые хелперы без DOM).
// Файл маленький, но на нём держится вся persistence-часть Firefox-проекции, и до сих пор он не был
// покрыт ничем. Проверяется не «работает ли», а три вещи, каждая из которых уже была источником
// тихих отказов в этом проекте:
//   1. Chrome отвечает КОЛБЭКОМ, Firefox - ПРОМИСОМ. Перепутать пути - значит получить `undefined`
//      вместо значения и не узнать об этом.
//   2. `chrome.runtime.lastError` - единственный способ Chrome сообщить об ошибке записи: колбэк
//      всё равно вызывается, и без проверки провал выглядит как успех (тот же класс, что C6.2, где
//      debounce выбрасывал запись, отчитываясь об успехе).
//   3. Отсутствующая область хранилища обязана давать НАЗВАННУЮ ошибку, а не падение на `undefined`.
// Каждый путь берёт свой экземпляр модуля: пространство имён захватывается при загрузке, поэтому
// один импорт не может проверить оба браузера.
// Запуск: node platform/browser.test.mjs

import assert from 'node:assert/strict';

function makeChromeArea(record) {
    return {
        get(keys, callback) { record.push(['get', keys]); callback({ answer: 42 }); },
        set(values, callback) { record.push(['set', values]); callback(); },
        remove(keys, callback) { record.push(['remove', keys]); callback(); }
    };
}

// --- 1. Chrome: колбэк превращается в промис ------------------------------------------------------

{
    const calls = [];
    globalThis.browser = undefined;
    globalThis.chrome = {
        runtime: { lastError: undefined },
        storage: { local: makeChromeArea(calls), sync: makeChromeArea(calls) }
    };

    const { extensionStorage } = await import('./browser.js?case=chrome');

    assert.deepEqual(await extensionStorage.get('local', 'answer'), { answer: 42 }, 'колбэк Chrome обязан превращаться в разрешённый промис');
    await extensionStorage.set('sync', { answer: 42 });
    await extensionStorage.remove('local', 'answer');
    assert.deepEqual(
        calls,
        [['get', 'answer'], ['set', { answer: 42 }], ['remove', 'answer']],
        'аргументы обязаны доезжать до области хранилища без изменений'
    );
}

// --- 2. Chrome: lastError - это отказ, а не успех -------------------------------------------------

{
    globalThis.browser = undefined;
    globalThis.chrome = {
        runtime: { lastError: { message: 'QUOTA_BYTES_PER_ITEM quota exceeded' } },
        storage: {
            sync: {
                get(keys, callback) { callback({}); },
                set(values, callback) { callback(); },
                remove(keys, callback) { callback(); }
            }
        }
    };

    const { extensionStorage } = await import('./browser.js?case=chrome-error');

    await assert.rejects(
        () => extensionStorage.set('sync', { big: 'payload' }),
        /QUOTA_BYTES_PER_ITEM/,
        'Chrome зовёт колбэк и на провале: без проверки lastError отказ выглядел бы успехом'
    );
}

// --- 3. Firefox: промис не оборачивается в колбэк -------------------------------------------------

{
    let sawCallbackArgument = false;
    const promiseArea = {
        get(keys, maybeCallback) {
            sawCallbackArgument = sawCallbackArgument || typeof maybeCallback === 'function';
            return Promise.resolve({ answer: 7 });
        },
        set() { return Promise.resolve(); },
        remove() { return Promise.resolve(); }
    };
    globalThis.browser = { storage: { local: promiseArea } };
    globalThis.chrome = undefined;

    const { extensionStorage } = await import('./browser.js?case=firefox');

    assert.deepEqual(await extensionStorage.get('local', 'answer'), { answer: 7 }, 'промис Firefox обязан доезжать как есть');
    assert.equal(sawCallbackArgument, false, 'на промис-пути колбэк не передаётся: Firefox вернул бы промис И позвал колбэк, то есть сделал бы работу дважды');
}

// --- 4. Отсутствующая область хранилища: названная ошибка -----------------------------------------

{
    globalThis.browser = undefined;
    globalThis.chrome = { runtime: { lastError: undefined }, storage: { local: makeChromeArea([]) } };

    const { extensionStorage } = await import('./browser.js?case=missing-area');

    await assert.rejects(
        () => extensionStorage.get('session', 'answer'),
        /Storage area is unavailable: session/,
        'отсутствующая область обязана называть себя, а не падать на обращении к undefined'
    );
}

// --- 5. Исключение из области хранилища не оставляет висящий промис -------------------------------

{
    globalThis.browser = undefined;
    globalThis.chrome = {
        runtime: { lastError: undefined },
        storage: {
            local: {
                get() { throw new Error('extension context invalidated'); },
                set() { throw new Error('extension context invalidated'); },
                remove() { throw new Error('extension context invalidated'); }
            }
        }
    };

    const { extensionStorage } = await import('./browser.js?case=throwing');

    await assert.rejects(
        () => extensionStorage.get('local', 'answer'),
        /extension context invalidated/,
        'синхронное исключение обязано становиться отказом промиса: иначе вызывающий ждёт вечно'
    );
}

console.log('platform/browser.test.mjs: ok (колбэк Chrome, промис Firefox, lastError, отсутствующая область, исключение)');
