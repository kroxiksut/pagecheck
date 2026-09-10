// Shield for the open findings API gates (TASKS C4.7). The whole external surface is a pure
// function, so every gate is pinned here without a browser.
// Run: node js/findings-api.test.mjs
//
// Contract pinned here:
//  - Gate order and, more importantly, that EVERY refusal looks identical: a caller must not be
//    able to tell whether the channel is off, whether it is allowlisted, or whether a tab exists.
//  - Nothing writable is reachable: only the two read-only actions are accepted.
//  - Page-originated messages are refused even if Chrome ever delivers them.
//  - Only the foreground tab is served; naming another tab is refused, not redirected.
//  - Responses carry no DOM references and no raw page text, and the URL is cut to origin+pathname.

import assert from 'node:assert/strict';
import {
    FINDINGS_API_ACTIONS,
    FINDINGS_API_SCHEMA_VERSION,
    createRateLimiter,
    handleFindingsApiRequest,
    normalizePageIdentity,
    serializeFindings,
    serializeContext
} from './findings-api.js';

const ALLOWED_ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';

const makeConfig = ({ enabled = true, allowlist = [ALLOWED_ID] } = {}) => ({
    settings: {
        findingsApiEnabled: enabled,
        findingsApiAllowedExtensionIds: allowlist
    }
});

const makeForeground = () => ({
    tabId: 7,
    url: 'https://example.com/docs/page?session=secret#part',
    status: 'issues',
    totalFindings: 3,
    stale: false,
    updatedAt: 1700000000000,
    frameSnapshot: {
        visualFindings: [
            {
                type: 'hidden-text',
                severity: 'medium',
                summary: 'Potential hidden text via display: none',
                details: 'div#sect [display:none on container (computed); ...]',
                detector: 'hiddenTextDetector'
            }
        ],
        linkFindings: [
            { type: 'punycode-domain', severity: 'high', summary: 'Suspicious domain', detector: 'linkDomain' }
        ],
        triggerFindings: [
            { type: 'trigger-phrase', severity: 'low', summary: 'Instruction-like phrase', detector: 'triggerPhrases' }
        ],
        partialModules: ['Trigger-Phrases']
    }
});

const makeContext = (overrides = {}) => ({
    config: makeConfig(),
    extensionVersion: '0.0.1',
    rateLimiter: createRateLimiter(),
    now: 1000,
    getForegroundSnapshot: () => makeForeground(),
    ...overrides
});

const SENDER = { id: ALLOWED_ID };
const REFUSAL = { ok: false, error: 'unavailable' };
const getFindings = { action: FINDINGS_API_ACTIONS.GET_FINDINGS };

// --- every gate refuses, and refuses identically -----------------------------

assert.deepEqual(
    handleFindingsApiRequest(getFindings, SENDER, makeContext({ config: makeConfig({ enabled: false }) })),
    REFUSAL,
    'channel disabled -> refusal'
);

assert.deepEqual(
    handleFindingsApiRequest(getFindings, SENDER, makeContext({ config: makeConfig({ allowlist: [] }) })),
    REFUSAL,
    'empty allowlist means nobody, even with the channel enabled'
);

assert.deepEqual(
    handleFindingsApiRequest(getFindings, { id: OTHER_ID }, makeContext()),
    REFUSAL,
    'sender outside the allowlist -> refusal'
);

assert.deepEqual(
    handleFindingsApiRequest(getFindings, {}, makeContext()),
    REFUSAL,
    'sender without an id -> refusal'
);

assert.deepEqual(
    handleFindingsApiRequest({ action: 'saveConfig' }, SENDER, makeContext()),
    REFUSAL,
    'an internal write action is not reachable from outside'
);

for (const writeAction of ['updateConfig', 'toggleModule', 'apiPermissionCommit', 'executeModuleAction', 'scanPage']) {
    assert.deepEqual(
        handleFindingsApiRequest({ action: writeAction }, SENDER, makeContext()),
        REFUSAL,
        `${writeAction} is not part of the external surface`
    );
}

assert.deepEqual(
    handleFindingsApiRequest({ action: '' }, SENDER, makeContext()),
    REFUSAL,
    'missing action -> refusal'
);

assert.deepEqual(
    handleFindingsApiRequest(getFindings, { id: ALLOWED_ID, tab: { id: 3 } }, makeContext()),
    REFUSAL,
    'a message carrying a tab context comes from a page and is refused'
);

assert.deepEqual(
    handleFindingsApiRequest(getFindings, { id: ALLOWED_ID, url: 'https://evil.example/' }, makeContext()),
    REFUSAL,
    'a message from an http origin is refused even if it names an allowlisted id'
);

