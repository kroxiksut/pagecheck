import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTargetPackage } from './build-extension.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const RELEASE_ROOT = path.join(PROJECT_ROOT, 'release', 'readiness');
const TARGETS = ['chrome', 'edge', 'firefox'];
const OPTIONAL_API_PERMISSION = 'webRequest';
const OPTIONAL_API_ORIGINS = ['http://*/*', 'https://*/*'];

function hashJson(value) {
    return createHash('sha256').update(`${JSON.stringify(value)}\n`).digest('hex');
}

function stableJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function hasExactEntries(actual, expected) {
    return Array.isArray(actual)
        && actual.length === expected.length
        && expected.every((entry) => actual.includes(entry));
}

function hasDnrMaterial(manifest, inventory) {
    return manifest.permissions?.includes('declarativeNetRequest') === true
        || Object.hasOwn(manifest, 'declarative_net_request')
        || inventory.some((entry) => entry.path === 'rules/ruleset.json' || entry.path === 'assets/blocked.html');
}

function hasDevelopmentMaterial(inventory) {
    return inventory.some((entry) => /(^|\/)(tests|fixtures|scripts|manifests|release|dist)(\/|$)|(^|\/)(AGENTS|AI_RULES|AI_CONTEXT|STRUCTURE|TASKS)\.ru?\.md$|\.test\.mjs$|\.md$/i.test(entry.path));
}

async function exists(absolutePath) {
    try {
        await access(absolutePath);
        return true;
    } catch {
        return false;
    }
}

function createTargetEvidence(target, build, sourceFacts) {
    const manifest = build.manifest;
    const dnrPresent = hasDnrMaterial(manifest, build.inventory);
    const staticChecks = {
        manifestParsed: true,
        optionalObserverPermission: hasExactEntries(manifest.optional_permissions, [OPTIONAL_API_PERMISSION])
            && hasExactEntries(manifest.optional_host_permissions, OPTIONAL_API_ORIGINS)
            && manifest.permissions?.includes(OPTIONAL_API_PERMISSION) === false,
        noDevelopmentMaterial: hasDevelopmentMaterial(build.inventory) === false,
        noDnrMaterial: dnrPresent === false,
        legacyDomStubAbsent: sourceFacts.legacyDomStubAbsent,
        localeKeysMatch: sourceFacts.localeKeysMatch,
        remoteCodeAndTelemetryAudit: 'not-run'
    };
    const blockers = [];
    if (!staticChecks.noDnrMaterial) {
        blockers.push('legacy-dnr-material-is-still-packaged');
    }
    if (!staticChecks.legacyDomStubAbsent) {
        blockers.push('legacy-api-interceptor-stub-is-still-present');
    }
    blockers.push('browser-sideload-and-runtime-matrix-not-run');
    blockers.push('remote-code-and-telemetry-artifact-audit-not-run');

    return {
        target,
        browserVersion: 'not-tested',
        candidateId: `${manifest.version_name || manifest.version}-${hashJson(build.inventory)}`,
        outcome: 'reject',
        outcomeReason: 'Known static release-contract violations prevent a hold or go outcome.',
        blockers,
        manifest,
        manifestSha256: hashJson(manifest),
        packageSha256: hashJson(build.inventory),
        packageHashKind: 'canonical-inventory-json-sha256',
        fileCount: build.inventory.length,
        inventory: build.inventory,
        staticChecks,
        manualChecks: {
            browserMatrix: 'not-run',
            functionalModuleMatrix: 'not-run',
            lifecycleAndPerformanceMatrix: 'not-run',
            localizationAndUxMatrix: 'not-run',
            rollbackRehearsal: 'not-run'
        },
        privacyEvidence: {
            artifactContainsNoCertificationUserData: true,
            runtimeTransmissionValidation: 'not-run',
            passwordAndRawPayloadExclusionValidation: 'not-run'
        }
    };
}

function createSummary(versionName, targets) {
    const rows = targets.map((target) => `| ${target.target} | ${target.outcome} | ${target.packageSha256} | ${target.fileCount} |`).join('\n');
    return `# Local release readiness: ${versionName}\n\n`
        + 'This is a deterministic local pre-certification record, not a store submission or browser validation result.\n\n'
        + '## Outcome\n\n'
        + 'All targets are **reject**. Chrome and Edge still package legacy DNR material. All targets still contain the quarantined legacy `modules/api-interception/ApiInterceptor.js` stub. Browser sideload, runtime, performance, localization, and rollback checks have not run.\n\n'
        + '| Target | Outcome | Package SHA-256 | Files |\n'
        + '| --- | --- | --- | ---: |\n'
        + `${rows}\n\n`
        + '## Evidence\n\n'
        + '- `artifact-inventory.json` contains target manifests, complete file hashes, and a canonical-inventory SHA-256 package identity.\n'
        + '- `validation-matrix.json` records static gates, blockers, and unrun manual gates.\n'
        + '- No URLs, DOM content, headers, request identifiers, user input, or payload data are written to this bundle.\n\n'
        + 'Re-run with `node scripts/certify-local-release.mjs` after an approved implementation change. A `go` outcome requires a new physical browser certification run.\n';
}

