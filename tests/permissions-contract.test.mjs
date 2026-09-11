// Щит соответствия «что расширение просит» и «что оно вызывает».
//
// ЗАЧЕМ. Для расширения лишнее разрешение - это не косметика: оно расширяет поверхность атаки,
// показывается пользователю при установке и разбирается ревью магазина. Обратная ошибка тише и
// злее: вызов API без объявленного разрешения падает уже у пользователя, а на стендах молчит,
// потому что стенды подставляют заглушки.
//
// Модульный `api-interception` (Priority 9.4) ждёт ровно такой проверки формулировкой «final
// zero-caller audit». Разовый аудит устаревает в тот же день; проверка - нет.
//
// Три вещи:
//   1. Каждое объявленное разрешение имеет либо вызывающего в коде, либо ДЕКЛАРАТИВНОГО владельца
//      (ключ манифеста), либо стоит в списке кандидатов на удаление - молча висеть оно не может.
//   2. Каждое пространство имён `chrome.*`, которое трогает рантайм, либо не требует разрешения,
//      либо объявлено, либо объявлено опциональным.
//   3. `webRequest` остаётся опциональным и принадлежит одному владельцу - background-наблюдателю.
// Запуск: node tests/permissions-contract.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

// Пространства имён, доступные любому расширению без разрешения.
const FREE_NAMESPACES = new Set(['runtime', 'i18n', 'extension', 'action', 'windows', 'permissions']);

// Разрешения без вызывающих в JS, потому что ими пользуется САМ МАНИФЕСТ.
const DECLARATIVE_OWNERS = {
    declarativeNetRequest: 'declarative_net_request'
};

// Кандидаты на удаление: объявлены, но вызывающих нет. Список ПУСТ, и это состояние, а не забывчивость:
// `declarativeContent`, `scripting` и `activeTab` удалены из манифеста 2026-09-10 по итогам
// zero-caller аудита (api-interception 9.4). Если разрешение снова понадобится без вызывающих в JS,
// его место здесь - с причиной.
const REMOVAL_CANDIDATES = new Set([]);

// --- сбор фактических вызовов --------------------------------------------------------------------

const RUNTIME_DIRS = ['js', 'modules', 'utils', 'platform'];

function collectRuntimeFiles(directory, collected = []) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'tests') continue;
            collectRuntimeFiles(full, collected);
            continue;
        }
        if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
        collected.push(full);
    }
    return collected;
}

// Комментарии вырезаются: первая версия этой проверки увидела `browser.js` в комментарии и объявила
// несуществующее пространство имён `js`. Щит, срабатывающий на комментарий, учит не писать
// комментарии, а не соблюдать контракт.
function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const files = RUNTIME_DIRS.flatMap((dir) => collectRuntimeFiles(join(ROOT, dir)));
assert.ok(files.length > 20, `рантайм-файлов найдено подозрительно мало (${files.length}) - обход сломан`);

const callers = new Map();
for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'));
    // `chrome?.webRequest` тоже вызов: первая версия регулярного выражения требовала точку сразу
    // после `chrome` и не видела опциональную цепочку - а именно так наблюдатель берёт namespace.
    // `chrome?.webRequest` - тоже вызов: первая версия требовала точку сразу после `chrome` и не
    // видела опциональную цепочку, а именно так background-наблюдатель и берёт namespace.
    for (const match of source.matchAll(/\bchrome\??\.([a-z][A-Za-z0-9_]*)/g)) {
        if (!callers.has(match[1])) callers.set(match[1], new Set());
        callers.get(match[1]).add(file.slice(ROOT.length + 1));
    }
}
assert.ok(callers.has('runtime'), 'ни один файл не обращается к chrome.runtime - разбор вызовов сломан');

// --- 1. Объявленное разрешение имеет владельца ---------------------------------------------------

const declared = manifest.permissions || [];
assert.ok(declared.length > 0, 'манифест обязан объявлять хотя бы одно разрешение');

for (const permission of declared) {
    const hasCaller = callers.has(permission);
    const declarativeOwner = DECLARATIVE_OWNERS[permission];
    const isCandidate = REMOVAL_CANDIDATES.has(permission);

    if (declarativeOwner) {
        assert.ok(
            Object.hasOwn(manifest, declarativeOwner),
            `${permission}: объявлено как декларативное, но ключа ${declarativeOwner} в манифесте нет - разрешение висит впустую`
        );
        continue;
    }

    assert.ok(
        hasCaller || isCandidate,
        `${permission}: разрешение объявлено, вызывающих нет и в кандидатах на удаление оно не значится - лишняя поверхность атаки`
    );

    // Кандидат обязан оставаться без вызывающих: если они появились, статус «кандидат» устарел и
    // решение об удалении надо пересматривать осознанно, а не обнаруживать при удалении.
    if (isCandidate) {
        assert.equal(
            hasCaller,
            false,
            `${permission}: числится кандидатом на удаление, но вызывающие появились (${[...(callers.get(permission) || [])].join(', ')}) - обнови статус`
        );
    }
}

// Список кандидатов не имеет права устаревать: разрешение, которого в манифесте уже нет, не может
// быть «кандидатом на удаление». Ровно так устаревают все списки, которые никто не сверяет.
for (const candidate of REMOVAL_CANDIDATES) {
    assert.ok(
        declared.includes(candidate),
        `${candidate} числится кандидатом на удаление, но в манифесте его уже нет - убери запись`
    );
}

// --- 2. Вызываемое пространство имён объявлено ---------------------------------------------------

const optional = new Set(manifest.optional_permissions || []);
for (const [namespace, users] of callers) {
    if (FREE_NAMESPACES.has(namespace)) continue;
    assert.ok(
        declared.includes(namespace) || optional.has(namespace),
        `chrome.${namespace} вызывается (${[...users].slice(0, 3).join(', ')}), но не объявлено ни в permissions, ни в optional_permissions`
    );
}

// --- 3. webRequest: опциональный и с одним владельцем -------------------------------------------

{
    assert.equal(declared.includes('webRequest'), false, 'webRequest не имеет права быть обязательным: модуль выключен по умолчанию');
    assert.ok(optional.has('webRequest'), 'webRequest обязан оставаться опциональным разрешением');

    // Путь сравнивается в едином виде: разделитель зависит от системы, а владелец - нет.
    const users = [...(callers.get('webRequest') || [])].map((file) => file.split(/[\\/]/).join('/'));
    assert.deepEqual(
        users,
        ['modules/api-interception/runtime/ApiResourceObserver.js'],
        `webRequest обязан принадлежать одному владельцу - background-наблюдателю, а не ${users.join(', ') || '(никому)'}`
    );

    assert.deepEqual(
        manifest.optional_host_permissions,
        ['https://*/*', 'http://*/*'],
        'host-доступ наблюдателя обязан оставаться опциональным и минимальным'
    );
    assert.equal('host_permissions' in manifest, false, 'обязательного host-доступа у расширения быть не должно');
}

console.log(`permissions: объявлено ${declared.length}, опциональных ${optional.size}, пространств имён в коде ${callers.size}, кандидатов на удаление ${REMOVAL_CANDIDATES.size}`);
