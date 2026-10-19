import type Database from 'better-sqlite3';
import { openSqlite } from './sqlite.js';
import type { ToolId } from '../core/auth-bundle.js';

export type AccountStatus = 'ok' | 'needs_relogin';
// 스냅샷이 다루는 범위 — 'auth': 인증 파일만, 'auth+app-profile': Electron 프로필(쿠키/Local Storage)까지.
export type AccountScope = 'auth' | 'auth+app-profile';
export type SwitchResultCode = 'ok' | 'rolled_back' | 'saved';

export interface NewAccount {
  tool: ToolId;
  accountId: string;
  orgId: string; // 없으면 ''
  email: string | null;
  displayName: string | null;
  label: string;
  snapshotPath: string;
  snapshotAt: string;
  scope?: AccountScope; // 생략하면 'auth'
}

export interface AccountRow extends NewAccount {
  id: number;
  status: AccountStatus;
  scope: AccountScope;
}

export interface SwitchEvent {
  accountRowId: number | null;
  switchedAt: string;
  result: SwitchResultCode;
}

export interface ImportRecord {
  srcTool: ToolId;
  srcKey: string;
  dstTool: ToolId;
  dstAccountKey: string; // claude: '<accountUuid>/<orgUuid>', codex: ''
  dstSessionId: string;
  importedAt: string;
  statsJson: string;
}

const MIGRATIONS = [
  `CREATE TABLE accounts (
     id            INTEGER PRIMARY KEY,
     tool          TEXT NOT NULL,
     account_id    TEXT NOT NULL,
     org_id        TEXT NOT NULL DEFAULT '',
     email         TEXT,
     display_name  TEXT,
     label         TEXT NOT NULL,
     snapshot_path TEXT NOT NULL,
     snapshot_at   TEXT NOT NULL,
     status        TEXT NOT NULL DEFAULT 'ok',
     UNIQUE (tool, account_id, org_id),
     UNIQUE (tool, label)
   );
   CREATE TABLE switch_events (
     id          INTEGER PRIMARY KEY,
     tool        TEXT NOT NULL,
     account_id  INTEGER REFERENCES accounts(id),
     switched_at TEXT NOT NULL,
     result      TEXT NOT NULL
   );`,
  `CREATE TABLE imports (
     id               INTEGER PRIMARY KEY,
     src_tool         TEXT NOT NULL,
     src_key          TEXT NOT NULL,
     dst_tool         TEXT NOT NULL,
     dst_account_key  TEXT NOT NULL,   -- claude: '<accountUuid>/<orgUuid>', codex: ''
     dst_session_id   TEXT NOT NULL,
     imported_at      TEXT NOT NULL,
     stats_json       TEXT NOT NULL
   );
   CREATE INDEX imports_src ON imports (src_tool, src_key, dst_tool, dst_account_key);`,
  `ALTER TABLE accounts ADD COLUMN scope TEXT NOT NULL DEFAULT 'auth';`,
];

const ACCOUNT_COLUMNS = `id, tool, account_id AS accountId, org_id AS orgId, email, display_name AS displayName,
  label, snapshot_path AS snapshotPath, snapshot_at AS snapshotAt, status, scope`;

export class AppDb {
  private db: Database.Database;

