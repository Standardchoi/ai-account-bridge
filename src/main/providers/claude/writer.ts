import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolId } from '../../core/auth-bundle.js';
import { applyImagePolicy } from '../../core/images.js';
import type { IrSession } from '../../core/ir.js';
import { type PreparedMessage, prepareForImport, type ToolLogMode } from '../../core/render.js';
import { normalizeWinPath } from '../../core/win-path.js';
import type { FsTransaction } from '../../infra/fs-transaction.js';
import type { PathProvider } from '../../infra/path-provider.js';

const HEAD_BYTES = 2 * 1024 * 1024; // 최근 버전 문자열 추출 시 읽는 최대 크기
const DEFAULT_VERSION = '2.1.0';
const FALLBACK_MODEL = 'claude-sonnet-4-5';
const TOOL_LABEL: Record<ToolId, string> = { codex: 'Codex', claude: 'Claude' };

export function encodeProjectDir(cwd: string): string {
  return normalizeWinPath(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

export interface ClaudeTranscriptOptions {
  sessionId: string; // 새 cliSessionId (uuid)
  cwd: string;
  version: string; // 대상 기기의 최신 Claude Code 버전(가장 최근 세션 줄의 version), 없으면 '2.1.0'
  gitBranch?: string;
  title: string; // '[Codex] 원제목'
  now: () => string; // ISO, 테스트 주입
  uuid: () => string; // 테스트 주입
}

// PreparedMessage[] → JSONL 줄(문자열 배열). 첫 줄 parentUuid null, 이후 직전 uuid. 끝에 custom-title 줄.
export function buildClaudeTranscript(messages: PreparedMessage[], model: string | undefined, o: ClaudeTranscriptOptions): string[] {
  const lines: string[] = [];
  let parentUuid: string | null = null;
  for (const m of messages) {
    const uuid = o.uuid();
    const timestamp = m.timestamp ?? o.now();
    const base = {
      parentUuid,
      isSidechain: false,
      uuid,
      timestamp,
      userType: 'external',
      entrypoint: 'claude-desktop',
      cwd: o.cwd,
      sessionId: o.sessionId,
      version: o.version,
      gitBranch: o.gitBranch || 'HEAD', // 실제 줄은 항상 비어 있지 않은 gitBranch 를 가진다(저장소 밖이면 'HEAD')
    };
    // 이미지가 있으면 Claude Code 처럼 이미지 블록을 글 앞에 둔다.
    const userContent = m.images?.length
      ? [
          ...m.images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
          ...(m.text ? [{ type: 'text', text: m.text }] : []),
        ]
      : m.text;
    const line =
      m.role === 'user'
        ? { ...base, type: 'user', message: { role: 'user', content: userContent }, promptId: o.uuid() }
        : {
            ...base,
            type: 'assistant',
            message: {
              model: model ?? 'imported',
              id: `msg_${uuid.replace(/-/g, '')}`,
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: m.text }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: {
                input_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: 0,
                service_tier: 'standard',
                cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
              },
            },
          };
    lines.push(JSON.stringify(line));
    parentUuid = uuid;
  }
  lines.push(JSON.stringify({ type: 'custom-title', customTitle: o.title, sessionId: o.sessionId }));
  return lines;
}

// 실제 Desktop 인덱스 파일(97개)에서 공통적으로 쓰이는 키만 남기는 허용목록. 그 밖의 템플릿 필드(대화 요약·원격 신원·
// 권한 스냅샷 등)는 복제본에 절대 딸려오지 않는다.
const INDEX_ALLOWLIST = [
  'sessionId', 'cliSessionId', 'cwd', 'originCwd', 'createdAt', 'lastActivityAt', 'lastFocusedAt', 'model', 'effort',
  'isArchived', 'title', 'titleSource', 'permissionMode', 'enabledMcpTools', 'remoteMcpServersConfig', 'completedTurns',
  'alwaysAllowedReasons', 'sessionPermissionUpdates',
] as const;

// 템플릿 인덱스에서 허용목록 키만 복사(깊은 복사)한 뒤 필드를 덮어쓴다. 타임스탬프는 템플릿의 타입(number|string)을 유지하고,
// 템플릿에 없으면 실제 파일처럼 13자리 ms 숫자로 쓴다. clearRemoteMcp 는 다른 계정으로 옮길 때 원격 MCP 서버 설정을 비운다.
export function buildClaudeIndex(
  template: Record<string, unknown>,
  o: { indexId: string; cliSessionId: string; cwd: string; title: string; nowMs: number; turns: number; clearRemoteMcp?: boolean },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of INDEX_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(template, key)) out[key] = structuredClone(template[key]);
  }

  out.sessionId = o.indexId;
  out.cliSessionId = o.cliSessionId;
  out.cwd = o.cwd;
  out.originCwd = o.cwd;
  out.title = o.title;
  out.titleSource = 'user';
  out.permissionMode = 'default';
  out.isArchived = false;
  out.completedTurns = o.turns;
  out.alwaysAllowedReasons = [];
  out.sessionPermissionUpdates = [];
  for (const key of ['createdAt', 'lastActivityAt', 'lastFocusedAt']) {
    out[key] = typeof template[key] === 'string' ? String(o.nowMs) : o.nowMs;
  }
  // 실제 파일에서 enabledMcpTools 는 {도구이름: boolean} 객체다(배열이 아니다).
  if (typeof out.enabledMcpTools !== 'object' || out.enabledMcpTools === null || Array.isArray(out.enabledMcpTools)) out.enabledMcpTools = {};
  if (o.clearRemoteMcp || !Array.isArray(out.remoteMcpServersConfig)) out.remoteMcpServersConfig = [];

  return out;
}

