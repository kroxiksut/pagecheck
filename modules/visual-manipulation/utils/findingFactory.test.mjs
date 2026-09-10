// Щит для фабрики находок visual-manipulation (корневой TASKS C3: чистые хелперы без DOM).
// Через эти четыре функции проходит КАЖДАЯ находка модуля, и до сих пор они проверялись только
// косвенно - через детекторы, где падение выглядело бы как ошибка детектора, а не фабрики.
// Проверяются свойства, ради которых фабрика и существует:
//   1. Словарь severity закрыт, и мусор ДЕГРАДИРУЕТ к умолчанию, а не роняет скан: опечатка в
//      уровне - ошибка кода, но платить за неё потерей всего скана нельзя.
//   2. Дедупликация не выбрасывает находки БЕЗ ключа: отсутствие ключа означает «сравнить не по
//      чему», а не «дубль».
//   3. Дедупликация учитывает и уже принятые находки, и дубли внутри самой пачки.
// Запуск: node modules/visual-manipulation/utils/findingFactory.test.mjs

import assert from 'node:assert/strict';
import { createFinding, normalizeFindings, dedupeFindings, getMessage } from './findingFactory.js';

// --- 1. Словарь severity закрыт ------------------------------------------------------------------

for (const severity of ['low', 'medium', 'high']) {
    assert.equal(
        createFinding({ type: 'hidden-text', summary: 's', details: 'd', severity }).severity,
        severity,
        `уровень ${severity} обязан сохраняться как есть`
    );
}

// 'critical' здесь не опечатка: словарь МОДУЛЯ - три уровня, и это записано в severityModel.js.
// findings API принимает и 'critical', но visual-manipulation его не выдаёт, потому что улик
// сильнее «скрытый интерактивный элемент под обманным overlay» у него нет. Проверяем именно
// границу: чужой уровень не проезжает через фабрику молча.
for (const wrong of ['critical', 'MEDIUM', 'severe', '', null, undefined, 3, {}]) {
    const finding = createFinding({ type: 'hidden-text', summary: 's', details: 'd', severity: wrong });
    assert.equal(
        finding.severity,
        'medium',
        `значение ${JSON.stringify(wrong)} вне словаря обязано деградировать к умолчанию, а не уходить в находку`
    );
}

// --- 2. Метаданные проходят, форма не теряется ---------------------------------------------------

{
    const finding = createFinding({
        type: 'clipping-hiding',
        summary: 'summary',
        details: 'details',
        severity: 'high',
        detector: 'hiddenTextDetector',
        dedupeKey: 'k1',
        extra: { nested: true }
    });
    assert.deepEqual(
        Object.keys(finding).sort(),
        ['dedupeKey', 'details', 'detector', 'extra', 'severity', 'summary', 'type'],
        'фабрика обязана пропускать метаданные детектора, не переписывая форму находки'
    );
    assert.equal(finding.detector, 'hiddenTextDetector', 'детектор обязан называть себя');
    assert.equal(createFinding({ type: 't', summary: 's', details: 'd' }).detector, 'unknown', 'детектор без имени обязан называться unknown, а не undefined');
}

// --- 3. normalizeFindings: пустые записи выбрасываются, уровни чинятся ---------------------------

{
    const normalized = normalizeFindings([
        null,
        undefined,
        { type: 'a', severity: 'high' },
        { type: 'b', severity: 'nonsense' },
        { type: 'c', detector: 'overlayDetector' }
    ]);
    assert.equal(normalized.length, 3, 'пустые записи не имеют права доезжать до находок');
    assert.equal(normalized[0].severity, 'high', 'корректный уровень обязан сохраняться');
    assert.equal(normalized[1].severity, 'medium', 'мусорный уровень обязан деградировать');
    assert.equal(normalized[2].detector, 'overlayDetector', 'собственный детектор обязан переживать нормализацию');
}

// --- 4. Дедупликация: без ключа - не дубль -------------------------------------------------------

{
    const withoutKeys = dedupeFindings([{ type: 'a' }, { type: 'a' }, { type: 'a' }]);
    assert.equal(
        withoutKeys.length,
        3,
        'находки без ключа дедупликации обязаны проходить все: отсутствие ключа означает «сравнить не по чему», а не «дубль»'
    );

    const withKeys = dedupeFindings([
        { type: 'a', dedupeKey: 'k1' },
        { type: 'b', dedupeKey: 'k1' },
        { type: 'c', dedupeKey: 'k2' }
    ]);
    assert.deepEqual(withKeys.map((finding) => finding.type), ['a', 'c'], 'дубль внутри одной пачки обязан отсекаться');

    const againstExisting = dedupeFindings(
        [{ type: 'a', dedupeKey: 'k1' }, { type: 'b', dedupeKey: 'k9' }],
        [{ type: 'old', dedupeKey: 'k1' }]
    );
    assert.deepEqual(
        againstExisting.map((finding) => finding.type),
        ['b'],
        'уже принятая находка обязана отсекать повтор: иначе каждый ре-рендер страницы добавлял бы копию'
    );

    const malformedKeys = dedupeFindings([
        { type: 'a', dedupeKey: 42 },
        { type: 'b', dedupeKey: 42 }
    ]);
    assert.equal(malformedKeys.length, 2, 'ключ не-строка ключом не является, и молча склеивать такие находки нельзя');
}

// --- 5. getMessage без chrome.i18n отдаёт запасной текст -----------------------------------------
// Модуль обязан работать в контексте, где i18n недоступен: пустая строка вместо текста находки -
// это находка, которую человек не прочитает.

{
    const savedChrome = globalThis.chrome;
    globalThis.chrome = undefined;
    assert.equal(getMessage('someKey', [], 'fallback text'), 'fallback text', 'без i18n обязан возвращаться запасной текст');

    globalThis.chrome = { i18n: { getMessage: () => '' } };
    assert.equal(getMessage('someKey', [], 'fallback text'), 'fallback text', 'пустой ответ i18n обязан заменяться запасным текстом');

    globalThis.chrome = { i18n: { getMessage: () => 'localized' } };
    assert.equal(getMessage('someKey', [], 'fallback text'), 'localized', 'локализованный текст обязан побеждать запасной');
    globalThis.chrome = savedChrome;
}

console.log('findingFactory.test.mjs: ok (словарь severity, метаданные, дедупликация, запасной текст)');
