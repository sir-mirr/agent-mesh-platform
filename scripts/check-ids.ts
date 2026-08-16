import { readFileSync } from 'fs';

const html = readFileSync('preview/index.html', 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  console.log('No script match');
  process.exit(1);
}
const js = scriptMatch[1];

const ids = [...js.matchAll(/document\.getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
console.log('Found getElementById calls:', ids.length);

const missing: string[] = [];
ids.forEach(id => {
  if (id.includes('${') || id.includes('+')) return;
  const regex = new RegExp(`id=["']${id}["']`);
  if (!regex.test(html)) {
    missing.push(id);
  }
});

console.log('Missing IDs in HTML:', [...new Set(missing)]);
