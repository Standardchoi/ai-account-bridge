import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deserializeBundle, serializeBundle, type AuthBundle } from '../core/auth-bundle.js';
import type { SecretStore } from './secret-store.js';

export class BackupStore {
  constructor(
    private readonly dir: string,
    private readonly secrets: SecretStore,
    private readonly keep = 20,
  ) {}

  // protect: 이 경로(또는 basename)에 해당하는 파일은 정리 대상에서 제외한다 — 방금 쓴 파일과 별개로,
  // 예를 들어 restoreBackup 이 복원 중인 백업 파일이 안전 백업 정리 때문에 지워지지 않도록 보호할 때 쓴다.
  async save(bundle: AuthBundle, protect?: string): Promise<string> {
    const toolDir = path.join(this.dir, bundle.tool);
    await fs.mkdir(toolDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(toolDir, `${stamp}-${crypto.randomBytes(3).toString('hex')}.bin`);
    await fs.writeFile(file, await this.secrets.encrypt(serializeBundle(bundle)));
    await this.prune(toolDir, path.basename(file), protect ? path.basename(protect) : undefined);
    return file;
  }

  async load(file: string): Promise<AuthBundle> {
    return deserializeBundle(await this.secrets.decrypt(await fs.readFile(file)));
  }

  private async prune(toolDir: string, keepName: string, protectName?: string): Promise<void> {
    const names = (await fs.readdir(toolDir))
      .filter((n) => n.endsWith('.bin') && n !== keepName && n !== protectName)
      .sort();
    for (const name of names.slice(0, Math.max(0, names.length - (this.keep - 1)))) {
      await fs.rm(path.join(toolDir, name));
    }
  }
}
