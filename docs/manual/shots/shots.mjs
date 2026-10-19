// 설명서 스크린샷 (예시 데이터가 들어간 GUI 에서) — 2배 해상도로 캡처
//   npx tsx docs/manual/shots/shots.mjs [출력 폴더, 기본 docs/manual/img]
// 헤드리스 Edge 로 gui/index.html 을 앱 창 크기(1120×760)로 열고, Tauri 연결은 가짜로 바꿔(백엔드는 응답하지 않음)
// 실제 계정·세션 없이 demo-data.js 의 예시 데이터만 그린다. 도구 아이콘은 설치된 앱에서 읽어 넣는다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readAppIcon } from '../../../src/main/infra/app-icons.js';
import { DEMO_SESSION } from './demo-session.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(here, '..', 'img'));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9229;
const edge = spawn(EDGE, ['--headless', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), 'aab-manual-edge')}`, 'about:blank'], { stdio: 'ignore' });
let page;
for (let i = 0; i < 50 && !page; i++) {
  await new Promise((r) => setTimeout(r, 200));
  page = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => undefined);
}
if (!page) throw new Error('헤드리스 Edge 에 연결하지 못했습니다');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => (ws.onopen = r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) console.log('ERR', r.result.exceptionDetails.exception?.description);
  return r.result?.result?.value;
};
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 760, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__TAURI__ = {
    shell: { Command: { sidecar: () => ({ stdout: { on() {} }, stderr: { on() {} }, on() {}, spawn: () => new Promise(() => {}) }) } },
    dialog: { open: async () => null },
    window: { getCurrentWindow: () => ({ isMaximized: async () => false, minimize() {}, toggleMaximize() {}, close() {}, onResized() {} }) },
  };`,
});
await send('Page.navigate', { url: pathToFileURL(path.join(here, '..', '..', '..', 'gui', 'index.html')).href });
await sleep(1500);
await ev('document.fonts.ready.then(() => true)');
const icons = { codex: await readAppIcon('OpenAI.Codex_2p2nqsd0c76g0'), claude: await readAppIcon('Claude_pzs8sxrjxfjjc') };
await ev(`Object.entries(${JSON.stringify(icons)}).forEach(([t, u]) => u && document.documentElement.style.setProperty('--icon-' + t, 'url("' + u + '")')), true`);
fs.mkdirSync(OUT, { recursive: true });
const vp = await ev('({ w: innerWidth, h: innerHeight })');
const shot = async (name, clip = { x: 0, y: 0, width: vp.w, height: vp.h }) => {
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 2 } });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
  console.log('saved', name);
};

await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await ev(fs.readFileSync(new URL('./demo-data.js', import.meta.url), 'utf8'));
await ev('document.activeElement?.blur(), true');
await sleep(300);

// 1) 전체 화면 + 번호
await ev(`(() => {
  const put = (n, x, y) => {
    const b = document.createElement('div');
    b.className = 'doc-badge';
    b.textContent = n;
    Object.assign(b.style, { position: 'fixed', left: x + 'px', top: y + 'px', width: '26px', height: '26px', borderRadius: '13px', background: '#e5484d', color: '#fff', font: '700 14px/22px "Pretendard Variable"', textAlign: 'center', zIndex: 9999, border: '2px solid #fff', boxShadow: '0 2px 8px rgba(0,0,0,.35)' });
    document.body.append(b);
  };
  const r = (sel) => document.querySelector(sel).getBoundingClientRect();
  put('1', r('#switcher-codex').left + 4, r('#switcher-codex').top + 2);
  put('2', r('#source-tool').left - 10, r('#source-tool').top - 12);
  put('3', r('#source-list .row').left - 8, r('#source-list .row').top - 10);
  put('4', r('#go-btn').right - 2, r('#go-btn').bottom - 14);
  put('5', r('#target-select').left - 10, r('#target-select').top - 12);
  put('6', r('#statusbar').left + 6, r('#statusbar').top - 13);
  put('7', r('#activity-btn').left - 8, r('#activity-btn').top + 2);
  return true;
})()`);
await sleep(200);
await shot('overview');
await ev(`document.querySelectorAll('.doc-badge').forEach((b) => b.remove()), true`);

