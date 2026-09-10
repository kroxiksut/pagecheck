// Щит для 10.5 модуля trigger-phrases (см. TASKS.ru.md модуля).
// reconcileInitialMutationQueue() гоняет mutation-батч ВНУТРИ firstScan, а beginCandidateBatch внутри
// него обнуляет счётчики кандидатов. Управление возвращалось в firstScan уже с цифрами крошечного
// батча реконсиляции, и лог с getStats() описывали ими первичный скан: «2 кандидата» на странице,
// где их сотни. Плюс totalScanTime перезаписывался длительностью последнего скана, то есть «суммарное
// время» было вторым именем lastScanTime.
// Запуск: node modules/trigger-phrases/initialScanCounters.test.mjs

import assert from 'node:assert/strict';

let documentRoot = null;

class StubText {
    constructor(data) {
        this.nodeType = 3;
        this.data = data;
        this.parentElement = null;
    }

    get textContent() { return this.data; }
}

class StubElement {
    constructor(tagName) {
        this.nodeType = 1;
        this.tagName = tagName.toUpperCase();
        this.childNodes = [];
        this.parentElement = null;
    }

    get localName() { return this.tagName.toLowerCase(); }
    get children() { return this.childNodes.filter((node) => node.nodeType === 1); }

    appendChild(node) {
        node.parentElement = this;
        this.childNodes.push(node);
        return node;
    }

    getAttribute() { return null; }
    hasAttribute() { return false; }
    matches() { return false; }
    closest() { return null; }
    querySelector() { return null; }

    get isConnected() {
        let current = this;
        while (current.parentElement) {
            current = current.parentElement;
        }
        return current === documentRoot;
    }

    contains(node) {
        let current = node;
        while (current) {
            if (current === this) return true;
            current = current.parentElement;
        }
        return false;
    }
}

function element(tag, children = []) {
    const node = new StubElement(tag);
    for (const child of children) {
        node.appendChild(typeof child === 'string' ? new StubText(child) : child);
    }
    return node;
}

globalThis.Element = StubElement;
globalThis.Node = class { static ELEMENT_NODE = 1; static TEXT_NODE = 3; };
// Часы идут вперёд, но медленно: шаг в миллисекунду исчерпал бы 100-мс бюджет скана за сотню
// обращений, и стенд мерил бы собственные часы вместо поведения модуля.
let clock = 0;
globalThis.performance = { now: () => (clock += 0.001) };
globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
};
globalThis.document = { get documentElement() { return documentRoot; } };
globalThis.chrome = { i18n: { getMessage: () => 'Suspicious trigger phrase detected' } };

const { Logger } = await import('../../utils/logger.js');
Logger.setLevel('silent');
const { default: TriggerPhrases } = await import('./TriggerPhrases.js');

// Страница с сотней абзацев: первичный скан обязан отчитаться про неё, а не про один абзац,
// добавленный во время скана.
const html = element('html');
const body = element('body');
html.appendChild(body);
for (let index = 0; index < 100; index += 1) {
    body.appendChild(element('p', [`Ordinary paragraph number ${index} about delivery terms.`]));
}
documentRoot = html;

const module = new TriggerPhrases();
module.isEnabled = true;
module.effectiveConfig = module.createEffectiveConfig({ sensitivity: 'medium' });

// Ставим корень реконсиляции: очередь непуста к моменту, когда первичный скан дойдёт до неё.
const injected = element('p', ['One more paragraph added while the initial scan was running.']);
body.appendChild(injected);
module.enqueueMutationRoot(injected);

await module.firstScan();

const stats = module.getStats();
assert.equal(
    module.pendingMutationRoots.length,
    0,
    'предусловие теста: очередь реконсиляции обязана быть разобрана внутри firstScan'
);
assert.equal(
    stats.candidatesAnalyzed >= 100,
    true,
    `отчёт обязан описывать первичный скан, а не батч реконсиляции (candidatesAnalyzed = ${stats.candidatesAnalyzed} при 100+ абзацах)`
);
assert.equal(
    stats.elementsVisited >= 100,
    true,
    `elementsVisited обязан описывать первичный скан (получено ${stats.elementsVisited})`
);

// totalScanTime - сумма, а не второе имя lastScanTime. Внутри ОДНОГО скана вклада два: батч
// реконсиляции (processMutationBatch) и сам первичный скан. Прежнее присваивание стирало первый.
// Между сканами суммарное время не растёт по контракту ядра: firstScan начинается с resetStats().
assert.equal(
    stats.lastScanTime > 0,
    true,
    'предусловие теста: скан обязан занять ненулевое время'
);
assert.equal(
    stats.totalScanTime > stats.lastScanTime,
    true,
    `работа батча реконсиляции обязана оставаться в суммарном времени, а не стираться отчётом первичного скана (total ${stats.totalScanTime}, last ${stats.lastScanTime})`
);

console.log('trigger-phrases 10.5: счётчики первичного скана - все проверки пройдены');
