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

// Convert paths like `/api/v1/messages/:agent` or `/api/v1/outbox/{message_id}` into flexible match patterns
function routeToRegex(route: string): RegExp {
  // Replace `:param` and `{param}` with wildcard segments `[^/?#\s"'<>]+`
  const clean = route.replace(/\/:[a-zA-Z0-9_-]+/g, '/[^/?#\\s"\'<>]+')
                     .replace(/\/\{[a-zA-Z0-9_-]+\}/g, '/[^/?#\\s"\'<>]+')
                     .replace(/\?/g, '\\?');
  return new RegExp(`^${clean}(?:\\?[^\\s"'<>]*)?$`);
}

const routeRegexes = rawAllowedRoutes.map(r => ({
  raw: r,
  regex: routeToRegex(r)
}));

console.log(`✓ Parsed ${rawAllowedRoutes.length} authoritative routes from SPEC.md (§ 9.1, § 9.2, § 9.2.1):`);
rawAllowedRoutes.forEach(r => console.log(`   • ${r}`));

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

// 4. Scan all HTML files for `/api/v1/...` and `/auth/...` references and validate against allowlist
htmlFiles.forEach(file => {
  const content = readFileSync(file, 'utf-8');
  // Match any API or auth path pattern in code snippets, strings, or links
  const foundApiRoutes = [...content.matchAll(/(?:\b|\/|\'|\")(\/(?:api\/v1|auth)\/[a-zA-Z0-9_\-\/{}:]+)/g)].map(m => m[1]);

  foundApiRoutes.forEach(route => {
    // Ignore internal anchor links or file paths
    if (route.endsWith('.html') || route.endsWith('.css') || route.endsWith('.js') || route.endsWith('.png')) return;
    
    const matched = routeRegexes.some(r => r.regex.test(route));
    if (!matched) {
      console.error(`❌ Unauthorized / Invented route '${route}' found in ${file}`);
      errors++;
    }
  });
});

console.log(`✓ Verified ${htmlFiles.length} HTML files against SPEC.md authoritative route allowlist.`);

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
  console.log('\n✅ ALL LINT & CONTRACT CHECKS PASSED (0 errors)');
  process.exit(0);
} else {
  console.error(`\n❌ Total Lint Errors: ${errors}`);
  process.exit(1);
}
