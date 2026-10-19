import fs from 'node:fs/promises';
import path from 'node:path';
import type { AuthBundle, AuthFile, AuthPathSpec, JsonKeyValue, ToolId } from '../core/auth-bundle.js';
import { resolveRoot, type PathProvider } from './path-provider.js';

export interface JsonKeySpec extends AuthPathSpec {
  key: string;
}

async function statOrNull(full: string) {
  try {
    return await fs.stat(full);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function walk(dir: string, relBase: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.endsWith('.aab-tmp')) continue;
    const rel = `${relBase}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

async function readJsonOrNull(full: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(full, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function writeAtomic(full: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.aab-tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, full);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export async function collectAuth(
  paths: PathProvider,
  tool: ToolId,
  fileSpecs: AuthPathSpec[],
  keySpecs: JsonKeySpec[] = [],
): Promise<AuthBundle> {
  const files: AuthFile[] = [];
  const replaceDirs: AuthPathSpec[] = [];
  for (const spec of fileSpecs) {
    const full = resolveRoot(paths, spec.root, spec.relPath);
    const st = await statOrNull(full);
    if (st?.isDirectory()) {
      replaceDirs.push({ root: spec.root, relPath: spec.relPath });
      for (const rel of await walk(full, spec.relPath)) {
        const data = await fs.readFile(resolveRoot(paths, spec.root, rel));
        files.push({ root: spec.root, relPath: rel, data: data.toString('base64') });
      }
    } else {
      const data = st ? (await fs.readFile(full)).toString('base64') : null;
      files.push({ root: spec.root, relPath: spec.relPath, data });
    }
  }
  const jsonKeys: JsonKeyValue[] = [];
  for (const spec of keySpecs) {
    const obj = await readJsonOrNull(resolveRoot(paths, spec.root, spec.relPath));
    const value = obj && spec.key in obj ? obj[spec.key] : null;
    jsonKeys.push({ root: spec.root, relPath: spec.relPath, key: spec.key, value });
  }
  return { tool, files, replaceDirs, jsonKeys };
}

// 번들이 실제로 다루는 경로 집합의 지문. 같은 spec 이면 디렉터리가 존재하든(=> replaceDirs)
// 없든(=> data:null 인 파일 하나) 동일한 문자열을 내도록 dir/file 을 구분하지 않는다.
export function bundleScope(b: AuthBundle): string[] {
  const scope = new Set<string>();
  for (const d of b.replaceDirs) scope.add(`path:${d.root}:${d.relPath}`);
  for (const f of b.files) {
    const underReplaceDir = b.replaceDirs.some((d) => d.root === f.root && f.relPath.startsWith(`${d.relPath}/`));
    if (!underReplaceDir) scope.add(`path:${f.root}:${f.relPath}`);
  }
  for (const k of b.jsonKeys) scope.add(`key:${k.root}:${k.relPath}#${k.key}`);
  return [...scope].sort();
}

// 로그아웃 없이 새 계정을 추가할 때 씀 — 같은 tool/replaceDirs 를 가지면서 모든 파일 데이터와 JSON 키
// 값을 null 로 비운 번들을 만든다. bundleScope 가 원본과 동일하므로 범위 검사에는 영향을 주지 않는다.
export function clearedBundle(b: AuthBundle): AuthBundle {
  return {
    tool: b.tool,
    replaceDirs: b.replaceDirs,
    files: b.files.map((f) => ({ root: f.root, relPath: f.relPath, data: null })),
    jsonKeys: b.jsonKeys.map((k) => ({ root: k.root, relPath: k.relPath, key: k.key, value: null })),
  };
}

export async function applyAuth(paths: PathProvider, bundle: AuthBundle): Promise<void> {
  for (const dir of bundle.replaceDirs) {
    await fs.rm(resolveRoot(paths, dir.root, dir.relPath), { recursive: true, force: true });
  }
  for (const f of bundle.files) {
    const full = resolveRoot(paths, f.root, f.relPath);
    if (f.data === null) {
      await fs.rm(full, { recursive: true, force: true });
    } else {
      await writeAtomic(full, Buffer.from(f.data, 'base64'));
    }
  }
  for (const k of bundle.jsonKeys) {
    const full = resolveRoot(paths, k.root, k.relPath);
    const existing = await readJsonOrNull(full);
    if (k.value === null && existing === null) continue; // 지울 키도, 파일 자체도 없음 — 새로 만들 필요 없음
    const obj = existing ?? {};
    if (k.value === null) delete obj[k.key];
    else obj[k.key] = k.value;
    await writeAtomic(full, Buffer.from(JSON.stringify(obj, null, 2), 'utf8'));
  }
}
