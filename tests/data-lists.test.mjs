// Щит для C7.2 (корневой TASKS): списки данных, которые устаревают молча.
// Проблема класса: в модулях живут оффлайновые таблицы - TLD, буквы-двойники, MIME-типы, теги
// HTML, - устаревание которых не проявляется НИКАК: ни падающим тестом, ни логом. Сверить их
// содержимое с внешним миром нельзя (правило «No network»), поэтому решение было принято такое:
// ревизия руками перед релизом, а направление отказа каждого списка записано рядом с ним.
// Автоматизировать нельзя содержимое - но можно требование «список задокументирован». Тег
// @data-list делает предрелизную ревизию грепом, а этот тест не даёт новому списку появиться молча.
// Запуск: node tests/data-lists.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODULES_DIR = join(ROOT, 'modules');

// Ниже этого размера набор - не таблица о внешнем мире, а деталь одной функции.
const MINIMUM_ENTRIES = 6;

const SKIP_DIRECTORIES = new Set(['fixtures', 'tests']);

function collectSourceFiles(directory) {
    const found = [];
    for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) {
            if (!SKIP_DIRECTORIES.has(entry)) {
                found.push(...collectSourceFiles(path));
            }
            continue;
        }
        if (entry.endsWith('.js') && !entry.endsWith('.test.js')) {
            found.push(path);
        }
    }
    return found;
}

const undocumented = [];
let documented = 0;

for (const path of collectSourceFiles(MODULES_DIR)) {
    const text = readFileSync(path, 'utf8');
    const lines = text.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
        const match = /^const ([A-Z][A-Z0-9_]{3,})\s*=\s*(new Set\(\[|\[)/.exec(lines[index]);
        if (!match) {
            continue;
        }

        // Размер набора: считаем запятые до закрывающей скобки, этого достаточно, чтобы отделить
        // таблицу от пары значений.
        const rest = lines.slice(index, index + 60).join('\n');
        const closing = rest.indexOf(match[2].startsWith('new Set') ? '])' : ']');
        const body = closing > 0 ? rest.slice(0, closing) : rest;
        const entries = (body.match(/,/g) || []).length + 1;
        if (entries < MINIMUM_ENTRIES) {
            continue;
        }

        // «Рядом» - это НЕПРЕРЫВНЫЙ блок комментария над объявлением, а не фиксированное число
        // строк: у самых важных списков объяснение занимает полтора десятка строк, и счётчик строк
        // отрезал бы именно их.
        let commentStart = index;
        while (commentStart > 0 && lines[commentStart - 1].trim().startsWith('//')) {
            commentStart -= 1;
        }
        const preceding = lines.slice(commentStart, index).join('\n');
        if (preceding.includes('@data-list')) {
            documented += 1;
        } else {
            undocumented.push(`${relative(ROOT, path).replace(/\\/g, '/')} :: ${match[1]} (${entries} элементов)`);
        }
    }
}

assert.deepEqual(
    undocumented,
    [],
    'у этих списков нет тега @data-list с направлением отказа - устаревание такого списка ничем себя не проявит:\n  '
    + undocumented.join('\n  ')
);

assert.equal(
    documented >= 15,
    true,
    `тест обязан находить сами списки, иначе он зелен впустую (найдено ${documented})`
);

console.log(`C7.2: ${documented} списков данных задокументированы тегом @data-list`);
