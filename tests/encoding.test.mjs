// Щит для C6.10 (корневой TASKS): правило «UTF-8, никакого мойбаке» записано в CLAUDE.md и
// AGENTS.md, но до этого теста его не проверял ни один детерминированный контракт - и порча в
// комментарии utils/i18n.js спокойно доехала до всех трёх сборок.
// Проверяется ровно то, что попадает в пакет (тот же фильтр, что у scripts/build-extension.mjs),
// плюс локали. Документация с примерами мойбаке (TASKS.ru.md) в пакет не входит и не проверяется.
// Запуск: node tests/encoding.test.mjs

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Те же корни и исключения, что и у сборщика: тест обязан смотреть на поставляемый набор файлов.
const RUNTIME_ROOTS = ['_locales', 'js', 'modules', 'platform', 'rules', 'styles', 'ui', 'utils'];
const EXCLUDED_DIRECTORY_NAMES = new Set(['tests', 'fixtures', 'manual-tests', '.git', '.agents', '.codex', 'dist', '_metadata']);
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css']);

// Последовательности, возникающие, когда UTF-8 прочитан как cp1251/latin-1 и записан снова как
// UTF-8. Ловим по паре символов, а не по одному: одиночная 'Ð' - легальная буква.
const MOJIBAKE_PATTERNS = [
    /[ÐÑ][\u0080-\u00BF\u0400-\u04FF]/u,
    /â€[\u0098-\u009F\u00A0-\u00BF™œ]/u,
    /Ã[\u0080-\u00BF]/u,
    /Â[\u00A0-\u00BF]/u,
    /[а-яА-Я]†’/u
];

async function collectFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) {
            continue;
        }
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectFiles(fullPath));
        } else if (TEXT_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith('.test.mjs')) {
            files.push(fullPath);
        }
    }
    return files;
}

const files = [path.join(projectRoot, 'manifest.json')];
for (const root of RUNTIME_ROOTS) {
    files.push(...await collectFiles(path.join(projectRoot, root)));
}

assert.equal(files.length > 50, true, 'набор поставляемых файлов подозрительно мал - проверь фильтр');

const strictDecoder = new TextDecoder('utf-8', { fatal: true });
const damaged = [];

for (const file of files) {
    const bytes = await readFile(file);
    const relativePath = path.relative(projectRoot, file);

    try {
        strictDecoder.decode(bytes);
    } catch {
        damaged.push(`${relativePath}: файл не является корректным UTF-8`);
        continue;
    }

    const text = bytes.toString('utf8');
    text.split(/\r?\n/).forEach((line, index) => {
        for (const pattern of MOJIBAKE_PATTERNS) {
            if (pattern.test(line)) {
                damaged.push(`${relativePath}:${index + 1}: ${line.trim().slice(0, 120)}`);
                return;
            }
        }
    });
}

assert.deepEqual(damaged, [], `мойбаке или битая кодировка в поставляемых файлах:\n${damaged.join('\n')}`);

// Локали дополнительно обязаны разбираться как JSON: BOM здесь допустим (он там исторически есть),
// а вот порча кодировки ломает разбор молча, уже в браузере.
for (const locale of ['en', 'ru']) {
    const localePath = path.join(projectRoot, '_locales', locale, 'messages.json');
    const raw = await readFile(localePath, 'utf8');
    JSON.parse(raw.replace(/^\uFEFF/, ''));
}

console.log(`Encoding contract checks passed (${files.length} shipped files)`);
