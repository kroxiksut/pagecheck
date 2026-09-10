// Щит для C4.2: настройки с перечислимым значением обязаны валидироваться, а не проходить по typeof.
// До правки `validateSettingsValue` для не-массивных полей делал ровно одну проверку —
// `typeof value === typeof defaultValue`, — поэтому `activeRemediationAction` принимал ЛЮБУЮ строку.
// Рантайм это переживал только потому, что InterventionLayer.setAction() падает в `annotate` при
// незнакомом значении: последний рубеж обороны, а не причина подавать ему мусор.
// Главная проверка файла — не одно поле, а ПРАВИЛО: любая строковая настройка обязана иметь список
// допустимых значений. Именно так эта дыра и появилась — настройка добавилась, а правило нет.
// Запуск: node utils/settingsValidation.test.mjs

import assert from 'node:assert/strict';

globalThis.chrome = {
    runtime: { lastError: undefined, onInstalled: { addListener: () => {} } },
    storage: {
        sync: { get: (k, cb) => cb({}), set: (v, cb) => cb(), remove: (k, cb) => cb() },
        local: { get: (k, cb) => cb({}), set: (v, cb) => cb(), remove: (k, cb) => cb() }
    },
    i18n: { getMessage: () => '' }
};

const quietConsole = { ...console };
for (const level of ['info', 'warn', 'debug', 'error']) {
    console[level] = () => {};
}

const { ConfigManager } = await import('./config-manager.js');

const defaults = ConfigManager.getDefaultConfig();

// --- 1. ПРАВИЛО: у каждой строковой настройки есть список допустимых значений --------------------
// Проверяется поведением, а не чтением приватной таблицы: настройке скармливается заведомо
// недопустимая строка, и результат обязан вернуться к умолчанию. Настройка, добавленная без
// правила, провалит этот цикл в тот же день, когда появится.

const stringSettings = Object.entries(defaults.settings)
    .filter(([, value]) => typeof value === 'string')
    .map(([field]) => field);

assert.ok(stringSettings.length > 0, 'предусловие: строковые настройки обязаны существовать, иначе цикл ничего не проверяет');

for (const field of stringSettings) {
    const validated = ConfigManager.validateConfig({ settings: { [field]: 'definitely-not-a-valid-value' } });
    assert.equal(
        validated.settings[field],
        defaults.settings[field],
        `настройка ${field} принимает произвольную строку: у строковой настройки обязан быть список допустимых значений`
    );
}

// --- 2. Активное вмешательство: все три действия проходят, мусор — нет ---------------------------

for (const action of ['annotate', 'reveal', 'neutralize']) {
    const validated = ConfigManager.validateConfig({ settings: { activeRemediationAction: action } });
    assert.equal(validated.settings.activeRemediationAction, action, `действие ${action} обязано сохраняться как есть`);
}

for (const garbage of ['delete-everything', 'ANNOTATE', 'annotate ', '', 'reveal;neutralize']) {
    const validated = ConfigManager.validateConfig({ settings: { activeRemediationAction: garbage } });
    assert.equal(
        validated.settings.activeRemediationAction,
        'annotate',
        `недопустимое значение ${JSON.stringify(garbage)} обязано откатываться к безопасному умолчанию`
    );
}

// Тип, а не только значение: число или объект вместо действия — тоже мусор.
for (const wrongType of [3, null, { action: 'reveal' }, ['reveal'], true]) {
    const validated = ConfigManager.validateConfig({ settings: { activeRemediationAction: wrongType } });
    assert.equal(validated.settings.activeRemediationAction, 'annotate', 'значение неверного типа обязано откатываться к умолчанию');
}

// --- 3. Гейт остаётся закрытым по умолчанию, и мусор в действии его не открывает -----------------

assert.equal(defaults.settings.activeRemediationEnabled, false, 'гейт активного вмешательства обязан быть закрыт по умолчанию');
const withGarbageAction = ConfigManager.validateConfig({ settings: { activeRemediationAction: 'reveal-everything-always' } });
assert.equal(withGarbageAction.settings.activeRemediationEnabled, false, 'мусор в действии не имеет права открывать гейт');

// --- 4. Булевы настройки не превратились в enum по ошибке ---------------------------------------

const booleanSettings = Object.entries(defaults.settings)
    .filter(([, value]) => typeof value === 'boolean')
    .map(([field]) => field);

for (const field of booleanSettings) {
    const enabled = ConfigManager.validateConfig({ settings: { [field]: true } });
    assert.equal(enabled.settings[field], true, `булева настройка ${field} обязана сохранять true`);
    const wrong = ConfigManager.validateConfig({ settings: { [field]: 'true' } });
    assert.equal(wrong.settings[field], defaults.settings[field], `строка вместо булевой настройки ${field} обязана откатываться к умолчанию`);
}

// --- 5. Smoke-check рапортует о том же, что проверено выше ---------------------------------------
// Отчёт видит пользователь через runConfigSmokeCheck в background; проверка без отчёта не помогает
// тому, кто разбирается с чужим профилем.

const report = ConfigManager.runConfigSmokeCheck();
const checkNames = report.checks.map((check) => check.name);
for (const expected of [
    'default-activeRemediationAction-is-annotate',
    'invalid-activeRemediationAction-fallback',
    'valid-activeRemediationAction-preserved'
]) {
    assert.ok(checkNames.includes(expected), `smoke-check обязан содержать проверку ${expected}`);
}
assert.equal(report.checks.every((check) => check.passed === true), true, 'все проверки smoke-check обязаны проходить на дефолтной конфигурации');

Object.assign(console, quietConsole);
console.log(`settingsValidation.test.mjs: ok (строковых настроек ${stringSettings.length}, булевых ${booleanSettings.length}, проверок smoke-check ${report.checks.length})`);