assert.deepEqual(
    handleFindingsApiRequest(getFindings, SENDER, makeContext({ getForegroundSnapshot: () => null })),
    REFUSAL,
    'no foreground tab -> refusal'
);

assert.deepEqual(
    handleFindingsApiRequest({ ...getFindings, tabId: 99 }, SENDER, makeContext()),
    REFUSAL,
    'naming a non-foreground tab is refused, not silently redirected'
);

// The refusals above must be indistinguishable from each other - that is the point.
const refusals = [
    handleFindingsApiRequest(getFindings, SENDER, makeContext({ config: makeConfig({ enabled: false }) })),
    handleFindingsApiRequest(getFindings, { id: OTHER_ID }, makeContext()),
    handleFindingsApiRequest({ action: 'saveConfig' }, SENDER, makeContext()),
    handleFindingsApiRequest({ ...getFindings, tabId: 99 }, SENDER, makeContext())
];
for (const refusal of refusals) {
    assert.deepEqual(refusal, refusals[0], 'all refusals are byte-identical, so no gate can be probed');
}

// --- rate limit --------------------------------------------------------------

{
    const rateLimiter = createRateLimiter({ windowMs: 1000, maxRequests: 3 });
    const context = makeContext({ rateLimiter, now: 0 });
    for (let index = 0; index < 3; index += 1) {
        assert.equal(
            handleFindingsApiRequest({ action: FINDINGS_API_ACTIONS.HELLO }, SENDER, { ...context, now: index }).ok,
            true,
            'requests inside the budget are served'
        );
    }
    assert.deepEqual(
        handleFindingsApiRequest({ action: FINDINGS_API_ACTIONS.HELLO }, SENDER, { ...context, now: 4 }),
        REFUSAL,
        'the fourth request in the window is refused'
    );
    assert.equal(
        handleFindingsApiRequest({ action: FINDINGS_API_ACTIONS.HELLO }, SENDER, { ...context, now: 2000 }).ok,
        true,
        'the window slides, so the caller recovers'
    );
}

// --- successful responses ----------------------------------------------------

{
    const hello = handleFindingsApiRequest({ action: FINDINGS_API_ACTIONS.HELLO }, SENDER, makeContext());
    assert.equal(hello.ok, true, 'hello succeeds for an allowlisted caller');
    assert.equal(hello.schemaVersion, FINDINGS_API_SCHEMA_VERSION, 'hello carries the schema version');
    assert.deepEqual(
        hello.capabilities,
        [FINDINGS_API_ACTIONS.HELLO, FINDINGS_API_ACTIONS.GET_FINDINGS],
        'hello advertises exactly the read-only surface'
    );
    assert.ok(!('findings' in hello), 'hello leaks no page data');
}

{
    const response = handleFindingsApiRequest(getFindings, SENDER, makeContext());
    assert.equal(response.ok, true, 'findings are served to an allowlisted caller');
    assert.deepEqual(
        response.page,
        { origin: 'https://example.com', pathname: '/docs/page' },
        'page identity is origin + pathname; query and fragment are dropped'
    );

    const serialized = JSON.stringify(response);
    assert.ok(!serialized.includes('session=secret'), 'query parameters never leave the extension');
    assert.ok(!serialized.includes('#part'), 'fragments never leave the extension');

    assert.equal(response.findings.length, 3, 'findings from all modules are flattened into one list');
    assert.deepEqual(
        response.findings.map((finding) => finding.module),
        ['Hidden-Content-Visual-Manipulation', 'Link-Domain-Security', 'Trigger-Phrases'],
        'each finding says which module produced it'
    );
    for (const finding of response.findings) {
        assert.deepEqual(
            Object.keys(finding).sort(),
            ['details', 'detector', 'module', 'severity', 'summary', 'type'],
            'a finding exposes exactly the agreed fields - no DOM handle, no raw text'
        );
    }
    assert.deepEqual(response.partialModules, ['Trigger-Phrases'], 'partial modules are reported');
    assert.equal(response.status, 'issues');
    assert.equal(response.totalFindings, 3);
}

// --- serialization details ---------------------------------------------------

assert.equal(normalizePageIdentity('file:///C:/secret.html'), null, 'non-http schemes are not described');
assert.equal(normalizePageIdentity('not a url'), null, 'malformed URLs are not described');
assert.equal(normalizePageIdentity(''), null, 'empty URL is not described');

