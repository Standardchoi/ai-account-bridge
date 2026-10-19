'use strict';

// Tauri 판 window.bridge — renderer.js 가 쓰는 인터페이스(request/nextRequestId/onPrompt/answerPrompt/onProgress/
// pickBackup, 'backend-exit' 이벤트)를 그대로 제공한다. 백엔드는 사이드카(aab-backend, scripts/build-sidecar.mjs 로 만든
// Node 단일 실행 파일)로 띄우고 stdio 줄 단위 JSON 으로 주고받는다(src/rpc/server.ts 의 프로토콜).
(() => {
  const { Command } = window.__TAURI__.shell;
  const { open } = window.__TAURI__.dialog;
  const pending = new Map(); // id -> { resolve, reject }
  const promptListeners = new Set();
  const progressListeners = new Set();
  let nextId = 1;
  let child = null;
  let exited = false;

  function onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 프로토콜 밖의 줄은 무시
    }
    if (msg.type === 'response') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (Object.prototype.hasOwnProperty.call(msg, 'error')) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    } else if (msg.type === 'prompt') {
      for (const cb of promptListeners) cb({ promptId: msg.promptId, kind: msg.kind, data: msg.data });
    } else if (msg.type === 'progress') {
      // id 를 그대로 넘긴다 — 렌더러가 자신이 기다리는 요청의 진행 상황인지 거른다.
      for (const cb of progressListeners) cb({ id: msg.id, step: msg.step });
    }
  }

  function onExit(info) {
    if (exited) return;
    exited = true;
    for (const p of pending.values()) p.reject(new Error('백엔드가 종료되었습니다'));
    pending.clear();
    document.dispatchEvent(new CustomEvent('backend-exit', { detail: info }));
  }

  const ready = (async () => {
    const cmd = Command.sidecar('binaries/aab-backend');
    cmd.stdout.on('data', onLine);
    cmd.stderr.on('data', (line) => console.warn('[backend]', line));
    cmd.on('close', ({ code }) => onExit({ code }));
    cmd.on('error', (e) => onExit({ code: null, message: String(e) }));
    child = await cmd.spawn();
  })();
  ready.catch((e) => onExit({ code: null, message: `백엔드를 시작하지 못했습니다: ${e}` }));

  const send = (obj) => child.write(`${JSON.stringify(obj)}\n`);

  window.bridge = {
    async request(method, params, requestId) {
      await ready;
      if (exited) throw new Error('백엔드가 실행 중이 아닙니다');
      const id = requestId ?? `m${nextId++}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ type: 'request', id, method, params }).catch((e) => {
          pending.delete(id);
          reject(e instanceof Error ? e : new Error(String(e)));
        });
      });
    },
    nextRequestId: () => `r${nextId++}`,
    onPrompt(cb) {
      promptListeners.add(cb);
      return () => promptListeners.delete(cb);
    },
    answerPrompt(promptId, answer) {
      ready.then(() => send({ type: 'promptAnswer', promptId, answer })).catch(() => {});
    },
    onProgress(cb) {
      progressListeners.add(cb);
      return () => progressListeners.delete(cb);
    },
    async pickBackup() {
      const defaultPath = await window.bridge.request('backupsDir').catch(() => undefined);
      const file = await open({ title: '백업 파일 선택', defaultPath, multiple: false, directory: false, filters: [{ name: 'Backup files', extensions: ['bin'] }] });
      return typeof file === 'string' ? file : null;
    },
  };

  // 창 조작 버튼 — 제목 표시줄을 앱이 직접 그린다(tauri.conf.json 의 decorations: false). 끌기는 data-tauri-drag-region.
  const win = window.__TAURI__.window.getCurrentWindow();
  const maxBtn = document.getElementById('win-max');
  const syncMax = async () => {
    const maximized = await win.isMaximized();
    maxBtn.classList.toggle('restore', maximized);
    maxBtn.setAttribute('aria-label', maximized ? '이전 크기로' : '최대화');
    maxBtn.title = maximized ? '이전 크기로' : '최대화';
  };
  document.getElementById('win-min').addEventListener('click', () => win.minimize());
  maxBtn.addEventListener('click', () => win.toggleMaximize());
  document.getElementById('win-close').addEventListener('click', () => win.close());
  win.onResized(() => syncMax());
  syncMax();
})();
