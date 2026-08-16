import { readFileSync, writeFileSync } from 'fs';

const filePath = 'preview/index.html';
let html = readFileSync(filePath, 'utf-8');

// Replace dead routes in OpenAPI explorer & quick docs
html = html.replace(/\/api\/v1\/inbox\/lease/g, '/api/v1/inbox');
html = html.replace(/\/api\/v1\/keys\/propose/g, '/api/v1/agents');

// Replace alerts & curl snippets
html = html.replace(/POST \/api\/v1\/inbox\/nack/g, 'POST /api/v1/inbox (revert)');
html = html.replace(/DELETE \/api\/v1\/inbox\/ack/g, 'POST /api/v1/inbox (piggybacked ack)');

// Replace modal catalog links
html = html.replace('<a href="/dev/api-inbox-lease.html" class="subnav-pill" style="display:block;">#52 POST /inbox/lease API</a>', '<a href="/dev/api-inbox.html" class="subnav-pill" style="display:block;">#52 POST /inbox (SPEC §8.10)</a>');
html = html.replace('<a href="/dev/api-inbox-ack.html" class="subnav-pill" style="display:block;">#53 DELETE /inbox/ack API</a>', '<a href="/dev/api-outbox-delete.html" class="subnav-pill" style="display:block;">#53 DELETE /outbox/{id}</a>');
html = html.replace('<a href="/dev/api-keys-propose.html" class="subnav-pill" style="display:block;">#54 POST /keys/propose API</a>', '<a href="/dev/api-inbox-history.html" class="subnav-pill" style="display:block;">#54 GET /inbox/history</a>\n          <a href="/dev/api-agents-provision.html" class="subnav-pill" style="display:block;">#55 POST /agents (Provision/Key)</a>');

writeFileSync(filePath, html, 'utf-8');
console.log('Successfully updated preview/index.html with valid routes!');
