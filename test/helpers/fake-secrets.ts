import type { SecretStore } from '../../src/main/infra/secret-store.js';

const PREFIX = Buffer.from('FAKE:');

export function fakeSecretStore(): SecretStore {
  return {
    encrypt: async (plain) => Buffer.concat([PREFIX, plain]),
    decrypt: async (cipher) => {
      if (!cipher.subarray(0, PREFIX.length).equals(PREFIX)) throw new Error('fake decrypt failed');
      return cipher.subarray(PREFIX.length);
    },
  };
}
