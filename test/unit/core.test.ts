import { describe, expect, it } from 'vitest';
import { deserializeBundle, serializeBundle, type AuthBundle } from '../../src/main/core/auth-bundle.js';
import { decodeJwtPayload, sameIdentity } from '../../src/main/core/identity.js';

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('AuthBundle serialization', () => {
  it('round-trips', () => {
    const bundle: AuthBundle = {
      tool: 'claude',
      files: [{ root: 'home', relPath: '.claude/.credentials.json', data: Buffer.from('{}').toString('base64') }],
      replaceDirs: [],
      jsonKeys: [{ root: 'home', relPath: '.claude.json', key: 'oauthAccount', value: { accountUuid: 'u1' } }],
    };
    expect(deserializeBundle(serializeBundle(bundle))).toEqual(bundle);
  });
});

describe('identity', () => {
  it('decodes JWT payload without verifying signature', () => {
    const jwt = `${b64url({ alg: 'none' })}.${b64url({ email: 'a@x.com', name: '에이' })}.sig`;
    expect(decodeJwtPayload(jwt)).toEqual({ email: 'a@x.com', name: '에이' });
  });

  it('rejects malformed JWT', () => {
    expect(() => decodeJwtPayload('not-a-jwt')).toThrow('invalid JWT');
  });

  it('rejects a JWT whose payload segment is not valid JSON', () => {
    // "bm90LWpzb24" is base64url for "not-json" — decodes fine as base64url but fails JSON.parse
    expect(() => decodeJwtPayload('h.bm90LWpzb24.s')).toThrow('invalid JWT');
  });

  it('compares identities by tool, accountId and orgId', () => {
    expect(sameIdentity({ tool: 'codex', accountId: 'a' }, { tool: 'codex', accountId: 'a', email: 'x' })).toBe(true);
    expect(sameIdentity({ tool: 'claude', accountId: 'a', orgId: 'o1' }, { tool: 'claude', accountId: 'a', orgId: 'o2' })).toBe(false);
    expect(sameIdentity({ tool: 'codex', accountId: 'a' }, { tool: 'claude', accountId: 'a' })).toBe(false);
  });
});
