'use strict';

// 화면 구성 (레퍼런스: GitHub Desktop 의 상단 현재 계정 막대 + Transmit 의 보내는 쪽 → 받는 쪽 전송 화면)
//  상단 막대   도구별 현재 계정. 누르면 계정 메뉴(전환·새 계정 추가·로그인 저장·이름 변경·삭제)
//  작업 영역   보내는 쪽 세션 목록 | 가져오기 | 받는 쪽(대상 + 이미 있는 세션). 대화 미리보기는 오른쪽 위를 덮는 서랍
//  상태 표시줄 마지막 작업 결과 (누르면 활동 기록)

const TOOLS = ['codex', 'claude'];
const TOOL_NAMES = { codex: 'ChatGPT', claude: 'Claude' };

const $ = (id) => document.getElementById(id);

// 아이콘 글꼴용 사용자 정의 영역 문자(U+E000–F8FF)는 웹 화면에서 복사한 대화에 섞여 들어와 엉뚱한 기호로 보이므로 뺀다.
const cleanText = (t) => String(t ?? '').replace(/[-]/g, '');

function cleanTitles(r) {
  for (const p of r.projects) for (const s of p.sessions) s.title = cleanText(s.title);
  return r;
}

// --- DOM 도우미 -----------------------------------------------------------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

function icon(name, cls) {
  const el = document.createElement('span');
  el.className = cls ? `i ${cls}` : 'i';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = window.ICONS[name] ?? '';
  return el;
}

// 설치된 앱 아이콘은 --icon-codex / --icon-claude 로 들어온다(loadAppIcons).
function tile(tool, size) {
  return h('span', { class: `tile tile-${tool}${size ? ` tile-${size}` : ''}`, 'aria-hidden': 'true' });
}

function iconBtn(name, label, onClick, { cls, focusable } = {}) {
  return h(
    'button',
    {
      class: cls ? `icon-btn ${cls}` : 'icon-btn',
      type: 'button',
      title: label,
      'aria-label': label,
      tabindex: focusable ? null : '-1',
      onclick: (e) => {
        e.stopPropagation();
        onClick();
      },
    },
    icon(name),
  );
}

function emptyEl(iconName, text) {
  return h('div', { class: 'empty' }, icon(iconName), h('span', { text }));
}

function loadingEl(text = '불러오는 중…') {
  return h('div', { class: 'loading' }, h('span', { class: 'spinner' }), h('span', { text }));
}

function formatDateTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function relTime(ms) {
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  return formatDateTime(ms).slice(0, 10);
}

for (const el of document.querySelectorAll('[data-icon]')) {
  if (!el.className) el.className = 'i';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = window.ICONS[el.dataset.icon] ?? '';
}

// --- 상태 ----------------------------------------------------------------

let state = null; // state RPC 결과: { tools, accounts, paths }
let busy = false;
let fatal = false;
let activeProgress = null; // { tool, prefix, onStep? } — 진행 중인 쓰기 작업
let activeRequestId = null;
const appProfile = { codex: false, claude: false }; // 계정 메뉴의 '앱 프로필도 함께' 토글

const src = { tool: 'codex', account: '', subagents: false, archived: false, data: null, error: null, loading: false, token: 0 };
const selected = new Set(); // 보낼 세션 key (대화 기록 있는 것만)
const collapsed = new Set(); // 접은 프로젝트 key
let visibleKeys = []; // 화면에 보이는 선택 가능한 세션 — Shift+클릭 범위, Ctrl+A
let anchorKey = null; // Shift+클릭 범위의 기준
let focusKey = null; // 목록에서 키보드 포커스를 둘 항목

let target = null; // 받는 쪽: targetOptions() 의 한 항목
const dest = { data: null, error: null, loading: false, token: 0, fresh: new Set() }; // fresh: 방금 가져온 세션 id

let preview = null; // { side: 'source'|'target', key, tool, token }
let drag = null; // { sessions } — 끌고 있는 세션들

function setBusy(v) {
  busy = v || fatal;
  document.body.classList.toggle('busy', busy);
  for (const b of document.querySelectorAll('.action-btn')) b.disabled = busy;
  $('swap-btn').disabled = busy;
  renderGo();
}

// --- 활동 기록 · 상태 표시줄 · 알림 ---------------------------------------

const KIND_ICON = { success: 'circle-check', warning: 'triangle-alert', error: 'circle-alert', info: 'info' };
let statusAt = null;

function log(kind, message) {
  const time = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  $('log').prepend(
    h('div', { class: `log-line ${kind}` }, h('span', { class: 'ic' }, kind === 'step' ? null : icon(KIND_ICON[kind] ?? 'info')), h('span', { class: 'msg', text: message }), h('time', { text: time })),
  );
  if ((kind === 'error' || kind === 'warning') && $('activity').classList.contains('hidden')) $('activity-btn').classList.add('alert');
}

function setStatus(kind, text, { sticky } = {}) {
  $('statusbar').className = `statusbar ${kind}`;
  const ic = $('status-icon');
  ic.textContent = '';
  ic.append(kind === 'progress' ? h('span', { class: 'spinner' }) : icon(KIND_ICON[kind] ?? 'info'));
  $('status-text').textContent = text;
  statusAt = kind === 'progress' || sticky ? null : Date.now();
  renderStatusTime();
}

function renderStatusTime() {
  $('status-time').textContent = statusAt ? relTime(statusAt) : '';
}

function toast(kind, title, message) {
  const host = $('toasts');
  const el = h(
    'div',
    { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(KIND_ICON[kind] ?? 'info'),
    h('div', { class: 'tx' }, h('b', { text: title }), message ? h('span', { text: message }) : null),
    iconBtn('x', '닫기', () => el.remove(), { focusable: true }),
  );
  host.prepend(el);
  while (host.children.length > 3) host.lastElementChild.remove();
  if (kind === 'success' || kind === 'info') setTimeout(() => el.remove(), 7000);
}

// 작업 결과는 활동 기록과 상태 표시줄에 남기고, 경고·오류(또는 꼭 봐야 하는 안내)는 알림으로도 띄운다.
function report(kind, title, detail, { notify } = {}) {
  const text = detail ? `${title} — ${detail}` : title;
  log(kind, text);
  setStatus(kind, text);
  if (notify || kind === 'warning' || kind === 'error') toast(kind, title, detail);
}

function toggleActivity(open) {
  const sheet = $('activity');
  const show = open ?? sheet.classList.contains('hidden');
  sheet.classList.toggle('hidden', !show);
  $('activity-btn').classList.toggle('open', show);
  if (show) $('activity-btn').classList.remove('alert');
}

function renderPaths() {
  const { appDataDir, claudeDesktop } = state.paths;
  $('paths-line').textContent = `앱 데이터  ${appDataDir}\nClaude Desktop  ${claudeDesktop}`;
}

window.bridge.onProgress(({ id, step }) => {
  if (!activeProgress || id !== activeRequestId) return;
  activeProgress.onStep?.(step);
  setStatus('progress', `${activeProgress.prefix} — ${step}`);
  log('step', step);
});

document.addEventListener('backend-exit', (e) => {
  const d = e.detail || {};
  fatal = true;
  setBusy(true);
  report('error', '백엔드가 종료되었습니다', [d.code != null ? `code ${d.code}` : null, d.message].filter(Boolean).join(' · ') || '앱을 다시 실행하세요');
});

// --- 대화상자 --------------------------------------------------------------

const overlay = $('modal-overlay');
const modalEl = $('modal');
const modalStack = []; // 대화상자 위에 대화상자(예: 가져오는 중 강제 종료 확인)가 뜨면 아래 것을 보관했다가 되돌린다
let modalCancel = null;

function openModal(nodes, { onCancel, wide } = {}) {
  closePopover();
  if (!overlay.classList.contains('hidden')) modalStack.push({ nodes: [...modalEl.childNodes], cancel: modalCancel, cls: modalEl.className });
  modalEl.textContent = '';
  modalEl.className = wide ? 'dialog wide' : 'dialog';
  modalEl.append(...[nodes].flat());
  modalCancel = onCancel ?? null;
  overlay.classList.remove('hidden');
}

function closeModal() {
  const prev = modalStack.pop();
  modalEl.textContent = '';
  if (prev) {
    modalEl.className = prev.cls;
    modalEl.append(...prev.nodes);
    modalCancel = prev.cancel;
    return;
  }
  modalCancel = null;
  overlay.classList.add('hidden');
}

function dialogParts(title, body, actions) {
  return [h('div', { class: 'dlg-body' }, h('h3', { text: title }), body), h('div', { class: 'dlg-actions' }, actions)];
}

function askLabel(title, message, initial) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      closeModal();
      resolve(v);
    };
    const input = h('input', { class: 'field', type: 'text', maxlength: '64', autocomplete: 'off', placeholder: '예: 회사 계정', 'aria-label': '이름' });
    input.value = initial ?? '';
    const ok = h('button', { class: 'btn primary', type: 'button', onclick: () => finish(input.value.trim() || null) }, '확인');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        ok.click();
      }
    });
    openModal(dialogParts(title, [message ? h('p', { text: message }) : null, input], [h('button', { class: 'btn', type: 'button', onclick: () => finish(null) }, '취소'), ok]), {
      onCancel: () => finish(null),
    });
    input.focus();
    input.select();
  });
}

