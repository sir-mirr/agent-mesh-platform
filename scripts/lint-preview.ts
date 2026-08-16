import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

console.log('--- Running Allowlist-Based Preview & Contract Linter ---');

const REPO_ROOT = process.cwd();

// 1. Verify all files in docs/deliverables.md exist
const deliverablesMd = readFileSync('docs/deliverables.md', 'utf-8');
const fileMatches = [...deliverablesMd.matchAll(/\[`([^`]+)`\]/g)].map(m => m[1]);

let errors = 0;
fileMatches.forEach(f => {
  if (!existsSync(f)) {
    console.error(`❌ Missing file in manifest: ${f}`);
    errors++;
  }
});
console.log(`✓ Verified ${fileMatches.length} files in deliverables manifest exist.`);

// 2. Parse SPEC.md to extract authoritative allowlist of routes (§ 9.1, § 9.2, § 9.2.1)
const spec = readFileSync(join(REPO_ROOT, 'SPEC.md'), 'utf8');

function extractRoutesFromSection(startMarker: string, endMarker: string): string[] {
  const start = spec.indexOf(startMarker);
  if (start === -1) return [];
  const end = endMarker ? spec.indexOf(endMarker, start) : spec.length;
  const sectionText = spec.slice(start, end === -1 ? undefined : end);
  
  // Match path in table: | Method | Path | ... where path is `/api/...` or `/auth/...`
  const matches = [...sectionText.matchAll(/`(\/(?:api|auth)[^`]+)`/g)].map(m => m[1].replace(/ \(SSE\)/g, '').trim());
  return matches;
}

const spec91Routes = extractRoutesFromSection('### 9.1.', '### 9.2.');
const spec92Routes = extractRoutesFromSection('### 9.2.', '#### 9.2.1.');
const spec921Routes = extractRoutesFromSection('#### 9.2.1.', '### 9.3.');

const rawAllowedRoutes = [...new Set([...spec91Routes, ...spec92Routes, ...spec921Routes])];

if (rawAllowedRoutes.length === 0) {
  console.error('❌ Extracted 0 routes from SPEC.md — section header markers changed');
  errors++;
}

// Convert paths like `/api/v1/messages/:agent` or `/api/v1/outbox/{message_id}` into flexible match patterns
function routeToRegex(route: string): RegExp {
  const clean = route.replace(/\/:[a-zA-Z0-9_-]+/g, '/[^/?#\\s"\'<>]+')
                     .replace(/\/\{[a-zA-Z0-9_-]+\}/g, '/[^/?#\\s"\'<>]+')
                     .replace(/\?/g, '\\?');
  return new RegExp(`^${clean}(?:\\?[^\\s"'<>]*)?$`);
}

const routeRegexes = rawAllowedRoutes.map(r => ({
  raw: r,
  regex: routeToRegex(r)
}));

console.log(`✓ Parsed ${rawAllowedRoutes.length} authoritative routes from SPEC.md (§ 9.1, § 9.2, § 9.2.1)`);

// 3. Helper to find all HTML files recursively
function getHtmlFiles(dir: string): string[] {
  let results: string[] = [];
  const list = readdirSync(dir);
  list.forEach(file => {
    const fullPath = join(dir, file);
    const stat = statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getHtmlFiles(fullPath));
    } else if (file.endsWith('.html')) {
      results.push(fullPath);
    }
  });
  return results;
}

const htmlFiles = getHtmlFiles('preview');

// 4. Scan all HTML files for `/(?:api|auth)/...` references
let totalRoutesFound = 0;
// Match routes, including those with template expressions like ${id}
const ROUTE_EXTRACT_REGEX = /\/(?:api\/v1|auth)\/[a-zA-Z0-9_\-\/{}:$.]+/g;

htmlFiles.forEach(file => {
  const content = readFileSync(file, 'utf-8');
  const foundApiRoutes = [...content.matchAll(ROUTE_EXTRACT_REGEX)].map(m => m[0]);

  foundApiRoutes.forEach(rawRoute => {
    // Strip trailing punctuation like . , ; : ' " )
    const cleanedRawRoute = rawRoute.replace(/[.,;:)'"`]+$/, '');

    // Ignore static asset paths (.html, .css, .js, .png, .json)
    if (cleanedRawRoute.endsWith('.html') || cleanedRawRoute.endsWith('.css') || cleanedRawRoute.endsWith('.js') || cleanedRawRoute.endsWith('.png') || cleanedRawRoute.endsWith('.json')) return;
    
    // Normalize template literals e.g. /api/v1/agents/${id}/keys -> /api/v1/agents/{param}/keys
    const normalizedRoute = cleanedRawRoute.replace(/\$\{[a-zA-Z0-9_]+\}/g, '{param}');

    totalRoutesFound++;
    const matched = routeRegexes.some(r => r.regex.test(normalizedRoute));
    if (!matched) {
      console.error(`❌ Unauthorized / Invented route '${cleanedRawRoute}' (normalized: '${normalizedRoute}') found in ${file}`);
      errors++;
    }
  });
});

if (totalRoutesFound === 0) {
  console.error('❌ Extracted 0 routes from 61 files — the route extractor is broken!');
  errors++;
} else {
  console.log(`✓ Extracted and verified ${totalRoutesFound} route references across ${htmlFiles.length} HTML files.`);
}

// 5. Verify all 9 capabilities exist in RBAC
const rbacHtml = readFileSync('preview/tenant/organization-rbac.html', 'utf-8');
const CAPABILITIES = [
  'key.approve',
  'agent.provision',
  'agent.teardown',
  'audit.read.metadata',
  'audit.read.content',
  'inbox.read.depth',
  'group.manage',
  'role.grant',
  'source.read'
];

CAPABILITIES.forEach(cap => {
  if (!rbacHtml.includes(cap)) {
    console.error(`❌ Missing capability '${cap}' in organization-rbac.html`);
    errors++;
  }
});
console.log(`✓ Verified all 9 capabilities (Contracts v0.9.1) exist in RBAC.`);

if (errors === 0) {
  console.log(`\n✅ ALL LINT & CONTRACT CHECKS PASSED (0 errors, ${totalRoutesFound} routes verified)`);
  process.exit(0);
} else {
  console.error(`\n❌ Total Lint Errors: ${errors}`);
  process.exit(1);
}
