import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tests = [
    '../decision/apiMimeDecision.test.mjs',
    '../runtime/ApiFindingState.test.mjs',
    '../runtime/ApiResourceObserver.test.mjs',
    '../runtime/BackgroundIntegration.test.mjs',
    '../permissions/ApiPermissionCoordinator.test.mjs',
    '../permissions/ApiPermissionUiContract.test.mjs',
    './ApiTestHarness.test.mjs',
    './BrowserPortabilityContract.test.mjs',
    './Priority4Privacy.test.mjs',
    './priority2FixtureServer.test.mjs',
    './metadata-fixture-server.test.mjs'
];

for (const test of tests) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(test, import.meta.url))], { stdio: 'inherit' });
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

console.log('Priority 4 local suite passed');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    // Executed directly by the documented local command.
}
