import { writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';

// Clean up incorrect old dev API files if present
const oldFiles = [
  'preview/dev/api-inbox-lease.html',
  'preview/dev/api-inbox-ack.html',
  'preview/dev/api-messages-send.html'
];
oldFiles.forEach(f => {
  if (existsSync(f)) unlinkSync(f);
});

console.log('Cleaned up old incorrect API reference files.');
