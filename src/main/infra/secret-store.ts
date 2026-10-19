import { runPowerShell } from './powershell.js';

export interface SecretStore {
  encrypt(plain: Buffer): Promise<Buffer>;
  decrypt(cipher: Buffer): Promise<Buffer>;
}

function dpapi(op: 'Protect' | 'Unprotect') {
  return async (input: Buffer): Promise<Buffer> => {
    const script =
      'Add-Type -AssemblyName System.Security; ' +
      '$in = [Convert]::FromBase64String([Console]::In.ReadToEnd()); ' +
      `$out = [Security.Cryptography.ProtectedData]::${op}($in, $null, 'CurrentUser'); ` +
      '[Console]::Out.Write([Convert]::ToBase64String($out))';
    const b64 = await runPowerShell(script, input.toString('base64'));
    return Buffer.from(b64.trim(), 'base64');
  };
}

// 현재 Windows 사용자에 귀속되는 DPAPI 암호화. Plan 4 에서 Electron safeStorage 로 교체 가능.
export function dpapiSecretStore(): SecretStore {
  return { encrypt: dpapi('Protect'), decrypt: dpapi('Unprotect') };
}
