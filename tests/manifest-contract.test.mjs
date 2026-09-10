import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildTargetPackage,
    createTargetManifest,
    validateTargetManifest
} from '../scripts/build-extension.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseManifest = JSON.parse(await readFile(path.join(projectRoot, 'manifest.json'), 'utf8'));
const firefoxOverlay = JSON.parse(await readFile(path.join(projectRoot, 'manifests', 'manifest.firefox.overlay.json'), 'utf8'));

const chromeManifest = createTargetManifest(baseManifest, {}, 'chrome');
assert.deepEqual(chromeManifest, baseManifest);
assert.equal(validateTargetManifest(chromeManifest, 'chrome'), true);
assert.equal(chromeManifest.permissions.includes('webRequest'), false);
assert.deepEqual(chromeManifest.optional_permissions, ['webRequest']);
assert.deepEqual(chromeManifest.optional_host_permissions, ['https://*/*', 'http://*/*']);
assert.equal('host_permissions' in chromeManifest, false);

const edgeManifest = createTargetManifest(baseManifest, {}, 'edge');
assert.deepEqual(edgeManifest, baseManifest);
assert.equal(validateTargetManifest(edgeManifest, 'edge'), true);

const firefoxManifest = createTargetManifest(baseManifest, firefoxOverlay, 'firefox');
assert.equal(validateTargetManifest(firefoxManifest, 'firefox'), true);
assert.equal('minimum_chrome_version' in firefoxManifest, false);
assert.equal('declarative_net_request' in firefoxManifest, false);
assert.equal(firefoxManifest.permissions.includes('declarativeNetRequest'), false);
assert.equal(firefoxManifest.permissions.includes('declarativeContent'), false);
assert.deepEqual(
    firefoxManifest.permissions,
    baseManifest.permissions.filter((permission) => permission !== 'declarativeNetRequest' && permission !== 'declarativeContent')
);
assert.deepEqual(firefoxManifest.optional_permissions, baseManifest.optional_permissions);
assert.deepEqual(firefoxManifest.optional_host_permissions, baseManifest.optional_host_permissions);
assert.deepEqual(firefoxManifest.background, {
    scripts: ['js/background.js'],
    persistent: false,
    type: 'module'
});
assert.deepEqual(firefoxManifest.browser_specific_settings.gecko.data_collection_permissions.required, ['none']);
assert.equal(firefoxManifest.web_accessible_resources.flatMap((entry) => entry.resources).includes('rules/ruleset.json'), false);
assert.deepEqual(
    firefoxManifest.web_accessible_resources,
    baseManifest.web_accessible_resources.map((entry) => ({
        ...entry,
        resources: entry.resources.filter((resource) => resource !== 'rules/ruleset.json' && resource !== 'assets/blocked.html')
    }))
);
assert.deepEqual(firefoxManifest.action, baseManifest.action);
assert.deepEqual(firefoxManifest.options_ui, baseManifest.options_ui);
assert.deepEqual(firefoxManifest.content_security_policy, baseManifest.content_security_policy);
assert.deepEqual(firefoxManifest.content_scripts, baseManifest.content_scripts);
assert.deepEqual(firefoxManifest.icons, baseManifest.icons);
assert.equal(firefoxManifest.default_locale, baseManifest.default_locale);
assert.equal('browser_specific_settings' in chromeManifest, false);

assert.throws(() => createTargetManifest(baseManifest, { unsupported: true }, 'firefox'), /Unknown manifest overlay key/);
assert.throws(() => createTargetManifest(baseManifest, {}, '../escape'), /Unknown build target/);
assert.throws(() => validateTargetManifest({ manifest_version: 2 }, 'chrome'), /Manifest V3/);
await assert.rejects(
    buildTargetPackage('firefox', { overlayPath: path.join(projectRoot, 'manifests', 'missing.overlay.json') }),
    /ENOENT/
);

const chromeBuildOne = await buildTargetPackage('chrome');
const chromeBuildTwo = await buildTargetPackage('chrome');
const firefoxBuild = await buildTargetPackage('firefox');
assert.deepEqual(chromeBuildOne.inventory, chromeBuildTwo.inventory);
assert.equal(chromeBuildOne.inventory.some((entry) => /(^|\/)(tests|fixtures)(\/|$)|\.mjs$|\.md$/i.test(entry.path)), false);
assert.equal(chromeBuildOne.inventory.some((entry) => /(^|\/)(scripts|manifests|manual-tests)(\/|$)|(^|\/)run-tests\.cjs$/i.test(entry.path)), false);
assert.equal(chromeBuildOne.inventory.some((entry) => entry.path === '_locales/en/messages.json'), true);
assert.equal(chromeBuildOne.inventory.some((entry) => entry.path === 'modules/ModuleCore.js'), true);
assert.equal(firefoxBuild.inventory.some((entry) => entry.path === 'rules/ruleset.json' || entry.path === 'assets/blocked.html'), false);
assert.equal(firefoxBuild.inventory.some((entry) => /(^|\/)(tests|fixtures)(\/|$)|\.mjs$|\.md$/i.test(entry.path)), false);
assert.equal(firefoxBuild.inventory.some((entry) => /(^|\/)(scripts|manifests|manual-tests)(\/|$)|(^|\/)run-tests\.cjs$/i.test(entry.path)), false);
assert.equal(firefoxBuild.inventory.some((entry) => entry.path === '_locales/ru/messages.json'), true);
assert.equal(firefoxBuild.inventory.some((entry) => entry.path === 'modules/ModuleCore.js'), true);
assert.equal(JSON.parse(await readFile(path.join(chromeBuildOne.outputDirectory, 'manifest.json'), 'utf8')).version, baseManifest.version);
assert.equal(JSON.parse(await readFile(path.join(firefoxBuild.outputDirectory, 'manifest.json'), 'utf8')).background.scripts[0], 'js/background.js');

// Пакет не имеет права содержать НИ ОДНОГО `.mjs`: в рантайме расширения таких файлов нет вовсе -
// это всегда тест, фикстура или сборочный скрипт. Правило по расширению, а не по шаблону имени,
// потому что шаблон `*.test.mjs` однажды уже пропустил конфликтную копию, созданную синхронизацией
// диска (`crossModuleBoundaries.test (копия с компьютера DESKTOP).mjs`), и она уехала в пакет.
for (const build of [chromeBuildOne, firefoxBuild]) {
    const stray = build.inventory.filter((entry) => entry.path.toLowerCase().endsWith('.mjs'));
    assert.deepEqual(stray, [], `в пакете не может быть .mjs: ${stray.map((entry) => entry.path).join(', ')}`);

    // Конфликтные копии и бэкапы редактора: имя произвольное, поэтому ловим по признаку, а не по
    // расширению. Такой файл в пакете - это чужая версия кода, доехавшая до пользователя.
    const copies = build.inventory.filter((entry) => /копия|\bcopy\b|\(\d+\)\.|\.bak$|~$/i.test(entry.path));
    assert.deepEqual(copies, [], `в пакете не может быть конфликтных копий: ${copies.map((entry) => entry.path).join(', ')}`);
}

console.log('Manifest and deterministic package contract checks passed');
