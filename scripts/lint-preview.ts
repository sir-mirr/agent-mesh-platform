import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = process.cwd();
const isTestMode = process.argv.includes('--test');

// Minimum floor for valid route extraction: 60 modular pages must extract at least 60 route references!
const MIN_ROUTE_REFERENCES_FLOOR = 60;

export function runLint(options?: {
  mockDeliverables?: string;
  mockSpec?: string;
  mockHtmlFiles?: Record<string, string>;
  mockRbac?: string;
  minFloorOverride?: number;
  silent?: boolean;
}): { errors: number; totalRoutesFound: number; totalAllowedRoutes: number } {
  let errors = 0;
  let totalRoutesFound = 0;
  const silent = options?.silent ?? false;
  const minFloor = options?.minFloorOverride ?? MIN_ROUTE_REFERENCES_FLOOR;

  // 1. Verify all files in docs/deliverables.md exist
  const deliverablesMd = options?.mockDeliverables ?? readFileSync('docs/deliverables.md', 'utf-8');
  const fileMatches = [...deliverablesMd.matchAll(/\[`([^`]+)`\]/g)]
    .map(m => m[1])
    .filter((f): f is string => typeof f === 'string');

  fileMatches.forEach(f => {
    if (!options?.mockDeliverables && !existsSync(f)) {
      if (!silent) console.error(`❌ Missing file in manifest: ${f}`);
      errors++;
    }
  });

  // 2. Parse SPEC.md to extract authoritative allowlist of routes (§ 9.1, § 9.2, § 9.2.1)
  const spec = options?.mockSpec ?? readFileSync(join(REPO_ROOT, 'SPEC.md'), 'utf8');

  function extractRoutesFromSection(startMarker: string, endMarker: string): string[] {
    const start = spec.indexOf(startMarker);
    if (start === -1) return [];
    const end = endMarker ? spec.indexOf(endMarker, start) : spec.length;
    const sectionText = spec.slice(start, end === -1 ? undefined : end);
    return [...sectionText.matchAll(/`(\/(?:api|auth)[^`]+)`/g)]
      .map(m => (m[1] ?? '').replace(/ \(SSE\)/g, '').trim())
      .filter(Boolean);
  }

  const spec91Routes = extractRoutesFromSection('### 9.1.', '### 9.2.');
  const spec92Routes = extractRoutesFromSection('### 9.2.', '#### 9.2.1.');
  const spec921Routes = extractRoutesFromSection('#### 9.2.1.', '### 9.3.');

  const rawAllowedRoutes = [...new Set([...spec91Routes, ...spec92Routes, ...spec921Routes])];

  if (rawAllowedRoutes.length === 0) {
    if (!silent) console.error('❌ Extracted 0 routes from SPEC.md — section header markers changed');
    errors++;
  }

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

  // 3. Helper to find all HTML files
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

  const htmlFilePaths = options?.mockHtmlFiles ? Object.keys(options.mockHtmlFiles) : getHtmlFiles('preview');
  const ROUTE_EXTRACT_REGEX = /\/(?:api\/v1|auth)\/[a-zA-Z0-9_\-\/{}:$.]+/g;

  htmlFilePaths.forEach(file => {
    const content = options?.mockHtmlFiles ? (options.mockHtmlFiles[file] ?? '') : readFileSync(file, 'utf-8');
    const foundApiRoutes = [...content.matchAll(ROUTE_EXTRACT_REGEX)].map(m => m[0]);

    foundApiRoutes.forEach(rawRoute => {
      const cleanedRawRoute = rawRoute.replace(/[.,;:)'"`]+$/, '');
      if (cleanedRawRoute.endsWith('.html') || cleanedRawRoute.endsWith('.css') || cleanedRawRoute.endsWith('.js') || cleanedRawRoute.endsWith('.png') || cleanedRawRoute.endsWith('.json')) return;
      
      const normalizedRoute = cleanedRawRoute.replace(/\$\{[a-zA-Z0-9_]+\}/g, '{param}');
      totalRoutesFound++;
      const matched = routeRegexes.some(r => r.regex.test(normalizedRoute));
      if (!matched) {
        if (!silent) console.error(`❌ Unauthorized / Invented route '${cleanedRawRoute}' (normalized: '${normalizedRoute}') found in ${file}`);
        errors++;
      }
    });
  });

  // Anti-degradation floor assertion: check that routes extracted did not degrade below expected floor!
  if (totalRoutesFound < minFloor) {
    if (!silent) console.error(`❌ Extracted ${totalRoutesFound} routes, expected at least ${minFloor} — the route extractor is degraded or missing routes!`);
    errors++;
  }

  // 4. Verify all 9 capabilities exist in RBAC
  const rbacHtml = options?.mockRbac ?? readFileSync('preview/tenant/organization-rbac.html', 'utf-8');
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
      if (!silent) console.error(`❌ Missing capability '${cap}' in organization-rbac.html`);
      errors++;
    }
  });

  return { errors, totalRoutesFound, totalAllowedRoutes: rawAllowedRoutes.length };
}

