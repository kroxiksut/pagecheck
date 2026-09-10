// Щит для C2: пауза модуля prompt-splitting СОХРАНЯЕТ находки, и потому возврат на неизменившуюся
// страницу имеет право обойтись без рескана.
// У этого модуля состояние findings живёт сложнее всех: находка описывает РЕГИОН из многих узлов,
// её ключ собирается из идентификаторов кандидатов, а сами идентификаторы связаны с элементами через
// WeakMap. Если пауза сотрёт эту идентичность, после возврата тот же элемент получит новый id, и
// первая же мутация заведёт ВТОРУЮ находку о том же регионе вместо обновления первой.
// Состояние находок наполняется здесь напрямую через findingState: собрать реальный распределённый
// промпт на мини-DOM дороже, чем проверяемый инвариант, а инвариант - именно про паузу.
// Запуск: node modules/prompt-splitting/pauseKeepsFindings.test.mjs

import assert from 'node:assert/strict';

class StubElement {
    constructor(tagName = 'div') {
        this.nodeType = 1;
        this.tagName = tagName.toUpperCase();
        this.childNodes = [];
        this.parentElement = null;
        this.attributes = new Map();
    }

    get localName() { return this.tagName.toLowerCase(); }
    get children() { return this.childNodes.filter((node) => node.nodeType === 1); }

