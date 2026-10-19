import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { stripAmbientContext } from '../../core/composed-prompt.js';
import { IMAGE_MARK } from '../../core/images.js';
import { IrBuilder, type IrSession } from '../../core/ir.js';
import { normalizeWinPath } from '../../core/win-path.js';
import type { PathProvider } from '../../infra/path-provider.js';
import type { SessionKind, SessionSummary } from '../types.js';

const HEAD_BYTES = 2 * 1024 * 1024; // CLI 전용 세션 메타 추출 시 읽는 최대 크기

// 슬래시 명령 실행 시 Claude Code 가 user 메시지로 끼워 넣는 합성 텍스트 — 실제 대화가 아니라 시스템 문맥으로 취급한다
const SYNTHETIC_USER_TEXT = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder)>/;
// 백그라운드 작업(서브에이전트·셸) 완료 알림 — 결과 본문은 이어지는 assistant 답변이 요약하므로 한 줄만 남긴다
const TASK_NOTIFICATION = /^\s*<task-notification>/;
const TASK_STATUS: Record<string, string> = { completed: '완료', failed: '실패', killed: '중단' };

function taskNote(text: string): string {
  const status = /<status>([^<]*)<\/status>/.exec(text)?.[1]?.trim() ?? '';
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim();
  const head = `백그라운드 작업 ${TASK_STATUS[status] ?? '알림'}`;
  return summary ? `[${head}: ${summary}]` : `[${head}]`;
}

function addUserText(b: IrBuilder, text: string, ts?: string): void {
  if (SYNTHETIC_USER_TEXT.test(text)) { b.stats.droppedSystem++; return; }
  if (TASK_NOTIFICATION.test(text)) { b.stats.droppedSystem++; b.text('user', taskNote(text), ts); return; }
  const t = stripAmbientContext(text); // 앱 내 브라우저 상태 블록
  if (t !== text) b.stats.droppedSystem++;
  b.text('user', t, ts);
}

const listDir = (d: string) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
const toMs = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const toBool = (v: unknown) => v === true || v === 'true';

// ~/.claude/projects/<dir>/<sessionId>.jsonl 전체를 sessionId → 경로로 모은다
function projectFiles(root: string): Map<string, { file: string; dir: string }> {
  const map = new Map<string, { file: string; dir: string }>();
  for (const d of listDir(root)) {
    if (!d.isDirectory()) continue;
    for (const f of listDir(path.join(root, d.name))) {
      if (f.isFile() && f.name.endsWith('.jsonl')) map.set(f.name.slice(0, -6), { file: path.join(root, d.name, f.name), dir: d.name });
    }
  }
  return map;
}

interface Meta { cwd: string; title?: string; firstPrompt?: string }

// 파일 앞부분만 읽어 마지막 cwd, 제목(custom > ai), 첫 사용자 문장을 뽑는다
function scanMeta(file: string): Meta {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, HEAD_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    const meta: Meta = { cwd: '' };
    let custom: string | undefined, ai: string | undefined;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('"cwd"') && !line.includes('title') && meta.firstPrompt) continue;
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      if (typeof o?.cwd === 'string') meta.cwd = o.cwd;
      if (o?.type === 'custom-title' && typeof o.customTitle === 'string') custom = o.customTitle;
      if (o?.type === 'ai-title' && typeof o.aiTitle === 'string') ai = o.aiTitle;
      const c = o?.message?.content;
      if (!meta.firstPrompt && o?.type === 'user' && !o.isMeta && typeof c === 'string' && !SYNTHETIC_USER_TEXT.test(c) && !TASK_NOTIFICATION.test(c))
        meta.firstPrompt = stripAmbientContext(c).slice(0, 60) || undefined;
    }
    meta.title = custom ?? ai;
    return meta;
  } finally {
    fs.closeSync(fd);
  }
}

function indexEntries(base: string): { accountId: string; orgId: string; dir: string; file: string; data: Record<string, unknown> }[] {
  const out = [];
  for (const a of listDir(base)) {
    if (!a.isDirectory()) continue;
    for (const o of listDir(path.join(base, a.name))) {
      if (!o.isDirectory()) continue;
      const dir = path.join(base, a.name, o.name);
      for (const f of listDir(dir)) {
        if (!f.isFile() || !/^local_.*\.json$/.test(f.name)) continue;
        try {
          out.push({ accountId: a.name, orgId: o.name, dir, file: path.join(dir, f.name), data: JSON.parse(fs.readFileSync(path.join(dir, f.name), 'utf8')) });
        } catch { /* 깨진 인덱스는 건너뛴다 */ }
      }
    }
  }
  return out;
}

