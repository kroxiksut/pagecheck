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
// Просматриваются ВСЕ каталоги рантайма, а не только modules/. Прежняя версия смотрела в modules/ и
// поэтому не видела `REVEAL_DECLARATIONS` в `js/intervention-layer.js` - таблицу CSS-свойств, которыми
// страница прячет текст. Таблица о внешнем мире не перестаёт ею быть от того, в каком каталоге лежит.
const SCANNED_DIRS = ['modules', 'js', 'utils', 'platform'].map((dir) => join(ROOT, dir));

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

// Смещение начала строки в тексте: нужно, чтобы считать элементы по исходнику, а не по срезу.
function offsetOf(linesArray, index) {
    let offset = 0;
    for (let i = 0; i < index; i += 1) offset += linesArray[i].length + 1;
    return offset;
}

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

// Считает элементы верхнего уровня литерала, начиная с открывающей скобки.
function countTopLevelEntries(source, openIndex) {
    let depth = 0;
    let entries = 0;
    let sawContent = false;
    let quote = null;
    for (let i = openIndex; i < source.length; i += 1) {
        const ch = source[i];
        if (quote) {
            if (ch === '\\') { i += 1; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; sawContent = true; continue; }
        if (ch === '[' || ch === '{' || ch === '(') { depth += 1; if (depth > 1) sawContent = true; continue; }
        if (ch === ']' || ch === '}' || ch === ')') {
            depth -= 1;
            if (depth === 0) return sawContent ? entries + 1 : 0;
            continue;
        }
        if (ch === ',' && depth === 1) { entries += 1; continue; }
        if (!/\s/.test(ch)) sawContent = true;
    }
    return 0;
}

const undocumented = [];
let documented = 0;

for (const path of SCANNED_DIRS.flatMap((dir) => collectSourceFiles(dir))) {
    const text = readFileSync(path, 'utf8');
    const lines = text.split(/\r?\n/);
    // Комментарии убираются ДО подсчёта: запятые в объяснении списка - не элементы списка.
    const stripped = stripComments(text);
    const strippedLines = stripped.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
        const match = /^const ([A-Z][A-Z0-9_]{3,})\s*=\s*(?:new Set\(|new Map\(|)\[/.exec(strippedLines[index]);
        if (!match) {
            continue;
        }

        // Размер набора считается по элементам ВЕРХНЕГО УРОВНЯ литерала. Прежняя версия считала все
        // запятые подряд в шестидесяти строках, и ошибалась в обе стороны: список из двух пар
        // выглядел шестёркой, а таблица из пятнадцати вложенных пар обрывалась на первой же `]` и
        // выглядела двойкой. Так `SCRIPT_PATTERNS` (15 письменностей Unicode) и прошёл мимо щита.
        const entries = countTopLevelEntries(stripped, offsetOf(strippedLines, index) + strippedLines[index].indexOf('['));
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

// Порог намеренно ниже прежних «19»: тот счёт был завышен подсчётом по запятым. Пятнадцать - это
// число списков, которые проходят порог при ЧЕСТНОМ подсчёте элементов верхнего уровня.

console.log(`C7.2: ${documented} списков данных задокументированы тегом @data-list`);