    appendChild(node) {
        node.parentElement = this;
        this.childNodes.push(node);
        return node;
    }

    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return this.attributes.has(name); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    get isConnected() { return true; }
    contains() { return false; }
    matches() { return false; }
    closest() { return null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
}

const documentRoot = new StubElement('html');
globalThis.Element = StubElement;
globalThis.Node = class { static ELEMENT_NODE = 1; static TEXT_NODE = 3; };
globalThis.performance = { now: () => 0 };
let observerInstances = 0;
globalThis.MutationObserver = class {
    constructor() { observerInstances += 1; }
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
};
globalThis.document = { documentElement: documentRoot };
globalThis.chrome = { i18n: { getMessage: () => '' } };

const { Logger } = await import('../../utils/logger.js');
Logger.setLevel('silent');
const { default: PromptSplitting } = await import('./PromptSplitting.js');

const decision = () => ({
    eligibility: 'eligible',
    ruleId: 'authority-impersonation.en.system-directive',
    supportingRuleIds: [],
    ruleVersion: 1,
    category: 'authority-impersonation',
    subtype: 'system-directive',
    actionGroup: 'authority-impersonation.system-directive',
    semanticSeverity: 'medium',
    semanticImpact: 'medium',
    semanticEvidenceStrength: 'strong',
    reconstructionConfidence: 'strong',
    sourceType: 'text',
    assemblyPath: 'boundary-aware',
    contributingCandidateCount: 2,
    contributingFragmentCount: 2,
    structuralEvidence: { regionType: 'section', candidateCount: 2, structuralTransitions: 0, hasStructuralMarker: false },
    reasonCodes: ['semantic-primary-match'],
    mitigationCodes: [],
    partial: false,
    truncated: false
});

const evidence = (regionId, candidateIds) => ({
    regionId,
    candidateIds,
    contributingCandidateIds: candidateIds,
    contributingFragmentIds: candidateIds.map((id) => `fragment-${id}`),
    sourceType: 'text',
    assemblyPath: 'boundary-aware'
});

function createModule() {
    const module = new PromptSplitting();
    module.isEnabled = true;
    return module;
}

function seedFindings(module) {
    const batch = module.findingState.beginBatch({ scope: 'full', regionIds: ['region-a'] });
    assert.equal(
        module.findingState.recordDecision(batch, decision(), evidence('region-a', ['candidate-1', 'candidate-2'])),
        true,
        'предусловие: находка обязана быть принята'
    );
    module.findingState.commitBatch(batch);
    const snapshot = module.findingState.getSnapshot();
    module.recentFindings = snapshot.findings;
    module.stats.threatsDetected = snapshot.activeCount;
    assert.ok(snapshot.activeCount > 0, 'предусловие: активные находки обязаны существовать');
    return snapshot;
}

// --- 1. Контракт объявлен -----------------------------------------------------------------------

assert.equal(
    createModule().keepsStateWhilePaused,
    true,
    'без этого флага js/content.js обязан пересканировать неизменившуюся страницу'
);

// --- 2. Пауза сохраняет находки и идентичность кандидатов и регионов ----------------------------

{
    const module = createModule();
    const before = seedFindings(module);

    const candidate = new StubElement('span');
    const anchor = new StubElement('section');
    module.candidateElementIds.set(candidate, 'candidate-1');
    module.regionAnchorIds.set(anchor, 'region-a');

    module.pause();

    const after = module.findingState.getSnapshot();
    assert.equal(module.isPaused, true, 'предусловие: модуль обязан быть на паузе');
    assert.equal(after.activeCount, before.activeCount, 'пауза не имеет права терять находки');
    assert.equal(after.findingRevision, before.findingRevision, 'ревизия findings не имеет права расти от самой паузы');
    assert.equal(module.stats.threatsDetected, before.activeCount, 'бейдж модуля не имеет права обнуляться при переключении вкладки');
    assert.equal(
        module.candidateElementIds.get(candidate),
        'candidate-1',
        'идентичность кандидата обязана пережить паузу: иначе после возврата мутация заведёт вторую находку о том же регионе'
    );
    assert.equal(module.regionAnchorIds.get(anchor), 'region-a', 'идентичность региона обязана пережить паузу');
}

// --- 3. Пауза снимает всё, что работало бы в фоновой вкладке -------------------------------------

{
    const module = createModule();
    seedFindings(module);
    module.mutationBatchTimer = 1717;
    module.initialScanInProgress = true;
    module.reconciliationPassPending = true;
    module.currentScanConfiguration = { revision: 1 };
    module.scanRegionAnchors.set('region-a', new StubElement('section'));

    module.pause();

    assert.equal(module.mutationBatchTimer, null, 'таймер батча обязан быть снят: иначе он сработает в фоновой вкладке');
    assert.equal(module.initialScanInProgress, false, 'признак идущего первичного скана обязан быть снят');
    assert.equal(module.reconciliationPassPending, false, 'отложенный проход согласования обязан быть снят');
    assert.equal(module.currentScanConfiguration, null, 'конфигурация скана обязана быть снята');
    assert.equal(module.scanRegionAnchors.size, 0, 'ссылки на якоря регионов не имеют права пережить скан, тем более паузу');
    assert.equal(module.observer, null, 'наблюдатель обязан быть отключён: пауза - это отсутствие работы');
}

// --- 4. Возврат без рескана отдаёт те же находки ------------------------------------------------

{
    const module = createModule();
    const before = seedFindings(module);

    module.pause();
    const observersBefore = observerInstances;
    const resumed = await module.resume({ rescan: false });

    assert.equal(resumed, true, 'возврат обязан удаться');
    assert.equal(module.isEnabled, true, 'модуль обязан снова работать');
    assert.equal(observerInstances, observersBefore + 1, 'наблюдатель обязан быть поднят заново');
    const after = module.findingState.getSnapshot();
    assert.equal(after.activeCount, before.activeCount, 'возврат без рескана обязан отдавать те же находки');
    assert.deepEqual(
        after.findings.map((entry) => entry.key),
        before.findings.map((entry) => entry.key),
        'ключи находок после возврата обязаны совпадать'
    );
}

// --- 5. Уничтожение модуля находки всё-таки стирает ----------------------------------------------

{
    const module = createModule();
    seedFindings(module);
    const candidate = new StubElement('span');
    module.candidateElementIds.set(candidate, 'candidate-1');

    module.destroy();

    assert.equal(module.findingState.getSnapshot().activeCount, 0, 'destroy обязан стирать находки: модуль ушёл');
    assert.equal(module.recentFindings.length, 0, 'destroy обязан стирать список последних находок');
    assert.equal(
        module.candidateElementIds.get(candidate),
        undefined,
        'без находок идентичность кандидатов ничего не описывает и уходит вместе с ними'
    );
}

console.log('prompt-splitting/pauseKeepsFindings.test.mjs: ok (пауза сохраняет находки и идентичность регионов)');
