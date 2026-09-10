// Щит для правила локализации из AGENTS.md: пользовательский текст идёт через _locales, и EN и RU
// правятся ОДНОЙ правкой. Забытый ключ не ломает ничего заметно - элемент просто остаётся с
// английской заглушкой из разметки или пустеет, поэтому без проверки такая потеря живёт до релиза.
// Проверяется три вещи:
//   1. каждый data-i18n из разметки есть в обеих локалях;
//   2. набор ключей EN и RU совпадает - перевод не отстаёт от оригинала;
//   3. ни одно сообщение не пустое.
// Запуск: node tests/i18n-coverage.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

console.log(`i18n: ${enKeys.size} ключей в обеих локалях, ${checkedKeys} проверок из разметки ui/`);