{
    const oversized = serializeFindings({
        visualFindings: Array.from({ length: 25 }, () => ({ type: 'hidden-text', summary: 'x'.repeat(1000) }))
    });
    assert.equal(oversized.length, 10, 'per-module count stays clipped even if the snapshot grows');
    assert.equal(oversized[0].summary.length, 300, 'strings stay clipped independently of the snapshot');
    assert.equal(oversized[0].severity, 'medium', 'missing severity falls back to medium');
}

assert.deepEqual(serializeFindings(null), [], 'a missing frame snapshot yields no findings');
assert.deepEqual(serializeFindings({ visualFindings: 'not-an-array' }), [], 'malformed snapshot fields are ignored');


// --- контекст страницы (C4): факт о среде, а не вердикт -----------------------------------------
// Агент, читающий страницу, узнаёт от нас две вещи: смотрит ли её автоматизированный браузер и
// отнимает ли она главный поток. Ни одна из них не является указанием что-либо делать, и ни одна
// не влияет на детекторы: `navigator.webdriver` подделывается в обе стороны одной строкой.

{
    const withContext = handleFindingsApiRequest(getFindings, SENDER, makeContext({
        getForegroundSnapshot: () => ({
            ...makeForeground(),
            frameSnapshot: {
                ...makeForeground().frameSnapshot,
                context: { automation: true, longTasksObserved: 4, sliceBackoffSteps: 2, framesPresent: 3, framesAnalyzed: 0, scanBudgetExhausted: false, lastScanActiveMs: 0 }
            }
        })
    }));
    assert.equal(withContext.ok, true, 'предусловие: ответ обязан быть успешным');
    assert.deepEqual(
        withContext.context,
        { automation: true, longTasksObserved: 4, sliceBackoffSteps: 2, framesPresent: 3, framesAnalyzed: 0, scanBudgetExhausted: false, lastScanActiveMs: 0 },
        'контекст обязан доезжать до подписчика: без него агент не знает, что мы вообще про среду знаем'
    );
    // C2, iframe: граница нашего знания названа вслух. «Фреймы есть, проанализировано ноль» - это
    // факт об охвате, и подписчик с доступом к дереву фреймов обязан его получить, иначе наше
    // «чисто» читается как утверждение обо всей странице.
    assert.equal(withContext.context.framesPresent, 3, 'число фреймов на странице обязано доезжать');
    assert.equal(withContext.context.framesAnalyzed, 0, 'сегодня анализируется только главный документ, и это обязано быть сказано, а не подразумеваться');
}

{
    const withoutContext = handleFindingsApiRequest(getFindings, SENDER, makeContext());
    assert.equal(withoutContext.context, null, 'нет контекста - null, а не выдуманные нули');
}

// Ответ обязан пересобирать контекст, а не отдавать пришедшее из страницы как есть.
{
    const leaky = handleFindingsApiRequest(getFindings, SENDER, makeContext({
        getForegroundSnapshot: () => ({
            ...makeForeground(),
            frameSnapshot: {
                ...makeForeground().frameSnapshot,
                context: { automation: 'yes', longTasksObserved: -5, sliceBackoffSteps: 'many', secret: 'do-not-store' }
            }
        })
    }));
    assert.deepEqual(
        leaky.context,
        { automation: false, longTasksObserved: 0, sliceBackoffSteps: 0, framesPresent: 0, framesAnalyzed: 0, scanBudgetExhausted: false, lastScanActiveMs: 0 },
        'контекст обязан пересобираться на границе API: лишнее поле не имеет права выйти наружу'
    );
    assert.equal(JSON.stringify(leaky).includes('do-not-store'), false, 'постороннее поле не имеет права покинуть расширение');
}

// Мусор из content-скрипта не имеет права протечь наружу как есть.
assert.deepEqual(
    serializeContext({ automation: 'yes', longTasksObserved: -5, sliceBackoffSteps: 'many', extra: 'do-not-store' }),
    { automation: false, longTasksObserved: 0, sliceBackoffSteps: 0, framesPresent: 0, framesAnalyzed: 0, scanBudgetExhausted: false, lastScanActiveMs: 0 },
    'контекст пересобирается по известным полям: строка вместо флага не становится true, а лишнее поле не проходит'
);
assert.equal(serializeContext(null), null, 'отсутствующий контекст остаётся отсутствующим');
assert.equal(
    serializeContext({ framesPresent: 10000 }).framesPresent,
    100,
    'число фреймов ограничено потолком: точное значение сверх сотни ничего не добавляет к факту «мы их не смотрели»'
);

// Версия схемы: новое поле обязано быть отличимо от старой версии, у которой его не было.
assert.equal(FINDINGS_API_SCHEMA_VERSION, 2, 'добавление context - это новая версия схемы, а не молчаливое расширение ответа');

console.log('findings-api.test.mjs: all assertions passed');
