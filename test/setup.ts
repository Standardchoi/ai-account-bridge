import { afterEach } from 'vitest';
import { cleanupTmpRoots } from './helpers/tmp-paths.js';

afterEach(async () => {
  await cleanupTmpRoots();
});
