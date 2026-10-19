import type { ToolId } from './auth-bundle.js';

export interface Identity {
  tool: ToolId;
  accountId: string;
  orgId?: string;
  email?: string;
  displayName?: string;
}

// identityOf 가 "로그인 안 됨" (파일/키 없음, 손상됨) 을 나타낼 때만 던진다.
// 계정 불일치처럼 로그인은 되어 있으나 신뢰할 수 없는 상태는 일반 Error 로 던져야
// 호출자가 "로그인 안 됨"과 혼동해 조용히 넘어가지 않는다.
export class NotLoggedInError extends Error {}

// 표시용 디코드. 서명은 검증하지 않는다.
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('invalid JWT');
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('invalid JWT');
  }
}

export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.tool === b.tool && a.accountId === b.accountId && (a.orgId ?? '') === (b.orgId ?? '');
}
