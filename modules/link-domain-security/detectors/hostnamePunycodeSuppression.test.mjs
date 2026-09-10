// Щит для 6.11 модуля link-domain-security: один hostname не должен приходить пользователю дважды -
// точной находкой и общей. Punycode - это способ записи, а не сам дефект, поэтому при наличии
// точного сигнала (whole-script confusable или смешение скриптов) общая низкоприоритетная запись
// только дублирует ту же проблему менее точной формулировкой.
// Тот же класс, что visual-manipulation 8.12 (общий overlay поверх deceptive-capture-surface).
// Запуск: node modules/link-domain-security/detectors/hostnamePunycodeSuppression.test.mjs

import assert from 'node:assert/strict';

import { inspectCurrentHostname, inspectTargetHostname } from './hostnameSecurityDetector.js';

globalThis.window = { location: { hostname: 'xn--80ak6aa92e.com' } };

function createModule(analysis) {
    return {
        config: { detectHomographs: true },
        analyzeHostname: () => analysis,
        describeElement: () => '<a>'
    };
}

function typesOf(findings) {
    return findings.map((finding) => finding.type).sort();
}

const baseAnalysis = {
    originalHostname: 'аррӏе.com',
    normalizedHostname: 'xn--80ak6aa92e.com',
    hasPunycode: true,
    // Cyrillic name in a Latin zone: the script does not belong to the zone, so the notice is
    // relevant here (question В4 after Priority 7). The case where it is NOT is checked below.
    hasScriptZoneMismatch: true,
    hasMixedScript: false,
    hasWholeScriptConfusable: false
};

// --- punycode сам по себе по-прежнему сообщается -------------------------------------------------

assert.deepEqual(
    typesOf(inspectCurrentHostname({ module: createModule({ ...baseAnalysis }) })),
    ['hostname-punycode'],
    'punycode без точного сигнала информативен сам по себе и обязан оставаться'
);

// --- В4: имя, написанное письменностью собственной зоны, записи не даёт -------------------------
// `сахар.рф` - punycode есть, точных сигналов нет, но письменность имени и есть письменность зоны,
// поэтому сообщать не о чем. Это второе условие того же гейта, что и 6.11.

assert.deepEqual(
    typesOf(inspectCurrentHostname({
        module: createModule({
            ...baseAnalysis,
            originalHostname: 'сахар.рф',
            normalizedHostname: 'xn--80aa2cbv.xn--p1ai',
            hasScriptZoneMismatch: false
        })
    })),
    [],
    'имя в письменности своей зоны не повод для записи о punycode'
);

// --- при точном сигнале общая запись гасится ------------------------------------------------------

assert.deepEqual(
    typesOf(inspectCurrentHostname({
        module: createModule({ ...baseAnalysis, hasWholeScriptConfusable: true })
    })),
    ['hostname-confusable'],
    'whole-script confusable уже описывает проблему точнее: общая punycode-запись только дублирует её'
);

assert.deepEqual(
    typesOf(inspectCurrentHostname({
        module: createModule({ ...baseAnalysis, hasMixedScript: true })
    })),
    ['hostname-mixed-script'],
    'то же для смешения скриптов'
);

assert.deepEqual(
    typesOf(inspectCurrentHostname({
        module: createModule({ ...baseAnalysis, hasMixedScript: true, hasWholeScriptConfusable: true })
    })),
    ['hostname-confusable', 'hostname-mixed-script'],
    'два точных сигнала остаются оба - они описывают разные признаки'
);

// --- та же логика на ветке ссылок ------------------------------------------------------------------

const targetContext = (analysis) => ({
    element: {},
    targetUrl: { hostname: 'xn--80ak6aa92e.com' },
    hostnameAnalysis: analysis,
    module: createModule(analysis)
});

assert.deepEqual(
    typesOf(inspectTargetHostname(targetContext({ ...baseAnalysis }))),
    ['hostname-punycode'],
    'ветка ссылок: punycode без точного сигнала остаётся'
);

assert.deepEqual(
    typesOf(inspectTargetHostname(targetContext({ ...baseAnalysis, hasWholeScriptConfusable: true }))),
    ['hostname-confusable'],
    'ветка ссылок обязана вести себя так же, как ветка текущего хоста'
);

console.log('Hostname punycode suppression contract checks passed (6.11)');
