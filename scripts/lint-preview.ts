import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

console.log('--- Running Preview & Contract Linter ---');

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

// 2. Helper to find all HTML files recursively
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

// 3. Verify no dead routes across all HTML files
const DEAD_PATTERNS = [
  'inbox/lease',
  'inbox/ack',
  'inbox/nack',
  'keys/propose'
];

const htmlFiles = getHtmlFiles('preview');

htmlFiles.forEach(f => {
  const content = readFileSync(f, 'utf-8');
  DEAD_PATTERNS.forEach(pat => {
    if (content.includes(pat)) {
      console.error(`❌ Dead pattern '${pat}' found in ${f}`);
      errors++;
    }
  });
});
console.log(`✓ Verified ${htmlFiles.length} HTML files are free of dead routes.`);

// 4. Verify all 9 capabilities exist in RBAC
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
  console.log('✅ ALL LINT & CONTRACT CHECKS PASSED (0 errors)');
  process.exit(0);
} else {
  console.error(`❌ Total Lint Errors: ${errors}`);
  process.exit(1);
}