function readHead(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, HEAD_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// ~/.claude/projects 에서 가장 최근 수정된 .jsonl 의 마지막 version 값(앞 2MB 스캔), 없으면 DEFAULT_VERSION.
function detectLatestVersion(paths: PathProvider): string {
  const root = path.join(paths.home, '.claude', 'projects');
  let latestFile: string | undefined;
  let latestMtime = -Infinity;
  let dirs: string[];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return DEFAULT_VERSION;
  }
  for (const d of dirs) {
    const dirPath = path.join(root, d);
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dirPath, f);
      const mtime = fs.statSync(full).mtimeMs;
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latestFile = full;
      }
    }
  }
  if (!latestFile) return DEFAULT_VERSION;

  let version: string | undefined;
  for (const line of readHead(latestFile).split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (typeof o?.version === 'string') version = o.version;
    } catch {
      /* 깨진 줄은 건너뛴다 */
    }
  }
  return version ?? DEFAULT_VERSION;
}

// 계정 폴더의 local_*.json 중 가장 최근 수정된 것을 템플릿으로 쓴다(JSON.parse 실패한 파일은 건너뛴다).
function pickTemplate(dir: string): Record<string, unknown> | undefined {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => /^local_.*\.json$/.test(f));
  } catch {
    return undefined;
  }
  const sorted = files
    .map((f) => path.join(dir, f))
    .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { f } of sorted) {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      continue; // 깨진 인덱스는 건너뛴다
    }
  }
  return undefined;
}

// 대상 계정 폴더의 최신 local_*.json(템플릿). 없으면 오류 — 가져오기는 무거운 작업(작업 폴더 복사) 전에 이것으로 먼저 확인한다.
export function requireClaudeTemplate(paths: PathProvider, account: { accountId: string; orgId: string }): Record<string, unknown> {
  const template = pickTemplate(path.join(paths.claudeDesktop, 'claude-code-sessions', account.accountId, account.orgId));
  if (!template) throw new Error('대상 계정에서 Code 세션을 하나 만든 뒤 다시 시도하세요.');
  return template;
}

