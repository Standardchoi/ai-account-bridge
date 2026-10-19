import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { splitComposed, stripAmbientContext } from '../../core/composed-prompt.js';
import { IMAGE_MARK, parseDataUrl } from '../../core/images.js';
import { IrBuilder, type IrImage, type IrSession } from '../../core/ir.js';
import { normalizeWinPath } from '../../core/win-path.js';
import type { PathProvider } from '../../infra/path-provider.js';
import { openSqlite } from '../../infra/sqlite.js';
import type { SessionSummary } from '../types.js';

export interface CodexProject { id: string; name: string; roots: string[] }

// 사용자 메시지에 통째로 주입되는 content 항목 — 사용자가 쓴 글이 아니므로 버린다.
const INJECTED =
  /^\s*(<environment_context>|<user_instructions>|# AGENTS\.md instructions|<permissions instructions>|<collaboration_mode>|<recommended_plugins>|<turn_aborted>|<subagent_notification>|<external_codex_apps_writing_block_edits>)/;
// 이미지 첨부는 '<image …>' · input_image · '</image>' 세 항목으로 온다 — 태그는 버리고 이미지(data URL)를 그 자리에 둔다.
const IMAGE_TAG = /^\s*<\/?image\b[^>]*>\s*$/;

// 목록 제목: 앱이 만든 이름(name)을 우선하고, 없으면 조립된 첫 메시지(title)에서 실제 요청만 쓴다.
function threadTitle(name: string | null, title: string | null): string {
  if (name?.trim()) return name.trim();
  const t = title?.trim() ?? '';
  return (splitComposed(t)?.request || t).trim() || '(제목 없음)';
}

const IGNORED_TYPES = new Set(['session_meta', 'turn_context', 'event_msg', 'world_state', 'token_usage_record', 'inter_agent_communication_metadata']);

interface ThreadRow { id: string; rollout_path: string; created_at: number; updated_at: number; source: string | null; cwd: string | null; title: string | null; name: string | null; archived: number; git_branch: string | null; project_id: string | null }

function parentOf(source: string | null): { subagent: boolean; parentId?: string } {
  if (!source || !source.startsWith('{')) return { subagent: false };
  try {
    const s = JSON.parse(source) as { subagent?: { thread_spawn?: { parent_thread_id?: string } } };
    if (!s.subagent) return { subagent: false };
    return { subagent: true, parentId: s.subagent.thread_spawn?.parent_thread_id };
  } catch {
    return { subagent: false };
  }
}

// Codex 앱 사이드바의 프로젝트는 DB(projects 표)가 아니라 ~/.codex/.codex-global-state.json 에 있다 —
// local-projects(사이드바 프로젝트 전부: 이름·루트), thread-project-assignments(스레드 → 프로젝트),
// projectless-thread-ids(프로젝트 밖으로 뺀 스레드). DB 에는 사이드바에서 뺀 프로젝트도 남아 있다.
// electron-saved-workspace-roots 는 2026-07 에 앱이 local-projects 로 옮긴 옛 목록이라 그 뒤 만든 프로젝트가 없다(쓰지 않는다).
// 파일이 없거나 형식이 다르면 null — DB 프로젝트를 쓴다.
interface CodexAppState { projects: CodexProject[]; assignments: Map<string, string>; projectless: Set<string> }

function readAppState(paths: PathProvider): CodexAppState | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(fs.readFileSync(path.join(paths.home, '.codex', '.codex-global-state.json'), 'utf8'));
  } catch {
    return null;
  }
  const locals = j['local-projects'];
  if (typeof locals !== 'object' || locals === null || Array.isArray(locals)) return null;
  const projects = Object.values(locals)
    .filter(
      (v): v is { id: string; name: string; rootPaths: unknown[] } =>
        typeof v === 'object' && v !== null && typeof (v as any).id === 'string' && typeof (v as any).name === 'string' && Array.isArray((v as any).rootPaths),
    )
    .map((l) => ({ id: l.id, name: l.name.trim() || l.id, roots: l.rootPaths.filter((r): r is string => typeof r === 'string').map(normalizeWinPath) }));
  const known = new Set(projects.map((pr) => pr.id));
  const assignments = new Map<string, string>();
  for (const [threadId, a] of Object.entries((j['thread-project-assignments'] ?? {}) as Record<string, { projectId?: unknown }>)) {
    if (typeof a?.projectId === 'string' && known.has(a.projectId)) assignments.set(threadId, a.projectId);
  }
  const ids = j['projectless-thread-ids'];
  const projectless = new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
  return { projects, assignments, projectless };
}

