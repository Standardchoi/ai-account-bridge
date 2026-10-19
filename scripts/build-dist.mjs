// 배포 묶음을 dist/ 하나에 모은다 (npm run dist 의 마지막 단계) — 매번 비우고 새로 채운다:
//   dist/AI Account Bridge_<버전>_x64-setup.exe  tauri build 가 만든 설치 파일
//   dist/AI Account Bridge 사용 설명서.pdf       docs/manual/manual.html 을 Edge 로 인쇄 ({{version}} 은 package.json 버전)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const installer = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis', `AI Account Bridge_${version}_x64-setup.exe`);
if (!fs.existsSync(installer)) throw new Error(`설치 파일이 없습니다 — tauri build 를 먼저 실행하세요: ${installer}`);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);
fs.copyFileSync(installer, path.join(dist, path.basename(installer)));

// 버전을 채운 사본은 원본 옆에 둔다 — 이미지·글꼴을 상대 경로로 읽으므로. 인쇄한 뒤 지운다.
const manualDir = path.join(root, 'docs', 'manual');
const html = path.join(manualDir, 'manual.build.html');
const pdf = path.join(dist, 'AI Account Bridge 사용 설명서.pdf');
fs.writeFileSync(html, fs.readFileSync(path.join(manualDir, 'manual.html'), 'utf8').replaceAll('{{version}}', version));
// Edge 는 인쇄를 끝내기 전에 반환할 때가 있다 — 그사이 사본을 지우면 '파일을 찾을 수 없음' 페이지가 인쇄된다(2026-10-19).
// 매번 새 프로필로 띄우고, PDF 크기가 더 늘지 않을 때까지 기다린 뒤에 사본을 지운다.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-manual-print-'));
try {
  execFileSync(EDGE, ['--headless', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=5000', `--user-data-dir=${profile}`, `--print-to-pdf=${pdf}`, pathToFileURL(html).href], { stdio: 'ignore' });
  let last = -1;
  for (let i = 0; i < 60; i++) {
    const size = fs.existsSync(pdf) ? fs.statSync(pdf).size : 0;
    if (size > 0 && size === last) break;
    last = size;
    await new Promise((r) => setTimeout(r, 500));
  }
} finally {
  fs.rmSync(html, { force: true });
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (!fs.existsSync(pdf) || fs.statSync(pdf).size === 0) throw new Error('설명서 PDF 를 만들지 못했습니다');
for (const f of fs.readdirSync(dist)) console.log(`dist: ${f} (${(fs.statSync(path.join(dist, f)).size / 1048576).toFixed(1)}MB)`);
