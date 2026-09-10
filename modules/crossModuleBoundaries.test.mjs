// Щит кроссмодульной дисциплины (AGENTS.md, раздел «Cross-module discipline»).
//
// ЗАЧЕМ. Правило «не дублировать чужую ответственность, не импортировать внутренности соседа»
// записано в AGENTS.md и продублировано СПИСКАМИ ЧЕКБОКСОВ в модульных TASKS (link-domain-security
// Discussion 7, trigger-phrases 1.1/2.2, prompt-splitting 2.x). До этого файла его не проверял
// никто: правило жило в прозе, а нарушается оно одной строкой `import`.
//
// Чекбокс на таком правиле бессмыслен - он описывает прошлое. Инвариант либо удерживается прогоном,
// либо не удерживается вообще. Поэтому граница проверяется здесь, а в TASKS стоит ссылка.
//
// Что именно защищается: независимость находок. Два модуля, которые смотрят на одно и то же,
// выдадут два вердикта об одном явлении - и пользователь увидит одну проблему дважды, а корреляция,
// которой ещё нет, окажется сделанной наполовину и в неправильном месте.
// Запуск: node modules/crossModuleBoundaries.test.mjs

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const MODULES_DIR = new URL('./', import.meta.url);

// Живые content-модули. `api-interception` сюда не входит намеренно: его content-файл
// (`ApiInterceptor.js`) не грузится с Priority 7.3 и ждёт удаления по гейту 7.7 - проверять
// границы неисполняемого кода значит выдавать охват, которого нет (Priority 15 этого модуля).
const DETECTOR_MODULES = ['visual-manipulation', 'link-domain-security', 'trigger-phrases', 'prompt-splitting'];

// Общая инфраструктура, которую импортировать РАЗРЕШЕНО: ядро, общие утилиты и семантическое ядро.
// Последнее - единственный общий предмет двух текстовых модулей, и он не детектор: он не владеет ни
// DOM, ни lifecycle, ни findings (см. modules/semantic-analysis/boundaryContract.test.mjs).
const SHARED = ['ModuleCore.js', 'utils/', 'semantic-analysis/'];

async function collectSources(directory, collected = []) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
        if (entry.isDirectory()) {
            if (entry.name === 'tests') continue;
            await collectSources(child, collected);
            continue;
        }
        if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.mjs')) continue;
        collected.push({ path: child, name: entry.name, source: await readFile(child, 'utf8') });
    }
    return collected;
}

const sourcesByModule = new Map();
for (const moduleName of DETECTOR_MODULES) {
    sourcesByModule.set(moduleName, await collectSources(new URL(`${moduleName}/`, MODULES_DIR)));
}

// --- 1. Модуль не импортирует внутренности соседа ------------------------------------------------

for (const [moduleName, files] of sourcesByModule) {
    for (const file of files) {
        const imports = [...file.source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
        for (const specifier of imports) {
            if (!specifier.startsWith('.')) continue;
            const isShared = SHARED.some((allowed) => specifier.includes(allowed));
            const foreignModule = DETECTOR_MODULES.find(
                (other) => other !== moduleName && specifier.includes(`${other}/`)
            );
            assert.equal(
                Boolean(foreignModule) && !isShared,
                false,
                `${moduleName}/${file.name} импортирует внутренности модуля ${foreignModule}: независимые находки перестают быть независимыми`
            );
        }
    }
}

// --- 2. Модуль не знает про рантайм расширения ---------------------------------------------------
// Зависимость в эту сторону означала бы, что модуль нельзя прогнать в Node без content-скрипта, -
// а именно этим держатся все дифференциальные прогоны проекта.

for (const [moduleName, files] of sourcesByModule) {
    for (const file of files) {
        // Проверяются ИМПОРТЫ, а не текст файла: первая версия ловила упоминание `js/content.js` в
        // комментарии и объявляла зависимостью объяснение. Щит, срабатывающий на комментарий, учит
        // не писать комментарии, а не соблюдать границу.
        const imports = [...file.source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
        for (const specifier of imports) {
            assert.equal(
                /(^|\/)js\//.test(specifier),
                false,
                `${moduleName}/${file.name} импортирует рантайм (${specifier}): модуль обязан оставаться прогоняемым без него`
            );
        }
    }
}

// --- 3. Предмет принадлежит одному модулю --------------------------------------------------------
// URL, hostname и IDN - предмет link-domain-security. Вычисленные стили и геометрия - предмет
// visual-manipulation. Совпадение здесь означает два вердикта об одном явлении.

const SUBJECT_OWNERS = [
    { subject: 'разбор URL и hostname', owner: 'link-domain-security', markers: ['hostname', 'punycode', 'toASCII', 'new URL('] },
    { subject: 'вычисленные стили и геометрия', owner: 'visual-manipulation', markers: ['getComputedStyle', 'getBoundingClientRect', 'elementsFromPoint'] }
];

for (const { subject, owner, markers } of SUBJECT_OWNERS) {
    for (const [moduleName, files] of sourcesByModule) {
        if (moduleName === owner) continue;
        for (const file of files) {
            for (const marker of markers) {
                assert.equal(
                    file.source.includes(marker),
                    false,
                    `${moduleName}/${file.name} трогает ${subject} (${marker}), а это предмет модуля ${owner}`
                );
            }
        }
    }
}

// Владелец предмета обязан им действительно владеть: если разбор URL исчезнет из
// link-domain-security, проверка выше станет тавтологией и промолчит.
{
    const linkFiles = sourcesByModule.get('link-domain-security');
    assert.ok(
        linkFiles.some((file) => file.source.includes('hostname')),
        'link-domain-security обязан оставаться владельцем разбора hostname, иначе проверка владения ничего не значит'
    );
    const visualFiles = sourcesByModule.get('visual-manipulation');
    assert.ok(
        visualFiles.some((file) => file.source.includes('getComputedStyle')),
        'visual-manipulation обязан оставаться владельцем вычисленных стилей'
    );
}

// --- 4. Каждый модуль наследует одно ядро --------------------------------------------------------
// Второе «ядро» означало бы второй lifecycle, а lifecycle - это и есть то, чем оплачен инцидент
// с 54 вкладками.

for (const [moduleName, files] of sourcesByModule) {
    const entryPoint = files.find((file) => /^[A-Z]/.test(file.name) && file.source.includes('extends ModuleCore'));
    assert.ok(entryPoint, `${moduleName}: точка входа обязана наследовать ModuleCore`);
    assert.ok(
        entryPoint.source.includes("from '../ModuleCore.js'"),
        `${moduleName}/${entryPoint.name} обязан брать ядро из общего файла, а не из копии`
    );
}

console.log(`crossModuleBoundaries.test.mjs: ok (модулей ${DETECTOR_MODULES.length}, файлов ${[...sourcesByModule.values()].reduce((sum, files) => sum + files.length, 0)})`);
