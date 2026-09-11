// Щит обещания «расширение работает полностью локально».
//
// ЗАЧЕМ. Отсутствие сети - не деталь реализации, а главное свойство продукта: оно записано в README,
// в AGENTS.md и в описании для магазина, и именно оно позволяет анализировать страницу, ничего о ней
// не рассказывая. Держится это обещание сегодня ТОЛЬКО договорённостью: манифест не ограничивает
// `connect-src`, CSP расширения тоже, и один `fetch('https://...')`, добавленный из лучших
// побуждений (проверить домен по репутации, отправить телеметрию, подтянуть словарь), нарушит его
// молча - ни один прогон не покраснеет.
//
// Проверяется:
//   1. В рантайме нет сетевых примитивов вообще: XMLHttpRequest, sendBeacon, WebSocket, EventSource,
//      importScripts, navigator.connection и т.п.
//   2. Каждый `fetch` адресует ресурс РАСШИРЕНИЯ: либо `chrome.runtime.getURL(...)`, либо
//      относительный путь-литерал, либо переменная из объявленного ниже списка.
//   3. Нет `eval` и `new Function`: они запрещены CSP расширения и остаются способом выполнить
//      строку, пришедшую со страницы.
// Запуск: node tests/no-network-contract.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_DIRS = ['js', 'modules', 'utils', 'platform'];

// Переменные-аргументы `fetch`, про которые проверено, откуда они берутся.
const ALLOWED_FETCH_VARIABLES = {
    filePath: 'js/options.js, loadComponent(): путь приходит из захардкоженного списка компонентов в loadComponents().',
    themePath: 'utils/theme-manager.js: строится как `styles/themes/<тема>.css` из проверенного списка тем.'
};

const FORBIDDEN_PRIMITIVES = [
    'XMLHttpRequest',
    'sendBeacon',
    'WebSocket',
    'EventSource',
    'importScripts',
    'RTCPeerConnection',
    'navigator.connection'
];

function stripComments(source) {
    const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
    return withoutBlocks.split('\n').map((line) => {
        let quote = null;
        let out = '';
        for (let i = 0; i < line.length; i += 1) {
            const ch = line[i];
            if (quote) {
                out += ch;
                if (ch === '\\') { out += line[i + 1] || ''; i += 1; continue; }
                if (ch === quote) quote = null;
                continue;
            }
            if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
            if (ch === '/' && line[i + 1] === '/') break;
            out += ch;
        }
        return out;
    }).join('\n');
}

function collect(dir, acc = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'tests') continue;
            collect(full, acc);
            continue;
        }
        if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
        acc.push(full);
    }
    return acc;
}

const files = RUNTIME_DIRS.flatMap((dir) => collect(join(ROOT, dir)));
assert.ok(files.length > 20, `рантайм-файлов найдено подозрительно мало (${files.length}) - обход сломан`);

let fetchCalls = 0;

for (const file of files) {
    const relative = file.slice(ROOT.length + 1).split(sep).join('/');
    const source = stripComments(readFileSync(file, 'utf8'));

    // --- 1. Сетевые примитивы -------------------------------------------------------------------
    for (const primitive of FORBIDDEN_PRIMITIVES) {
        assert.equal(
            source.includes(primitive),
            false,
            `${relative}: ${primitive} - это сеть. Расширение обещает работать полностью локально, и обещание держится только кодом`
        );
    }

    // --- 3. Выполнение строк ---------------------------------------------------------------------
    assert.equal(/\beval\s*\(/.test(source), false, `${relative}: eval запрещён CSP расширения и остаётся способом выполнить строку со страницы`);
    assert.equal(/new\s+Function\s*\(/.test(source), false, `${relative}: new Function - тот же eval другими словами`);

    // --- 2. Адресат каждого fetch ----------------------------------------------------------------
    for (const match of source.matchAll(/fetch\(\s*([^)]{0,160})/g)) {
        fetchCalls += 1;
        const argument = match[1].trim();

        const isExtensionUrl = argument.startsWith('chrome.runtime.getURL(')
            || argument.startsWith('browser.runtime.getURL(')
            || argument.startsWith('chrome?.runtime')
            || /^['"`]\.{1,2}\//.test(argument);
        // Конец строки допустим наравне со скобкой и запятой: захват аргумента останавливается ПЕРЕД
        // закрывающей скобкой, поэтому `fetch(filePath)` доходит сюда как просто `filePath`.
        const variableName = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*([),]|$)/.exec(argument)?.[1];
        const isAllowedVariable = variableName && Object.hasOwn(ALLOWED_FETCH_VARIABLES, variableName);

        assert.ok(
            isExtensionUrl || isAllowedVariable,
            `${relative}: fetch(${argument.slice(0, 60)}...) адресует не ресурс расширения. Либо это сеть, либо переменную нужно объявить в ALLOWED_FETCH_VARIABLES с объяснением, откуда она берётся`
        );

        assert.equal(
            /https?:\/\//.test(argument),
            false,
            `${relative}: fetch с абсолютным адресом - это сеть: ${argument.slice(0, 80)}`
        );
    }
}

assert.ok(fetchCalls >= 5, `вызовов fetch найдено подозрительно мало (${fetchCalls}) - разбор сломан, и проверка зелена впустую`);

// --- 4. Манифест не просит сетевых возможностей --------------------------------------------------
// Обязательный host-доступ и `<all_urls>` в host_permissions - это разрешение ходить куда угодно.
// Единственный host-доступ проекта опциональный и принадлежит наблюдателю метаданных, который сам
// ничего не запрашивает, а только СЛУШАЕТ чужие запросы.

{
    const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    assert.equal('host_permissions' in manifest, false, 'обязательный host-доступ означал бы право ходить в сеть без спроса');
    assert.equal(
        (manifest.permissions || []).some((permission) => ['webRequest', 'webRequestBlocking', 'proxy'].includes(permission)),
        false,
        'сетевые разрешения не могут быть обязательными'
    );
    assert.deepEqual(
        manifest.optional_permissions,
        ['webRequest'],
        'единственное опциональное сетевое разрешение - webRequest наблюдателя метаданных'
    );
}

console.log(`no-network: файлов ${files.length}, вызовов fetch ${fetchCalls} (все к ресурсам расширения), сетевых примитивов 0`);