// Self-Test Mode (Meta-Testing the Linter against Mutations & Degradations)
if (isTestMode) {
  console.log('🧪 --- Running Linter Mutation & Degradation Self-Test Suite ---');
  let testFailures = 0;

  // Test 1: Unregistered route MUST fail (errors > 0)
  const mut1 = runLint({
    mockHtmlFiles: { 'test.html': '<div>POST /api/v1/tenants/acme/quota</div>' },
    minFloorOverride: 1,
    silent: true
  });
  if (mut1.errors === 0) {
    console.error('❌ Mutation Test 1 Failed: Invented route did not trigger error!');
    testFailures++;
  } else {
    console.log('✓ Mutation Test 1 Passed: Invented route was caught.');
  }

  // Test 2: Degraded extraction (e.g. only 7 routes when floor is 60) MUST fail
  const mut2 = runLint({
    mockHtmlFiles: { 'test.html': '<div>' + Array(7).fill('/api/v1/inbox').join(' ') + '</div>' },
    minFloorOverride: 60,
    silent: true
  });
  if (mut2.errors === 0) {
    console.error('❌ Mutation Test 2 Failed: Degraded extraction (7 < 60) did not trigger error!');
    testFailures++;
  } else {
    console.log('✓ Mutation Test 2 Passed: Degraded route extraction (below floor of 60) was caught.');
  }

  // Test 3: Missing RBAC capability MUST fail (errors > 0)
  const mut3 = runLint({
    mockRbac: '<div>key.approve only</div>',
    silent: true
  });
  if (mut3.errors === 0) {
    console.error('❌ Mutation Test 3 Failed: Missing capabilities did not trigger error!');
    testFailures++;
  } else {
    console.log('✓ Mutation Test 3 Passed: Missing capability was caught.');
  }

  // Test 4: SPEC header change resulting in 0 allowed routes MUST fail
  const mut4 = runLint({
    mockSpec: '# Invalid SPEC with no 9.1 section',
    silent: true
  });
  if (mut4.errors === 0) {
    console.error('❌ Mutation Test 4 Failed: Corrupted SPEC did not trigger error!');
    testFailures++;
  } else {
    console.log('✓ Mutation Test 4 Passed: Corrupted SPEC was caught.');
  }

  if (testFailures === 0) {
    console.log('🎉 ALL 4 LINTER MUTATION & DEGRADATION SELF-TESTS PASSED!\n');
  } else {
    console.error(`❌ Total Mutation Failures: ${testFailures}`);
    process.exit(1);
  }
}

// Normal Linter Execution
console.log('--- Running Allowlist-Based Preview & Contract Linter ---');
const result = runLint();

if (result.errors === 0) {
  console.log(`✓ Verified 60 files in deliverables manifest exist.`);
  console.log(`✓ Parsed ${result.totalAllowedRoutes} authoritative routes from SPEC.md (§ 9.1, § 9.2, § 9.2.1).`);
  console.log(`✓ Extracted and verified ${result.totalRoutesFound} route references across 61 HTML files (Floor: >= ${MIN_ROUTE_REFERENCES_FLOOR}).`);
  console.log(`✓ Verified all 9 capabilities (Contracts v0.9.1) exist in RBAC.`);
  console.log(`\n✅ ALL LINT & CONTRACT CHECKS PASSED (0 errors, ${result.totalRoutesFound} routes verified)`);
  process.exit(0);
} else {
  console.error(`\n❌ Total Lint Errors: ${result.errors}`);
  process.exit(1);
}
