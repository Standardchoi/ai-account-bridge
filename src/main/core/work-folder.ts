import path from 'node:path';
import type { IrSession } from './ir.js';
import { normalizeWinPath } from './win-path.js';

// Codex 앱은 프로젝트 없이 시작한 대화마다 '<문서>\Codex\<날짜>\<이름>' 폴더를 만들어 작업 폴더로 쓴다
// (안에 work·outputs 를 두고 git 저장소를 받아 오기도 한다 — 2026-10 이 PC 관찰). 실제 프로젝트 폴더가 아니라
// 그 대화만의 폴더이므로, 다른 도구로 옮길 때 통째로 복사해 따로 쓸 수 있다. GUI(renderer.js)도 같은 규칙으로 판단한다.
const CHAT_FOLDER = /^(.*[\\/])Codex([\\/])(\d{4}-\d{2}-\d{2})[\\/]([^\\/]+)$/i;

export function isCodexChatFolder(cwd: string): boolean {
  return CHAT_FOLDER.test(normalizeWinPath(cwd));
}

// 복사본을 둘 자리: 'Codex' 를 'Claude' 로 바꾼 같은 구조('<문서>\Claude\<날짜>\<이름>'). 이미 있으면 호출자가 뒤에 ' (2)', ' (3)' 을 붙인다.
export function claudeCopyOf(cwd: string): string | undefined {
  const m = CHAT_FOLDER.exec(normalizeWinPath(cwd));
  return m ? `${m[1]}Claude${m[2]}${m[3]}${m[2]}${m[4]}` : undefined;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 폴더 이름이 거기서 끝나는 자리: 경로 구분자·따옴표·공백·괄호 등, 문장 끝 마침표, 바로 붙은 한글 조사.
// '…\new-chat' 이 '…\new-chat-2' 나 '…\new-chat.zip' 을 바꾸지 않게 한다.
const NAME_END = '(?=$|[\\\\/\\s"\'`)\\]},;:|<>!?\\uAC00-\\uD7A3]|\\.(?:$|\\s))';

// 대화 글 속의 원래 폴더 경로를 복사본 경로로 바꾼다 — 보통(\)·JSON 이스케이프(\\)·슬래시(/) 표기를 대소문자 없이.
// 옮긴 대화를 이어 갈 때 AI 가 예전 절대 경로를 그대로 써서 원본 폴더를 고치는 일을 막는다.
export function rebasePath(text: string, from: string, to: string): string {
  const f = normalizeWinPath(from).replace(/\//g, '\\');
  const t = normalizeWinPath(to).replace(/\//g, '\\');
  let out = text;
  for (const [a, b] of [
    [f, t],
    [f.replace(/\\/g, '\\\\'), t.replace(/\\/g, '\\\\')],
    [f.replace(/\\/g, '/'), t.replace(/\\/g, '/')],
  ] as const) {
    out = out.replace(new RegExp(escapeRegExp(a) + NAME_END, 'gi'), () => b);
  }
  return out;
}

// 대화의 글·도구 호출·요약 속 폴더 경로를 다른 경로로 바꾸고 cwd 도 바꾼다.
export function withRebasedFolder(ir: IrSession, from: string, to: string): IrSession {
  const r = (s: string) => rebasePath(s, from, to);
  const messages = ir.messages.map((m) => ({
    ...m,
    blocks: m.blocks.map((b) => {
      if (b.kind === 'text' || b.kind === 'compactSummary') return { ...b, text: r(b.text) };
      if (b.kind === 'tool') return { ...b, input: r(b.input), ...(b.output !== undefined ? { output: r(b.output) } : {}) };
      return b;
    }),
  }));
  return { ...ir, cwd: to, messages };
}

// 복사본에서 이어 갈 대화: 글·도구 호출·요약 속 원본 폴더 경로를 복사본으로 바꾸고, 바꿨다는 사실과 원본을 건드리지
// 말라는 안내를 첫머리에 붙인다(바꾼 경로만 보면 원본에서 한 작업이 복사본에서 한 것처럼 읽히므로).
export function withCopiedFolder(ir: IrSession, from: string, to: string): IrSession {
  const note =
    `[작업 폴더 안내] 이 세션의 작업 폴더는 원본 ${normalizeWinPath(from)} 을 복사한 ${normalizeWinPath(to)} 입니다. ` +
    '아래 대화의 원본 폴더 경로는 복사본 경로로 바꿔 두었습니다(실제 작업은 원본에서 했습니다). 원본 폴더는 이 세션의 폴더가 아니니 고치지 마세요.';
  const rebased = withRebasedFolder(ir, from, to);
  return { ...rebased, messages: [{ role: 'user', blocks: [{ kind: 'text', text: note }] }, ...rebased.messages] };
}

const isFullPath = (p: string) => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(p);
const rootOf = (p: string) => path.win32.parse(p).root.toLowerCase();

// Claude 는 작업 폴더 경로 문자열로 프로젝트를 나눈다(~\.claude\projects\<경로 인코딩>, Desktop 목록의 cwd). 같은 폴더가
// 다른 표기(링크·정션·대소문자 — 예: 사용자 폴더 이름을 바꾸고 남긴 C:\Users\olduser → C:\Users\me)로 기록돼 있어도 한
// 프로젝트에 모이도록 표기 하나를 고른다: 이 폴더를 이미 쓰는 Claude 세션이 있으면 가장 최근 세션의 표기, 없으면 실제 경로.
// 실제 경로가 다른 드라이브로 풀리면(subst·네트워크 드라이브) 원래 표기를 둔다. real 은 링크를 푸는 함수(infra/real-path).
export function pickClaudeCwd(cwd: string, known: { cwd: string; updatedAt: number }[], real: (p: string) => string): string {
  const recorded = normalizeWinPath(cwd);
  if (!isFullPath(recorded)) return cwd;
  const key = (p: string) => normalizeWinPath(real(p)).toLowerCase();
  const target = key(recorded);
  let best: { cwd: string; updatedAt: number } | undefined;
  for (const k of known) {
    if (!isFullPath(k.cwd) || key(k.cwd) !== target) continue;
    if (!best || k.updatedAt > best.updatedAt) best = k;
  }
  if (best) return normalizeWinPath(best.cwd);
  const resolved = normalizeWinPath(real(recorded));
  return rootOf(resolved) === rootOf(recorded) ? resolved : recorded;
}
