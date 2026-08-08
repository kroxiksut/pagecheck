import assert from 'node:assert/strict';
import { startMetadataFixtureServer } from './metadata-fixture-server.mjs';

const fixture = await startMetadataFixtureServer();
try {
    for (const [route, status, contentType] of [
        ['/', 200, 'text/html'],
        ['/image/png', 200, 'image/png'],
        ['/image/document', 200, 'text/html'],
        ['/image/script', 200, 'application/javascript'],
        ['/image/missing', 200, null],
        ['/image/malformed', 200, 'not a mime'],
        ['/api/xhr', 200, 'application/json'],
        ['/status/204', 204, 'text/html']
    ]) {
        const response = await fetch(`${fixture.baseUrl}${route}`);
        assert.equal(response.status, status);
        if (contentType) assert.match(response.headers.get('content-type') || '', new RegExp(`^${contentType}`));
        else assert.equal(response.headers.get('content-type'), null);
    }
    const redirect = await fetch(`${fixture.baseUrl}/redirect/image`);
    assert.equal(redirect.status, 200);
    assert.match(redirect.headers.get('content-type') || '', /^text\/html/);
    await fetch(`${fixture.baseUrl}/delay`);
    await assert.rejects(fetch(`${fixture.baseUrl}/error`));
    for (let index = 0; index < 140; index += 1) await fetch(`${fixture.baseUrl}/burst?ignored=${index}`);
    assert.ok(fixture.getAudit().length <= 128);
    assert.equal(fixture.getAudit().every((route) => !route.includes('?')), true);
    fixture.reset();
    assert.deepEqual(fixture.getAudit(), []);
} finally {
    await fixture.close();
}

console.log('Metadata fixture server checks passed');
