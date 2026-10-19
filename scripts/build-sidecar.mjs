// Tauri 사이드카 백엔드를 만든다 (npm run build:sidecar):
//   src/rpc/sea-entry.ts --esbuild--> out/sidecar/backend.cjs --Node SEA--> aab-backend.exe
// 결과는 src-tauri/binaries/ 에 둔다 — aab-backend-<target>.exe (tauri.conf.json 의 externalBin) 와
// better_sqlite3.node (bundle.resources, 설치 폴더에서 실행 파일 옆에 놓인다).
// SEA 에 쓰는 Node 는 이 스크립트를 실행한 node 자신이다(블롭과 실행 파일의 버전이 같아야 한다).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inject } from 'postject';

const TARGET = 'x86_64-pc-windows-msvc';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'out', 'sidecar');
const binDir = path.join(root, 'src-tauri', 'binaries');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(binDir, { recursive: true });

// 1) 한 파일로 묶는다 — SEA 의 main 은 CommonJS 여야 한다. server.ts 의 직접 실행 가드(import.meta.url)는 여기선 꺼진다.
const script = path.join(out, 'backend.cjs');
await build({
  entryPoints: [path.join(root, 'src', 'rpc', 'sea-entry.ts')],
  outfile: script,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  define: { 'import.meta.url': '""' },
  legalComments: 'none',
  logLevel: 'warning',
});

// 2) SEA 블롭 → node.exe 복사본에 주입
const blob = path.join(out, 'sea-prep.blob');
const config = path.join(out, 'sea-config.json');
fs.writeFileSync(config, JSON.stringify({ main: script, output: blob, disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });
const exe = path.join(out, 'aab-backend.exe');
fs.copyFileSync(process.execPath, exe);
await inject(exe, 'NODE_SEA_BLOB', fs.readFileSync(blob), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });

// 3) Tauri 가 가져갈 자리로
fs.copyFileSync(exe, path.join(binDir, `aab-backend-${TARGET}.exe`));
fs.copyFileSync(path.join(root, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node'), path.join(binDir, 'better_sqlite3.node'));

const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(1);
console.log(`sidecar: aab-backend-${TARGET}.exe ${mb(exe)}MB (script ${Math.round(fs.statSync(script).size / 1024)}KB, node ${process.version})`);