function confirmModal(title, body, { confirmText = '확인', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      closeModal();
      resolve(v);
    };
    const ok = h('button', { class: danger ? 'btn danger' : 'btn primary', type: 'button', onclick: () => finish(true) }, confirmText);
    openModal(dialogParts(title, typeof body === 'string' ? h('p', { text: body }) : body, [h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, '취소'), ok]), {
      onCancel: () => finish(false),
    });
    ok.focus();
  });
}

function pickToolModal(title, message) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      closeModal();
      resolve(v);
    };
    const pick = h(
      'div',
      { class: 'pick' },
      TOOLS.map((t) => h('button', { type: 'button', onclick: () => finish(t) }, tile(t, 'lg'), TOOL_NAMES[t])),
    );
    openModal(dialogParts(title, [h('p', { text: message }), pick], [h('button', { class: 'btn', type: 'button', onclick: () => finish(null) }, '취소')]), { onCancel: () => finish(null) });
    pick.querySelector('button').focus();
  });
}

function procList(procs) {
  return h('div', { class: 'proc-list' }, procs.map((p) => h('div', { text: `${p.name}  (pid ${p.pid})` })));
}

window.bridge.onPrompt(async ({ promptId, kind, data }) => {
  let answer = null;
  if (kind === 'confirmKill') {
    answer = await confirmModal(
      '앱을 강제로 종료할까요?',
      [h('p', { text: `앱이 스스로 종료되지 않았습니다 (${data.length}개 프로세스). 강제로 종료하면 저장하지 않은 입력이 사라질 수 있습니다.` }), procList(data)],
      { confirmText: '강제 종료', danger: true },
    );
  } else if (kind === 'confirmStrayCli') {
    answer = await confirmModal('따로 실행 중인 CLI가 있습니다', [h('p', { text: '전환한 뒤에도 이 CLI가 이전 계정의 토큰을 덮어쓸 수 있습니다. 그래도 진행할까요?' }), procList(data)], {
      confirmText: '진행',
    });
  } else if (kind === 'confirmSaveUnknown') {
    answer = await askLabel(
      '지금 로그인을 저장할까요?',
      `현재 로그인(${data.email ?? data.accountId})은 등록되지 않았습니다. 전환하기 전에 저장하려면 이름을 입력하세요. 비워 두면 저장하지 않습니다.`,
    );
  }
  window.bridge.answerPrompt(promptId, answer);
});

// --- 팝오버 (계정 메뉴 · 받는 쪽 선택 · 계정 필터) --------------------------

let pop = null; // { el, anchor }

