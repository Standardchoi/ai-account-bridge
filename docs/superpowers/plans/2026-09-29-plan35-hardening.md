# Plan 3.5 — 완성도 보강 (Hardening)

리뷰에서 "후속"으로 미뤄 둔 항목을 모아 처리한다. 모두 TDD, 항목별 커밋. 같은 파일을 동시에 건드리지 않도록 묶음 A → B → C → D 순서로 진행하고 묶음마다 리뷰한다.

## A. 안전성 (services / infra)
- **A1 프로세스 간 잠금:** `~\.ai-account-bridge\op.lock` 을 `fs.open(…, 'wx')` 로 만들어 쓰기 작업(save·switch·restore·add·rename·delete·import) 동안 유지. 내용 `{pid, startedAt, op}`. 이미 있으면 기록된 pid 가 살아 있는지 확인(`process.kill(pid, 0)`) — 죽었으면(또는 12시간 초과) 오래된 잠금으로 보고 교체, 살아 있으면 `다른 창(또는 CLI)에서 작업이 진행 중입니다 (<op>, pid <pid>)` 로 거절. RPC `withLock` 과 CLI 쓰기 명령이 사용. 프로세스 내 `inFlight` 가드는 유지.
- **A2 복원 견고화:** `restoreBackup` 의 범위 확인을 앱 종료 **후**(`current` 재사용)로 옮겨 잠긴 쿠키 파일로 인한 EBUSY 를 없앤다 — 범위가 다르면 재실행 후 aborted. 복원 쓰기가 실패하면 안전 백업(`current`)으로 되돌린 뒤에만 재실행하고, 되돌리기까지 실패하면 재실행하지 않고 백업 경로를 담은 오류.
- **A3 갱신 생략 안내:** 전환/새 계정 추가에서 현재 로그인이 없거나 손상되어 이전 계정 스냅샷 갱신을 건너뛰면 결과에 `notice: '현재 로그인 정보를 읽을 수 없어 이전 계정 스냅샷을 갱신하지 않았습니다'` 추가, CLI/GUI 표시.
- **A4 needs_relogin 정확화:** 스냅샷 **복호화** 실패일 때만 `needs_relogin`. 파일 없음(ENOENT)은 `needs_relogin` + "스냅샷 파일 없음", 그 밖의 IO/PowerShell 오류는 상태를 바꾸지 않고 aborted.
- **A5 이관 날짜:** 원본 `createdAt` 이 유효하지 않으면 현재 시각으로 대체하고 `stats` 에 기록(영문 RangeError 제거).

## B. 형식 대응 (providers)
- **B1 Codex id_token:** `id_token` 디코드 실패는 신원 확인을 막지 않는다 — `account_id` 만으로 신원을 만들고 이메일/이름 생략.
- **B2 Codex writer:** UNC cwd 는 `\\?\UNC\server\share…` 로 접두어 처리. `session_index.jsonl` 은 임시 파일 + rename 으로 원자적으로 교체(백업은 FsTransaction 유지). FsTransaction 백업 폴더(`backups\*.jsonl` 등)는 최근 50개만 유지.
- **B3 npm CLI 감지:** 프로세스 목록에 명령줄을 포함(Win32_Process CommandLine). `node.exe` 인데 명령줄에 `@anthropic-ai/claude-code` 또는 `@openai/codex` 가 있으면 해당 도구의 독립 실행 CLI 로 분류.

## C. GUI · CLI
- **C1 Electron 메뉴 제거:** `Menu.setApplicationMenu(null)` (개발자 도구는 Ctrl+Shift+I 유지하지 않음).
- **C2 스냅샷 범위 표시:** 계정 저장 시 범위(`auth` / `auth+app-profile`)를 DB 에 기록(마이그레이션 3: `accounts.scope TEXT NOT NULL DEFAULT 'auth'`), CLI `list`·GUI 계정 행에 표시. 기존 행은 스냅샷을 복호화하지 않고 `auth` 로 둔다(현재 등록 계정은 모두 기본 범위).
- **C3 CLI Ctrl+C:** 프롬프트 대기 중 SIGINT 는 "취소" 로 응답해 서비스가 정상적으로 aborted 경로(앱 재실행 포함)를 밟게 한다. 두 번째 Ctrl+C 는 즉시 종료.

## D. 기능
- **D1 지침 파일 복사(선택):** 가져오기 대화상자/CLI `--copy-instructions` 옵션(기본 꺼짐). Codex→Claude: 대상 cwd 에 `AGENTS.md` 가 있고 `CLAUDE.md` 가 없으면 `CLAUDE.md` 를 만들고 내용은 `@AGENTS.md` 한 줄(Claude Code 의 파일 참조 문법 — 원본 유지·중복 방지). Claude→Codex: `CLAUDE.md` 가 있고 `AGENTS.md` 가 없으면 `CLAUDE.md` 내용을 복사한 `AGENTS.md` 생성(Codex 는 참조 문법이 없음). 이미 있으면 건드리지 않고 결과에 "이미 있음". 생성 파일은 FsTransaction 으로 추적되어 실패 시 제거. 결과/로그에 만든 파일 경로 표시.
