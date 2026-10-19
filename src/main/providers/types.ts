import type { AuthBundle, ToolId } from '../core/auth-bundle.js';
import type { Identity } from '../core/identity.js';

export interface AppInfo {
  aumid: string; // shell:AppsFolder 실행용
  packageDirMarker: string; // 앱 프로세스 경로에 포함되는 문자열
  managedDirs: string[]; // 앱이 띄우는 하위 프로세스(내장 CLI 등) 경로
  cliNames: string[]; // 독립 실행 CLI 프로세스 이름 (소문자)
  cliCommandMarkers: string[]; // node 로 실행되는 npm CLI 를 알아보는 명령줄 문자열
}

export interface ToolAuthProvider {
  id: ToolId;
  app: AppInfo;
  readCurrentAuth(): Promise<AuthBundle>;
  identityOf(bundle: AuthBundle): Identity; // 로그인 안 됨이면 throw
  writeAuth(bundle: AuthBundle): Promise<void>; // 호출 전 앱 종료는 호출자 책임
}

export interface AuthProviderOptions {
  withAppProfile?: boolean; // Electron 프로필(쿠키 등)까지 교체 — Phase 0 V2/V3 결과로 기본값 결정
}

export type SessionKind = 'code' | 'cowork' | 'cli' | 'subagent';

export interface SessionSummary {
  tool: ToolId;
  key: string;                 // 도구 안에서 유일: codex:<threadId> / claude:<kind>:<id>
  sessionId: string;           // 원본 세션/스레드 ID (Claude 는 cliSessionId)
  title: string;
  cwd: string;                 // 정규화된 작업 폴더 (알 수 없으면 '')
  createdAt: number;           // ms
  updatedAt: number;           // ms
  archived: boolean;
  kind: SessionKind;
  parentId?: string;           // 서브에이전트의 부모 스레드
  remote?: boolean;            // Claude ssh-* 원격 세션
  accountRef?: { accountId: string; orgId?: string; email?: string }; // Claude 인덱스 폴더 기준
  file: string;                // 대화 본문 파일 (없으면 '')
  projectId?: string;          // Codex 프로젝트 ID
  projectless?: boolean;       // Codex 앱에서 프로젝트 밖으로 뺀 스레드
  gitBranch?: string;
  indexPath?: string;          // Claude 인덱스(local_*.json) 파일 경로 — Code/Cowork 세션만
  hostFolder?: string;         // Cowork 세션의 실제 작업 폴더 (인덱스의 userSelectedFolders[0])
}
