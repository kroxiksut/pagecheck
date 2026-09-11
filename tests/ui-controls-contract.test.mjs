// Щит достижимости интерактивных контролов: кнопка, за которую код не может зацепиться, ничего не
// делает при нажатии.
//
// ЗАЧЕМ. Это тот же класс, что уже дал два дефекта: `allowIntervention` был чекбоксом без единого
// читателя, а чувствительность `prompt-splitting` - настройкой без контрола. Здесь третья форма:
// контрол есть, выглядит рабочим, и не привязан ни к чему. Для пользователя это неотличимо от
// сломанного расширения, а в прогоне не видно вообще: разметка и код лежат в разных файлах.
//
// Проверка: у каждого <button>, <input>, <select>, <textarea> в `ui/` есть за что зацепиться из
// кода - id, класс, `data-action` или `name`, который в коде упоминается. Всё, что не проходит,
// обязано быть в списке ниже с причиной.
// Запуск: node tests/ui-controls-contract.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Контролы без связи с кодом. Каждый - с причиной; список существует, чтобы мёртвые контролы не
// появлялись молча, а не чтобы их узаконить.
const DECLARED_UNBOUND = {
    'module-toggle': 'Ложная тревога по построению проверки: привязывается общим селектором `.module-card input, .module-card select`, а не по имени.',
    'help-btn': 'Шапка страницы настроек: обработчика нет. Раньше его давал встроенный <script> компонента, но выполниться тот не мог (innerHTML + CSP), и удалён 2026-09-10. Ждёт решения владельца: привязать или убрать.',
    feedback: 'Пункт выпадающего меню шапки, которое не раскрывается: обработчика нет. Ждёт решения вместе с шапкой.',
    'mobile-menu-btn': 'Кнопка мобильного меню в шапке: обработчика нет. Ждёт решения вместе с шапкой.'
};

function collect(dir, extension, acc = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { collect(full, extension, acc); continue; }
        if (entry.name.endsWith(extension) && !entry.name.includes('.test.')) acc.push(full);
    }
    return acc;
}

const htmlFiles = collect(join(ROOT, 'ui'), '.html');
const jsFiles = [...collect(join(ROOT, 'js'), '.js'), ...collect(join(ROOT, 'utils'), '.js')];
assert.ok(htmlFiles.length > 3, `html-файлов найдено подозрительно мало (${htmlFiles.length})`);
assert.ok(jsFiles.length > 3, `js-файлов найдено подозрительно мало (${jsFiles.length})`);

const jsBlob = jsFiles.map((file) => readFileSync(file, 'utf8')).join('\n');

const CONTROL_PATTERN = /<(button|input|select|textarea)\b([^>]*)>/gi;
const unbound = [];
let controls = 0;

for (const file of htmlFiles) {
    const html = readFileSync(file, 'utf8');
    for (const match of html.matchAll(CONTROL_PATTERN)) {
        const [, tag, attributes] = match;
        controls += 1;

        const id = (/\sid="([^"]+)"/.exec(attributes) || [])[1];
        const classes = ((/\sclass="([^"]+)"/.exec(attributes) || [])[1] || '').split(/\s+/).filter(Boolean);
        const dataAction = (/\sdata-action="([^"]+)"/.exec(attributes) || [])[1];
        const name = (/\sname="([^"]+)"/.exec(attributes) || [])[1];

        const handles = [id, dataAction, name, ...classes].filter(Boolean);
        const reachable = handles.some((handle) => jsBlob.includes(`'${handle}'`)
            || jsBlob.includes(`"${handle}"`)
            || jsBlob.includes(`#${handle}`)
            || jsBlob.includes(`.${handle}`));

        if (!reachable) {
            unbound.push({ file: file.slice(ROOT.length + 1).split(sep).join('/'), tag, handles });
        }
    }
}

assert.ok(controls > 20, `интерактивных контролов найдено подозрительно мало (${controls}) - разбор разметки сломан`);

// --- 1. Непривязанный контрол обязан быть объявлен ------------------------------------------------

for (const control of unbound) {
    const known = control.handles.find((handle) => Object.hasOwn(DECLARED_UNBOUND, handle));
    assert.ok(
        known,
        `${control.file}: <${control.tag}> (${control.handles.join(' | ') || 'без id и класса'}) не привязан ни к чему и не объявлен - при нажатии не произойдёт ничего, и пользователь решит, что расширение сломано`
    );
}

// --- 2. Список не имеет права устаревать ---------------------------------------------------------
// Контрол, который привязали, обязан уйти из списка: иначе список перестаёт означать «мёртвые» и
// становится свалкой, мимо которой смотрят.

const unboundHandles = new Set(unbound.flatMap((control) => control.handles));
for (const handle of Object.keys(DECLARED_UNBOUND)) {
    assert.ok(
        unboundHandles.has(handle),
        `${handle} объявлен непривязанным, но код его уже упоминает - убери запись, иначе список врёт`
    );
}

// --- 3. В компонентах не может быть встроенных скриптов ------------------------------------------
// Компоненты вставляются через `container.innerHTML` (js/options.js, loadComponent), а скрипты,
// добавленные через innerHTML, не выполняются по спецификации HTML. Вдобавок CSP расширения -
// `script-src 'self'` - запрещает встроенные скрипты на страницах расширения. Такой скрипт выглядит
// рабочим кодом и не является им: именно так интерактивность шапки оказалась мёртвой, а выглядела
// реализованной.

const componentFiles = htmlFiles.filter((file) => file.includes(`components${sep}`) || file.includes('components/'));
assert.ok(componentFiles.length > 0, 'компоненты обязаны находиться, иначе проверка бессмысленна');

for (const file of componentFiles) {
    // HTML-комментарии убираются: в них объясняется, почему встроенного скрипта здесь быть не должно,
    // и слово <script> в объяснении не является скриптом. Первая версия проверки сработала на
    // собственном комментарии.
    const html = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, ' ');
    assert.equal(
        /<script[\s>]/i.test(html),
        false,
        `${file.slice(ROOT.length + 1)}: встроенный <script> в компоненте никогда не выполнится (вставка через innerHTML + CSP script-src 'self') - вынеси обработчики в js/`
    );
}

// --- 4. Встроенных обработчиков событий нет ------------------------------------------------------
// onclick="..." запрещён той же CSP (`script-src 'self'` без 'unsafe-inline'), и неважно, где он
// написан - в разметке ui/ или в HTML-строке, которую код вставляет через innerHTML. Кнопка
// рисуется и молча не работает. Так три кнопки options (перезагрузка после ошибки загрузки и
// закрытие уведомления) были мёртвыми при зелёных проверках выше: те смотрят только в ui/.

const INLINE_HANDLER = /<[a-z][^>]*\son[a-z]+\s*=/i;
let inlineChecked = 0;
for (const file of [...htmlFiles, ...jsFiles]) {
    const text = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, ' ');
    const offending = text.split(/\r?\n/).filter((line) => INLINE_HANDLER.test(line) && !/^\s*\/\//.test(line));
    assert.deepEqual(
        offending.map((line) => line.trim()),
        [],
        `${file.slice(ROOT.length + 1)}: встроенный обработчик события не выполнится (CSP script-src 'self') - повесь его через addEventListener`
    );
    inlineChecked += 1;
}

console.log(`ui-контролы: ${controls} всего, ${unbound.length} без связи с кодом (все объявлены), компонентов без встроенных скриптов: ${componentFiles.length}, файлов без встроенных обработчиков: ${inlineChecked}`);
