import assert from 'node:assert/strict';
import { startPriority2FixtureServer } from './priority2FixtureServer.mjs';

const fixture = await startPriority2FixtureServer();
try {
    const page = await fetch(`${fixture.baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /^text\/html/);
    assert.match(await page.text(), /fixture-body-must-not-be-read/);
    assert.match(await (await fetch(`${fixture.baseUrl}/`)).text(), /type="password"/);

    const png = await fetch(`${fixture.baseUrl}/image/ok.png`);
    assert.equal(png.status, 200);
    assert.match(png.headers.get('content-type') || '', /^image\/png$/);
    assert.ok((await png.arrayBuffer()).byteLength > 0);

    const declaredHtml = await fetch(`${fixture.baseUrl}/image/declared-html`);
    assert.equal(declaredHtml.status, 200);
    assert.match(declaredHtml.headers.get('content-type') || '', /^text\/html/);

    const redirect = await fetch(`${fixture.baseUrl}/api/redirect`);
    assert.equal(redirect.status, 200);
    assert.match(redirect.headers.get('content-type') || '', /^application\/json/);

    const frame = await fetch(`${fixture.baseUrl}/frame.html`);
    assert.equal(frame.status, 200);
    assert.match(await frame.text(), /iframe\.png/);

    const post = await fetch(`${fixture.baseUrl}/api/ok`, { method: 'POST', body: 'fixture-body-must-not-be-read' });
    assert.equal(post.status, 200);
    const audit = fixture.getRequestAudit();
    assert.ok(audit.length <= 128);
    assert.equal(audit.some((record) => record.pathname.includes('?')), false);
    assert.equal(audit.some((record) => record.pathname.includes('fixture-body-must-not-be-read')), false);
    assert.equal(audit.some((record) => record.method === 'POST' && record.pathname === '/api/ok'), true);

    fixture.clearRequestAudit();
    for (let index = 0; index < 129; index += 1) {
        const response = await fetch(`${fixture.baseUrl}/api/ok?fixture-query-must-not-be-stored=${index}`);
        assert.equal(response.status, 200);
    }
    const cappedAudit = fixture.getRequestAudit();
    assert.equal(cappedAudit.length, 128);
    assert.equal(cappedAudit.every((record) => record.pathname === '/api/ok'), true);
    assert.equal(JSON.stringify(cappedAudit).includes('fixture-query-must-not-be-stored'), false);

    const auditResponse = await fetch(`${fixture.baseUrl}/__audit`);
    assert.equal(auditResponse.status, 200);
    assert.equal(Array.isArray(await auditResponse.json()), true);
} finally {
    await fixture.close();
}

console.log('ApiResourceObserver local fixture server checks passed');
