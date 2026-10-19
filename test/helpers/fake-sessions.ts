import Database from 'better-sqlite3';
import path from 'node:path';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { writeFile } from './tmp-paths.js';

export function codexStateDb(p: PathProvider): Database.Database {
  const db = new Database(path.join(p.home, '.codex', 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT,
             model_provider TEXT, cwd TEXT, title TEXT, archived INTEGER DEFAULT 0, git_branch TEXT, cli_version TEXT,
             sandbox_policy TEXT, approval_mode TEXT, history_mode TEXT, name TEXT, preview TEXT, first_user_message TEXT,
             created_at_ms INTEGER, updated_at_ms INTEGER, recency_at INTEGER, recency_at_ms INTEGER, tokens_used INTEGER,
             project_id TEXT, has_user_event INTEGER);
           CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, metadata TEXT, position INTEGER);
           CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);`);
  return db;
}

export const jsonl = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

export async function writeRollout(p: PathProvider, name: string, rows: object[]): Promise<string> {
  const file = path.join(p.home, '.codex', 'sessions', '2026', '09', '28', name);
  await writeFile(file, jsonl(...rows));
  return file;
}

// 형식 판별·크기 읽기에 필요한 머리(시그니처 + IHDR)만 가진 PNG, base64.
export function pngBase64(width: number, height: number): string {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b.toString('base64');
}
