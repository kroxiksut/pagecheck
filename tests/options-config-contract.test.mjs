// Щит соответствия «что показывает options» и «что хранит ConfigManager».
//
// ЗАЧЕМ. Этот класс дефектов проект уже ловил дважды, и оба раза случайно:
//   - `allowIntervention` жил чекбоксом в options, не читался НИКЕМ в рантайме и обещал контроль,
//     которого нет;
//   - `sensitivity` у `prompt-splitting` управляла семантической допустимостью находки, хранилась в
//     конфиге, но в интерфейс не выводилась - то есть навсегда оставалась `medium`.
// Обе ошибки - одна и та же рассинхронизация двух списков, которые никто не сверял.
//
// Проверяется два направления:
//   1. Поле, показанное пользователю, обязано существовать в дефолтах. Иначе `validateConfig`
//      молча выбросит его при сохранении: пользователь настройку меняет, а до рантайма она не едет.
//   2. Ключ, который хранится, обязан быть показан - кроме трёх структурных (`enabled` управляется
//      карточкой модуля, `name`/`description` это метаданные, а не настройки). Скрытый ключ, который
//      влияет на детект, - это настройка, до которой пользователь не может дотянуться.
//
// Схема ВЫЧИСЛЯЕТСЯ, а не разбирается регулярками: первая версия этого аудита парсила текст и выдала
// три ложных сигнала подряд (общие поля `sensitivity`/`action` объявлены переменными, ветка по
// умолчанию не отделялась от предыдущей). Проверка, которая врёт, хуже отсутствующей.
// Запуск: node tests/options-config-contract.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const MODULE_IDS = {
    VISUAL_MANIPULATION: 'Hidden-Content-Visual-Manipulation',
    LINK_DOMAIN_SECURITY: 'Link-Domain-Security',
    TRIGGER_PHRASES: 'Trigger-Phrases',
    PROMPT_SPLITTING: 'Prompt-Splitting',
    API_INTERCEPTOR: 'Api-Interceptor'
};

// Структурные ключи: не настройки детекции, и в списке полей им делать нечего.
const STRUCTURAL_KEYS = new Set(['enabled', 'name', 'description']);

function extractBody(source, startMarker, endMarker, name) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `${name}: не найдено начало (${startMarker})`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, `${name}: не найден конец (${endMarker})`);
    return source.slice(start + startMarker.length, end);
}

// --- схема options -------------------------------------------------------------------------------

const optionsSource = readFileSync(join(ROOT, 'js', 'options.js'), 'utf8');
const schemaBody = extractBody(optionsSource, '    getSchema(moduleKey) {', '\n    populateForm()', 'getSchema')
    .replace(/\}\s*$/, '');
const getSchema = vm.runInNewContext(`(function (moduleKey) {${schemaBody}})`, Object.create(null));

function renderedKeys(moduleId) {
    const sections = getSchema(moduleId);
    assert.ok(Array.isArray(sections) && sections.length > 0, `${moduleId}: схема пуста - пользователю нечего настраивать`);
    const keys = new Set();
    for (const section of sections) {
        for (const field of section.fields || []) {
            if (field && typeof field.key === 'string') keys.add(field.key);
        }
    }
    return keys;
}

// --- дефолты ConfigManager -----------------------------------------------------------------------

const configSource = readFileSync(join(ROOT, 'utils', 'config-manager.js'), 'utf8');
const defaultsBody = extractBody(configSource, '    getDefaultConfig() {', '\n    async clearConfig()', 'getDefaultConfig')
    .replace(/\}\s*,?\s*$/, '');
const defaults = vm.runInNewContext(`(function (MODULE_IDS) {${defaultsBody}})`, Object.create(null))(MODULE_IDS);

assert.ok(defaults?.modules, 'дефолты обязаны содержать блок modules');
assert.equal(
    Object.keys(defaults.modules).length,
    Object.keys(MODULE_IDS).length,
    'число модулей в дефолтах разошлось со списком этого щита - обнови обе стороны осознанно'
);

// --- 1. Показанное поле обязано храниться --------------------------------------------------------

for (const moduleId of Object.values(MODULE_IDS)) {
    const rendered = renderedKeys(moduleId);
    const stored = new Set(Object.keys(defaults.modules[moduleId] || {}));
    assert.ok(stored.size > 0, `${moduleId}: в дефолтах нет ни одного ключа`);

    const orphans = [...rendered].filter((key) => !stored.has(key));
    assert.deepEqual(
        orphans,
        [],
        `${moduleId}: поля показаны пользователю, но не хранятся в конфигурации - validateConfig выбросит их при сохранении: ${orphans.join(', ')}`
    );
}

// --- 2. Хранимый ключ обязан быть показан --------------------------------------------------------

for (const moduleId of Object.values(MODULE_IDS)) {
    const rendered = renderedKeys(moduleId);
    const stored = Object.keys(defaults.modules[moduleId] || {});
    const hidden = stored.filter((key) => !rendered.has(key) && !STRUCTURAL_KEYS.has(key));
    assert.deepEqual(
        hidden,
        [],
        `${moduleId}: настройки хранятся и влияют на модуль, но пользователь до них не дотянется: ${hidden.join(', ')}`
    );
}

// --- 3. Настройки уровня settings, которые читает options, существуют ----------------------------

{
    const settingsKeys = new Set(Object.keys(defaults.settings || {}));
    assert.ok(settingsKeys.size > 0, 'дефолты обязаны содержать блок settings');
    const readInUi = new Set(
        [...optionsSource.matchAll(/(?:config|this\.config)\??\.settings\??\.([A-Za-z0-9_]+)/g)].map((match) => match[1])
    );
    assert.ok(readInUi.size > 0, 'options.js обязан читать хоть одну настройку уровня settings, иначе проверка бессмысленна');
    const orphans = [...readInUi].filter((key) => !settingsKeys.has(key));
    assert.deepEqual(
        orphans,
        [],
        `options.js читает настройки, которых нет в дефолтах: ${orphans.join(', ')}`
    );
}

// --- 4. Чувствительность есть у каждого детектора ------------------------------------------------
// Отдельная проверка, потому что именно её отсутствие у `prompt-splitting` и было дефектом: набор
// модулей растёт, и «у всех есть, а у нового забыли» - самый вероятный способ повторить.

for (const moduleId of Object.values(MODULE_IDS)) {
    const stored = new Set(Object.keys(defaults.modules[moduleId] || {}));
    if (!stored.has('sensitivity')) continue;
    assert.ok(
        renderedKeys(moduleId).has('sensitivity'),
        `${moduleId}: чувствительность хранится и влияет на детект, но не выведена в интерфейс`
    );
}

console.log(`options/config: ${Object.keys(MODULE_IDS).length} модулей, расхождений нет`);
