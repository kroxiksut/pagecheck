import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const DIST_ROOT = path.join(PROJECT_ROOT, 'dist');
const TARGETS = new Set(['chrome', 'edge', 'firefox']);
const RUNTIME_ROOTS = new Set(['_locales', 'assets', 'js', 'modules', 'platform', 'rules', 'styles', 'ui', 'utils']);
const EXCLUDED_DIRECTORY_NAMES = new Set(['tests', 'fixtures', 'manual-tests', '.git', '.agents', '.codex', 'dist', '_metadata']);
const EXCLUDED_FILE_NAMES = new Set(['AGENTS.md', 'AGENTS.ru.md', 'AI_RULES.md', 'AI_RULES.ru.md', 'AI_CONTEXT.md', 'AI_CONTEXT.ru.md', 'CLA.md', 'CONTRIBUTING.md', 'ROADMAP.ru.md', 'STRUCTURE.md', 'STRUCTURE.ru.md', 'TASKS.ru.md', 'run-tests.cjs']);
const FIREFOX_REMOVED_PERMISSIONS = new Set(['declarativeNetRequest', 'declarativeContent']);
const OVERLAY_ROOT_KEYS = new Set(['background', 'browser_specific_settings']);

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeObjects(base, overlay) {
    const merged = cloneJson(base);
    for (const [key, value] of Object.entries(overlay)) {
        if (isPlainObject(value) && isPlainObject(merged[key])) {
            merged[key] = mergeObjects(merged[key], value);
        } else {
            merged[key] = cloneJson(value);
        }
    }
    return merged;
}

function assertKnownTarget(target) {
    if (!TARGETS.has(target)) {
        throw new Error(`Unknown build target: ${target}`);
    }
}

function assertOverlayShape(overlay) {
    if (!isPlainObject(overlay)) {
        throw new Error('Manifest overlay must be an object');
    }
    for (const key of Object.keys(overlay)) {
        if (!OVERLAY_ROOT_KEYS.has(key)) {
            throw new Error(`Unknown manifest overlay key: ${key}`);
        }
    }
}

function removeFirefoxOnlyChromeKeys(manifest) {
    delete manifest.minimum_chrome_version;
    delete manifest.declarative_net_request;
    if (isPlainObject(manifest.background)) {
        delete manifest.background.service_worker;
    }
    manifest.permissions = Array.isArray(manifest.permissions)
        ? manifest.permissions.filter((permission) => !FIREFOX_REMOVED_PERMISSIONS.has(permission))
        : [];
    manifest.web_accessible_resources = Array.isArray(manifest.web_accessible_resources)
        ? manifest.web_accessible_resources.map((entry) => ({
            ...entry,
            resources: Array.isArray(entry.resources)
                ? entry.resources.filter((resource) => resource !== 'rules/ruleset.json' && resource !== 'assets/blocked.html')
                : []
        }))
        : [];
}

export function createTargetManifest(baseManifest, overlay = {}, target) {
    assertKnownTarget(target);
    if (!isPlainObject(baseManifest)) {
        throw new Error('Base manifest must be an object');
    }
    if (target === 'chrome' || target === 'edge') {
        return cloneJson(baseManifest);
    }

    assertOverlayShape(overlay);
    const manifest = mergeObjects(baseManifest, overlay);
    removeFirefoxOnlyChromeKeys(manifest);
    return manifest;
}

export function validateTargetManifest(manifest, target) {
    assertKnownTarget(target);
    if (!isPlainObject(manifest) || manifest.manifest_version !== 3) {
        throw new Error('Target manifest must be a Manifest V3 object');
    }
    for (const key of ['name', 'description', 'version', 'default_locale', 'action', 'background']) {
        if (!(key in manifest)) {
            throw new Error(`Target manifest is missing ${key}`);
        }
    }
    if (target === 'firefox') {
        if (manifest.background?.service_worker || !Array.isArray(manifest.background?.scripts)
            || manifest.background.scripts.join(',') !== 'js/background.js'
            || manifest.background.persistent !== false
            || manifest.background.type !== 'module') {
            throw new Error('Firefox manifest must use the reviewed module event-page background');
        }
        if ('minimum_chrome_version' in manifest || 'declarative_net_request' in manifest) {
            throw new Error('Firefox manifest must not include Chrome-only DNR or minimum version keys');
        }
        if (manifest.permissions?.some((permission) => FIREFOX_REMOVED_PERMISSIONS.has(permission))) {
            throw new Error('Firefox manifest must not include excluded Chrome permissions');
        }
        if (manifest.web_accessible_resources?.some((entry) => entry.resources?.includes('rules/ruleset.json') || entry.resources?.includes('assets/blocked.html'))) {
            throw new Error('Firefox manifest must not expose excluded DNR resources');
        }
        const requiredCollection = manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required;
        if (!Array.isArray(requiredCollection) || requiredCollection.length !== 1 || requiredCollection[0] !== 'none') {
            throw new Error('Firefox manifest must declare no external data collection');
        }
    } else if (manifest.background?.service_worker !== 'js/background.js' || manifest.background?.type !== 'module') {
        throw new Error('Chromium manifest must use the module service worker');
    }
    return true;
}

