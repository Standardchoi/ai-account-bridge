// 설치본 백엔드 진입점 — scripts/build-sidecar.mjs 가 이 파일을 Node 단일 실행 파일(SEA)로 묶어 Tauri 사이드카로 쓴다.
// SEA 안에서는 require 로 .node 를 못 읽으므로, 실행 파일 옆의 better_sqlite3.node 를 src/main/infra/sqlite.ts 에 알려 준다.
import fs from 'node:fs';
import path from 'node:path';
import { main } from './server.js';

const addon = path.join(path.dirname(process.execPath), 'better_sqlite3.node');
if (!process.env.AAB_SQLITE_ADDON && fs.existsSync(addon)) process.env.AAB_SQLITE_ADDON = addon;

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
