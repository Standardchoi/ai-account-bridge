import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupTmpRoots, exists, pendingTmpRoots, tmpPaths } from '../helpers/tmp-paths.js';

describe('tmpPaths cleanup', () => {
  it('registers each created root and cleanupTmpRoots removes them from disk', async () => {
    const p = await tmpPaths();
    const root = path.dirname(p.home);
    expect(await exists(root)).toBe(true);
    expect(pendingTmpRoots).toContain(root);

    await cleanupTmpRoots();

    expect(await exists(root)).toBe(false);
    expect(pendingTmpRoots).toHaveLength(0);
  });
});
