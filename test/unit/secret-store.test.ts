import { describe, expect, it } from 'vitest';
import { dpapiSecretStore } from '../../src/main/infra/secret-store.js';

describe.skipIf(process.platform !== 'win32')('dpapiSecretStore', () => {
  it('encrypts to different bytes and decrypts back', async () => {
    const store = dpapiSecretStore();
    const plain = Buffer.from('{"token":"비밀"}', 'utf8');
    const cipher = await store.encrypt(plain);
    expect(cipher.equals(plain)).toBe(false);
    expect((await store.decrypt(cipher)).toString('utf8')).toBe('{"token":"비밀"}');
  }, 30_000);

  it('fails to decrypt garbage', async () => {
    await expect(dpapiSecretStore().decrypt(Buffer.from('garbage'))).rejects.toThrow();
  }, 30_000);
});
