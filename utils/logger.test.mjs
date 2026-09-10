// Щит для C6.8 (корневой TASKS): неизвестный уровень логирования не должен выключать логи целиком.
// До правки init() присваивал config.logLevel без проверки, а shouldLog сравнивал 0 <= undefined,
// что глушило все уровни, включая error, - и первым же терялся канал, по которому это видно.
// Запуск: node utils/logger.test.mjs

import assert from 'node:assert/strict';

const captured = { error: [], warn: [], info: [], debug: [] };
const nativeConsole = { ...console };
for (const level of Object.keys(captured)) {
    console[level] = (...args) => { captured[level].push(args); };
}
console.time = () => {};
console.timeEnd = () => {};

const { Logger } = await import('./logger.js');

function reset() {
    for (const level of Object.keys(captured)) {
        captured[level].length = 0;
    }
}

// --- неизвестный уровень: error остаётся включённым ---------------------------------------------

reset();
Logger.init({ logLevel: 'verbose' });
assert.equal(Logger.logLevel, 'error', 'неизвестный уровень обязан падать на error, а не приниматься');
assert.equal(captured.error.length >= 1, true, 'отказ обязан быть виден в логе на уровне, который сам же и остаётся включённым');

reset();
Logger.error('boom');
assert.equal(captured.error.length, 1, 'error обязан логироваться при нераспознанном уровне');
Logger.info('quiet');
assert.equal(captured.info.length, 0, 'уровень error не пропускает info');

// --- корректные уровни работают как раньше ------------------------------------------------------

reset();
Logger.init({ logLevel: 'debug' });
assert.equal(Logger.logLevel, 'debug');
Logger.debug('d');
Logger.error('e');
assert.equal(captured.debug.length, 1);
assert.equal(captured.error.length, 1);

reset();
Logger.init({ logLevel: 'silent' });
assert.equal(Logger.logLevel, 'silent');
Logger.error('e');
Logger.warn('w');
assert.equal(captured.error.length + captured.warn.length, 0, "'silent' по-прежнему глушит всё");

// --- init без logLevel не меняет уровень --------------------------------------------------------

Logger.setLevel('warn');
Logger.init({});
assert.equal(Logger.logLevel, 'warn', 'отсутствие logLevel в конфиге не должно сбрасывать уровень');

// --- второй рубеж: прямое присваивание полю в обход init/setLevel -------------------------------

reset();
Logger.logLevel = 'nonsense';
Logger.error('e');
assert.equal(captured.error.length, 1, 'даже при испорченном поле ошибки обязаны доходить');
Logger.warn('w');
assert.equal(captured.warn.length, 0, 'запасной порог - именно error, а не «пропускать всё»');

Logger.logLevel = 'info';
Object.assign(console, nativeConsole);
console.log('Logger level validation contract checks passed');
