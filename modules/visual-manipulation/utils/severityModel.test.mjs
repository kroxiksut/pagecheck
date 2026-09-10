// Щит для словаря severity модуля visual-manipulation (TASKS Block C.1 / R4).
// До R4 словарь существовал только как соглашение: каждый детектор писал литералы, и ничто не
// мешало ветке вернуть 'critical', 'info' или опечатку - findingFactory пропускал любое значение
// насквозь, дальше оно уезжало в снапшот и в findings API.
// Запуск: node modules/visual-manipulation/utils/severityModel.test.mjs

import assert from 'node:assert/strict';

import { SEVERITY_LEVELS, compareSeverity, isSeverity, lowerSeverity, maxSeverity } from './severityModel.js';
import { createFinding, normalizeFindings } from './findingFactory.js';

// --- словарь ------------------------------------------------------------------------------------

assert.deepEqual(SEVERITY_LEVELS, ['low', 'medium', 'high'], 'словарь модуля - ровно три уровня по возрастанию');
assert.equal(isSeverity('critical'), false, "'critical' принимает findings API, но модуль его не выдаёт");
assert.equal(isSeverity('info'), false, 'произвольные уровни не входят в словарь');
assert.equal(isSeverity(''), false, 'пустая строка - не уровень');
assert.equal(isSeverity(undefined), false, 'отсутствующее значение - не уровень');

// --- порядок ------------------------------------------------------------------------------------

assert.ok(compareSeverity('high', 'medium') > 0, 'high строго выше medium');
assert.ok(compareSeverity('low', 'medium') < 0, 'low строго ниже medium');
assert.equal(compareSeverity('low', 'low'), 0, 'равные уровни сравниваются как равные');
assert.ok(compareSeverity('bogus', 'low') < 0, 'значение вне словаря сортируется ниже low и не может выиграть сравнение');

// --- max / lower --------------------------------------------------------------------------------

assert.equal(maxSeverity('low', 'medium'), 'medium', 'максимум из двух уровней');
assert.equal(maxSeverity('high', 'medium'), 'high', 'максимум не понижает');
assert.equal(maxSeverity('medium', 'bogus'), 'medium', 'мусор не может поднять уровень');
assert.equal(maxSeverity('bogus', 'bogus'), 'low', 'из двух мусорных значений остаётся минимальный уровень словаря');

assert.equal(lowerSeverity('high'), 'medium', 'понижение - ровно один шаг');
assert.equal(lowerSeverity('medium'), 'low', 'понижение - ровно один шаг');
assert.equal(lowerSeverity('low'), 'low', 'ниже low уровня нет: benign-свидетельство понижает, но не отменяет находку');
assert.equal(lowerSeverity('critical'), 'low', 'значение вне словаря понижается до минимального уровня, а не остаётся собой');

// --- findingFactory обязан удерживать словарь ---------------------------------------------------

assert.equal(
    createFinding({ type: 'hidden-text', summary: 's', details: 'd', severity: 'critical' }).severity,
    'medium',
    'значение вне словаря не имеет права дойти до снапшота и findings API'
);
assert.equal(
    createFinding({ type: 'hidden-text', summary: 's', details: 'd' }).severity,
    'medium',
    'дефолт остаётся medium'
);
assert.equal(
    createFinding({ type: 'hidden-text', summary: 's', details: 'd', severity: 'high' }).severity,
    'high',
    'корректный уровень проходит без изменений'
);

const normalized = normalizeFindings([
    { type: 'overlay', severity: 'high' },
    { type: 'overlay', severity: 'CRITICAL' },
    { type: 'overlay' }
]);
assert.deepEqual(
    normalized.map((finding) => finding.severity),
    ['high', 'medium', 'medium'],
    'нормализация findings подчиняется тому же словарю, что и создание'
);
assert.equal(normalized[0].detector, 'unknown', 'дефолт detector не потерян при нормализации');

console.log('Severity vocabulary contract checks passed (Block C.1 / R4)');
