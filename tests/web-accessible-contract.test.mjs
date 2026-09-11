// Щит доступности ресурсов, которые грузит content-скрипт.
//
// ЗАЧЕМ. Content-скрипт живёт в изолированном мире и всё, что подгружает по `chrome.runtime.getURL`,
// обязан объявить в `web_accessible_resources`. Ресурс, которого там нет, не загрузится - а
// импорты собраны в один `Promise.all`, поэтому падает не одна возможность, а ВЕСЬ content-скрипт:
// `init()` уходит в catch, `isInitialized` остаётся false, и ни один детектор не запускается ни на
// одной странице.
//
// Так и случилось: `js/intervention-layer.js` появился в импортах 2026-09-09 и не был добавлен в
// манифест. Ни один детерминированный прогон этого не видел и увидеть не мог - в Node модуль
// импортируется по обычному пути, без манифеста и без изоляции. Нашлось сверкой двух списков.
//
// Проверяется и ТРАНЗИТИВНАЯ цепочка: модуль, который импортирует сосед, браузер грузит так же.
// Запуск: node tests/web-accessible-contract.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

const patterns = (manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || []);
assert.ok(patterns.length > 0, 'манифест обязан объявлять web_accessible_resources');

// Шаблон Chrome: `*` не пересекает границу сегмента пути.
function toRegExp(pattern) {
    const escaped = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^${escaped.join('[^/]*')}$`);
}
const covers = (file) => patterns.some((pattern) => toRegExp(pattern).test(file));

// Здравость самой проверки: заведомо внутренний файл доступен быть не должен.
assert.equal(covers('js/background.js'), false, 'service worker не может быть доступен страницам - проверка сломана');

// --- 1. Всё, что content.js грузит напрямую ------------------------------------------------------

const contentSource = readFileSync(join(ROOT, 'js', 'content.js'), 'utf8');
const directlyLoaded = [...contentSource.matchAll(/getURL\('([^']+)'\)/g)].map((match) => match[1]);
assert.ok(directlyLoaded.length >= 6, `в content.js найдено подозрительно мало getURL (${directlyLoaded.length}) - разбор сломан`);

for (const file of directlyLoaded) {
    assert.ok(
        covers(file),
        `${file} грузится content-скриптом, но не объявлен в web_accessible_resources - импорт упадёт, а вместе с ним весь content-скрипт`
    );
    assert.ok(existsSync(join(ROOT, file.split('/').join(sep))), `${file} объявлен и грузится, но файла нет на диске`);
}

// --- 2. Транзитивные импорты -------------------------------------------------------------------

const visited = new Set();
function walkImports(relativeFile, depth = 0) {
    if (depth > 6 || visited.has(relativeFile)) return;
    const absolute = join(ROOT, relativeFile.split('/').join(sep));
    if (!existsSync(absolute)) return;
    visited.add(relativeFile);

    const source = readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
        const resolved = posix.normalize(posix.join(posix.dirname(relativeFile), match[1]));
        walkImports(resolved, depth + 1);
    }
}
for (const file of directlyLoaded.filter((name) => name.endsWith('.js'))) walkImports(file);

assert.ok(visited.size > 10, `транзитивных модулей найдено подозрительно мало (${visited.size}) - обход импортов сломан`);

const uncovered = [...visited].filter((file) => !covers(file));
assert.deepEqual(
    uncovered,
    [],
    `эти модули грузятся по цепочке импортов из content-скрипта, но страницам недоступны: ${uncovered.join(', ')}`
);

// --- 3. Доступное объявлено с ограничением по источникам -----------------------------------------
// `web_accessible_resources` без `matches` в MV3 невозможен, но пустой список источников сделал бы
// объявление бессмысленным, а звёздочка в ресурсах без ограничения источников - это раздача
// внутренностей кому угодно. Проверяем, что ограничение вообще есть.

for (const entry of manifest.web_accessible_resources) {
    assert.ok(
        Array.isArray(entry.matches) && entry.matches.length > 0,
        `блок web_accessible_resources без matches: ${JSON.stringify(entry.resources).slice(0, 80)}`
    );
}

console.log(`web accessible: шаблонов ${patterns.length}, прямых загрузок ${directlyLoaded.length}, транзитивных модулей ${visited.size}, недоступных 0`);
