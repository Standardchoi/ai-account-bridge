// 설명서 캡처용 예시 데이터 — 실제 계정·세션 대신 화면에 넣는다 (렌더러 전역 상태를 덮어씀)
(() => {
  lastFocusRefresh = Date.now() + 1e12; // 창 포커스 시 실제 데이터로 새로고침하지 않게
  src.token += 1000; dest.token += 1000; // 진행 중인 실제 조회 응답은 버리게
  const now = Date.now(), min = 60e3, hr = 60 * min, day = 24 * hr;
  state = {
    tools: {
      codex: { current: { email: 'work@company.com', accountId: 'demo-a1', registeredLabel: '회사 계정' } },
      claude: { current: { email: 'me@example.com', accountId: 'demo-c1', registeredLabel: '개인' } },
    },
    accounts: [
      { id: 1, tool: 'codex', label: '회사 계정', email: 'work@company.com', status: 'ok', scope: 'auth' },
      { id: 2, tool: 'codex', label: '개인 계정', email: 'me@example.com', status: 'ok', scope: 'auth' },
      { id: 3, tool: 'claude', label: '개인', email: 'me@example.com', status: 'ok', scope: 'auth' },
      { id: 4, tool: 'claude', label: '회사', email: 'work@company.com', status: 'ok', scope: 'auth' },
    ],
    paths: { appDataDir: '~\.ai-account-bridge', claudeDesktop: '~\AppData\Local\Packages\Claude_…\Claude' },
  };
  const S = (key, title, ago, account, extra = {}) => ({ key: `codex:${key}`, tool: 'codex', sessionId: key, title, cwd: extra.cwd ?? 'C:\work\web-shop', createdAt: now - ago - hr, updatedAt: now - ago, archived: false, kind: 'code', hasTranscript: true, accountKey: account === '미분류' ? 'unassigned' : `acct:${account === '회사 계정' ? 1 : 2}`, accountLabel: account, ...extra });
  src.tool = 'codex'; src.account = ''; src.loading = false; src.error = null;
  src.data = {
    accounts: [{ key: 'acct:1', label: '회사 계정' }, { key: 'acct:2', label: '개인 계정' }, { key: 'unassigned', label: '미분류' }],
    imported: ['codex:s3'],
    projects: [
      { key: 'proj:web', name: 'web-shop', path: 'C:\work\web-shop', sessions: [
        S('s1', '장바구니 결제 흐름 리팩터링', 12 * min, '회사 계정'),
        S('s2', '상품 목록 API 페이지네이션 추가', 2 * hr, '회사 계정'),
        S('s3', '로그인 화면 접근성 점검', 1 * day, '개인 계정'),
      ] },
      { key: 'proj:api', name: 'api-server', path: 'C:\work\api-server', sessions: [
        S('s4', '주문 서비스 테스트 보강', 3 * hr, '회사 계정', { cwd: 'C:\work\api-server' }),
        S('s5', 'DB 마이그레이션 스크립트 정리', 9 * day, '회사 계정', { cwd: 'C:\work\api-server' }),
      ] },
      { key: 'loose', name: '프로젝트 없음', sessions: [
        S('s6', '회의록 요약해 줘', 5 * hr, '미분류', { cwd: 'C:\Users\me\Documents\Codex\chat' }),
        S('s7', '정규식 질문', 2 * day, '미분류', { cwd: 'C:\Users\me\Documents\Codex\chat-2' }),
      ] },
    ],
  };
  selected.clear(); collapsed.clear();
  renderSwitchers(); renderSourceTool(); renderSource();
  target = targetOptions()[0];
  const D = (key, title, ago, extra = {}) => ({ key: `claude:code:${key}`, tool: 'claude', sessionId: key, title, cwd: extra.cwd ?? 'C:\work\web-shop', createdAt: now - ago, updatedAt: now - ago, archived: false, kind: 'code', hasTranscript: true, accountKey: 'acct:3', accountLabel: '개인' });
  dest.loading = false; dest.error = null; dest.fresh = new Set();
  dest.data = { tool: 'claude', accounts: [{ key: 'acct:3', label: '개인' }], imported: [], projects: [
    { key: 'cwd:web', name: 'web-shop', path: 'C:\work\web-shop', sessions: [D('d1', '[Codex] 로그인 화면 접근성 점검', 1 * day), D('d2', '배포 스크립트 검토', 3 * day)] },
    { key: 'cwd:notes', name: 'notes', path: 'C:\Users\me\notes', sessions: [D('d3', '주간 보고서 초안', 2 * day, { cwd: 'C:\Users\me\notes' })] },
  ] };
  renderTargetSelect(); renderTargetList(); renderGo();
  setStatus('success', "ChatGPT를 '회사 계정' 계정으로 전환했습니다");
  return true;
})()
