import type { ToolId } from './auth-bundle.js';

export interface IrToolBlock { kind: 'tool'; name: string; input: string; output?: string; isError?: boolean }
// 대화에 붙인 이미지. data 는 base64(data: 접두어 없음), mediaType 은 원본이 밝힌 형식 — 대상에 쓸 때 core/images 가 검증한다.
export interface IrImage { mediaType: string; data: string }
export type IrBlock =
  | { kind: 'text'; text: string }
  | IrToolBlock
  | ({ kind: 'image' } & IrImage)
  | { kind: 'compactSummary'; text: string }
  | { kind: 'importNotice'; fromTool: ToolId; title?: string; sessionId: string; createdAt: string };
export interface IrMessage { role: 'user' | 'assistant'; timestamp?: string; blocks: IrBlock[] }
export interface IrStats { droppedReasoning: number; droppedSystem: number; droppedSidechain: number; unknownLines: number; toolCalls: number }
export interface IrSession { tool: ToolId; sessionId: string; title?: string; cwd?: string; model?: string; messages: IrMessage[]; stats: IrStats }

export const TOOL_TEXT_LIMIT = 2048;

export function truncate(s: string, limit = TOOL_TEXT_LIMIT): string {
  return s.length <= limit ? s : `${s.slice(0, limit)}… (${s.length - limit}자 생략)`;
}

// reader 가 원본을 한 줄씩 읽으며 IR 을 쌓는 도우미.
export class IrBuilder {
  readonly stats: IrStats = { droppedReasoning: 0, droppedSystem: 0, droppedSidechain: 0, unknownLines: 0, toolCalls: 0 };
  title?: string;
  cwd?: string;
  model?: string;
  private readonly messages: IrMessage[] = [];
  private readonly pendingTools = new Map<string, IrToolBlock>();
  private readonly pendingOutputs = new Map<string, { output: string; isError: boolean }>();

  constructor(private readonly tool: ToolId, private readonly sessionId: string) {}

  private push(role: IrMessage['role'], block: IrBlock, timestamp?: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === role) last.blocks.push(block);
    else this.messages.push({ role, timestamp, blocks: [block] });
  }

  text(role: IrMessage['role'], text: string, timestamp?: string): void {
    if (text.trim() === '') return;
    this.push(role, { kind: 'text', text }, timestamp);
  }

  image(role: IrMessage['role'], image: IrImage, timestamp?: string): void {
    this.push(role, { kind: 'image', mediaType: image.mediaType, data: image.data }, timestamp);
  }

  compactSummary(text: string, timestamp?: string): void {
    this.push('user', { kind: 'compactSummary', text: truncate(text, 4096) }, timestamp);
  }

  toolCall(id: string, name: string, input: string, timestamp?: string): void {
    const block: IrToolBlock = { kind: 'tool', name, input: truncate(input) };
    const pending = this.pendingOutputs.get(id);
    if (pending) {
      // 출력 줄이 파일에서 호출보다 먼저 나온 경우(뒤섞인 jsonl) — 대기 중이던 출력을 바로 짝짓는다.
      block.output = pending.output;
      block.isError = pending.isError;
      this.pendingOutputs.delete(id);
    } else {
      this.pendingTools.set(id, block);
    }
    this.stats.toolCalls++;
    this.push('assistant', block, timestamp);
  }

  toolOutput(id: string, output: string, isError: boolean): void {
    const block = this.pendingTools.get(id);
    if (block) {
      block.output = truncate(output);
      block.isError = isError;
      this.pendingTools.delete(id);
      return;
    }
    // 아직 호출을 보지 못했다 — 나중에 toolCall 이 오면 짝짓도록 보관한다.
    this.pendingOutputs.set(id, { output: truncate(output), isError });
  }

  build(): IrSession {
    return { tool: this.tool, sessionId: this.sessionId, title: this.title, cwd: this.cwd, model: this.model, messages: this.messages, stats: this.stats };
  }
}