function openPopover(anchor, content, { align = 'start', minWidth = 0 } = {}) {
  const same = pop?.anchor === anchor;
  closePopover();
  if (same) return; // 같은 버튼을 다시 누르면 닫기만
  const el = h('div', { class: 'popover', role: 'menu' }, content);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  el.style.minWidth = `${Math.max(r.width, minWidth)}px`;
  const left = align === 'end' ? r.right - el.offsetWidth : r.left;
  el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - el.offsetWidth - 8))}px`;
  el.style.top = `${r.bottom + 6}px`;
  anchor.classList.add('open');
  anchor.setAttribute('aria-expanded', 'true');
  el.addEventListener('keydown', (e) => onPopoverKey(e, el));
  pop = { el, anchor };
  (el.querySelector('.mi.cur, .opt.on') ?? menuItems(el)[0])?.focus({ preventScroll: true });
}

function closePopover({ refocus } = {}) {
  if (!pop) return;
  const { el, anchor } = pop;
  pop = null;
  el.remove();
  anchor.classList.remove('open');
  anchor.setAttribute('aria-expanded', 'false');
  if (refocus) anchor.focus();
}

function menuItems(el) {
  return [...el.querySelectorAll('.mi[tabindex="0"]')].filter((x) => !x.classList.contains('disabled'));
}

function onPopoverKey(e, el) {
  const items = menuItems(el);
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  } else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) {
    e.preventDefault();
    items[i].click();
  } else if (e.key === 'Tab') {
    closePopover();
  }
}

// 메뉴 항목: 버튼처럼 동작하는 div (안에 이름 변경·삭제 같은 작은 버튼을 넣을 수 있게)
function menuItem(cls, children, onClick, { disabled } = {}) {
  const el = h('div', { class: `mi ${cls}${disabled ? ' disabled' : ''}`, role: 'menuitem', tabindex: '0', 'aria-disabled': disabled ? 'true' : null }, children);
  if (onClick && !disabled) el.addEventListener('click', onClick);
  return el;
}

document.addEventListener(
  'mousedown',
  (e) => {
    if (pop && !pop.el.contains(e.target) && !pop.anchor.contains(e.target)) closePopover();
  },
  true,
);
window.addEventListener('resize', () => closePopover());
window.addEventListener('blur', () => closePopover());

// --- 상단 막대: 도구별 현재 계정 -------------------------------------------

function renderSwitchers() {
  for (const tool of TOOLS) renderSwitcher(tool);
}

function renderSwitcher(tool) {
  const btn = $(`switcher-${tool}`);
  btn.textContent = '';
  const cur = state?.tools[tool].current;
  let mark;
  let label;
  let muted = false;
  if (activeProgress?.tool === tool) {
    mark = h('span', { class: 'spinner' });
    label = `${activeProgress.prefix}…`;
  } else if (!cur) {
    mark = h('span', { class: 'dot' });
    label = '불러오는 중…';
    muted = true;
  } else if (cur.error) {
    mark = h('span', { class: 'dot' });
    label = '로그인 정보 없음';
    muted = true;
  } else if (!cur.registeredLabel) {
    mark = h('span', { class: 'dot warn' });
    label = cur.email ?? '등록 안 된 로그인';
  } else {
    mark = h('span', { class: 'dot on' });
    label = cur.registeredLabel;
  }
  btn.append(
    tile(tool, 'lg'),
    h('span', { class: 'sw-text' }, h('small', { text: `${TOOL_NAMES[tool]} 계정` }), h('b', { class: muted ? 'muted' : null }, mark, h('span', { text: label }))),
    icon('chevron-down'),
  );
  btn.title = cur?.error ?? '';
}

function flashSwitcher(tool) {
  const btn = $(`switcher-${tool}`);
  btn.classList.remove('flash');
  void btn.offsetWidth; // 애니메이션 다시 시작
  btn.classList.add('flash');
}

function accountMenu(tool) {
  const cur = state.tools[tool].current;
  const rows = state.accounts.filter((a) => a.tool === tool);
  const items = [h('div', { class: 'menu-label', text: `${TOOL_NAMES[tool]} 계정` })];

  if (cur.error) {
    items.push(h('div', { class: 'mi-note' }, icon('triangle-alert'), h('span', { text: cur.error })));
  } else if (!cur.registeredLabel) {
    items.push(
      h(
        'div',
        { class: 'mi-note' },
        icon('triangle-alert'),
        h('span', { text: `등록되지 않은 로그인 · ${cur.email ?? cur.accountId}` }),
        h('button', { class: 'btn action-btn', type: 'button', disabled: busy, onclick: () => (closePopover(), doSave(tool)) }, '저장…'),
      ),
    );
  }

  for (const a of rows) {
    const active = !cur.error && a.label === cur.registeredLabel;
    const sub = [a.email ?? '이메일 없음', a.scope && a.scope !== 'auth' ? '앱 프로필 포함' : null, a.status === 'needs_relogin' ? '다시 로그인 필요' : null].filter(Boolean).join(' · ');
    items.push(
      menuItem(
        `acct${active ? ' cur' : ''}`,
        [
          h('span', { class: 'mi-check' }, active ? icon('check') : null),
          h('span', { class: 'mi-text' }, h('b', { text: a.label }), h('small', { text: sub })),
          h(
            'span',
            { class: 'mi-tools' },
            iconBtn('pencil', '이름 변경', () => (closePopover(), doRename(tool, a.label))),
            iconBtn('trash-2', '삭제', () => (closePopover(), doDelete(tool, a.label)), { cls: 'danger' }),
          ),
          active ? h('span', { class: 'using', text: '사용 중' }) : h('span', { class: 'mi-go', text: '전환' }),
        ],
        active ? null : () => (closePopover(), doSwitch(tool, a.label)),
        { disabled: busy && !active },
      ),
    );
  }
  if (rows.length === 0 && cur.error) {
    items.push(h('div', { class: 'mi-note' }, icon('info'), h('span', { text: '등록된 계정이 없습니다. 앱에서 로그인한 뒤 저장하세요.' })));
  }

  items.push(h('div', { class: 'msep' }));
  items.push(menuItem('act', [icon('user-plus'), h('span', { text: '새 계정 추가' })], () => (closePopover(), doAddAccount(tool)), { disabled: busy }));
  items.push(menuItem('act', [icon('save'), h('span', { text: '현재 로그인 저장…' })], () => (closePopover(), doSave(tool)), { disabled: busy || Boolean(cur.error) }));
  items.push(h('div', { class: 'msep' }));

  const sw = h('input', { class: 'switch', type: 'checkbox', role: 'switch', tabindex: '-1', 'aria-label': '앱 프로필도 함께 저장·교체' });
  sw.checked = appProfile[tool];
  sw.addEventListener('change', () => {
    appProfile[tool] = sw.checked;
  });
  items.push(
    menuItem('toggle', [icon('settings-2'), h('span', { class: 'mi-text' }, h('b', { text: '앱 프로필도 함께 저장·교체' }), h('small', { text: '쿠키·로컬 저장소까지 · 검증용' })), sw], (e) => {
      if (e.target !== sw) sw.click();
    }),
  );
  return items;
}

// --- 계정 작업 -------------------------------------------------------------

// 쓰기 작업 공통: 진행 표시(상단 막대의 해당 도구 + 상태 표시줄), 바쁨 처리, 끝나면 상태 새로고침.
async function runWithProgress(tool, prefix, method, params) {
  const requestId = window.bridge.nextRequestId();
  activeRequestId = requestId;
  activeProgress = { tool, prefix };
  setBusy(true);
  setStatus('progress', prefix);
  renderSwitchers();
  try {
    return await window.bridge.request(method, params, requestId);
  } finally {
    activeProgress = null;
    activeRequestId = null;
    setBusy(false);
    await refreshState();
  }
}

async function doSwitch(tool, label) {
  try {
    const r = await runWithProgress(tool, '전환 중', 'switch', { tool, label, withAppProfile: appProfile[tool] });
    if (r.status === 'switched') {
      report('success', `${TOOL_NAMES[tool]}를 '${r.account.label}' 계정으로 전환했습니다`, r.notice);
      flashSwitcher(tool);
    } else if (r.status === 'aborted') {
      report('warning', '전환을 취소했습니다', r.reason);
    } else {
      report('error', '전환하지 못해 이전 상태로 되돌렸습니다', `${r.reason} (백업: ${r.backupPath})`);
    }
    if (r.launchWarning) report('warning', '앱이 다시 실행되지 않았습니다', r.launchWarning);
  } catch (e) {
    report('error', '전환하지 못했습니다', e.message);
  }
}

async function doSave(tool) {
  const cur = state?.tools[tool].current;
  const who = cur && !cur.error && cur.email ? `(${cur.email})` : '';
  const label = await askLabel(`${TOOL_NAMES[tool]} 로그인 저장`, `지금 로그인한 계정${who}을 이 이름으로 등록합니다.`, cur?.registeredLabel);
  if (!label) return;
  try {
    const r = await runWithProgress(tool, '저장 중', 'save', { tool, label, withAppProfile: appProfile[tool] });
    report('success', `${TOOL_NAMES[tool]} 계정을 저장했습니다`, r.label);
  } catch (e) {
    report('error', '저장하지 못했습니다', e.message);
  }
}

async function doAddAccount(tool) {
  const body = [
    h('p', { text: `지금 계정을 저장해 두고, 로그아웃하지 않은 채 로그인 정보만 비운 뒤 ${TOOL_NAMES[tool]} 앱을 다시 엽니다. 앱에서 새 계정으로 로그인하면 계정 메뉴에서 저장할 수 있습니다.` }),
    appProfile[tool] ? h('div', { class: 'callout warn' }, icon('triangle-alert'), h('span', { text: '‘앱 프로필도 함께’가 켜져 있어 쿠키와 로컬 저장소도 비워집니다. 기존 상태는 백업과 계정 스냅샷에 남습니다.' })) : null,
  ];
  if (!(await confirmModal(`${TOOL_NAMES[tool]}에 새 계정 추가`, body, { confirmText: '계속' }))) return;
  try {
    const r = await runWithProgress(tool, '계정 추가 준비 중', 'addAccount', { tool, withAppProfile: appProfile[tool] });
    if (r.status === 'ready') {
      log('info', `백업: ${r.backupPath}`);
      if (r.notice) log('warning', r.notice);
      report('info', `${TOOL_NAMES[tool]}에서 새 계정으로 로그인하세요`, '로그인하면 계정 메뉴에 ‘등록되지 않은 로그인’으로 나타납니다. 그때 저장하세요.', { notify: true });
    } else {
      report('warning', '계정 추가를 취소했습니다', r.reason);
    }
    if (r.launchWarning) report('warning', '앱이 다시 실행되지 않았습니다', r.launchWarning);
  } catch (e) {
    report('error', '계정 추가를 준비하지 못했습니다', e.message);
  }
}

async function doRename(tool, label) {
  const next = await askLabel(`'${label}' 이름 변경`, null, label);
  if (!next || next === label) return;
  setBusy(true);
  try {
    const r = await window.bridge.request('rename', { tool, label, newLabel: next });
    report('success', '이름을 바꿨습니다', `${label} → ${r.label}`);
  } catch (e) {
    report('error', '이름을 바꾸지 못했습니다', e.message);
  } finally {
    setBusy(false);
    await refreshState();
  }
}

async function doDelete(tool, label) {
  const ok = await confirmModal(`'${label}' 계정을 삭제할까요?`, '등록 정보와 저장된 로그인 스냅샷을 지웁니다. 앱의 현재 로그인은 그대로 둡니다.', { confirmText: '삭제', danger: true });
  if (!ok) return;
  setBusy(true);
  try {
    await window.bridge.request('delete', { tool, label });
    report('success', '계정을 삭제했습니다', label);
  } catch (e) {
    report('error', '삭제하지 못했습니다', e.message);
  } finally {
    setBusy(false);
    await refreshState();
  }
}

async function doRestore() {
  const tool = await pickToolModal('어느 앱의 로그인을 복원할까요?', '전환하기 전에 자동으로 만든 백업 파일을 고르면 그 시점의 로그인으로 되돌립니다.');
  if (!tool) return;
  const file = await window.bridge.pickBackup();
  if (!file) return;
  try {
    const r = await runWithProgress(tool, '복원 중', 'restore', { tool, file, withAppProfile: appProfile[tool] });
    if (r.status === 'restored') report('success', `${TOOL_NAMES[tool]} 로그인을 백업에서 복원했습니다`, r.backupPath ? `복원 직전 상태 백업: ${r.backupPath}` : undefined);
    else report('warning', '복원을 취소했습니다', r.reason);
    if (r.launchWarning) report('warning', '앱이 다시 실행되지 않았습니다', r.launchWarning);
  } catch (e) {
    report('error', '복원하지 못했습니다', e.message);
  }
}

async function refreshState() {
  try {
    state = await window.bridge.request('state', {});
  } catch (e) {
    log('error', `상태를 불러오지 못했습니다 — ${e.message}`);
    return;
  }
  renderSwitchers();
  renderPaths();
  ensureTarget();
}

async function loadAppIcons() {
  try {
    const icons = await window.bridge.request('appIcons', {});
    for (const t of TOOLS) if (icons[t]) document.documentElement.style.setProperty(`--icon-${t}`, `url("${icons[t]}")`);
  } catch {
    // 앱 아이콘을 못 읽으면 기본 타일 색만 보인다
  }
}

// --- 보내는 쪽 --------------------------------------------------------------

function sourceQuery() {
  return $('source-search').value.trim().toLowerCase();
}

// 검색어가 프로젝트 이름·경로에 맞으면 프로젝트 전체를, 아니면 제목·작업 폴더가 맞는 세션만 남긴다.
function filterProjects(projects, q) {
  if (!q) return projects;
  const hit = (v) => typeof v === 'string' && v.toLowerCase().includes(q);
  return projects.map((p) => (hit(p.name) || hit(p.path) ? p : { ...p, sessions: p.sessions.filter((s) => hit(s.title) || hit(s.cwd)) })).filter((p) => p.sessions.length > 0);
}

function allSourceSessions() {
  return src.data ? src.data.projects.flatMap((p) => p.sessions) : [];
}

function selectedSessions() {
  return allSourceSessions().filter((s) => selected.has(s.key));
}

function renderSourceTool() {
  const seg = $('source-tool');
  seg.textContent = '';
  for (const tool of TOOLS) {
    seg.append(h('button', { class: 'seg-item', type: 'button', role: 'radio', 'aria-checked': String(src.tool === tool), onclick: () => setSourceTool(tool) }, tile(tool, 'sm'), TOOL_NAMES[tool]));
  }
}

function setSourceTool(tool, { account = '', targetKey } = {}) {
  if (src.tool === tool && src.account === account && targetKey === undefined) return;
  src.tool = tool;
  src.account = account;
  src.data = null;
  selected.clear();
  anchorKey = null;
  focusKey = null;
  closePreview();
  renderSourceTool();
  ensureTarget(targetKey);
  sourceRefresh();
}

function renderSourceAccount() {
  const btn = $('source-account');
  btn.textContent = '';
  const acc = src.data?.accounts.find((a) => a.key === src.account);
  btn.append(h('span', { class: 'sel-text', text: acc ? acc.label : '모든 계정' }), icon('chevron-down'));
}

function accountFilterMenu() {
  const opts = [{ key: '', label: '모든 계정' }, ...(src.data?.accounts ?? [])];
  return opts.map((o) =>
    menuItem(`opt${o.key === src.account ? ' on' : ''}`, [h('span', { class: 'mi-sel' }, o.key === src.account ? icon('check') : null), h('span', { class: 'mi-text' }, h('b', { text: o.label }))], () => {
      closePopover({ refocus: true });
      if (o.key === src.account) return;
      src.account = o.key;
      selected.clear();
      sourceRefresh();
    }),
  );
}

async function sourceRefresh() {
  const token = ++src.token;
  src.loading = true;
  if (!src.data) renderSourceList();
  try {
    const r = await window.bridge.request('libraryList', {
      tool: src.tool,
      ...(src.account ? { account: src.account } : {}),
      includeSubagents: src.subagents,
      includeArchived: src.archived,
    });
    if (token !== src.token) return;
    // 거르던 계정이 사라졌으면(삭제 등) 전체 보기로 돌아간다
    if (src.account && !r.accounts.some((a) => a.key === src.account)) {
      src.account = '';
      sourceRefresh();
      return;
    }
    src.data = cleanTitles(r);
    src.error = null;
    const keys = new Set(allSourceSessions().map((s) => s.key));
    for (const k of [...selected]) if (!keys.has(k)) selected.delete(k);
  } catch (e) {
    if (token !== src.token) return;
    src.data = null;
    src.error = e.message;
    log('error', `세션 목록을 불러오지 못했습니다 — ${e.message}`);
  } finally {
    if (token === src.token) {
      src.loading = false;
      renderSource();
    }
  }
}

function renderSource() {
  renderSourceAccount();
  renderSourceList();
  renderSourceFoot();
  renderGo();
}

function renderSourceList() {
  const list = $('source-list');
  const hadFocus = list.contains(document.activeElement);
  const scroll = list.scrollTop;
  list.textContent = '';
  visibleKeys = [];
  if (!src.data) {
    list.append(src.loading ? loadingEl() : emptyEl('triangle-alert', src.error ? `목록을 불러오지 못했습니다: ${src.error}` : '세션이 없습니다'));
    return;
  }
  const q = sourceQuery();
  const projects = filterProjects(src.data.projects, q);
  if (projects.length === 0) {
    list.append(src.data.projects.length ? emptyEl('search', '검색 결과가 없습니다') : emptyEl('message-square-text', '이 도구에는 아직 세션이 없습니다'));
    return;
  }
  const imported = new Set(src.data.imported ?? []);
  for (const proj of projects) {
    const isCollapsed = !q && collapsed.has(proj.key);
    const withT = proj.sessions.filter((s) => s.hasTranscript);
    const all = withT.length > 0 && withT.every((s) => selected.has(s.key));
    const some = withT.some((s) => selected.has(s.key));
    const cb = h('input', { class: 'cb', type: 'checkbox', tabindex: '-1', 'aria-label': `${proj.name} 전체 선택` });
    cb.checked = all;
    cb.indeterminate = !all && some;
    cb.disabled = withT.length === 0;
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      for (const s of withT) cb.checked ? selected.add(s.key) : selected.delete(s.key);
      renderSource();
    });
    const grp = h(
      'div',
      { class: 'grp', role: 'button', tabindex: '-1', 'aria-expanded': String(!isCollapsed), title: proj.path ?? null, dataset: { focus: `p:${proj.key}` } },
      icon('chevron-down', 'chev'),
      cb,
      icon(proj.key === 'loose' ? 'message-square-text' : 'folder', 'fold'), // '프로젝트 없음'은 폴더가 아니라 대화 묶음
      h('span', { class: 'name', text: proj.name }),
      h('span', { class: 'n', text: String(proj.sessions.length) }),
    );
    const setCollapsed = (v) => {
      if (q || v === collapsed.has(proj.key)) return;
      v ? collapsed.add(proj.key) : collapsed.delete(proj.key);
      focusKey = `p:${proj.key}`;
      renderSourceList();
    };
    grp.addEventListener('click', () => setCollapsed(!collapsed.has(proj.key)));
    grp.addEventListener('focus', () => setFocus(`p:${proj.key}`));
    grp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setCollapsed(!collapsed.has(proj.key));
      } else if (e.key === 'ArrowLeft') setCollapsed(true);
      else if (e.key === 'ArrowRight') setCollapsed(false);
    });
    if (withT.length > 0) {
      grp.draggable = true;
      grp.addEventListener('dragstart', (e) => startDrag(e, withT, grp));
      grp.addEventListener('dragend', endDrag);
    }
    list.append(grp);
    if (isCollapsed) continue;
    for (const s of proj.sessions) {
      list.append(sourceRow(s, imported));
      if (s.hasTranscript) visibleKeys.push(s.key);
    }
  }
  applyRovingFocus(list, hadFocus);
  list.scrollTop = scroll;
}

function badgesFor(s, imported) {
  const out = [];
  if (s.archived) out.push(['보관됨']);
  if (s.kind === 'subagent') out.push(['서브에이전트']);
  if (s.remote) out.push(['원격']);
  if (s.kind === 'cowork') out.push(['Cowork']);
  if (s.kind === 'cli') out.push(['CLI']);
  if (!s.hasTranscript) out.push(['대화 기록 없음']);
  if (imported) out.push(['이관됨', 'ok']);
  return out.map(([text, cls]) => h('span', { class: cls ? `badge ${cls}` : 'badge', text }));
}

function sourceRow(s, imported) {
  const on = selected.has(s.key);
  const viewing = preview?.side === 'source' && preview.key === s.key;
  const row = h('div', { class: `row${on ? ' sel' : ''}${viewing ? ' viewing' : ''}${s.hasTranscript ? '' : ' off'}`, dataset: { key: s.key } });
  if (s.hasTranscript) {
    const cb = h('input', { class: 'cb', type: 'checkbox', tabindex: '-1', 'aria-label': `${s.title} 선택` });
    cb.checked = on;
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      anchorKey = s.key;
      setSelected(s.key, cb.checked);
    });
    row.append(cb);
  } else {
    row.append(h('span', { class: 'cb cb-ghost', 'aria-hidden': 'true' }));
  }
  row.append(
    h(
      'div',
      { class: 'rtx' },
      h('div', { class: 'rt', text: s.title }),
      h('div', { class: 'rm' }, h('span', { text: relTime(s.updatedAt), title: formatDateTime(s.updatedAt) }), h('span', { class: 'sep' }), h('span', { text: s.accountLabel }), badgesFor(s, imported.has(s.key))),
    ),
  );
  if (!s.hasTranscript) {
    row.title = '대화 기록이 없어 가져올 수 없습니다';
    return row;
  }
  row.dataset.focus = `s:${s.key}`;
  row.tabIndex = -1;
  row.append(iconBtn('eye', '미리보기 (Enter)', () => openPreview('source', s), { cls: 'peek' }));
  row.addEventListener('click', (e) => onRowClick(e, s));
  row.addEventListener('dblclick', () => openPreview('source', s));
  row.addEventListener('focus', () => setFocus(`s:${s.key}`));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      openPreview('source', s);
    } else if (e.key === ' ') {
      e.preventDefault();
      anchorKey = s.key;
      setSelected(s.key, !selected.has(s.key));
    }
  });
  row.draggable = true;
  row.addEventListener('dragstart', (e) => startDrag(e, selected.has(s.key) ? selectedSessions() : [s], row, s));
  row.addEventListener('dragend', endDrag);
  return row;
}

// 파일 탐색기처럼: 클릭 = 이 세션만 선택, Ctrl+클릭 = 추가/빼기, Shift+클릭 = 범위. 미리보기가 열려 있으면 따라간다.
function onRowClick(e, s) {
  focusKey = `s:${s.key}`;
  if (e.shiftKey && anchorKey) {
    const a = visibleKeys.indexOf(anchorKey);
    const b = visibleKeys.indexOf(s.key);
    if (a >= 0 && b >= 0) for (const k of visibleKeys.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(k);
    renderSource();
    return;
  }
  anchorKey = s.key;
  if (e.ctrlKey || e.metaKey) {
    setSelected(s.key, !selected.has(s.key));
    return;
  }
  selected.clear();
  selected.add(s.key);
  renderSource();
  if (preview) openPreview('source', s);
}

function setSelected(key, on) {
  on ? selected.add(key) : selected.delete(key);
  focusKey = `s:${key}`;
  renderSource();
}

function clearSelection() {
  selected.clear();
  renderSource();
}

function setFocus(key) {
  focusKey = key;
  for (const el of $('source-list').querySelectorAll('[data-focus]')) el.tabIndex = el.dataset.focus === key ? 0 : -1;
}

// 목록 전체가 탭 한 번에 들어오고 나가도록 포커스 가능한 항목은 하나만 tabindex=0 으로 둔다.
function applyRovingFocus(list, refocus) {
  const items = [...list.querySelectorAll('[data-focus]')];
  const cur = items.find((el) => el.dataset.focus === focusKey) ?? items[0];
  for (const el of items) el.tabIndex = el === cur ? 0 : -1;
  if (refocus && cur) cur.focus({ preventScroll: true });
}

function renderSourceFoot() {
  const foot = $('source-foot');
  foot.textContent = '';
  if (selected.size > 0) {
    foot.append(h('b', { text: `${selected.size}개 선택됨` }), h('span', { text: '·' }), h('button', { class: 'link-btn', type: 'button', onclick: clearSelection }, '선택 해제'));
    return;
  }
  const total = allSourceSessions().length;
  foot.append(icon('info'), h('span', { text: `${total ? `${total}개 · ` : ''}클릭해서 고르고 오른쪽으로 끌어다 놓으세요. 더블클릭하면 미리보기` }));
}

// --- 끌어다 놓기 -------------------------------------------------------------

function startDrag(e, sessions, el, single) {
  if (busy || sessions.length === 0) {
    e.preventDefault();
    return;
  }
  // 선택하지 않은 행을 끌면 그 행만 선택한다 — 끌고 있는 요소를 다시 그리면 끌기가 취소되므로 표시만 바꾼다.
  if (single && !selected.has(single.key)) {
    selected.clear();
    selected.add(single.key);
    for (const r of $('source-list').querySelectorAll('.row')) {
      const on = r.dataset.key === single.key;
      r.classList.toggle('sel', on);
      const cb = r.querySelector('input.cb');
      if (cb) cb.checked = on;
    }
    renderSourceFoot();
    renderGo();
  }
  drag = { sessions };
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('application/x-aab-sessions', sessions.map((s) => s.key).join('\n'));
  const ghost = h('div', { class: 'drag-ghost' }, icon('layers'), `세션 ${sessions.length}개`);
  document.body.append(ghost);
  e.dataTransfer.setDragImage(ghost, 14, 14);
  setTimeout(() => ghost.remove(), 0);
  el.classList.add('dragging');
  // dragstart 처리 중에 레이아웃을 바꾸면 끌기가 바로 취소될 수 있어 다음 틱에 받는 쪽을 드러낸다.
  setTimeout(() => {
    if (!drag) return;
    closePreview();
    document.body.classList.add('dragging');
    $('dropzone-text').textContent = target ? `여기에 놓아 가져오기 · ${target.title}` : '받을 곳이 없습니다';
  }, 0);
}

function endDrag(e) {
  e.currentTarget.classList.remove('dragging');
  document.body.classList.remove('dragging');
  $('target-pane').classList.remove('over');
  $('dropzone-text').textContent = '세션을 여기로 끌어다 놓으세요';
  drag = null;
}

{
  const pane = $('target-pane');
  pane.addEventListener('dragenter', (e) => {
    if (!drag || !target) return;
    e.preventDefault();
    pane.classList.add('over');
  });
  pane.addEventListener('dragover', (e) => {
    if (!drag || !target) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  pane.addEventListener('dragleave', (e) => {
    if (!pane.contains(e.relatedTarget)) pane.classList.remove('over');
  });
  pane.addEventListener('drop', (e) => {
    if (!drag || !target) return;
    e.preventDefault();
    const sessions = drag.sessions;
    pane.classList.remove('over');
    document.body.classList.remove('dragging');
    openImportDialog(sessions);
  });
}

// --- 받는 쪽 ---------------------------------------------------------------

// 받을 곳 목록: Claude 세션은 ChatGPT(이 PC 의 Codex)로, 두 도구 모두 Claude 계정(현재 로그인 + 등록 계정)으로.
// libKey 는 라이브러리의 계정 키 — 받는 쪽 목록을 그 계정 세션으로 거를 때 쓴다(미등록 현재 로그인은 목록을 받은 뒤 찾는다).
function targetOptions() {
  if (!state) return [];
  const out = [];
  // Codex 세션은 계정이 아니라 PC 에 저장되고 앱도 계정별로 나누지 않는다 — 어느 GPT 계정으로 로그인해도 보인다.
  if (src.tool === 'claude') out.push({ key: 'codex', tool: 'codex', title: 'ChatGPT · 모든 계정', desc: '이 PC의 Codex — 어느 GPT 계정으로 로그인해도 보입니다', libKey: null });
  const cur = state.tools.claude.current;
  const loggedIn = !cur.error;
  const claudeRows = state.accounts.filter((a) => a.tool === 'claude');
  const curRow = loggedIn && cur.registeredLabel ? claudeRows.find((a) => a.label === cur.registeredLabel) : undefined;
  if (loggedIn) {
    out.push({
      key: `current:${cur.accountId}`,
      tool: 'claude',
      accountKey: 'current',
      title: cur.registeredLabel ? `Claude · ${cur.registeredLabel}` : 'Claude',
      desc: `현재 로그인 · ${cur.email ?? cur.accountId}`,
      libKey: curRow ? `acct:${curRow.id}` : null,
    });
  }
  for (const a of claudeRows) {
    if (a === curRow) continue;
    out.push({ key: `acct:${a.id}`, tool: 'claude', accountKey: `acct:${a.id}`, title: `Claude · ${a.label}`, desc: a.email ?? '저장된 계정', libKey: `acct:${a.id}` });
  }
  return out;
}

// 받는 쪽을 유지할 수 있으면 유지하고, 아니면 첫 항목으로. preferKey 는 target key 나 라이브러리 계정 키(acct:N).
function ensureTarget(preferKey) {
  const opts = targetOptions();
  const prevKey = target?.key;
  target =
    (preferKey && opts.find((o) => o.key === preferKey || (o.libKey && o.libKey === preferKey))) ||
    (target && opts.find((o) => o.key === target.key)) ||
    opts[0] ||
    null;
  renderTargetSelect();
  renderGo();
  if (target?.key !== prevKey) dest.fresh = new Set();
  if (target?.key !== prevKey || (target && !dest.data && !dest.loading)) targetRefresh();
}

function renderTargetSelect() {
  const btn = $('target-select');
  btn.textContent = '';
  if (!target) {
    btn.append(
      icon('circle-alert'),
      h('span', { class: 'sel-text' }, h('span', { text: state ? '받을 곳이 없습니다' : '불러오는 중…' }), h('small', { text: state ? 'Claude에 로그인하거나 계정을 등록하세요' : '' })),
      icon('chevron-down'),
    );
    return;
  }
  btn.append(tile(target.tool), h('span', { class: 'sel-text' }, h('span', { text: target.title }), h('small', { text: target.desc })), icon('chevron-down'));
}

function targetMenu() {
  const opts = targetOptions();
  if (opts.length === 0) return [h('div', { class: 'mi-note' }, icon('info'), h('span', { text: '받을 곳이 없습니다. Claude에 로그인하거나 계정을 등록하세요.' }))];
  return [
    h('div', { class: 'menu-label', text: '받을 곳' }),
    ...opts.map((o) =>
      menuItem(
        `opt${o.key === target?.key ? ' on' : ''}`,
        [tile(o.tool), h('span', { class: 'mi-text' }, h('b', { text: o.title }), h('small', { text: o.desc })), h('span', { class: 'mi-sel' }, o.key === target?.key ? icon('check') : null)],
        () => {
          closePopover({ refocus: true });
          if (o.key === target?.key) return;
          target = o;
          dest.fresh = new Set();
          renderTargetSelect();
          renderGo();
          targetRefresh();
        },
      ),
    ),
  ];
}

async function targetRefresh() {
  if (!target) {
    dest.data = null;
    renderTargetList();
    return;
  }
  const token = ++dest.token;
  const tool = target.tool;
  dest.loading = true;
  if (!dest.data || dest.data.tool !== tool) {
    dest.data = null;
    renderTargetList();
  }
  try {
    const r = await window.bridge.request('libraryList', { tool });
    if (token !== dest.token) return;
    dest.data = { ...cleanTitles(r), tool };
    dest.error = null;
  } catch (e) {
    if (token !== dest.token) return;
    dest.data = null;
    dest.error = e.message;
  } finally {
    if (token === dest.token) {
      dest.loading = false;
      renderTargetList();
    }
  }
}

function destSessions() {
  if (!dest.data || !target || dest.data.tool !== target.tool) return [];
  const all = dest.data.projects.flatMap((p) => p.sessions.map((s) => ({ ...s, projectName: p.name })));
  if (target.tool === 'codex') return all; // Codex 세션은 GPT 계정과 상관없이 이 PC 에서 공유된다
  const cur = state.tools.claude.current;
  const libKey = target.libKey ?? dest.data.accounts.find((a) => a.key.startsWith(`unreg:${cur.accountId}/`))?.key;
  return libKey ? all.filter((s) => s.accountKey === libKey) : [];
}

function renderTargetList() {
  const list = $('target-list');
  list.textContent = '';
  if (!target) return;
  if (!dest.data) {
    list.append(dest.error ? emptyEl('triangle-alert', `목록을 불러오지 못했습니다: ${dest.error}`) : loadingEl());
    return;
  }
  const sessions = destSessions();
  if (sessions.length === 0) {
    list.append(emptyEl('message-square-text', '아직 세션이 없습니다'));
    return;
  }
  // 방금 가져온 세션을 맨 위에, 나머지는 프로젝트별로
  const fresh = sessions.filter((s) => dest.fresh.has(s.sessionId));
  if (fresh.length) {
    list.append(h('div', { class: 'grp static' }, icon('download', 'fold'), h('span', { class: 'name', text: '방금 가져옴' }), h('span', { class: 'n', text: String(fresh.length) })));
    for (const s of fresh) list.append(destRow(s));
  }
  const groups = new Map();
  for (const s of sessions) {
    if (dest.fresh.has(s.sessionId)) continue;
    const g = groups.get(s.projectName) ?? [];
    g.push(s);
    groups.set(s.projectName, g);
  }
  for (const [name, group] of groups) {
    list.append(h('div', { class: 'grp static' }, icon('folder', 'fold'), h('span', { class: 'name', text: name }), h('span', { class: 'n', text: String(group.length) })));
    for (const s of group) list.append(destRow(s));
  }
}

function destRow(s) {
  const fresh = dest.fresh.has(s.sessionId);
  const origin = /^\[(Codex|Claude)\]\s/.exec(s.title)?.[1];
  const viewing = preview?.side === 'target' && preview.key === s.key;
  const row = h(
    'div',
    { class: `row dest${fresh ? ' fresh' : ''}${viewing ? ' viewing' : ''}`, dataset: { key: s.key } },
    origin ? tile(origin === 'Codex' ? 'codex' : 'claude', 'sm') : h('span', { class: 'tile tile-sm', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'rtx' },
      h('div', { class: 'rt', text: s.title }),
      h('div', { class: 'rm' }, h('span', { text: relTime(s.updatedAt), title: formatDateTime(s.updatedAt) }), fresh ? h('span', { class: 'badge new', text: '방금 가져옴' }) : null),
    ),
  );
  if (s.hasTranscript) {
    row.tabIndex = 0;
    row.title = '누르면 대화를 미리 봅니다';
    row.addEventListener('click', () => openPreview('target', s));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPreview('target', s);
      }
    });
  }
  return row;
}

// --- 가운데: 가져오기 · 방향 바꾸기 -------------------------------------------

function renderGo() {
  const n = selected.size;
  const go = $('go-btn');
  go.disabled = busy || n === 0 || !target;
  const em = $('go-count');
  em.textContent = String(n);
  em.classList.toggle('hidden', n === 0);
  go.title = !target ? '받을 곳을 먼저 고르세요' : n === 0 ? '보낼 세션을 고르세요' : `선택한 세션 ${n}개 가져오기 → ${target.title} (Ctrl+Enter)`;
}

// 보내는 쪽과 받는 쪽을 맞바꾼다 — 예) ChatGPT → Claude · A  ⇄  Claude · A → ChatGPT
function swapSides() {
  if (busy || !target) return;
  if (src.tool === 'codex') {
    setSourceTool('claude', { account: target.libKey ?? '', targetKey: 'codex' });
  } else if (target.tool === 'codex') {
    setSourceTool('codex', { targetKey: src.account || '' });
  } else {
    const from = src.account;
    setSourceTool('claude', { account: target.libKey ?? '', targetKey: from || '' });
  }
}

// --- 미리보기 서랍 ---------------------------------------------------------

function markViewing() {
  for (const r of document.querySelectorAll('.row.viewing')) r.classList.remove('viewing');
  if (!preview) return;
  const list = preview.side === 'source' ? $('source-list') : $('target-list');
  for (const r of list.querySelectorAll('.row')) if (r.dataset.key === preview.key) r.classList.add('viewing');
}

function closePreview() {
  if (!preview) return;
  preview = null;
  $('preview').classList.add('hidden');
  $('preview').textContent = '';
  markViewing();
}

function previewMeta(s, session) {
  const folder = s.projectName ?? s.cwd?.split(/[\\/]/).filter(Boolean).pop();
  return h(
    'div',
    { class: 'meta' },
    folder ? h('span', { class: 'm', title: s.cwd || null }, icon('folder'), folder) : null,
    session?.model ? h('span', { class: 'm' }, icon('cpu'), session.model) : null,
    s.gitBranch ? h('span', { class: 'm' }, icon('git-branch'), s.gitBranch) : null,
    h('span', { text: [relTime(s.updatedAt), s.accountLabel, session ? `도구 호출 ${session.stats.toolCalls.toLocaleString('ko-KR')}` : null].filter(Boolean).join(' · ') }),
  );
}

async function openPreview(side, s) {
  const tool = side === 'source' ? src.tool : target?.tool;
  if (!tool) return;
  const token = (preview?.token ?? 0) + 1;
  preview = { side, key: s.key, tool, token };
  markViewing();
  const drawer = $('preview');
  drawer.textContent = '';
  drawer.classList.remove('hidden');
  const meta = previewMeta(s);
  const actions = h('div', { class: 'pv-actions' });
  if (side === 'source' && target) {
    actions.append(h('button', { class: 'btn primary action-btn', type: 'button', disabled: busy, onclick: () => openImportDialog([s]) }, tile(target.tool, 'sm'), `${TOOL_NAMES[target.tool]}로 가져오기`));
  }
  actions.append(iconBtn('x', '닫기 (Esc)', closePreview, { focusable: true }));
  const body = h('div', { class: 'pv-body' }, loadingEl('대화를 불러오는 중…'));
  // 첫 메시지 전체가 제목인 세션도 있다 — 두 줄까지만 보이고(CSS) 전체는 툴팁으로
  const heading = h('h3', { text: s.title, title: s.title.length > 500 ? `${s.title.slice(0, 500)}…` : s.title });
  drawer.append(h('div', { class: 'pv-head' }, h('div', { class: 'pv-titles' }, heading, meta), actions), body);
  try {
    const r = await window.bridge.request('librarySession', { tool, key: s.key });
    if (preview?.token !== token) return;
    meta.replaceWith(previewMeta(s, r.session));
    body.textContent = '';
    body.append(renderThread(r.session, tool));
    if (r.blocksTruncated || r.messagesTruncated) body.append(h('p', { class: 'hint', text: r.messagesTruncated ? '앞 300개 메시지만 표시합니다' : '블록이 많아 앞 2000개만 표시합니다' }));
  } catch (e) {
    if (preview?.token !== token) return;
    body.textContent = '';
    body.append(emptyEl('triangle-alert', `대화를 불러오지 못했습니다: ${e.message}`));
  }
}

// 도구 호출 입력에서 한 줄 요약을 뽑는다 — 셸 명령이면 명령을, 아니면 첫 줄을.
function toolSummary(input) {
  const s = String(input);
  try {
    const o = JSON.parse(s);
    const cmd = o.cmd ?? o.command ?? o.file_path ?? o.path ?? o.query ?? o.pattern ?? o.url;
    if (cmd) return Array.isArray(cmd) ? cmd.join(' ') : String(cmd);
  } catch {
    // JSON 이 아니면 아래에서
  }
  // Codex 의 exec 는 JSON 이 아니라 코드 문자열(text(await tools.exec_command({cmd:"…"})))로 온다
  const m = /\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s);
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1];
    }
  }
  return s.split('\n')[0];
}

// 대화 본문은 대부분 마크다운이다. 해석은 marked(gui/vendor, MIT)의 lexer 로 하고 DOM 은 직접 만든다 — 본문 속 HTML 은
// 실행하지 않고 글자 그대로 보이며, 링크는 앱 창이 그 주소로 넘어가지 않게 누를 수 없는 글자(주소는 툴팁)로 둔다.
function mdInline(tokens) {
  return (tokens ?? []).map((t) => {
    switch (t.type) {
      case 'strong':
        return h('strong', null, mdInline(t.tokens));
      case 'em':
        return h('em', null, mdInline(t.tokens));
      case 'del':
        return h('del', null, mdInline(t.tokens));
      case 'codespan':
        return h('code', { text: t.text });
      case 'br':
        return h('br');
      case 'link':
        return h('span', { class: 'md-link', title: t.href }, mdInline(t.tokens));
      case 'image':
        return h('span', { class: 'md-link', title: t.href, text: t.text ? `[이미지: ${t.text}]` : '[이미지]' });
      case 'text':
        return t.tokens ? mdInline(t.tokens) : t.text;
      default:
        return t.text ?? ''; // escape, html — 글자 그대로
    }
  });
}

function mdBlocks(tokens) {
  const aligned = (tag, cell, align) => h(tag, { class: align ? `al-${align}` : null }, mdInline(cell.tokens));
  return (tokens ?? []).map((t) => {
    switch (t.type) {
      case 'space':
      case 'def':
        return null;
      case 'heading':
        return h(`h${t.depth}`, null, mdInline(t.tokens));
      case 'paragraph':
        return h('p', null, mdInline(t.tokens));
      case 'text': // 촘촘한 목록 항목의 글자
        return t.tokens ? mdInline(t.tokens) : t.text;
      case 'code':
        return h('pre', { class: 'md-code' }, h('code', { text: t.text }));
      case 'blockquote':
        return h('blockquote', null, mdBlocks(t.tokens));
      case 'hr':
        return h('hr');
      case 'list':
        return h(
          t.ordered ? 'ol' : 'ul',
          { start: t.ordered && t.start !== 1 ? t.start : null },
          t.items.map((it) => h('li', { class: it.task ? 'task' : null }, mdBlocks(it.tokens))),
        );
      case 'checkbox':
        return h('input', { type: 'checkbox', disabled: true, checked: t.checked });
      case 'table':
        return h(
          'div',
          { class: 'md-table' },
          h(
            'table',
            null,
            h('thead', null, h('tr', null, t.header.map((c, i) => aligned('th', c, t.align[i])))),
            h('tbody', null, t.rows.map((r) => h('tr', null, r.map((c, i) => aligned('td', c, t.align[i]))))),
          ),
        );
      default:
        return t.text ? h('p', { text: t.text }) : null; // html 블록 — 글자 그대로
    }
  });
}

function markdown(text) {
  const src = cleanText(text);
  try {
    return h('div', { class: 'md' }, mdBlocks(window.marked.lexer(src, { gfm: true, breaks: true })));
  } catch {
    return h('div', { class: 'md plain', text: src }); // 해석 실패(지나치게 깊은 중첩 등) — 원문 그대로
  }
}

function toolRow(b) {
  return h(
    'details',
    { class: `toolrow${b.isError ? ' err' : ''}` },
    h('summary', null, icon('terminal'), h('span', { text: b.name }), h('code', { text: toolSummary(b.input).slice(0, 160) })),
    h('pre', { text: b.input }),
    b.output !== undefined ? h('pre', { text: b.output }) : null,
  );
}

// 이어진 도구 호출은 한 줄("도구 호출 N개")로 접어 두고 누르면 펼친다
function toolGroup(tools) {
  if (tools.length === 1) return toolRow(tools[0]);
  const errors = tools.filter((b) => b.isError).length;
  return h(
    'details',
    { class: 'toolgroup' },
    h(
      'summary',
      null,
      icon('terminal'),
      h('b', { text: `도구 호출 ${tools.length}개` }),
      h('span', { class: 'names', text: [...new Set(tools.map((b) => b.name))].join(' · ') }),
      errors ? h('span', { class: 'errs', text: `오류 ${errors}` }) : null,
      icon('chevron-right', 'chev'),
    ),
    h('div', { class: 'toolgroup-list' }, tools.map(toolRow)),
  );
}

// 붙여넣은 대화처럼 아주 긴 사용자 메시지는 열 줄만 보이고 펼칠 수 있게
function userBubble(text) {
  const body = h('div', { class: 'u-text', text: cleanText(text) });
  if (text.length <= 900 && text.split('\n').length <= 16) return h('div', { class: 'msg-u' }, body);
  const more = h('button', { class: 'u-more', type: 'button', text: '전체 보기' });
  const el = h('div', { class: 'msg-u folded' }, body, more);
  more.addEventListener('click', () => {
    more.textContent = el.classList.toggle('folded') ? '전체 보기' : '접기';
  });
  return el;
}

function renderThread(session, tool) {
  const t = h('div', { class: 'thread' });
  let tools = [];
  const flushTools = () => {
    if (tools.length) t.append(toolGroup(tools));
    tools = [];
  };
  for (const m of session.messages) {
    for (const b of m.blocks) {
      if (b.kind === 'tool') {
        tools.push(b);
        continue;
      }
      flushTools();
      if (b.kind === 'compactSummary') {
        t.append(h('div', { class: 'note-block' }, h('b', { text: '이전 대화 요약' }), markdown(b.text)));
      } else if (b.kind === 'importNotice') {
        t.append(h('div', { class: 'note-block', text: `${b.fromTool === 'claude' ? 'Claude' : 'Codex'}의 '${b.title ?? '(제목 없음)'}' 세션에서 가져왔습니다 (${b.createdAt})` }));
      } else if (b.kind === 'image') {
        // 붙인 이미지 — 누르면 서랍 폭까지 크게 본다
        const img = h('img', { src: `data:${b.mediaType};base64,${b.data}`, alt: '첨부한 이미지', title: '누르면 크게 봅니다' });
        const box = h('div', { class: `msg-img${m.role === 'user' ? ' u' : ''}` }, img);
        img.addEventListener('click', () => box.classList.toggle('big'));
        t.append(box);
      } else if (m.role === 'user') {
        t.append(userBubble(b.text)); // 사용자 메시지는 원래 앱들처럼 입력한 그대로
      } else {
        t.append(h('div', { class: 'msg-a' }, tile(tool, 'sm'), markdown(b.text)));
      }
    }
  }
  flushTools();
  if (!t.childElementCount) t.append(emptyEl('message-square-text', '표시할 대화가 없습니다'));
  return t;
}

// --- 가져오기 확인 ---------------------------------------------------------

const IMPORT_LABELS = { imported: '가져옴', forked: '복사함', skipped: '건너뜀', failed: '실패' };

function routeEnd(tool, title, sub) {
  return h('div', { class: 'end' }, tile(tool, 'lg'), h('span', null, h('span', { text: title }), sub ? h('small', { text: sub }) : null));
}

function instructionsText(r) {
  if (r.status === 'created') return `지침 파일 만듦: ${r.path}`;
  if (r.status === 'exists') return `지침 파일 이미 있음: ${r.path}`;
  return `지침 파일 건너뜀: ${r.path}${r.reason ? ` (${r.reason})` : ''}`;
}

// src/main/core/work-folder.ts 와 같은 규칙: Codex 가 대화마다 만드는 '<문서>\Codex\<날짜>\<이름>' 폴더
const isCodexChatFolder = (cwd) => /^(.*[\\/])Codex[\\/]\d{4}-\d{2}-\d{2}[\\/][^\\/]+$/i.test(String(cwd ?? '').replace(/^\\\\\?\\/, ''));

function folderCopyText(r) {
  if (r.status === 'copied') return `작업 폴더 복사함: ${r.to}`;
  if (r.status === 'reused') return `작업 폴더: 앞 세션과 같은 복사본 (${r.to})`;
  return `작업 폴더 복사 ${r.status === 'failed' ? '실패' : '건너뜀'}${r.reason ? ` (${r.reason})` : ''} — 원래 폴더를 같이 씁니다`;
}

function openImportDialog(sessions) {
  if (sessions.length === 0) return;
  if (!target) {
    toast('warning', '받을 곳이 없습니다', 'Claude에 로그인하거나 계정을 등록하세요.');
    return;
  }
  const srcTool = src.tool;
  const tgt = target;
  const n = sessions.length;
  const fork = srcTool === 'claude' && tgt.tool === 'claude';
  const blocked = fork && !sessions.every((s) => s.kind === 'code') ? 'Cowork·CLI 세션은 Claude 계정 간 공유를 지원하지 않습니다. ChatGPT로 보내는 것만 됩니다.' : null;

  const radio = (value, text, checked) => {
    const input = h('input', { type: 'radio', name: 'import-policy', value });
    input.checked = Boolean(checked);
    return { input, label: h('label', { class: 'radio' }, input, text) };
  };
  const skip = radio('skip', '건너뛰기', true);
  const copy = radio('copy', '새 복사본 만들기');
  const instr = h('input', { class: 'cb', type: 'checkbox' });
  // GPT 대화 폴더(프로젝트 없이 시작한 대화의 폴더)가 있는 세션을 Claude 로 보낼 때만 보인다.
  const folderOpt = srcTool === 'codex' && tgt.tool === 'claude' && sessions.some((s) => isCodexChatFolder(s.cwd));
  const folder = h('input', { class: 'cb', type: 'checkbox' });
  // Claude 계정 간 복사(포크)는 대화 파일을 그대로 복사하므로 도구 기록 옵션이 필요 없다.
  const fullLog = h('input', { class: 'cb', type: 'checkbox' });
  const options = h(
    'div',
    null,
    h('div', { class: 'opt-group' }, h('b', { text: '이미 가져온 세션이면' }), skip.label, copy.label),
    h('div', { class: 'opt-group' }, h('label', { class: 'check' }, instr, '지침 파일도 복사 (AGENTS.md ↔ CLAUDE.md, 하위 저장소 포함)')),
    fork
      ? null
      : h(
          'div',
          { class: 'opt-group' },
          h('label', { class: 'check' }, fullLog, '도구 실행 기록 전부 넣기'),
          h('p', { class: 'opt-hint', text: '기본은 실행한 명령·파일을 한 줄씩, 실패한 경우에만 결과 앞부분을 옮깁니다. 켜면 입력과 결과를 모두 옮겨 대화가 3~5배 길어집니다.' }),
        ),
    folderOpt
      ? h(
          'div',
          { class: 'opt-group' },
          h('label', { class: 'check' }, folder, 'GPT 대화 폴더도 복사해 따로 쓰기'),
          h('p', { class: 'opt-hint', text: 'Documents\\Codex\\… 폴더를 git 저장소째 Documents\\Claude\\… 로 복사합니다. 원본은 그대로 두고, 이후 두 폴더는 따로 바뀝니다. 프로젝트 폴더는 복사하지 않습니다.' }),
        )
      : null,
  );
  const progressEl = h('div', { class: 'progress-line hidden' }, h('span', { class: 'spinner' }), h('span', { text: '준비 중…' }));
  const resultsEl = h('ul', { class: 'results hidden' });
  const cancelBtn = h('button', { class: 'btn', type: 'button' }, '취소');
  const runBtn = h('button', { class: 'btn primary', type: 'button' }, `${n}개 가져오기`);
  runBtn.disabled = Boolean(blocked);

  let running = false;
  const close = () => {
    if (!running) closeModal();
  };
  cancelBtn.addEventListener('click', close);

  runBtn.addEventListener('click', async () => {
    running = true;
    runBtn.disabled = true;
    cancelBtn.disabled = true;
    for (const el of options.querySelectorAll('input')) el.disabled = true;
    progressEl.classList.remove('hidden');
    const requestId = window.bridge.nextRequestId();
    activeRequestId = requestId;
    activeProgress = {
      tool: tgt.tool,
      prefix: '가져오는 중',
      onStep: (step) => {
        progressEl.lastChild.textContent = step;
      },
    };
    setBusy(true);
    setStatus('progress', '가져오는 중');
    renderSwitchers();
    const titleOf = new Map(sessions.map((s) => [s.key, s.title]));
    try {
      const r = await window.bridge.request(
        'importSessions',
        {
          srcTool,
          keys: sessions.map((s) => s.key),
          target: tgt.tool === 'codex' ? { tool: 'codex' } : { tool: 'claude', accountKey: tgt.accountKey },
          policy: copy.input.checked ? 'copy' : 'skip',
          copyInstructions: instr.checked,
          copyWorkFolder: folderOpt && folder.checked,
          fullToolLog: !fork && fullLog.checked,
        },
        requestId,
      );
      if (r.status === 'done') {
        // 가져오긴 했지만 작업 폴더를 복사하지 못한 세션 — GPT 폴더를 같이 쓰게 되므로 성공과 구분해 알린다
        const copyMissed = (x) => x.folderCopy?.status === 'failed' || x.folderCopy?.status === 'skipped';
        for (const x of r.results) {
          const ok = x.status === 'imported' || x.status === 'forked';
          const warn = ok && copyMissed(x);
          resultsEl.append(
            h(
              'li',
              { class: warn ? 'warn' : ok ? 'ok' : x.status === 'failed' ? 'fail' : 'skip' },
              icon(warn ? 'triangle-alert' : ok ? 'circle-check' : x.status === 'failed' ? 'circle-alert' : 'info'),
              h(
                'div',
                { class: 'tx' },
                h('span', { text: `${titleOf.get(x.key) ?? x.key} — ${IMPORT_LABELS[x.status] ?? x.status}` }),
                x.reason ? h('small', { text: x.reason }) : null,
                x.instructions ? h('small', { text: instructionsText(x.instructions) }) : null,
                (x.subInstructions ?? []).map((s) => h('small', { text: instructionsText(s) })),
                x.folderCopy ? h('small', { text: folderCopyText(x.folderCopy) }) : null,
              ),
            ),
          );
          log(x.status === 'failed' ? 'error' : warn ? 'warning' : 'info', `가져오기 — ${titleOf.get(x.key) ?? x.key}: ${IMPORT_LABELS[x.status] ?? x.status}${x.reason ? ` (${x.reason})` : ''}${x.folderCopy ? ` · ${folderCopyText(x.folderCopy)}` : ''}`);
        }
        dest.fresh = new Set(r.results.map((x) => x.dstSessionId).filter(Boolean));
        const count = (st) => r.results.filter((x) => x.status === st).length;
        const done = count('imported') + count('forked');
        const failed = count('failed');
        const summary = [tgt.title, `가져옴 ${done}`, count('skipped') ? `건너뜀 ${count('skipped')}` : null, failed ? `실패 ${failed}` : null].filter(Boolean).join(' · ');
        const missed = r.results.filter((x) => (x.status === 'imported' || x.status === 'forked') && copyMissed(x)).length;
        if (failed) report('warning', `세션 ${failed}개를 가져오지 못했습니다`, summary);
        else if (missed) report('warning', `세션 ${done}개를 가져왔지만 작업 폴더 ${missed}개는 복사하지 못했습니다`, `그 세션은 GPT 대화 폴더를 같이 씁니다 — ${summary}`);
        else report('success', `세션 ${done}개를 가져왔습니다`, summary);
        if (r.launchWarning) report('warning', '앱이 다시 실행되지 않았습니다', r.launchWarning);
        selected.clear();
      } else {
        resultsEl.append(h('li', { class: 'fail' }, icon('circle-alert'), h('div', { class: 'tx', text: `취소됨: ${r.reason}` })));
        report('warning', '가져오기를 취소했습니다', r.reason);
      }
    } catch (e) {
      resultsEl.append(h('li', { class: 'fail' }, icon('circle-alert'), h('div', { class: 'tx', text: e.message })));
      report('error', '가져오지 못했습니다', e.message);
    } finally {
      running = false;
      activeProgress = null;
      activeRequestId = null;
      setBusy(false);
      progressEl.classList.add('hidden');
      resultsEl.classList.remove('hidden');
      runBtn.remove();
      cancelBtn.disabled = false;
      cancelBtn.textContent = '닫기';
      cancelBtn.className = 'btn primary';
      cancelBtn.focus();
      renderSwitchers();
      await refreshState();
      sourceRefresh();
      targetRefresh();
    }
  });

  openModal(
    dialogParts(
      `세션 ${n}개를 가져올까요?`,
      [
        h('div', { class: 'route' }, routeEnd(srcTool, TOOL_NAMES[srcTool], `세션 ${n}개`), icon('arrow-right'), routeEnd(tgt.tool, tgt.title, tgt.desc)),
        h('ul', { class: 'titles' }, sessions.slice(0, 4).map((s) => h('li', { text: s.title })), n > 4 ? h('li', { class: 'more', text: `외 ${n - 4}개` }) : null),
        blocked ? h('div', { class: 'callout err' }, icon('circle-alert'), h('span', { text: blocked })) : null,
        fork && !blocked ? h('div', { class: 'callout' }, icon('info'), h('span', { text: '받는 계정에 복사본이 만들어지고, 원래 세션과는 따로 이어집니다.' })) : null,
        h('div', { class: 'callout' }, icon('shield-check'), h('span', { text: `원본은 그대로 둡니다. ${TOOL_NAMES[tgt.tool]} 앱이 켜져 있으면 종료했다가 다시 실행합니다.` })),
        options,
        progressEl,
        resultsEl,
      ],
      [cancelBtn, runBtn],
    ),
    { onCancel: close, wide: true },
  );
  (runBtn.disabled ? cancelBtn : runBtn).focus();
}

// --- 초기화 · 이벤트 ------------------------------------------------------

for (const tool of TOOLS) {
  const btn = $(`switcher-${tool}`);
  btn.addEventListener('click', () => {
    if (state) openPopover(btn, accountMenu(tool), { minWidth: 330 });
  });
}
$('source-account').addEventListener('click', (e) => openPopover(e.currentTarget, accountFilterMenu(), { align: 'end', minWidth: 200 }));
$('target-select').addEventListener('click', (e) => openPopover(e.currentTarget, targetMenu()));
$('source-search').addEventListener('input', () => renderSourceList());
$('source-refresh').addEventListener('click', () => sourceRefresh());
$('target-refresh').addEventListener('click', () => targetRefresh());
for (const [id, keyName] of [
  ['chip-subagents', 'subagents'],
  ['chip-archived', 'archived'],
]) {
  $(id).addEventListener('click', (e) => {
    src[keyName] = !src[keyName];
    e.currentTarget.setAttribute('aria-pressed', String(src[keyName]));
    sourceRefresh();
  });
}
$('go-btn').addEventListener('click', () => openImportDialog(selectedSessions()));
$('swap-btn').addEventListener('click', () => swapSides());
$('activity-btn').addEventListener('click', () => toggleActivity());
$('activity-close').addEventListener('click', () => toggleActivity(false));
$('statusbar').addEventListener('click', () => toggleActivity(true));
$('restore-btn').addEventListener('click', () => doRestore());

// 목록 안 이동: ↑/↓/Home/End (Enter = 미리보기, Space = 선택, ←/→ = 프로젝트 접기/펼치기)
$('source-list').addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = [...$('source-list').querySelectorAll('[data-focus]')];
  if (items.length === 0) return;
  const i = items.indexOf(document.activeElement);
  let next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1);
  next = Math.max(0, Math.min(items.length - 1, next));
  e.preventDefault();
  items[next].focus({ preventScroll: true });
  items[next].scrollIntoView({ block: 'nearest' });
});

// 전역 단축키 — 캡처 단계에서 받아 대화상자 입력칸의 Enter/Esc 처리와 겹치지 않게 한다.
document.addEventListener(
  'keydown',
  (e) => {
    if (!overlay.classList.contains('hidden')) {
      if (e.key === 'Escape' && modalCancel) {
        e.preventDefault();
        e.stopPropagation();
        modalCancel();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (pop) closePopover({ refocus: true });
      else if (preview) closePreview();
      else if (!$('activity').classList.contains('hidden')) toggleActivity(false);
      else if (e.target === $('source-search') && $('source-search').value) {
        $('source-search').value = '';
        renderSourceList();
      } else if (selected.size > 0) clearSelection();
      else return;
      e.preventDefault();
      return;
    }
    if (pop) return;
    const inList = document.activeElement === document.body || $('source-list').contains(document.activeElement);
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('source-search').focus();
      $('source-search').select();
    } else if (e.key === 'F5') {
      e.preventDefault();
      refreshAll();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'a' && inList) {
      e.preventDefault();
      for (const k of visibleKeys) selected.add(k);
      renderSource();
    } else if (e.ctrlKey && e.key === 'Enter' && !$('go-btn').disabled) {
      e.preventDefault();
      openImportDialog(selectedSessions());
    }
  },
  true,
);

async function refreshAll() {
  await refreshState();
  sourceRefresh();
  targetRefresh();
}

// 다른 앱에서 돌아오면 계정 상태와 목록을 새로 읽는다 (작업 중·대화상자·끌기 중에는 건너뜀).
let lastFocusRefresh = 0;
window.addEventListener('focus', () => {
  if (busy || drag || !overlay.classList.contains('hidden') || Date.now() - lastFocusRefresh < 3000) return;
  lastFocusRefresh = Date.now();
  refreshAll();
});

setInterval(renderStatusTime, 30000);

setStatus('info', '보낼 세션을 고른 뒤 오른쪽으로 끌어다 놓거나 가운데 화살표를 누르세요', { sticky: true });
renderSwitchers();
renderSourceTool();
renderTargetSelect();
renderSource();
loadAppIcons();
refreshState().then(() => sourceRefresh());