function createRussianSummary(versionName, targets) {
    const rows = targets.map((target) => `| ${target.target} | ${target.outcome} | ${target.packageSha256} | ${target.fileCount} |`).join('\n');
    return `# Локальная готовность релиза: ${versionName}\n\n`
        + 'Это детерминированная локальная запись pre-certification, а не отправка в store и не результат browser validation.\n\n'
        + '## Результат\n\n'
        + 'Для всех targets выставлен **reject**. Chrome и Edge всё ещё содержат legacy DNR material. Во всех targets остаётся изолированный legacy-stub `modules/api-interception/ApiInterceptor.js`. Browser sideload, runtime, performance, localization и rollback проверки не запускались.\n\n'
        + '| Target | Outcome | Package SHA-256 | Files |\n'
        + '| --- | --- | --- | ---: |\n'
        + `${rows}\n\n`
        + '## Evidence\n\n'
        + '- `artifact-inventory.json` содержит target manifests, полные file hashes и canonical-inventory SHA-256 package identity.\n'
        + '- `validation-matrix.json` фиксирует static gates, blockers и незапущенные manual gates.\n'
        + '- Bundle не содержит URL, DOM content, headers, request identifiers, user input или payload data.\n\n'
        + 'После approved implementation change повторно запустите `node scripts/certify-local-release.mjs`. Для `go` потребуется новый physical browser certification run.\n';
}

async function readLocaleFacts() {
    const [english, russian] = await Promise.all([
        readFile(path.join(PROJECT_ROOT, '_locales', 'en', 'messages.json'), 'utf8'),
        readFile(path.join(PROJECT_ROOT, '_locales', 'ru', 'messages.json'), 'utf8')
    ]);
    const englishKeys = Object.keys(JSON.parse(english.replace(/^\uFEFF/, ''))).sort();
    const russianKeys = Object.keys(JSON.parse(russian.replace(/^\uFEFF/, ''))).sort();
    return englishKeys.length === russianKeys.length && englishKeys.every((key, index) => key === russianKeys[index]);
}

async function main() {
    const sourceManifest = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'manifest.json'), 'utf8'));
    const versionName = sourceManifest.version_name || sourceManifest.version;
    const readinessDirectory = path.join(RELEASE_ROOT, versionName);
    const sourceFacts = Object.freeze({
        legacyDomStubAbsent: (await exists(path.join(PROJECT_ROOT, 'modules', 'api-interception', 'ApiInterceptor.js'))) === false,
        localeKeysMatch: await readLocaleFacts()
    });
    const targetBuilds = [];
    for (const target of TARGETS) {
        const first = await buildTargetPackage(target);
        const repeated = await buildTargetPackage(target);
        if (JSON.stringify(first.inventory) !== JSON.stringify(repeated.inventory)) {
            throw new Error(`Non-deterministic package inventory for ${target}`);
        }
        targetBuilds.push(createTargetEvidence(target, first, sourceFacts));
    }
    const artifactInventory = {
        schemaVersion: 1,
        certificationKind: 'local-static-pre-certification',
        extensionVersion: sourceManifest.version,
        extensionVersionName: versionName,
        buildDate: null,
        buildDateStatus: 'not-recorded; a physical release candidate has not been selected',
        targets: targetBuilds.map(({ staticChecks, manualChecks, privacyEvidence, outcome, outcomeReason, blockers, browserVersion, ...artifact }) => artifact)
    };
    const validationMatrix = {
        schemaVersion: 1,
        certificationKind: 'local-static-pre-certification',
        extensionVersion: sourceManifest.version,
        extensionVersionName: versionName,
        sourceFacts,
        targets: targetBuilds.map(({ manifest, manifestSha256, packageSha256, fileCount, candidateId, inventory, ...validation }) => validation)
    };
    await rm(readinessDirectory, { recursive: true, force: true });
    await mkdir(readinessDirectory, { recursive: true });
    await Promise.all([
        writeFile(path.join(readinessDirectory, 'artifact-inventory.json'), stableJson(artifactInventory), 'utf8'),
        writeFile(path.join(readinessDirectory, 'validation-matrix.json'), stableJson(validationMatrix), 'utf8'),
        writeFile(path.join(readinessDirectory, 'SUMMARY.md'), createSummary(versionName, targetBuilds), 'utf8'),
        writeFile(path.join(readinessDirectory, 'SUMMARY.ru.md'), createRussianSummary(versionName, targetBuilds), 'utf8')
    ]);
    process.stdout.write(`${JSON.stringify({ versionName, outcomes: targetBuilds.map(({ target, outcome }) => ({ target, outcome })) })}\n`);
}

await main();