function shouldExclude(relativePath, target) {
    const segments = relativePath.split(path.sep);
    if (segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) {
        return true;
    }
    const basename = path.basename(relativePath);
    // `.mjs` исключается ЦЕЛИКОМ, а не по шаблону `*.test.mjs`. Причина не теоретическая: Яндекс.Диск
    // создал конфликтную копию `crossModuleBoundaries.test (копия с компьютера DESKTOP).mjs`, она не
    // подошла под шаблон - и уехала в пакет к пользователю. В рантайме расширения файлов `.mjs` нет
    // ни одного (тесты, фикстуры и сборочные скрипты - все `.mjs`), поэтому правило по расширению
    // строго сильнее и не зависит от того, как назван файл.
    if (EXCLUDED_FILE_NAMES.has(basename) || basename.endsWith('.md') || basename.endsWith('.mjs')) {
        return true;
    }
    if (target === 'firefox' && (segments[0] === 'rules' || relativePath === path.join('assets', 'blocked.html'))) {
        return true;
    }
    return false;
}

async function assertNoLinksOutsideWorkspace(sourcePath) {
    const stat = await lstat(sourcePath);
    if (stat.isSymbolicLink()) {
        throw new Error(`Symlink is not allowed in package source: ${sourcePath}`);
    }
    if (!stat.isDirectory()) {
        return;
    }
    for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
        await assertNoLinksOutsideWorkspace(path.join(sourcePath, entry.name));
    }
}

async function copyRuntimeSource(target, temporaryDirectory) {
    for (const rootName of [...RUNTIME_ROOTS].sort()) {
        const source = path.join(PROJECT_ROOT, rootName);
        const destination = path.join(temporaryDirectory, rootName);
        await assertNoLinksOutsideWorkspace(source);
        await cp(source, destination, {
            recursive: true,
            filter: (sourcePath) => {
                const relative = path.relative(PROJECT_ROOT, sourcePath);
                return relative === '' || !shouldExclude(relative, target);
            }
        });
    }
}

async function createInventory(rootDirectory) {
    const files = [];
    async function walk(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await walk(absolute);
            } else if (entry.isFile()) {
                const relative = path.relative(rootDirectory, absolute).split(path.sep).join('/');
                const content = await readFile(absolute);
                files.push({
                    path: relative,
                    sha256: createHash('sha256').update(content).digest('hex')
                });
            } else {
                throw new Error(`Unsupported package entry: ${absolute}`);
            }
        }
    }
    await walk(rootDirectory);
    return files.sort((left, right) => left.path.localeCompare(right.path));
}

function getOutputDirectory(target) {
    assertKnownTarget(target);
    const output = path.resolve(DIST_ROOT, target);
    if (path.dirname(output) !== path.resolve(DIST_ROOT)) {
        throw new Error('Target output escapes dist directory');
    }
    return output;
}

export async function buildTargetPackage(target, options = {}) {
    assertKnownTarget(target);
    const baseManifestPath = options.baseManifestPath || path.join(PROJECT_ROOT, 'manifest.json');
    const overlayPath = options.overlayPath || path.join(PROJECT_ROOT, 'manifests', 'manifest.firefox.overlay.json');
    const baseManifest = JSON.parse(await readFile(baseManifestPath, 'utf8'));
    const overlay = target === 'firefox'
        ? JSON.parse(await readFile(overlayPath, 'utf8'))
        : {};
    const manifest = createTargetManifest(baseManifest, overlay, target);
    validateTargetManifest(manifest, target);

    const outputDirectory = getOutputDirectory(target);
    await mkdir(DIST_ROOT, { recursive: true });
    const temporaryDirectory = path.join(DIST_ROOT, `.tmp-${target}-${process.pid}`);
    await rm(temporaryDirectory, { recursive: true, force: true });
    try {
        await mkdir(temporaryDirectory, { recursive: true });
        await copyRuntimeSource(target, temporaryDirectory);
        await writeFile(
            path.join(temporaryDirectory, 'manifest.json'),
            `${JSON.stringify(manifest, null, 2)}\n`,
            'utf8'
        );
        const inventory = await createInventory(temporaryDirectory);
        await rm(outputDirectory, { recursive: true, force: true });
        await rename(temporaryDirectory, outputDirectory);
        return Object.freeze({
            target,
            outputDirectory,
            manifest: Object.freeze(manifest),
            inventory: Object.freeze(inventory)
        });
    } catch (error) {
        await rm(temporaryDirectory, { recursive: true, force: true });
        throw error;
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const target = process.argv[2] || 'chrome';
    const result = await buildTargetPackage(target);
    process.stdout.write(`${JSON.stringify({ target: result.target, files: result.inventory.length })}\n`);
}
