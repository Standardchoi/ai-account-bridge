import { normalizeWinPath } from './win-path.js';

// Codex 앱(과 Claude Desktop 의 앱 내 브라우저)은 사용자 입력 앞에 문맥 섹션(첨부 파일·선택 텍스트·응답 주석·
// 참조한 ChatGPT 대화·앱 내 브라우저 상태)을 붙이고, 실제 요청은 마지막 "## My request:"(또는
// "## My request for Codex:") 머리말 뒤에 둔다(실기기 전사 관찰). 섹션 내용(대화 JSON·선택 원문 등)은 버리고
// 뜻 있는 부분만 한 줄 표시로 남긴다. 첨부·선택한 파일은 옮긴 뒤에도 AI 가 다시 열 수 있게 전체 경로를 남긴다.
const PREAMBLE =
  /^\s*(# (Files mentioned by the user|Files pasted by the user|Selected text|Response annotations|In app browser):|## Referenced ChatGPT conversation:|<(in-app-browser-context|ambient-ui-state)\b)/;
const REQUEST_HEADER = /## My request(?: for Codex)?:/g;
const AMBIENT_BLOCK = /<(in-app-browser-context|ambient-ui-state)\b[^>]*>[\s\S]*?<\/\1>\s*/g;
const CLIPBOARD_FILE = /^codex-clipboard-[\w-]+\.\w+$/;

// 앱이 적는 경로 표기('/C:/…', '\\?\C:\…')를 보통 경로로 — 구분자(/ 또는 \)는 적힌 그대로 둔다.
const filePath = (p: string): string => normalizeWinPath(p.trim().replace(/^\/(?=[A-Za-z]:)/, ''));

export function splitComposed(text: string): { notes: string[]; request: string } | null {
  if (!PREAMBLE.test(text)) return null;
  const last = [...text.matchAll(REQUEST_HEADER)].at(-1);
  // 머리말이 없으면 앱 내 브라우저 블록만 걷어낸다
  if (!last) return { notes: [], request: text.replace(AMBIENT_BLOCK, '').trim() };
  return { notes: preambleNotes(text.slice(0, last.index)), request: text.slice(last.index + last[0].length).trim() };
}

function preambleNotes(preamble: string): string[] {
  const files: string[] = [];
  const notes: string[] = [];
  let section = '';
  for (const line of preamble.split(/\r?\n/)) {
    const header = /^(?:# (Files mentioned by the user|Files pasted by the user|Selected text|Response annotations)|## (Referenced ChatGPT conversation)):\s*$/.exec(line);
    if (header) {
      section = header[1] ?? header[2]!;
      if (section === 'Files pasted by the user') notes.push('붙여넣은 내용');
      if (section === 'Response annotations') notes.push('이전 응답 일부 인용');
      if (section === 'Referenced ChatGPT conversation') notes.push('참조한 ChatGPT 대화');
      continue;
    }
    if (section === 'Files mentioned by the user') {
      const m = /^## (.+?): (.*)$/.exec(line);
      if (m && !CLIPBOARD_FILE.test(m[1]!)) files.push(filePath(m[2]!) || m[1]!); // 클립보드 이미지는 이미지 자체가 대신한다
    } else if (section === 'Selected text') {
      const src = /^## Selection \d+: (.+)$/.exec(line)?.[1];
      if (src) notes.push(`선택한 텍스트: ${filePath(src)}`);
    } else if (section === 'Referenced ChatGPT conversation' && notes.at(-1) === '참조한 ChatGPT 대화') {
      const title = /"title":"((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
      if (title) notes[notes.length - 1] = `참조한 ChatGPT 대화: ${title}`;
    }
  }
  if (files.length > 0) notes.unshift(`첨부: ${files.join(', ')}`);
  return notes.map((n) => `[${n}]`);
}

export function stripAmbientContext(text: string): string {
  const parts = splitComposed(text);
  if (!parts) return text;
  return [...parts.notes, parts.request].filter(Boolean).join('\n');
}
