import Database from 'better-sqlite3';

// better-sqlite3 로 DB 를 연다. 설치본의 백엔드는 Node 단일 실행 파일(SEA)이라 require 로 네이티브 모듈(.node)을
// 읽지 못한다 — 진입점(src/rpc/sea-entry.ts)이 AAB_SQLITE_ADDON 에 실행 파일 옆 better_sqlite3.node 경로를 넣어 주면
// 그것을 직접 올려서 넘긴다. 개발·테스트에서는 비어 있어 평소처럼 연다.
let addon: object | undefined;

function nativeBinding(): object | undefined {
  const file = process.env.AAB_SQLITE_ADDON;
  if (!file) return undefined;
  if (!addon) {
    const mod = { exports: {} as object };
    process.dlopen(mod, file);
    addon = mod.exports;
  }
  return addon;
}

export function openSqlite(file: string, options: Database.Options = {}): Database.Database {
  const binding = nativeBinding();
  // @types/better-sqlite3 는 nativeBinding 을 경로 문자열로만 적어 두었지만, 라이브러리는 이미 올린 모듈 객체도 받는다.
  return new Database(file, binding ? ({ ...options, nativeBinding: binding } as unknown as Database.Options) : options);
}
