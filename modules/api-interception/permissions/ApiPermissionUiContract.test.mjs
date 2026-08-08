import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const popupSource = await readFile(new URL('../../../js/popup.js', import.meta.url), 'utf8');
const optionsSource = await readFile(new URL('../../../js/options.js', import.meta.url), 'utf8');
const backgroundSource = await readFile(new URL('../../../js/background.js', import.meta.url), 'utf8');

for (const source of [popupSource, optionsSource]) {
    const beginIndex = source.indexOf("action: 'apiPermissionBegin'");
    const requestIndex = source.indexOf('chrome.permissions.request(API_PERMISSION_REQUEST)');
    const waitIndex = source.indexOf('await Promise.all([beginPromise, requestPromise])');
    assert.ok(beginIndex >= 0 && requestIndex > beginIndex && waitIndex > requestIndex);
    assert.equal(source.includes("action: 'apiPermissionCommit'"), true);
    assert.equal(source.includes("action: 'apiPermissionDisable'"), true);
}

assert.equal(optionsSource.includes('e.stopPropagation();'), true);
assert.equal(optionsSource.includes('if (moduleId === API_INTERCEPTION_MODULE_ID) return;'), true);
assert.equal(backgroundSource.includes("case 'apiPermissionBegin'"), true);
assert.equal(backgroundSource.includes("case 'apiPermissionCommit'"), true);
assert.equal(backgroundSource.includes("case 'apiPermissionDisable'"), true);
assert.equal(backgroundSource.includes("case 'apiPermissionState'"), true);

console.log('API permission UI contract checks passed');