  constructor(file: string) {
    this.db = openSqlite(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    const version = this.db.pragma('user_version', { simple: true }) as number;
    for (let i = version; i < MIGRATIONS.length; i++) {
      const migration = MIGRATIONS[i]!;
      this.db.transaction(() => {
        this.db.exec(migration);
        this.db.pragma(`user_version = ${i + 1}`);
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  findAccountByIdentity(tool: ToolId, accountId: string, orgId: string): AccountRow | undefined {
    return this.db
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE tool = ? AND account_id = ? AND org_id = ?`)
      .get(tool, accountId, orgId) as AccountRow | undefined;
  }

  findAccountByLabel(tool: ToolId, label: string): AccountRow | undefined {
    return this.db
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE tool = ? AND label = ?`)
      .get(tool, label) as AccountRow | undefined;
  }

  listAccounts(tool?: ToolId): AccountRow[] {
    return tool
      ? (this.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE tool = ? ORDER BY id`).all(tool) as AccountRow[])
      : (this.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY tool, id`).all() as AccountRow[]);
  }

  // 같은 신원이면 스냅샷만 갱신(라벨 유지), 새 신원이면 추가.
  upsertAccount(a: NewAccount): { row: AccountRow; created: boolean } {
    const existing = this.findAccountByIdentity(a.tool, a.accountId, a.orgId);
    if (existing) {
      this.db
        .prepare(`UPDATE accounts SET email = ?, display_name = ?, snapshot_path = ?, snapshot_at = ?, scope = ?, status = 'ok' WHERE id = ?`)
        .run(a.email, a.displayName, a.snapshotPath, a.snapshotAt, a.scope ?? 'auth', existing.id);
      return { row: this.findAccountByLabel(a.tool, existing.label)!, created: false };
    }
    if (this.findAccountByLabel(a.tool, a.label)) {
      throw new Error(`label '${a.label}' is already used by another ${a.tool} account`);
    }
    this.db
      .prepare(
        `INSERT INTO accounts (tool, account_id, org_id, email, display_name, label, snapshot_path, snapshot_at, scope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.tool, a.accountId, a.orgId, a.email, a.displayName, a.label, a.snapshotPath, a.snapshotAt, a.scope ?? 'auth');
    return { row: this.findAccountByLabel(a.tool, a.label)!, created: true };
  }

  setAccountStatus(id: number, status: AccountStatus): void {
    this.db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, id);
  }

  renameAccount(id: number, newLabel: string): AccountRow {
    const row = this.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).get(id) as AccountRow | undefined;
    if (!row) throw new Error(`no account with id ${id}`);
    if (row.label !== newLabel) {
      const conflict = this.db.prepare('SELECT id FROM accounts WHERE tool = ? AND label = ? AND id != ?').get(row.tool, newLabel, id);
      if (conflict) throw new Error(`label '${newLabel}' is already used by another ${row.tool} account`);
      this.db.prepare('UPDATE accounts SET label = ? WHERE id = ?').run(newLabel, id);
    }
    return { ...row, label: newLabel };
  }

  // switch_events 는 계정이 지워져도 기록으로 남긴다 — FK 를 NULL 로 풀고 나서 계정 행을 지운다.
  deleteAccount(id: number): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE switch_events SET account_id = NULL WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    })();
  }

  recordSwitch(tool: ToolId, accountRowId: number | null, result: SwitchResultCode, at = new Date().toISOString()): void {
    this.db
      .prepare('INSERT INTO switch_events (tool, account_id, switched_at, result) VALUES (?, ?, ?, ?)')
      .run(tool, accountRowId, at, result);
  }

  listSwitches(tool: ToolId): SwitchEvent[] {
    return this.db
      .prepare('SELECT account_id AS accountRowId, switched_at AS switchedAt, result FROM switch_events WHERE tool = ? ORDER BY id')
      .all(tool) as SwitchEvent[];
  }

  recordImport(r: ImportRecord): void {
    this.db
      .prepare(
        `INSERT INTO imports (src_tool, src_key, dst_tool, dst_account_key, dst_session_id, imported_at, stats_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.srcTool, r.srcKey, r.dstTool, r.dstAccountKey, r.dstSessionId, r.importedAt, r.statsJson);
  }

  findImports(srcTool: ToolId, srcKey: string, dstTool: ToolId, dstAccountKey: string): ImportRecord[] {
    return this.db
      .prepare(
        `SELECT src_tool AS srcTool, src_key AS srcKey, dst_tool AS dstTool, dst_account_key AS dstAccountKey,
                dst_session_id AS dstSessionId, imported_at AS importedAt, stats_json AS statsJson
         FROM imports WHERE src_tool = ? AND src_key = ? AND dst_tool = ? AND dst_account_key = ? ORDER BY imported_at`,
      )
      .all(srcTool, srcKey, dstTool, dstAccountKey) as ImportRecord[];
  }

  // 이관 이력 조회(대상 무관) — RPC 의 importHistory 용.
  findImportsBySource(srcTool: ToolId, srcKey: string): ImportRecord[] {
    return this.db
      .prepare(
        `SELECT src_tool AS srcTool, src_key AS srcKey, dst_tool AS dstTool, dst_account_key AS dstAccountKey,
                dst_session_id AS dstSessionId, imported_at AS importedAt, stats_json AS statsJson
         FROM imports WHERE src_tool = ? AND src_key = ? ORDER BY imported_at`,
      )
      .all(srcTool, srcKey) as ImportRecord[];
  }

  // libraryList 에 '이관됨' 배지를 붙이기 위한 최소 비용 조회: 대상(도구/계정)에 상관없이 이 도구에서
  // 원본으로 한 번이라도 이관된 적 있는 src_key 전체를 쿼리 한 번으로 가져온다(세션마다 조회하지 않음).
  listImportedSrcKeys(srcTool: ToolId): Set<string> {
    const rows = this.db.prepare('SELECT DISTINCT src_key AS srcKey FROM imports WHERE src_tool = ?').all(srcTool) as { srcKey: string }[];
    return new Set(rows.map((r) => r.srcKey));
  }

  findAccountById(id: number): AccountRow | undefined {
    return this.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).get(id) as AccountRow | undefined;
  }
}