export function listCodexSessions(paths: PathProvider): { sessions: SessionSummary[]; projects: CodexProject[] } {
  const file = path.join(paths.home, '.codex', 'state_5.sqlite');
  if (!fs.existsSync(file)) return { sessions: [], projects: [] };
  let db: Database.Database | null = null;
  try {
    db = openSqlite(file, { readonly: true, fileMustExist: true, timeout: 5000 });
    db.prepare('SELECT 1').get(); // fileMustExist 는 파일 존재만 확인 — sqlite 형식 검증을 위해 가벼운 쿼리로 확인
  } catch (e) {
    db?.close();
    throw new Error(`Codex 세션 DB를 열 수 없습니다: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const rows = db
      .prepare('SELECT id, rollout_path, created_at, updated_at, source, cwd, title, name, archived, git_branch, project_id FROM threads')
      .all() as ThreadRow[];
    const app = readAppState(paths);
    const sessions: SessionSummary[] = rows.map((r) => {
      const { subagent, parentId } = parentOf(r.source);
      return {
        tool: 'codex',
        key: `codex:${r.id}`,
        sessionId: r.id,
        title: threadTitle(r.name, r.title),
        cwd: r.cwd ? normalizeWinPath(r.cwd) : '',
        createdAt: r.created_at * 1000,
        updatedAt: r.updated_at * 1000,
        archived: r.archived === 1,
        kind: subagent ? 'subagent' : 'code',
        parentId,
        file: r.rollout_path ? normalizeWinPath(r.rollout_path) : '',
        gitBranch: r.git_branch ?? undefined,
        projectId: app ? app.assignments.get(r.id) : (r.project_id ?? undefined),
        ...(app?.projectless.has(r.id) ? { projectless: true } : {}),
      };
    });
    if (app) return { sessions, projects: app.projects };
    const roots = db
      .prepare('SELECT p.id AS id, p.name AS name, r.path AS path FROM projects p JOIN project_roots r ON r.project_id = p.id ORDER BY p.position, r.position')
      .all() as { id: string; name: string; path: string }[];
    const byId = new Map<string, CodexProject>();
    for (const r of roots) {
      const proj = byId.get(r.id) ?? { id: r.id, name: r.name, roots: [] };
      proj.roots.push(normalizeWinPath(r.path));
      byId.set(r.id, proj);
    }
    return { sessions, projects: [...byId.values()] };
  } finally {
    db.close();
  }
}

type ContentItem = { type?: string; text?: string; image_url?: unknown };
type Content = ContentItem[] | undefined;
const textItems = (c: Content, type: string): { text: string }[] =>
  (c ?? []).filter((x): x is { type: string; text: string } => x.type === type && typeof x.text === 'string');
const joinText = (c: Content, type: string) => textItems(c, type).map((x) => x.text).join('\n');
// function_call_output/tool_search_output 은 문자열이거나, {type:'input_text',text} 배열이거나, 그 외 구조화된 값일 수 있다.
const outputText = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const joined = joinText(v as Content, 'input_text');
    return joined || JSON.stringify(v);
  }
  return JSON.stringify(v ?? '');
};

// Codex 는 도구 출력에 실패 표시를 따로 두지 않고 글에 남긴다(2026-10 관찰): 'Exit code: 1', 'Process exited with code 1',
// {"metadata":{"exit_code":1}}, 'apply_patch verification failed …' 처럼. 종료 코드가 0 이 아니거나 오류 머리말로 시작하면 실패.
const EXIT_CODE = /^Exit code: (-?\d+)|Process exited with code (-?\d+)|"exit_code"\s*:\s*(-?\d+)/m;
const ERROR_HEAD = /^\s*(?:apply_patch verification failed|error:|fatal:)/i;
function failedOutput(out: string): boolean {
  const m = EXIT_CODE.exec(out);
  if (m) return (m[1] ?? m[2] ?? m[3]) !== '0';
  return ERROR_HEAD.test(out);
}

export async function readCodexSession(file: string, sessionId: string, title?: string): Promise<IrSession> {
  const b = new IrBuilder('codex', sessionId);
  b.title = title;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
    try {
      o = JSON.parse(line);
    } catch {
      b.stats.unknownLines++;
      continue;
    }
    if (!o || typeof o !== 'object' || typeof o.type !== 'string') { b.stats.unknownLines++; continue; }
    const p = (o.payload ?? {}) as Record<string, any>;
    const ts = o.timestamp;
    if (o.type === 'session_meta') { if (typeof p.cwd === 'string') b.cwd = normalizeWinPath(p.cwd); continue; }
    if (o.type === 'turn_context') { if (typeof p.model === 'string') b.model = p.model; continue; }
    if (o.type === 'compacted') {
      const hist = (p.replacement_history ?? []) as { role?: string; content?: Content }[];
      b.compactSummary(hist.map((h) => joinText(h.content, h.role === 'assistant' ? 'output_text' : 'input_text')).filter(Boolean).join('\n\n'), ts);
      continue;
    }
    if (IGNORED_TYPES.has(o.type)) continue;
    if (o.type !== 'response_item') { b.stats.unknownLines++; continue; }
    switch (p.type) {
      case 'message':
        if (p.role === 'developer' || p.role === 'system') { b.stats.droppedSystem++; break; }
        if (p.role === 'user') {
          // 주입 문맥(AGENTS.md 지침 등)이 실제 사용자 프롬프트와 같은 메시지의 다른 content 블록으로 섞여 온다 —
          // 블록 단위로 걸러내고, 뭔가 걸러졌으면 메시지당 한 번만 droppedSystem 을 센다.
          // 앱이 같은 블록 안에 붙이는 문맥 섹션(첨부·선택 텍스트·앱 내 브라우저 등)은 잘라내고 실제 요청만 남긴다.
          // 이미지는 순서대로 이미지 블록으로(data URL 이 아니면 [이미지] 표시로) 남긴다.
          const parts: (string | IrImage)[] = [];
          let dropped = false;
          for (const c of (p.content ?? []) as ContentItem[]) {
            if (c.type === 'input_image') {
              parts.push((typeof c.image_url === 'string' ? parseDataUrl(c.image_url) : undefined) ?? IMAGE_MARK);
              continue;
            }
            if (c.type !== 'input_text' || typeof c.text !== 'string' || IMAGE_TAG.test(c.text)) continue;
            if (INJECTED.test(c.text)) { dropped = true; continue; }
            const raw = c.text.replaceAll('&#x20;', ' '); // 입력창이 줄 앞뒤 공백을 엔티티로 저장한다
            const t = stripAmbientContext(raw);
            if (t !== raw) dropped = true;
            parts.push(t);
          }
          if (dropped) b.stats.droppedSystem++;
          // 이어진 글은 한 블록으로 합치고, 이미지는 제자리에 둔다.
          let texts: string[] = [];
          const flush = () => {
            b.text('user', texts.filter((t) => t.trim() !== '').join('\n'), ts);
            texts = [];
          };
          for (const part of parts) {
            if (typeof part === 'string') texts.push(part);
            else {
              flush();
              b.image('user', part, ts);
            }
          }
          flush();
        } else if (p.role === 'assistant') b.text('assistant', joinText(p.content, 'output_text'), ts);
        break;
      case 'reasoning': b.stats.droppedReasoning++; break;
      case 'function_call': b.toolCall(String(p.call_id), String(p.name), String(p.arguments ?? ''), ts); break;
      case 'custom_tool_call': b.toolCall(String(p.call_id), String(p.name), String(p.input ?? ''), ts); break;
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const out = outputText(p.output);
        b.toolOutput(String(p.call_id), out, failedOutput(out));
        break;
      }
      case 'web_search_call': b.toolCall(String(p.call_id ?? p.id ?? ''), 'web_search', JSON.stringify(p.action ?? {}), ts); break;
      case 'tool_search_call': b.toolCall(String(p.call_id), 'tool_search', typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? {}), ts); break;
      case 'tool_search_output': b.toolOutput(String(p.call_id), outputText(p.tools), false); break;
      case 'agent_message': b.stats.droppedSidechain++; break;
      default: b.stats.unknownLines++;
    }
  }
  return b.build();
}