// 2) 계정 메뉴
await ev(`openPopover(document.getElementById('switcher-codex'), accountMenu('codex'), { minWidth: 330 }), true`);
await sleep(300);
const m = await ev(`(() => {
  const a = document.getElementById('switcher-codex').getBoundingClientRect();
  const p = document.querySelector('.popover').getBoundingClientRect();
  return { x: Math.max(0, a.left - 16), y: 0, width: Math.max(p.right, a.right) - a.left + 40, height: p.bottom + 20 };
})()`);
await shot('account-menu', m);
await ev('closePopover(), true');

// 3) 두 개 고르고 끌어다 놓는 중
await ev(`(() => {
  selected.add('codex:s1'); selected.add('codex:s2'); renderSource();
  document.body.classList.add('dragging');
  document.getElementById('target-pane').classList.add('over');
  document.getElementById('dropzone-text').textContent = '여기에 놓아 가져오기 · ' + target.title;
  document.getElementById('source-list').scrollTop = 0;
  document.activeElement?.blur();
  return true;
})()`);
await sleep(250);
await shot('drag');
await ev(`(() => {
  document.body.classList.remove('dragging');
  document.getElementById('target-pane').classList.remove('over');
  document.getElementById('dropzone-text').textContent = '세션을 여기로 끌어다 놓으세요';
  return true;
})()`);

// 4) 가져오기 확인 창
await ev(`openImportDialog(selectedSessions()), true`);
await sleep(350);
const d = await ev(`(() => { const r = document.getElementById('modal').getBoundingClientRect(); return { x: r.left - 24, y: r.top - 24, width: r.width + 48, height: r.height + 48 }; })()`);
await ev('document.activeElement?.blur(), true');
await shot('import-dialog', d);
await ev('modalCancel && modalCancel(), true');

// 5) 미리보기
await ev(`(() => {
  const s = src.data.projects[0].sessions[0];
  const session = ${JSON.stringify(DEMO_SESSION)};
  preview = { side: 'source', key: s.key, tool: 'codex', token: 9999 };
  const drawer = document.getElementById('preview');
  drawer.textContent = '';
  drawer.classList.remove('hidden');
  const actions = h('div', { class: 'pv-actions' }, h('button', { class: 'btn primary action-btn', type: 'button' }, tile('claude', 'sm'), 'Claude로 가져오기'), iconBtn('x', '닫기 (Esc)', closePreview, { focusable: true }));
  drawer.append(h('div', { class: 'pv-head' }, h('div', { class: 'pv-titles' }, h('h3', { text: s.title }), previewMeta({ ...s, projectName: 'web-shop' }, session)), actions), h('div', { class: 'pv-body' }, renderThread(session, 'codex')));
  selected.clear(); selected.add(s.key); renderSource(); markViewing();
  document.getElementById('source-list').scrollTop = 0;
  document.activeElement?.blur();
  return true;
})()`);
await sleep(300);
await shot('preview');
await ev('closePreview(), true');

// 6) 활동 기록
await ev(`(() => {
  document.getElementById('log').textContent = '';
  log('success', "ChatGPT를 '회사 계정' 계정으로 전환했습니다");
  log('info', '가져오기 — 장바구니 결제 흐름 리팩터링: 가져옴');
  log('info', '가져오기 — 상품 목록 API 페이지네이션 추가: 가져옴');
  log('success', '세션 2개를 가져왔습니다 — Claude · 개인 · 가져옴 2');
  toggleActivity(true);
  document.getElementById('activity-btn').classList.remove('alert');
  return true;
})()`);
await sleep(300);
const a = await ev(`(() => { const r = document.getElementById('activity').getBoundingClientRect(); const l = document.getElementById('log').lastElementChild.getBoundingClientRect(); return { x: r.left - 1, y: 0, width: r.width + 1, height: l.bottom + 1 }; })()`);
await shot('activity-crop', a);
await ev('toggleActivity(false), true');
ws.close();
edge.kill();
process.exit(0);
