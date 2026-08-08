import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readinessDirectory = path.join(projectRoot, 'release', 'readiness', '0.0.1-pre-alpha');
const evidenceFiles = ['artifact-inventory.json', 'validation-matrix.json', 'SUMMARY.md', 'SUMMARY.ru.md'];

function certify() {
    execFileSync(process.execPath, ['scripts/certify-local-release.mjs'], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: 'pipe'
    });
}

async function readEvidence() {
    return Object.fromEntries(await Promise.all(evidenceFiles.map(async (name) => [
        name,
        await readFile(path.join(readinessDirectory, name), 'utf8')
    ])));
}

certify();
const first = await readEvidence();
certify();
const second = await readEvidence();
assert.deepEqual(second, first);

const inventory = JSON.parse(first['artifact-inventory.json']);
const matrix = JSON.parse(first['validation-matrix.json']);
assert.equal(inventory.certificationKind, 'local-static-pre-certification');
assert.equal(inventory.extensionVersion, '0.0.1');
assert.equal(inventory.extensionVersionName, '0.0.1-pre-alpha');
assert.equal(inventory.buildDate, null);
assert.deepEqual(inventory.targets.map((target) => target.target), ['chrome', 'edge', 'firefox']);
assert.equal(inventory.targets.every((target) => /^[a-f0-9]{64}$/.test(target.packageSha256)), true);
assert.equal(inventory.targets.every((target) => target.manifest && Array.isArray(target.inventory)), true);
assert.deepEqual(matrix.sourceFacts, {
    legacyDomStubAbsent: false,
    localeKeysMatch: true
});
assert.equal(matrix.targets.every((target) => target.outcome === 'reject'), true);
assert.equal(matrix.targets.every((target) => target.blockers.includes('legacy-api-interceptor-stub-is-still-present')), true);
assert.equal(matrix.targets.find((target) => target.target === 'chrome').staticChecks.noDnrMaterial, false);
assert.equal(matrix.targets.find((target) => target.target === 'edge').staticChecks.noDnrMaterial, false);
assert.equal(matrix.targets.find((target) => target.target === 'firefox').staticChecks.noDnrMaterial, true);
assert.match(first['SUMMARY.md'], /All targets are \*\*reject\*\*/);
assert.match(first['SUMMARY.ru.md'], /Для всех targets выставлен \*\*reject\*\*/);
assert.equal(first['SUMMARY.ru.md'].includes('Результат'), true);

console.log('Local release certification contract checks passed');
