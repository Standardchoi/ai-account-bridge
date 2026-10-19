import type { ToolId } from './auth-bundle.js';
import { IMAGE_MARK } from './images.js';
import type { IrBlock, IrImage, IrSession, IrToolBlock } from './ir.js';

const TOOL_NAME: Record<ToolId, string> = { codex: 'Codex', claude: 'Claude' };

export function blockToText(b: IrBlock, source: ToolId): string {
  switch (b.kind) {
    case 'text': return b.text;
    case 'tool': {
      const out = b.output === undefined ? '(결과 없음)' : b.isError ? `(오류) ${b.output}` : b.output;
      return `🔧 [${TOOL_NAME[source]}: ${b.name}] ${b.input}\n→ ${out}`;
    }
    case 'image': return IMAGE_MARK;
    case 'compactSummary': return `[이전 대화 요약]\n${b.text}`;
    case 'importNotice': return `이 세션은 ${TOOL_NAME[b.fromTool]} 의 '${b.title ?? '(제목 없음)'}' 에서 가져왔습니다 (원본 ID ${b.sessionId}, ${b.createdAt})`;
  }
}

// 도구 실행 기록을 얼마나 옮길지. 실제 세션을 재 보면 도구 입력·출력이 이관 글의 75~88% 를 차지하지만(2026-10, 이 PC),
// 출력은 다음 답변이 요약하고 파일은 디스크에 있으므로 기본은 'summary' — 무엇을 했는지 한 줄씩, 실패한 출력만 앞부분을 남긴다.
// 'full' 은 예전처럼 입력·출력(각 2KB 까지)을 모두 옮긴다.
export type ToolLogMode = 'summary' | 'full';
export const TOOL_LINE_MAX = 160;
export const TOOL_ERROR_MAX = 300;
const SUMMARY_NOTE = '(도구 실행 기록은 실행한 명령·파일만 한 줄씩, 실패한 경우에만 결과 앞부분을 옮겼습니다)';

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// 도구 입력에서 무엇을 했는지 한 줄로: 셸 명령·파일 경로·검색어·URL·작업 설명, Codex exec 코드의 cmd,
// apply_patch 면 고친 파일 목록, 그 밖은 입력 그대로(공백을 접어 TOOL_LINE_MAX 자까지).
export function toolLine(input: string): string {
  let s: string | undefined;
  try {
    const o: unknown = JSON.parse(input);
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const r = o as Record<string, unknown>;
      const v = r.cmd ?? r.command ?? r.file_path ?? r.path ?? r.query ?? r.pattern ?? r.url ?? r.description;
      if (v !== undefined && v !== null) s = Array.isArray(v) ? v.join(' ') : String(v);
    }
  } catch {
    // JSON 이 아니면 아래에서
  }
  if (s === undefined) {
    const m = /\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input); // Codex exec: text(await tools.exec_command({cmd:"…"}))
    if (m) {
      try {
        s = JSON.parse(`"${m[1]}"`) as string;
      } catch {
        s = m[1];
      }
    }
  }
  if (s === undefined) {
    const files = [...input.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map((x) => `${x[1]} ${x[2]!.trim()}`);
    if (files.length > 0) s = `patch: ${files.join(', ')}`;
  }
  return clip((s ?? input).replace(/\s+/g, ' ').trim(), TOOL_LINE_MAX);
}

function toolSummary(b: IrToolBlock, source: ToolId): string {
  const head = `🔧 [${TOOL_NAME[source]}: ${b.name}] ${toolLine(b.input)}`;
  return b.isError && b.output ? `${head}\n→ (오류) ${clip(b.output.trim(), TOOL_ERROR_MAX)}` : head;
}

// images: 사용자 메시지에 붙은 이미지(있을 때만). 대상 도구에 맞게 거르는 건 writer 가 core/images 의 applyImagePolicy 로 한다.
export interface PreparedMessage { role: 'user' | 'assistant'; text: string; images?: IrImage[]; timestamp?: string }

// 대상 도구에 쓸 메시지 목록: 텍스트로 렌더링, 빈 메시지 제거, 같은 역할 연속 병합, 첫 메시지는 이관 안내를 포함한 user.
// 이미지는 사용자 메시지에서만 옮긴다(두 도구 모두 assistant 메시지에는 이미지를 넣을 수 없다 — 그 자리는 [이미지] 표시).
export function prepareForImport(ir: IrSession, sourceCreatedAt: string, toolLog: ToolLogMode = 'summary'): PreparedMessage[] {
  let notice = blockToText({ kind: 'importNotice', fromTool: ir.tool, title: ir.title, sessionId: ir.sessionId, createdAt: sourceCreatedAt }, ir.tool);
  // 요약한 경우 받는 쪽 AI 가 결과가 빠졌다는 걸 알도록 안내에 밝힌다(도구 호출이 있을 때만).
  if (toolLog === 'summary' && ir.messages.some((m) => m.blocks.some((b) => b.kind === 'tool'))) notice = `${notice}\n${SUMMARY_NOTE}`;
  const render = (b: IrBlock) => (b.kind === 'tool' && toolLog === 'summary' ? toolSummary(b, ir.tool) : blockToText(b, ir.tool));
  const out: PreparedMessage[] = [{ role: 'user', text: notice }];
  for (const m of ir.messages) {
    const carried = (b: IrBlock): b is Extract<IrBlock, { kind: 'image' }> => m.role === 'user' && b.kind === 'image';
    const images = m.blocks.filter(carried).map(({ mediaType, data }) => ({ mediaType, data }));
    // 요약한 도구 줄은 빈 줄 없이 한 줄씩 이어 붙이고, 나머지 블록 사이에는 빈 줄을 둔다.
    const parts: string[] = [];
    let prevTool = false;
    for (const b of m.blocks) {
      if (carried(b)) continue;
      const t = render(b);
      if (t.trim() === '') continue;
      const isLine = b.kind === 'tool' && toolLog === 'summary';
      if (parts.length > 0) parts.push(isLine && prevTool ? '\n' : '\n\n');
      parts.push(t);
      prevTool = isLine;
    }
    const text = parts.join('');
    if (text.trim() === '' && images.length === 0) continue;
    const last = out[out.length - 1]!;
    if (last.role === m.role) {
      last.text = [last.text, text].filter((t) => t.trim() !== '').join('\n\n');
      if (images.length > 0) last.images = [...(last.images ?? []), ...images];
      // 병합 시 더 이른 타임스탬프를 유지한다(이전 메시지에 없었으면 그대로 설정).
      if (m.timestamp !== undefined && (last.timestamp === undefined || m.timestamp < last.timestamp)) {
        last.timestamp = m.timestamp;
      }
    } else {
      out.push({ role: m.role, text, ...(images.length > 0 ? { images } : {}), timestamp: m.timestamp });
    }
  }
  // 안내 메시지 자체는 타임스탬프가 없다 — 병합되지 않았다면 첫 실제 메시지의 타임스탬프를 물려받는다.
  if (out.length > 1 && out[0]!.timestamp === undefined) {
    out[0]!.timestamp = out[1]!.timestamp;
  }
  return out;
}
