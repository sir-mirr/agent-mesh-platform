import { unlinkSync, existsSync } from 'fs';

if (existsSync('preview/dev/api-keys-propose.html')) {
  unlinkSync('preview/dev/api-keys-propose.html');
  console.log('Removed preview/dev/api-keys-propose.html');
}
