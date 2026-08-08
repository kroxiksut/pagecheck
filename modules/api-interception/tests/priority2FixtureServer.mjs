import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const fixturePageUrl = new URL('../fixtures/priority2-resource-page.html', import.meta.url);
const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9WQAAAABJRU5ErkJggg==',
    'base64'
);
const MAX_AUDIT_RECORDS = 128;

function send(response, status, headers, body = '') {
    response.writeHead(status, headers);
    response.end(body);
}

async function handleFixtureRequest(request, response, requestAudit) {
    const pathname = new URL(request.url || '/', 'http://fixture.invalid').pathname;
    if (requestAudit.length >= MAX_AUDIT_RECORDS) {
        requestAudit.shift();
    }
    requestAudit.push({ method: String(request.method || 'GET').slice(0, 16), pathname });
    if (pathname === '/__audit') {
        send(response, 200, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(requestAudit));
        return;
    }
    if (pathname === '/') {
        const page = await readFile(fixturePageUrl, 'utf8');
        send(response, 200, { 'Content-Type': 'text/html; charset=utf-8' }, page);
        return;
    }
    if (pathname === '/frame.html') {
        send(response, 200, { 'Content-Type': 'text/html; charset=utf-8' }, '<img src="/image/iframe.png" alt="frame image">');
        return;
    }
    if (pathname === '/api/ok') {
        send(response, 200, { 'Content-Type': 'application/json; charset=utf-8' }, '{"ok":true}');
        return;
    }
    if (pathname === '/api/redirect') {
        send(response, 302, { Location: '/api/ok' });
        return;
    }
    if (pathname === '/image/ok.png' || pathname === '/image/iframe.png') {
        send(response, 200, { 'Content-Type': 'image/png' }, tinyPng);
        return;
    }
    if (pathname === '/image/declared-html') {
        send(response, 200, { 'Content-Type': 'text/html; charset=utf-8' }, '<!doctype html><title>Fixture document</title>');
        return;
    }
    send(response, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
}

export async function startPriority2FixtureServer() {
    const requestAudit = [];
    const server = createServer((request, response) => {
        handleFixtureRequest(request, response, requestAudit).catch(() => {
            send(response, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Fixture error');
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Local fixture server did not receive a TCP address');
    }
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        getRequestAudit: () => requestAudit.map((record) => ({ ...record })),
        clearRequestAudit: () => {
            requestAudit.length = 0;
        },
        close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const fixture = await startPriority2FixtureServer();
    console.log(`Priority 2 fixture server: ${fixture.baseUrl}`);
}
