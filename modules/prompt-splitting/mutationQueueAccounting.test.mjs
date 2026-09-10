// Щит для 11.4, 11.7 и 11.9 модуля prompt-splitting (см. TASKS.ru.md модуля, «Переделано после
// потери данных»). Все три - про учёт работы очереди мутаций:
//  11.4 корни, не поместившиеся в батч, исчезали навсегда: takeBatch() опустошает очередь, а срез
//       до maxMutationRegionsPerBatch выбрасывал остаток. Страница оставалась «partial», и на этом
//       всё - внедрение в хвосте крупного батча не анализировалось никогда.
//  11.7 отказ по нерелевантности узла считался пропуском по лимиту и делал страницу «частично
//       просканированной» навсегда.
//  11.9 одно значение коллектора прибавлялось к двум разным именам счётчиков.
// Запуск: node modules/prompt-splitting/mutationQueueAccounting.test.mjs

import assert from 'node:assert/strict';

class StubElement {
    constructor(tagName) {
        this.nodeType = 1;
        this.tagName = tagName.toUpperCase();
        this.childNodes = [];
        this.parentElement = null;
    }

    get localName() { return this.tagName.toLowerCase(); }
    get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
    get isConnected() { return true; }

    appendChild(node) {
        node.parentElement = this;
        this.childNodes.push(node);
        return node;
    }

    contains(node) {
        let current = node;
        while (current) {
            if (current === this) return true;
            current = current.parentElement;
        }
        return false;
    }

    hasAttribute() { return false; }
    getAttribute() { return null; }
    matches() { return false; }
    closest() { return null; }
}

globalThis.Element = StubElement;
globalThis.Node = class { static ELEMENT_NODE = 1; static TEXT_NODE = 3; };
globalThis.performance = { now: () => 0 };
globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
};
globalThis.document = { documentElement: null };
globalThis.chrome = {
    runtime: { onInstalled: { addListener: () => {} }, lastError: undefined },
    storage: {
        sync: { get: (keys, cb) => cb({}), set: (values, cb) => cb(), remove: (keys, cb) => cb() },
        local: { get: (keys, cb) => cb({}), set: (values, cb) => cb(), remove: (keys, cb) => cb() }
    },
    i18n: { getMessage: () => '' }
};

const { Logger } = await import('../../utils/logger.js');
Logger.setLevel('silent');
const { default: PromptSplitting } = await import('./PromptSplitting.js');

function createModule() {
    const module = new PromptSplitting();
    module.isEnabled = true;
    module.effectiveConfig = module.createEffectiveConfig({});
    return module;
}

// --- 11.7: нерелевантный узел - это не пропущенная работа --------------------------------------

{
    const module = createModule();
    const textNode = { nodeType: 3, data: 'text' };

    assert.equal(module.enqueueMutationRoot(textNode), false, 'текстовый узел не может быть корнем скана');
    assert.equal(module.mutationRootsRejectedAsIrrelevant, 1, 'отказ по нерелевантности обязан считаться отдельно');
    assert.equal(module.mutationRootsSkippedByLimit, 0, 'нерелевантный узел не является пропуском по лимиту');
    assert.equal(
        module.getSnapshotState().partialResult,
        false,
        'одна мутация с текстовым узлом не имеет права делать страницу «частично просканированной»'
    );

    // А вот настоящая потеря по лимиту обязана транслироваться в partial ровно как прежде.
    module.maxPendingMutationRoots = 2;
    module.mutationQueue.limits.maxRoots = 2;
    for (let index = 0; index < 5; index += 1) {
        module.enqueueMutationRoot(new StubElement('div'));
    }
    assert.equal(module.mutationRootsSkippedByLimit > 0, true, 'корни, не поместившиеся в очередь, обязаны считаться потерянными');
    assert.equal(module.getSnapshotState().partialResult, true, 'потеря по лимиту обязана оставаться сигналом partial');
}

// --- 11.4: переполнение батча планирует ровно один полный рескан -------------------------------

{
    const module = createModule();
    let processedRootCount = null;
    module.processMutationRoots = async (roots) => {
        processedRootCount = roots.length;
    };

    for (let index = 0; index < module.maxMutationRegionsPerBatch + 5; index += 1) {
        module.enqueueMutationRoot(new StubElement('div'));
    }

    await module.processQueuedMutationBatch(module.runtimeRevision, module.lifecycleRevision);

    assert.equal(processedRootCount, module.maxMutationRegionsPerBatch, 'батч обязан остаться ограниченным');
    assert.equal(module.mutationRootsSkippedByLimit, 5, 'выброшенные корни обязаны быть посчитаны');
    assert.equal(
        module.reconciliationRescanScheduled,
        true,
        'работа выброшенных корней обязана возвращаться полным рескансом, а не исчезать под флагом partial'
    );

    // Повторные запросы, пока рескан не отработал, новых не создают.
    assert.equal(module.scheduleReconciliationRescan(), false, 'второй запрос не имеет права создавать второй рескан');
    module.reconciliationRescanScheduled = false;
    assert.equal(module.scheduleReconciliationRescan(), true, 'после отработавшего рескана новый запрос снова возможен');
}

// --- 11.9: одно событие - один счётчик ----------------------------------------------------------

{
    const module = createModule();
    module.candidateCollector = {
        collect: async () => ({
            status: 'partial',
            partial: true,
            dispose: () => {},
            candidates: [],
            regions: [],
            diagnostics: {
                elementsVisited: 10,
                candidatesCreated: 0,
                fragmentsCreated: 0,
                charactersRead: 0,
                regionsCreated: 0,
                workSlices: 1,
                partial: true,
                lifecycleCancelled: false,
                candidatesSkippedByLimit: 2,
                elementsSkippedByLimit: 7,
                elementsSkippedByTime: 0,
                directNodesSkippedByLimit: 0,
                fragmentsSkippedByLimit: 0,
                fragmentBatchesSkippedByLimit: 0,
                charactersSkippedByLimit: 0,
                privacySubtreesSkipped: 0,
                technicalSubtreesSkipped: 0
            }
        })
    };

    await module.collectCandidateBatch(new StubElement('div'), module.buildInitialScanLimits
        ? module.buildInitialScanLimits()
        : { findingScope: { type: 'page' }, reconstructionLimits: {}, forcePartial: false });

    assert.equal(module.candidatesSkippedByLimit, 2, 'пропуск кандидата обязан браться из собственного счётчика коллектора');
    assert.equal(module.elementsSkippedByLimit, 7, 'пропуск элемента обязан оставаться пропуском элемента');
}

console.log('prompt-splitting 11.4 / 11.7 / 11.9: учёт очереди мутаций - все проверки пройдены');
