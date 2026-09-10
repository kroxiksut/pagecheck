// Щит для C5.5 (правило 1 в корневом TASKS) и для 11.1 модуля: корпус обязан хотя бы одним прогоном
// идти на ПОСТАВЛЯЕМОЙ ПО УМОЛЧАНИЮ политике, а не на литерале, собранном в тесте.
// Именно из-за отсутствия такого прогона дефект 11.1 дожил до ревью: PromptSplittingCorpus.test.mjs
// передаёт `{}` (то есть minimumConfidence 'moderate'), а поставляемый дефолт detectionThreshold 0.8
// отображается в 'strong' - и кейс, утверждаемый как «eligible», в продакшене был бы ineligible.
// Запуск: node modules/prompt-splitting/tests/PromptSplittingDefaultPolicy.test.mjs

import assert from 'node:assert/strict';

// --- минимальное окружение расширения ------------------------------------------------------------

globalThis.chrome = {
    runtime: { onInstalled: { addListener: () => {} }, lastError: undefined },
    storage: {
        sync: { get: (keys, cb) => cb({}), set: (values, cb) => cb(), remove: (keys, cb) => cb() },
        local: { get: (keys, cb) => cb({}), set: (values, cb) => cb(), remove: (keys, cb) => cb() }
    },
    i18n: { getMessage: () => '' }
};
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
};
globalThis.document = { documentElement: null };

const quietConsole = { ...console };
for (const level of ['info', 'warn', 'debug']) {
    console[level] = () => {};
}

const { ConfigManager } = await import('../../../utils/config-manager.js');
const { default: PromptSplitting } = await import('../PromptSplitting.js');
const { default: PromptDecisionEngine } = await import('../reconstruction/PromptDecisionEngine.js');
const { PROMPT_SPLITTING_CORPUS } = await import('./PromptSplittingCorpus.v1.mjs');

Object.assign(console, quietConsole);

// --- политика берётся из поставляемых дефолтов, а не из литерала ----------------------------------

const defaultModuleConfig = ConfigManager.getDefaultConfig().modules['Prompt-Splitting'];
assert.equal(typeof defaultModuleConfig?.detectionThreshold, 'number', 'у модуля обязан быть поставляемый порог');

const shippedPolicy = new PromptSplitting().createEffectiveConfig(defaultModuleConfig);
assert.equal(
    shippedPolicy.detectionThreshold,
    defaultModuleConfig.detectionThreshold,
    'политика обязана строиться из того же значения, что уходит пользователю'
);

// --- корпус на этой политике ----------------------------------------------------------------------

function buildCandidate(testCase) {
    const assemblyPath = testCase.assemblyPath || 'boundary-aware';
    const separator = assemblyPath === 'compact' ? '' : ' ';
    let offset = 0;
    const fragmentSpans = testCase.fragments.map((text, index) => {
        if (index > 0) offset += separator.length;
        const start = offset;
        offset += text.length;
        return { candidateId: `candidate-${index + 1}`, fragmentId: `fragment-${index + 1}`, start, end: offset };
    });
    const flags = {
        code: testCase.context?.code === true,
        quote: testCase.context?.quote === true,
        list: testCase.context?.list === true,
        navigation: testCase.context?.navigation === true
    };
    return {
        text: testCase.fragments.join(separator),
        sourceType: 'text',
        assemblyPath,
        regionId: `region-${testCase.id}`,
        candidateIds: testCase.fragments.map((_, index) => `candidate-${index + 1}`),
        candidateCount: testCase.fragments.length,
        fragmentCount: testCase.fragments.length,
        structuralContext: { type: 'section' },
        structuralTransitions: 0,
        context: { any: { ...flags }, all: { ...flags } },
        sequencing: { hasStructuralMarker: false },
        partial: testCase.partial === true,
        truncated: false,
        fragmentSpans,
        sourceFragments: testCase.fragments.map((text, index) => ({
            candidateId: `candidate-${index + 1}`,
            fragmentId: `fragment-${index + 1}`,
            text
        }))
    };
}

const eligibleUnderShippedPolicy = [];
for (const testCase of PROMPT_SPLITTING_CORPUS) {
    const result = await new PromptDecisionEngine().evaluate(buildCandidate(testCase), shippedPolicy, {
        limits: { maxElapsedMs: 1000 },
        isCurrent: () => true
    });
    const decision = result.decisions[0];
    if (decision?.eligibility === 'eligible') {
        eligibleUnderShippedPolicy.push(testCase.id);
    }
    // benign-кейсы обязаны оставаться неприемлемыми на любой политике
    if (testCase.kind === 'benign') {
        assert.notEqual(decision?.eligibility, 'eligible', `${testCase.id}: benign-кейс не должен проходить`);
    }
    result.dispose();
}

// Ключевая проверка: на поставляемой политике модуль выдаёт находки. Если это число когда-нибудь
// станет нулём, значит порог и уверенность снова разошлись так, что модуль молча выключился.
assert.equal(
    eligibleUnderShippedPolicy.length > 0,
    true,
    'на поставляемой по умолчанию политике корпус обязан давать хотя бы одну находку - иначе модуль включать бессмысленно'
);

// Все позитивные кейсы, которым корпус приписывает strong, обязаны проходить и на дефолте.
for (const testCase of PROMPT_SPLITTING_CORPUS) {
    if (testCase.kind !== 'positive' || testCase.expected.confidence !== 'strong') {
        continue;
    }
    assert.equal(
        eligibleUnderShippedPolicy.includes(testCase.id),
        true,
        `${testCase.id}: позитивный кейс с уверенностью strong обязан проходить на поставляемой политике`
    );
}

console.log(`PromptSplitting shipped-policy corpus checks passed (${eligibleUnderShippedPolicy.length} of ${PROMPT_SPLITTING_CORPUS.length} eligible)`);
