import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

describe('toolchain', () => {
  it('loads better-sqlite3 native module', () => {
    const db = new Database(':memory:');
    expect(db.prepare('select 1 as v').get()).toEqual({ v: 1 });
    db.close();
  });
});
