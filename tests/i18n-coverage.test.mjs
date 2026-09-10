// Щит для правила локализации из AGENTS.md: пользовательский текст идёт через _locales, и EN и RU
// правятся ОДНОЙ правкой. Забытый ключ не ломает ничего заметно - элемент просто остаётся с
// английской заглушкой из разметки или пустеет, поэтому без проверки такая потеря живёт до релиза.
// Проверяется пять вещей:
//   1. набор ключей EN и RU совпадает - перевод не отстаёт от оригинала;
//   2. ни одно сообщение не пустое;
//   3. каждый data-i18n из разметки есть в обеих локалях;
//   4. каждый ключ, названный строкой в JS (getMessage со строковым аргументом), есть в обеих
//      локалях - разметка это меньшая часть поверхности, а забытый ключ из кода даёт пустую строку
//      ровно так же тихо;
//   5. подстановки EN и RU совпадают - подстановка, потерянная в одном языке, уносит с собой число
//      или имя, но оставляет предложение грамматически целым, поэтому глазами это не ловится.
// Запуск: node tests/i18n-coverage.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readLocale(locale) {
    const raw = readFileSync(join(ROOT, '_locales', locale, 'messages.json'), 'utf8');
    // BOM в этих файлах есть и он намеренный - JSON.parse его не переваривает.
    return JSON.parse(raw.replace(/^﻿/, ''));
}

const en = readLocale('en');
const ru = readLocale('ru');

// --- 1. Наборы ключей совпадают ------------------------------------------------------------------

const enKeys = new Set(Object.keys(en));
const ruKeys = new Set(Object.keys(ru));

const missingInRu = [...enKeys].filter((key) => !ruKeys.has(key));
const missingInEn = [...ruKeys].filter((key) => !enKeys.has(key));

assert.deepEqual(missingInRu, [], `в RU нет ключей, которые есть в EN: ${missingInRu.join(', ')}`);
assert.deepEqual(missingInEn, [], `в EN нет ключей, которые есть в RU: ${missingInEn.join(', ')}`);

// --- 2. Пустых сообщений нет ---------------------------------------------------------------------

for (const [locale, data] of [['en', en], ['ru', ru]]) {
    for (const [key, entry] of Object.entries(data)) {
        assert.equal(
            typeof entry?.message === 'string' && entry.message.trim().length > 0,
            true,
            `${locale}: ключ ${key} пуст - это тот же забытый перевод, только незаметный`
        );
    }
}

// --- 3. Каждый data-i18n из разметки переведён ---------------------------------------------------

const uiDir = join(ROOT, 'ui');
const htmlFiles = readdirSync(uiDir).filter((name) => name.endsWith('.html'));
assert.equal(htmlFiles.length > 0, true, 'в ui/ обязаны быть html-файлы, иначе проверка бессмысленна');

let checkedKeys = 0;
for (const fileName of htmlFiles) {
    const html = readFileSync(join(uiDir, fileName), 'utf8');
    const keys = new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]));
    for (const key of keys) {
        assert.equal(enKeys.has(key), true, `${fileName}: ключ ${key} не переведён в EN`);
        assert.equal(ruKeys.has(key), true, `${fileName}: ключ ${key} не переведён в RU`);
        checkedKeys += 1;
    }
}

// --- 4. Каждый ключ, названный строкой в коде, переведён ----------------------------------------
// Разметка - меньшая часть поверхности: большинство сообщений просит код (уведомления popup, тексты
// находок, метки слоя вмешательства). Ключ, которого нет, даёт пустую строку так же тихо.

const SKIP_DIRECTORIES = new Set(['dist', '.git', '.agents', '.codex', 'node_modules', '_locales', 'release', '_metadata']);

function collectSourceFiles(directory, collected = []) {
    for (const name of readdirSync(directory)) {
        if (SKIP_DIRECTORIES.has(name)) continue;
        const full = join(directory, name);
        if (statSync(full).isDirectory()) {
            collectSourceFiles(full, collected);
            continue;
        }
        if (!/\.(js|mjs|cjs)$/.test(name)) continue;
        // Тесты сюда не входят: они называют ключи, которых может не быть, в том числе намеренно.
        if (name.includes('.test.')) continue;
        collected.push(full);
    }
    return collected;
}

const sourceFiles = collectSourceFiles(ROOT);
assert.ok(
    sourceFiles.length > 20,
    `исходников найдено подозрительно мало (${sourceFiles.length}) - обход сломан, и проверка ничего не значит`
);

let checkedCodeKeys = 0;
for (const file of sourceFiles) {
    const source = readFileSync(file, 'utf8');
    const keys = new Set([...source.matchAll(/getMessage\(\s*'([A-Za-z0-9_]+)'/g)].map((match) => match[1]));
    for (const key of keys) {
        assert.equal(enKeys.has(key), true, `${file}: ключ ${key} назван в коде, но отсутствует в EN - в интерфейсе будет пусто`);
        assert.equal(ruKeys.has(key), true, `${file}: ключ ${key} назван в коде, но отсутствует в RU`);
        checkedCodeKeys += 1;
    }
}
assert.ok(
    checkedCodeKeys > 50,
    `ключей из кода проверено подозрительно мало (${checkedCodeKeys}) - регулярное выражение перестало их находить`
);

// --- 5. Подстановки EN и RU совпадают -----------------------------------------------------------
// Подстановка, забытая в одном языке, не ломает вёрстку и не делает строку пустой: предложение
// остаётся целым, просто без числа. Поэтому глазами такое не ловится, а пользователь одного из
// языков видит текст, которому нечего сказать.

const SLOT_PATTERN = /\$([A-Za-z0-9_]+)\$/g;
const slotsOf = (message) => [...String(message || '').matchAll(SLOT_PATTERN)].map((match) => match[1].toLowerCase()).sort();
const declaredOf = (entry) => Object.keys(entry?.placeholders || {}).map((name) => name.toLowerCase()).sort();

for (const key of enKeys) {
    assert.deepEqual(
        slotsOf(ru[key].message),
        slotsOf(en[key].message),
        `${key}: подстановки в тексте EN и RU различаются - в одном из языков значение потеряется`
    );
    assert.deepEqual(
        declaredOf(ru[key]),
        declaredOf(en[key]),
        `${key}: объявленные placeholders EN и RU различаются`
    );
    for (const slot of slotsOf(en[key].message)) {
        assert.ok(
            declaredOf(en[key]).includes(slot),
            `${key}: подстановка используется в тексте, но не объявлена в placeholders - Chrome подставит пустоту (${slot})`
        );
    }
}

console.log(`i18n: ${enKeys.size} ключей в обеих локалях, ${checkedKeys} проверок из разметки ui/, ${checkedCodeKeys} из кода`);
