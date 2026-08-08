import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const pilotPageUrl = new URL('../fixtures/metadata-pilot-page.html', import.meta.url);
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9WQAAAABJRU5ErkJggg==', 'base64');
const MAX_AUDIT = 128;

function record(audit, routeId) {
    audit.push(routeId);
    if (audit.length > MAX_AUDIT) audit.shift();
}

function send(response, status, contentType, body = '') {
    response.writeHead(status, contentType ? { 'Content-Type': contentType } : {});
    response.end(body);
}

export async function startMetadataFixtureServer() {
    const audit = [];
    const server = createServer(async (request, response) => {
        const pathname = new URL(request.url || '/', 'http://fixture.invalid').pathname;
        record(audit, pathname);
        if (pathname === '/') return send(response, 200, 'text/html; charset=utf-8', await readFile(pilotPageUrl, 'utf8'));
        if (pathname === '/image/png') return send(response, 200, 'image/png', tinyPng);
        if (pathname === '/image/document') return send(response, 200, 'text/html; charset=utf-8', '<!doctype html>');
        if (pathname === '/image/script') return send(response, 200, 'application/javascript', 'void 0;');
        if (pathname === '/image/missing') return send(response, 200, null, 'fixture');
        if (pathname === '/image/malformed') return send(response, 200, 'not a mime', 'fixture');
        if (pathname === '/api/xhr') return send(response, 200, 'application/json', '{"ok":true}');
        if (pathname === '/status/204') return send(response, 204, 'text/html', '');
        if (pathname === '/redirect/image') {
            response.writeHead(302, { Location: '/image/document' });
            return response.end();
        }
        if (pathname === '/delay') return setTimeout(() => send(response, 200, 'image/png', tinyPng), 25);
        if (pathname === '/error') return response.destroy();
        if (pathname === '/burst') return send(response, 200, 'application/json', '{"burst":true}');
        if (pathname === '/frame') return send(response, 200, 'text/html; charset=utf-8', '<img src="/image/png" alt="frame">');
        if (pathname === '/__metrics') return send(response, 200, 'application/json', JSON.stringify({ count: audit.length, routes: audit }));
        if (pathname === '/__reset') {
            audit.length = 0;
            return send(response, 204, null);
        }
        return send(response, 404, 'text/plain; charset=utf-8', 'not found');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server address unavailable');
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        getAudit: () => [...audit],
        reset: () => { audit.length = 0; },
        close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const fixture = await startMetadataFixtureServer();
    console.log(`Metadata fixture server: ${fixture.baseUrl}`);
}
