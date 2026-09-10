// Щит для 10.8 модуля trigger-phrases (см. TASKS.ru.md модуля, «Переделано после потери данных»).
// Схлопывание mutation-корней жило двумя проходами по всей очереди с Node.contains() на КАЖДУЮ
// постановку корня - O(n²) внутри колбэка observer, на том же тике, где работает очистка из 10.3.
// Проверяется не скорость, а механизм: contains() в горячем пути больше не зовётся вовсе, а
// семантика схлопывания (предок съедает потомков) сохранена, включая проход перед переполнением.
// Запуск: node modules/trigger-phrases/mutationRootCoalescing.test.mjs

import assert from 'node:assert/strict';

let documentRoot = null;
let containsCalls = 0;

class StubElement {
    constructor(tagName) {
        this.nodeType = 1;
        this.tagName = tagName.toUpperCase();
        this.childNodes = [];
        this.parentElement = null;
        this.attributes = new Map();
    }

    get localName() {
        return this.tagName.toLowerCase();
    }

    get children() {
        return this.childNodes.filter((node) => node.nodeType === 1);
    }

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

    // Инструментирован: горячий путь постановки корня обязан не трогать его вовсе.
    contains(node) {
        containsCalls += 1;
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
        node.appendChild(child);
    }
    return node;
}

globalThis.Element = StubElement;
globalThis.Node = class { static ELEMENT_NODE = 1; static TEXT_NODE = 3; };
globalThis.performance = { now: () => 0 };
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

function createModule() {
    const module = new TriggerPhrases();
    module.isEnabled = true;
    module.effectiveConfig = module.createEffectiveConfig({ sensitivity: 'medium' });
    return module;
}

// --- 1. Предок в очереди съедает потомка, и это не стоит прохода по очереди --------------------

{
    const html = element('html');
    const body = element('body');
    html.appendChild(body);
    const section = element('section');
    body.appendChild(section);
    const paragraphs = [];
    for (let index = 0; index < 50; index += 1) {
        const paragraph = element('p');
        section.appendChild(paragraph);
        paragraphs.push(paragraph);
    }
    documentRoot = html;

    const module = createModule();
    containsCalls = 0;
    module.enqueueMutationRoot(section);
    for (const paragraph of paragraphs) {
        module.enqueueMutationRoot(paragraph);
    }

    assert.equal(module.pendingMutationRoots.length, 1, 'потомки обязаны схлопываться в уже стоящий предок');
    assert.equal(module.pendingMutationRoots[0], section, 'в очереди обязан остаться именно предок');
    assert.equal(module.coalescedMutationRoots, 50, 'каждое схлопывание обязано быть посчитано');
    assert.equal(containsCalls, 0, `постановка корня обязана обходиться без Node.contains() (вызовов: ${containsCalls})`);
}

// --- 2. Потомки, поставленные раньше предка, снимаются при заборе очереди ----------------------

{
    const html = element('html');
    const body = element('body');
    html.appendChild(body);
    const section = element('section');
    body.appendChild(section);
    const first = element('p');
    const second = element('p');
    section.appendChild(first);
    section.appendChild(second);
    documentRoot = html;

    const module = createModule();
    module.enqueueMutationRoot(first);
    module.enqueueMutationRoot(second);
    module.enqueueMutationRoot(section);
    assert.equal(module.pendingMutationRoots.length, 3, 'до забора очереди потомки ещё стоят: схлопывание перенесено, а не размазано по постановкам');

    containsCalls = 0;
    const roots = module.takePendingMutationRoots();
    assert.deepEqual(roots, [section], 'забор очереди обязан снять корни, у которых предок тоже в очереди');
    assert.equal(module.pendingMutationRoots.length, 0, 'очередь обязана опустеть');
    assert.equal(module.pendingMutationRootSet.size, 0, 'зеркало очереди обязано очищаться вместе с ней');
    assert.equal(containsCalls, 0, 'схлопывание тоже обязано обходиться без Node.contains()');
}

// --- 3. Проход перед переполнением спасает очередь от лишнего полного рескана ------------------

{
    const html = element('html');
    const body = element('body');
    html.appendChild(body);
    const section = element('section');
    body.appendChild(section);
    documentRoot = html;

    const module = createModule();
    module.maxPendingMutationRoots = 8;
    for (let index = 0; index < 8; index += 1) {
        const paragraph = element('p');
        section.appendChild(paragraph);
        module.enqueueMutationRoot(paragraph);
    }
    assert.equal(module.pendingMutationRoots.length, 8, 'очередь заполнена потомками');

    const accepted = module.enqueueMutationRoot(section);
    assert.equal(accepted, true, 'предок обязан приниматься: перед переполнением очередь схлопывается, а не объявляется переполненной');
    assert.deepEqual(module.pendingMutationRoots, [section], 'вся вложенная очередь обязана схлопнуться в один корень');
    assert.equal(module.mutationQueueRequiresFullRescan, false, 'схлопнувшаяся очередь не обязана требовать полный рескан');
}

// --- 4. Настоящее переполнение по-прежнему просит полный рескан --------------------------------

{
    const html = element('html');
    const body = element('body');
    html.appendChild(body);
    documentRoot = html;

    const module = createModule();
    module.maxPendingMutationRoots = 4;
    for (let index = 0; index < 6; index += 1) {
        const section = element('section');
        body.appendChild(section);
        module.enqueueMutationRoot(section);
    }

    assert.equal(module.pendingMutationRoots.length, 4, 'очередь не обязана расти сверх предела');
    assert.equal(module.mutationQueueRequiresFullRescan, true, 'корни, которые не поместились и не схлопнулись, обязаны просить полный рескан');
    assert.equal(module.mutationQueueOverflows > 0, true, 'переполнение обязано быть видно в диагностике');
}

console.log('trigger-phrases 10.8: схлопывание mutation-корней - все проверки пройдены');
