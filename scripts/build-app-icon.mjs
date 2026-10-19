// 앱 아이콘을 굽는다 (npm run app-icon): gui/assets/icon.svg → out/app-icon.png(1024px) → tauri icon 이
// src-tauri/icons/ 에 창·작업 표시줄·설치 마법사용 크기(ico 포함)를 모두 만든다.
import { Resvg } from '@resvg/resvg-js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'gui', 'assets', 'icon.svg'));
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } }).render().asPng();
const src = path.join(root, 'out', 'app-icon.png');
fs.mkdirSync(path.dirname(src), { recursive: true });
fs.writeFileSync(src, png);
const icons = path.join(root, 'src-tauri', 'icons');
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tauri', 'icon', src, '-o', icons], { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' });
// Windows 설치본에 쓰는 것만 남긴다 (모바일·macOS·스토어용 제거)
const keep = new Set(['32x32.png', '64x64.png', '128x128.png', '128x128@2x.png', 'icon.ico', 'icon.png']);
for (const name of fs.readdirSync(icons)) if (!keep.has(name)) fs.rmSync(path.join(icons, name), { recursive: true, force: true });
console.log(`src-tauri/icons: ${[...keep].join(', ')}`);
