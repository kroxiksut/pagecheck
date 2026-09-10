// Щит для 14.1 модуля api-interception (см. TASKS.ru.md модуля).
// Модуль ищет `action`, `src`, `data-api` и `data-endpoint`, но наблюдатель их не видел, а
// handleMutations брал только childList. Подменённый НА МЕСТЕ адрес в DOM-путь не попадал вовсе:
// такая правка не порождает childList-записи. Усугубляла дело отметка «уже разобран» -
// processedCandidateElements без инвалидации отбрасывал элемент даже там, где он всё-таки
// доходил до скана.
// Запуск: node modules/api-interception/attributeMutations.test.mjs

import assert from 'node:assert/strict';

class StubElement {
    constructor(tagName = 'div', attributes = {}) {
        this.tagName = tagName.toUpperCase();
        this.localName = tagName.toLowerCase();
        this.attributes = new Map(Object.entries(attributes));
        this.childNodes = [];
        this.parentElement = null;
        this.isConnected = true;
        this.nodeType = 1;
    }

    get children() { return this.childNodes.filter((node) => node.nodeType === 1); }

    appendChild(node) {
        node.parentElement = this;
        this.childNodes.push(node);
        return node;
    }

    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    hasAttribute(name) { return this.attributes.has(name); }
    matches() { return false; }
    closest() { return null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }

    contains(node) {
        let current = node;
        while (current) {
            if (current === this) return true;
            current = current.parentElement;
        }
        return false;
    }

    get textContent() {
        return this.childNodes.map((node) => (node.nodeType === 3 ? node.data : node.textContent)).join('');
    }
}

const documentRoot = new StubElement('html');
const body = new StubElement('body');
documentRoot.appendChild(body);

globalThis.Element = StubElement;
globalThis.Node = class { static TEXT_NODE = 3; static ELEMENT_NODE = 1; };
globalThis.performance = { now: () => 0 };
globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
};
globalThis.document = { get documentElement() { return documentRoot; }, baseURI: 'https://shop.example.com/' };
globalThis.window = { location: new URL('https://shop.example.com/catalog') };
globalThis.chrome = undefined;

const { Logger } = await import('../../utils/logger.js');
Logger.setLevel('silent');
const { default: ApiInterceptor } = await import('./ApiInterceptor.js');

function createModule() {
    const module = new ApiInterceptor();
    module.isEnabled = true;
    // Планировщик батчей в этом стенде не нужен: проверяется решение «это работа или нет».
    module.scheduleMutationBatch = () => {};
    return module;
}

function record(type, fields = {}) {
    return { type, target: null, addedNodes: [], removedNodes: [], attributeName: null, ...fields };
}

// --- 1. Наблюдатель настроен на те же атрибуты, которые ищет отбор кандидатов --------------------

{
    const module = createModule();
    assert.equal(
        module.observerConfig.attributes,
        true,
        'наблюдатель обязан видеть атрибуты: иначе модуль заявляет детект, которого у него нет'
    );
    assert.deepEqual(
        [...module.observerConfig.attributeFilter].sort(),
        ['action', 'data-api', 'data-endpoint', 'src'].sort(),
        'фильтр обязан быть узким и совпадать с тем, что ищет scanElement'
    );
    assert.equal(
        module.observerConfig.attributeFilter.includes('class'),
        false,
        'широкий фильтр прогнал бы через конвейер каждое изменение class на анимированной странице'
    );
}

// --- 2. Подмена атрибута на месте ставит элемент в очередь ---------------------------------------

{
    const module = createModule();
    const script = new StubElement('script', { src: 'https://cdn.example.com/app.js' });
    body.appendChild(script);

    script.setAttribute('src', 'https://evil.example.net/collect.js');
    module.handleMutations([record('attributes', { target: script, attributeName: 'src' })]);

    assert.equal(
        [...module.pendingMutationRoots].includes(script),
        true,
        'элемент с подменённым src обязан попадать в очередь: childList такой правки не порождает'
    );
}

// --- 3. Отметка «уже разобран» снимается, иначе ветка бесполезна ---------------------------------
// Это та развилка, которая была записана при заведении пункта: processedCandidateElements отвечает
// на вопрос «этот элемент уже разобран», а после подмены атрибута прежний ответ описывает прежнее
// значение.

{
    const module = createModule();
    const form = new StubElement('form', { action: 'https://shop.example.com/checkout' });
    body.appendChild(form);

    // Модуль уже видел этот элемент в прошлом скане.
    module.processedCandidateElements.add(form);
    assert.equal(module.processedCandidateElements.has(form), true, 'предусловие: элемент помечен разобранным');

    form.setAttribute('action', 'https://evil.example.net/collect');
    module.handleMutations([record('attributes', { target: form, attributeName: 'action' })]);

    assert.equal(
        module.processedCandidateElements.has(form),
        false,
        'отметка «уже разобран» обязана сниматься: иначе элемент отбрасывается с прежним значением атрибута'
    );
    assert.equal([...module.pendingMutationRoots].includes(form), true, 'и сам элемент обязан быть в очереди');
}

// --- 4. Границы: узел вне документа и переполнение очереди ---------------------------------------

{
    const module = createModule();
    const detached = new StubElement('script', { src: 'https://cdn.example.com/app.js' });
    detached.isConnected = false;

    module.handleMutations([record('attributes', { target: detached, attributeName: 'src' })]);
    assert.equal(module.pendingMutationRoots.size, 0, 'узел вне документа работой не является');

    const flooding = createModule();
    flooding.maxPendingMutationRoots = 3;
    const records = [];
    for (let index = 0; index < 20; index += 1) {
        const node = new StubElement('script', { src: `https://cdn.example.com/${index}.js` });
        body.appendChild(node);
        records.push(record('attributes', { target: node, attributeName: 'src' }));
    }
    flooding.handleMutations(records);

    assert.equal(
        flooding.pendingMutationRoots.size <= 3,
        true,
        `очередь обязана оставаться ограниченной (в ней ${flooding.pendingMutationRoots.size})`
    );
    assert.equal(
        flooding.mutationRootsSkippedByLimit > 0,
        true,
        'потерянная по лимиту работа обязана быть посчитана'
    );
}

console.log('api-interception 14.1: подмена атрибутов на месте - все проверки пройдены');
