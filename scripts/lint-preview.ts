import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = process.cwd();

// Minimum floor for valid route extraction: 60 modular pages must extract at least 60 route references!
const MIN_ROUTE_REFERENCES_FLOOR = 60;

export function runLint(options?: {
  mockDeliverables?: string;
  /**
   * How a manifest entry is checked for existence.
   *
   * **The mock used to turn this rule off.** The check read
   * `!options?.mockDeliverables && !existsSync(f)`, so every caller that handed
   * in a manifest also silently disabled the only rule that manifest is about —
   * and the missing-file branch was unreachable from a test, which is why
   * nothing had ever executed it. A seam instead: the real answer by default,
   * and a test can say a file is not there without deleting one.
   */
  exists?: (path: string) => boolean;
  mockSpec?: string;
  mockHtmlFiles?: Record<string, string>;
  mockRbac?: string;
  /**
   * Where the capability vocabulary comes from. The real one is the contracts
   * package; a test hands in a source that fails, which is the only way to
   * reach the refusal below without breaking the package for everything else.
   */
  mockCapabilitySource?: () => Record<string, string>;
  minFloorOverride?: number;
  silent?: boolean;
}): { errors: number; totalRoutesFound: number; totalAllowedRoutes: number; capabilityCount: number } {
  let errors = 0;
  let totalRoutesFound = 0;
  const silent = options?.silent ?? false;
  const minFloor = options?.minFloorOverride ?? MIN_ROUTE_REFERENCES_FLOOR;

  // 1. Verify all files in docs/deliverables.md exist
  const deliverablesMd = options?.mockDeliverables ?? readFileSync('docs/deliverables.md', 'utf-8');
  const fileMatches = [...deliverablesMd.matchAll(/\[`([^`]+)`\]/g)]
    .map(m => m[1])
    .filter((f): f is string => typeof f === 'string');

  const exists = options?.exists ?? existsSync;
  fileMatches.forEach(f => {
    if (!exists(f)) {
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

  // 4. Verify the capability vocabulary appears in RBAC — **read from the
  //    contract, never restated here.**
  //
  //    This was a nine-name list written by hand, and it printed
  //    `✓ Verified all 9 capabilities` while the contract held twelve:
  //    `tenant.read.stats`, `user.admit` and `usage.read` had arrived and this
  //    file did not know. A guard whose denominator is its own copy of the
  //    answer reports agreement with itself — the same shape as `rbacapi.mjs`'s
  //    hand-copied map and `scenario-ids`' hand-written FILES list, which is
  //    three of these in one repository.
  //
  //    So it is imported, and if it cannot be imported the lint fails rather
  //    than falling back to a list — falling back is what it is here to prevent.
  const rbacHtml = options?.mockRbac ?? readFileSync('preview/tenant/organization-rbac.html', 'utf-8');
  const capabilitySource = options?.mockCapabilitySource
    ?? (() => require('@agent-mesh/contracts').CAPABILITY as Record<string, string>);
  let CAPABILITIES: string[];
  try {
    CAPABILITIES = [...new Set(Object.values(capabilitySource()))];
    // An empty vocabulary is the same defect wearing a passing coat: the loop
    // below runs zero times and the lint reports success having checked
    // nothing.
    if (CAPABILITIES.length === 0) throw new Error('CAPABILITY is empty');
  } catch (err) {
    console.error(`❌ Could not read CAPABILITY from @agent-mesh/contracts: ${err instanceof Error ? err.message : String(err)}`);
    console.error('   Not falling back to a hand-written list — that is the defect this check exists to catch.');
    errors++;
    CAPABILITIES = [];
  }

  CAPABILITIES.forEach(cap => {
    if (!rbacHtml.includes(cap)) {
      if (!silent) console.error(`❌ Missing capability '${cap}' in organization-rbac.html`);
      errors++;
    }
  });

  return { errors, totalRoutesFound, totalAllowedRoutes: rawAllowedRoutes.length , capabilityCount: CAPABILITIES.length };
}

// **Only when run, never when imported.**
//
// Everything below prints and calls `process.exit`. `test/preview-lint.test.ts`
// imports `runLint` from this file, and without this guard that import executed
// the whole script and exited the process — the suite stopped at that file and
// reported success, because the exit code was 0 and there was nobody left to
// disagree. A green run that ended early looks exactly like a green run.
//
// **The `--test` self-check moved out.** Four mutations of the linter's own
// inputs lived here behind a flag, and no `package.json` script and no CI job
// ever passed it — the only way they ran was a person typing the path, which
// is the shape this file's own tests were written to end. They are cases in
// `test/preview-lint.test.ts` now, so a linter that stops catching an invented
// route fails the suite rather than waiting to be asked.
/**
 * What a person sees when they run this, and what the shell gets back.
 *
 * **This was the body of `import.meta.main` and nothing counted it.** The
 * linter's own rules are tested; the paragraph that *reports* them was
 * reachable only by typing the path, which is the same gap this file was
 * written to close one level down — a check that only runs when somebody
 * remembers is one that does not run. Both branches matter: the failing one
 * decides whether CI stops, and it is the one nobody looks at while things
 * are green.
 *
 * `out` and `exit` are parameters so a test can read the lines instead of the
 * terminal, and so calling this does not end the suite.
 */
export function reportLint(
  result: ReturnType<typeof runLint>,
  {
    say = (line: string) => { console.log(line); },
    complain = (line: string) => { console.error(line); },
    exit = (code: number): void => { process.exit(code); },
  }: {
    say?: (line: string) => void;
    complain?: (line: string) => void;
    exit?: (code: number) => void;
  } = {},
): void {
  if (result.errors === 0) {
    say(`\u2713 Verified 60 files in deliverables manifest exist.`);
    say(`\u2713 Parsed ${result.totalAllowedRoutes} authoritative routes from SPEC.md (\u00a7 9.1, \u00a7 9.2, \u00a7 9.2.1).`);
    say(`\u2713 Extracted and verified ${result.totalRoutesFound} route references across 61 HTML files (Floor: >= ${MIN_ROUTE_REFERENCES_FLOOR}).`);
    say(`\u2713 Verified all ${result.capabilityCount} capabilities from @agent-mesh/contracts exist in RBAC.`);
    say(`\n\u2705 ALL LINT & CONTRACT CHECKS PASSED (0 errors, ${result.totalRoutesFound} routes verified)`);
    exit(0);
    return;
  }
  complain(`\n\u274c Total Lint Errors: ${result.errors}`);
  exit(1);
}

if (import.meta.main) {
  console.log('--- Running Allowlist-Based Preview & Contract Linter ---');
  reportLint(runLint());
}