function fromIndex(kind: SessionKind, e: ReturnType<typeof indexEntries>[number], file: string): SessionSummary {
  const d = e.data;
  const cli = String(d.cliSessionId ?? '');
  const fallbackId = String(d.sessionId ?? path.basename(e.file, '.json'));
  const userSelectedFolders = d.userSelectedFolders;
  const hostFolder =
    Array.isArray(userSelectedFolders) && typeof userSelectedFolders[0] === 'string' ? normalizeWinPath(userSelectedFolders[0]) : undefined;
  return {
    tool: 'claude',
    key: `claude:${kind}:${fallbackId}`,
    sessionId: cli || fallbackId, // cliSessionId 없는 인덱스도 있음 — 인덱스 자체 ID로 대체해 충돌을 피한다
    title: (typeof d.title === 'string' && d.title.trim()) || '(제목 없음)',
    cwd: typeof d.cwd === 'string' ? normalizeWinPath(d.cwd) : '',
    createdAt: toMs(d.createdAt),
    updatedAt: toMs(d.lastActivityAt) || toMs(d.createdAt),
    archived: toBool(d.isArchived),
    kind,
    accountRef: { accountId: e.accountId, orgId: e.orgId, email: typeof d.emailAddress === 'string' ? d.emailAddress : undefined },
    file,
    indexPath: e.file,
    hostFolder,
  };
}

export function listClaudeSessions(paths: PathProvider): SessionSummary[] {
  const projectsRoot = path.join(paths.home, '.claude', 'projects');
  const files = projectFiles(projectsRoot);
  const out: SessionSummary[] = [];
  const indexed = new Set<string>();

  for (const e of indexEntries(path.join(paths.claudeDesktop, 'claude-code-sessions'))) {
    const cli = String(e.data.cliSessionId ?? '');
    if (cli) indexed.add(cli);
    out.push(fromIndex('code', e, cli ? (files.get(cli)?.file ?? '') : ''));
  }

  for (const e of indexEntries(path.join(paths.claudeDesktop, 'local-agent-mode-sessions'))) {
    const cli = String(e.data.cliSessionId ?? '');
    const sessionDir = path.join(e.dir, String(e.data.sessionId ?? path.basename(e.file, '.json')));
    const own = cli ? projectFiles(path.join(sessionDir, '.claude', 'projects')).get(cli) : undefined;
    out.push(fromIndex('cowork', e, own?.file ?? ''));
  }

  for (const [id, { file, dir }] of files) {
    if (indexed.has(id)) continue;
    const st = fs.statSync(file);
    const meta = scanMeta(file);
    out.push({
      tool: 'claude',
      key: `claude:cli:${id}`,
      sessionId: id,
      title: meta.title ?? meta.firstPrompt ?? '(제목 없음)',
      cwd: meta.cwd ? normalizeWinPath(meta.cwd) : '',
      createdAt: st.birthtimeMs || st.mtimeMs,
      updatedAt: st.mtimeMs,
      archived: false,
      kind: 'cli',
      remote: dir.startsWith('ssh-'),
      file,
    });
  }
  return out;
}

const resultText = (c: unknown): string => {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((x: any) => (x?.type === 'text' && typeof x.text === 'string' ? x.text : `[${x?.type ?? '?'}]`)).join('\n');
};

export async function readClaudeSession(file: string, sessionId: string, title?: string): Promise<IrSession> {
  const b = new IrBuilder('claude', sessionId);
  let custom: string | undefined, ai: string | undefined;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { b.stats.unknownLines++; continue; }
    if (!o || typeof o !== 'object' || typeof o.type !== 'string') { b.stats.unknownLines++; continue; }
    if (typeof o.cwd === 'string') b.cwd = normalizeWinPath(o.cwd);
    if (o.type === 'custom-title') { custom = o.customTitle; continue; }
    if (o.type === 'ai-title') { ai = o.aiTitle; continue; }
    if (o.type !== 'user' && o.type !== 'assistant') continue; // system/attachment/queue-operation 등 부가 정보
    if (o.isSidechain) { b.stats.droppedSidechain++; continue; }
    if (o.isMeta) { b.stats.droppedSystem++; continue; }
    const c = o.message?.content;
    const ts = typeof o.timestamp === 'string' ? o.timestamp : undefined;
    if (o.type === 'user') {
      if (typeof c === 'string') {
        addUserText(b, c, ts);
        continue;
      }
      for (const blk of Array.isArray(c) ? c : []) {
        if (blk?.type === 'text') addUserText(b, String(blk.text ?? ''), ts);
        else if (blk?.type === 'tool_result') b.toolOutput(String(blk.tool_use_id), resultText(blk.content), blk.is_error === true);
        else if (blk?.type === 'image') {
          // 붙여 넣은 이미지는 base64 로 전사에 들어 있다 — 그 밖의 형태(url 등)는 표시만 남긴다.
          const src = blk.source;
          if (src?.type === 'base64' && typeof src.media_type === 'string' && typeof src.data === 'string') {
            b.image('user', { mediaType: src.media_type.toLowerCase(), data: src.data }, ts);
          } else b.text('user', IMAGE_MARK, ts);
        }
      }
    } else {
      if (typeof o.message?.model === 'string') b.model = o.message.model;
      for (const blk of Array.isArray(c) ? c : []) {
        if (blk?.type === 'text') b.text('assistant', String(blk.text ?? ''), ts);
        else if (blk?.type === 'tool_use') b.toolCall(String(blk.id), String(blk.name), JSON.stringify(blk.input ?? {}), ts);
        else if (blk?.type === 'thinking' || blk?.type === 'redacted_thinking') b.stats.droppedReasoning++;
      }
    }
  }
  b.title = title ?? custom ?? ai;
  return b.build();
}
