export type ToolId = 'codex' | 'claude';
export type RootKey = 'home' | 'appData' | 'localAppData' | 'claudeDesktop';

export interface AuthPathSpec {
  root: RootKey;
  relPath: string; // '/' 구분자 상대 경로
}

export interface AuthFile extends AuthPathSpec {
  data: string | null; // base64, null = 파일 없음
}

export interface JsonKeyValue extends AuthPathSpec {
  key: string;
  value: unknown; // null = 키 없음
}

export interface AuthBundle {
  tool: ToolId;
  files: AuthFile[];
  replaceDirs: AuthPathSpec[]; // 적용 시 통째로 지우고 files 로 다시 채울 폴더
  jsonKeys: JsonKeyValue[]; // JSON 파일의 특정 최상위 키만 교체
}

export function serializeBundle(bundle: AuthBundle): Buffer {
  return Buffer.from(JSON.stringify(bundle), 'utf8');
}

export function deserializeBundle(buf: Buffer): AuthBundle {
  return JSON.parse(buf.toString('utf8')) as AuthBundle;
}
