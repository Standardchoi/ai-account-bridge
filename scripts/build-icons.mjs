// gui/icons.js 를 만든다 — @phosphor-icons/core 에서 GUI 가 쓰는 아이콘만 골라 인라인 SVG 문자열로 묶는다.
// 렌더러는 아래 왼쪽 이름으로 부른다. 굵기는 역할별로: 조작 버튼 bold, 메뉴·폴더 duotone, 상태 표시 fill.
// 아이콘을 추가하면 ICONS 에 넣고 `npm run icons` 로 다시 만든다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ICONS = {
  'arrow-left-right': 'bold/arrows-left-right-bold',
  'arrow-right': 'bold/arrow-right-bold',
  'archive-restore': 'duotone/box-arrow-up-duotone',
  check: 'bold/check-bold',
  'chevron-down': 'bold/caret-down-bold',
  'chevron-right': 'bold/caret-right-bold',
  'circle-alert': 'fill/warning-circle-fill',
  'circle-check': 'fill/check-circle-fill',
  cpu: 'bold/cpu-bold',
  download: 'duotone/tray-arrow-down-duotone',
  eye: 'bold/eye-bold',
  folder: 'duotone/folder-simple-duotone',
  'git-branch': 'bold/git-branch-bold',
  history: 'bold/clock-counter-clockwise-bold',
  image: 'bold/image-bold',
  info: 'fill/info-fill',
  layers: 'bold/stack-bold',
  'message-square-text': 'duotone/chat-text-duotone',
  pencil: 'duotone/pencil-simple-duotone',
  'refresh-cw': 'bold/arrow-clockwise-bold',
  save: 'duotone/floppy-disk-duotone',
  search: 'bold/magnifying-glass-bold',
  'settings-2': 'duotone/sliders-horizontal-duotone',
  'shield-check': 'duotone/shield-check-duotone',
  terminal: 'bold/terminal-window-bold',
  'trash-2': 'duotone/trash-duotone',
  'triangle-alert': 'fill/warning-fill',
  'user-plus': 'duotone/user-plus-duotone',
  x: 'bold/x-bold',
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'node_modules', '@phosphor-icons', 'core', 'assets');
const entries = Object.entries(ICONS).map(([name, file]) => {
  const svg = fs.readFileSync(path.join(dir, `${file}.svg`), 'utf8').replace(/\s*\n\s*/g, ' ').trim();
  return `  ${JSON.stringify(name)}: ${JSON.stringify(svg)},`;
});
const out = `// 자동 생성 파일 — scripts/build-icons.mjs 로 다시 만든다. 아이콘: Phosphor Icons (MIT License, https://phosphoricons.com)
'use strict';
window.ICONS = {
${entries.join('\n')}
};
`;
fs.writeFileSync(path.join(root, 'gui', 'icons.js'), out);
console.log(`gui/icons.js: ${entries.length} icons`);
