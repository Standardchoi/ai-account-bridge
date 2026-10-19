import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import type { ToolId } from '../main/core/auth-bundle.js';
import { AppDb } from '../main/infra/app-db.js';
import { migrateAppData } from '../main/infra/data-migration.js';
import { systemPaths } from '../main/infra/path-provider.js';
import { windowsProcessController } from '../main/infra/process-controller.js';
import { dpapiSecretStore } from '../main/infra/secret-store.js';
import { claudeAuthProvider } from '../main/providers/claude/auth.js';
import { codexAuthProvider } from '../main/providers/codex/auth.js';
import type { ToolAuthProvider } from '../main/providers/types.js';
import { createHandlers, type HandlerContext, type PromptKind } from './handlers.js';

// GUI(렌더러) <-> 이 백엔드 프로세스 사이의 stdio 줄 단위 JSON 프로토콜 메시지.
interface RequestMessage {
  type: 'request';
  id: number | string;
  method: string;
  params?: unknown;
}
interface PromptAnswerMessage {
  type: 'promptAnswer';
  promptId: number;
  answer: unknown;
}

function isRequestMessage(m: unknown): m is RequestMessage {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  return r.type === 'request' && (typeof r.id === 'number' || typeof r.id === 'string') && typeof r.method === 'string';
}

function isPromptAnswerMessage(m: unknown): m is PromptAnswerMessage {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  return r.type === 'promptAnswer' && typeof r.promptId === 'number';
}

// 한 줄을 파싱한다 — 빈 줄은 undefined, 잘못된 JSON도 예외를 던지지 않고 undefined 를 반환한다.
export function parseMessage(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

// switch/restore/addAccount 처리 중 진행 상황을 { type: 'progress', id, step } 줄로 흘려보내는 컨텍스트.
export function progressCtx(id: number | string, send: (msg: unknown) => void): HandlerContext {
  return {
    progress(step: string): void {
      send({ type: 'progress', id, step });
    },
  };
}

export async function main(): Promise<void> {
  const paths = systemPaths();
  await migrateAppData(paths, (line) => console.error(line));
  await fs.mkdir(paths.appDataDir, { recursive: true });
  const db = new AppDb(path.join(paths.appDataDir, 'app.db'));
  const secrets = dpapiSecretStore();
  const procs = windowsProcessController();

  const pendingPrompts = new Map<number, (answer: unknown) => void>();
  let nextPromptId = 1;

  const handlers = createHandlers({
    paths,
    db,
    secrets,
    procs,
    makeProviders(withAppProfile: boolean): Record<ToolId, ToolAuthProvider> {
      return {
        codex: codexAuthProvider(paths, { withAppProfile }),
        claude: claudeAuthProvider(paths, { withAppProfile }),
      };
    },
    prompt(kind: PromptKind, data: unknown): Promise<unknown> {
      return new Promise((resolve) => {
        const promptId = nextPromptId++;
        pendingPrompts.set(promptId, resolve);
        send({ type: 'prompt', promptId, kind, data });
      });
    },
  });

  const rl = readline.createInterface({ input: process.stdin });

  // stdin 이 닫혀도(예: 스모크 테스트, 백엔드 셧다운) 처리 중인 요청이 있으면 응답을 다 쓸 때까지 기다렸다가 종료한다.
  let inFlight = 0;
  let closing = false;
  function maybeExit(): void {
    if (!closing || inFlight > 0) return;
    db.close();
    process.exit(0);
  }

  rl.on('line', (line: string) => {
    const msg = parseMessage(line);
    if (msg === undefined) {
      if (line.trim()) console.error(`무시됨 — 잘못된 메시지: ${line.slice(0, 200)}`);
      return;
    }
    if (isPromptAnswerMessage(msg)) {
      const resolve = pendingPrompts.get(msg.promptId);
      if (resolve) {
        pendingPrompts.delete(msg.promptId);
        resolve(msg.answer);
      }
      return;
    }
    if (isRequestMessage(msg)) {
      inFlight++;
      handlers
        .handle(msg.method, msg.params, progressCtx(msg.id, send))
        .then(
          (result) => send({ type: 'response', id: msg.id, result }),
          (err: unknown) => send({ type: 'response', id: msg.id, error: err instanceof Error ? err.message : String(err) }),
        )
        .finally(() => {
          inFlight--;
          maybeExit();
        });
      return;
    }
    console.error(`무시됨 — 알 수 없는 메시지 형식: ${line.slice(0, 200)}`);
  });

  rl.on('close', () => {
    closing = true;
    maybeExit();
  });
}

// tsx 로 직접 실행됐을 때만 main() 을 돌린다 (src/cli/index.ts 와 동일한 가드).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