// 대상 계정 폴더의 최신 local_*.json 을 템플릿으로 사용. 없으면 오류(대상 계정에서 Code 세션을 하나 만든 뒤 다시 시도).
export async function writeClaudeSession(
  paths: PathProvider,
  tx: FsTransaction,
  input: {
    ir: IrSession;
    sourceCreatedAt: string;
    account: { accountId: string; orgId: string };
    cwd: string;
    gitBranch?: string;
    toolLog?: ToolLogMode;
    now?: () => Date;
    uuid?: () => string;
  },
): Promise<{ cliSessionId: string; indexId: string; transcriptPath: string; indexPath: string }> {
  const now = input.now ?? (() => new Date());
  const uuid = input.uuid ?? (() => crypto.randomUUID());

  const indexDir = path.join(paths.claudeDesktop, 'claude-code-sessions', input.account.accountId, input.account.orgId);
  const template = requireClaudeTemplate(paths, input.account);

  const cwd = normalizeWinPath(input.cwd);
  const cliSessionId = uuid();
  const version = detectLatestVersion(paths);
  const title = `[${TOOL_LABEL[input.ir.tool]}] ${input.ir.title ?? '(제목 없음)'}`;
  const messages = applyImagePolicy(prepareForImport(input.ir, input.sourceCreatedAt, input.toolLog), 'claude');

  // 이어서 대화할 때 Codex 모델명(gpt-*)을 요청하지 않도록 대상 계정 템플릿의 Claude 모델을 쓴다.
  const model = typeof template.model === 'string' && template.model ? template.model : FALLBACK_MODEL;
  const lines = buildClaudeTranscript(messages, model, {
    sessionId: cliSessionId,
    cwd,
    version,
    gitBranch: input.gitBranch,
    title,
    now: () => now().toISOString(),
    uuid,
  });
  const transcriptPath = path.join(paths.home, '.claude', 'projects', encodeProjectDir(cwd), `${cliSessionId}.jsonl`);
  await tx.createFile(transcriptPath, `${lines.join('\n')}\n`);

  const indexId = `local_${uuid()}`;
  const turns = messages.filter((m) => m.role === 'assistant').length;
  const index = buildClaudeIndex(template, { indexId, cliSessionId, cwd, title, nowMs: now().getTime(), turns });
  const indexPath = path.join(indexDir, `${indexId}.json`);
  await tx.createFile(indexPath, JSON.stringify(index));

  return { cliSessionId, indexId, transcriptPath, indexPath };
}

// Claude 세션 포크: 원본 전사를 새 cliSessionId 로 복사하고, 원본 인덱스로부터 대상 계정용 인덱스를 새로 만든다
// (buildClaudeIndex 를 거치므로 원본의 권한·원격 신원 필드는 그대로 딸려오지 않는다). 원본 전사가 없으면 오류.
export async function forkClaudeSession(
  paths: PathProvider,
  tx: FsTransaction,
  input: {
    sourceIndexPath: string;
    sourceTranscriptPath: string;
    to: { accountId: string; orgId: string };
    uuid?: () => string;
    now?: () => Date;
  },
): Promise<{ cliSessionId: string; indexId: string; transcriptPath: string; indexPath: string }> {
  let transcriptRaw: string;
  try {
    transcriptRaw = fs.readFileSync(input.sourceTranscriptPath, 'utf8');
  } catch {
    throw new Error(`원본 전사 파일을 찾을 수 없습니다: ${input.sourceTranscriptPath}`);
  }
  let indexRaw: string;
  try {
    indexRaw = fs.readFileSync(input.sourceIndexPath, 'utf8');
  } catch {
    throw new Error(`원본 인덱스를 찾을 수 없습니다: ${input.sourceIndexPath}`);
  }
  const source: Record<string, unknown> = JSON.parse(indexRaw);

  const now = input.now ?? (() => new Date());
  const uuid = input.uuid ?? (() => crypto.randomUUID());
  const cliSessionId = uuid();

  // 줄 단위로 복사하며 sessionId 필드만 새 cliSessionId 로 바꾼다. 파싱 안 되는 줄은 그대로 둔다.
  const rewritten = transcriptRaw
    .split('\n')
    .map((line) => {
      try {
        const o = JSON.parse(line);
        if (o && typeof o === 'object' && 'sessionId' in o) o.sessionId = cliSessionId;
        return JSON.stringify(o);
      } catch {
        return line;
      }
    })
    .join('\n');
  const transcriptPath = path.join(path.dirname(input.sourceTranscriptPath), `${cliSessionId}.jsonl`);
  await tx.createFile(transcriptPath, rewritten);

  const indexId = `local_${uuid()}`;
  const cwd = typeof source.cwd === 'string' ? source.cwd : '';
  const title = typeof source.title === 'string' ? source.title : '';
  const turns = typeof source.completedTurns === 'number' ? source.completedTurns : 0;
  const index = buildClaudeIndex(source, { indexId, cliSessionId, cwd, title, nowMs: now().getTime(), turns, clearRemoteMcp: true });
  const indexPath = path.join(paths.claudeDesktop, 'claude-code-sessions', input.to.accountId, input.to.orgId, `${indexId}.json`);
  await tx.createFile(indexPath, JSON.stringify(index));

  return { cliSessionId, indexId, transcriptPath, indexPath };
}
