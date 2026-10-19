# Phase 0 — 세션 이관 검증 (V5 · V6 · V7 · V9)

실제 앱에서 이관 결과를 확인한 기록이다. 원본은 항상 그대로 두고, 대상 앱에는 새 세션을 추가만 한다.

## 결과 요약

| ID | 방향 | 결과 | 날짜 |
|---|---|---|---|
| V7 | Claude Code → Codex | **통과** — 목록·프로젝트 분류·대화 표시·이어서 메시지 전송 모두 정상 | 2026-09-29 |
| V6 | Codex → Claude Code | **통과** — GUI 가져오기로 Claude Desktop Code 탭에 표시, 대화 표시, 이어서 메시지 전송 정상 | 2026-09-29 |
| V5 | Claude 계정 A → B (복제) | 대기 (Claude 계정 2개 등록 필요) | — |
| V9 | Codex 세션을 다른 GPT 계정에서 이어쓰기 | 대기 | — |

## V6 — Codex → Claude Code (2026-09-29)

- GUI([라이브러리] → Codex 세션 1개 → [가져오기…] → 대상 Claude, 현재 로그인 계정)로 수행. Claude Desktop 이 재시작되고 Code 탭 목록에 `[Codex] …` 세션이 나타났으며, 이관 안내와 원래 대화(도구 실행은 `🔧 [Codex: exec] …` 요약)가 보였고, 이어서 보낸 메시지에 Claude 가 정상 응답했다. **첫 시도에 통과** — 사전에 실제 인덱스 97개·전사 497개와 키/타입을 대조한 dry run 으로 형식을 맞춘 효과.
- 검증 전에 드러나 고친 문제:
  1. **MSIX 파일 가상화** — Claude Desktop(과 그 안의 터미널에서 실행한 프로세스)의 `%APPDATA%` 쓰기는 `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\` 로 리디렉션된다. 일반 터미널의 GUI 는 Claude Desktop 의 실제 세션 폴더를 못 봐서 "템플릿 세션 없음"으로 실패했고, 이 앱의 DB 도 두 곳으로 갈라졌다. → 앱 데이터를 `~\.ai-account-bridge` 로 옮기고(기존 데이터 자동 이전), Claude Desktop 데이터는 패키지 폴더를 우선 사용 (`b7ea9e9`, `9df11e5`, `e530521`).
  2. Desktop 이 띄운 Claude Code 는 가상 경로(`%APPDATA%\Claude\claude-code`)로 보고되어 "독립 실행 CLI" 경고가 잘못 떴다 → 두 경로 모두 앱 소속으로 인정 (`2a33074`).
  3. Claude 인덱스에 Codex 모델명이 들어가거나(이어쓰기 실패 원인) 템플릿(실행 중인 다른 대화)의 상태가 섞이던 문제 → 템플릿 모델 유지, 인덱스는 허용 목록 필드만 (`0ac5c34`, `05a7b49`, `7229024`).
- 관찰 후 개선: Codex 가 사용자 메시지 앞에 붙이는 `<in-app-browser-context>` 블록과 `## My request:` 머리말이 이관 대화에 노출됨 → 읽을 때 잘라내고 실제 요청만 남김 (`cc0da54`, 이후 이관부터 적용).
- 추가 정리(실제 rollout 125개·Claude 전사 506개 전수 점검): Codex 의 조립형 메시지(`# Files mentioned by the user` / `# Selected text` / `# Response annotations` / `## Referenced ChatGPT conversation` + `## My request for Codex:`)는 실제 요청만 남기고 `[첨부: …]`·`[선택한 텍스트: …]`·`[참조한 ChatGPT 대화: 제목]` 한 줄로 요약. `<recommended_plugins>`·`<turn_aborted>`·`<subagent_notification>`·`<external_codex_apps_writing_block_edits>` 는 버리고, `<image>` 묶음은 `[이미지]`. 목록 제목은 앱이 만든 `threads.name` 우선. Claude 쪽 `<task-notification>` 은 `[백그라운드 작업 완료: 요약]` 한 줄로.

## V7 — Claude Code → Codex (2026-09-29)

- 원본: Claude Code 세션 `Learning resource comparison` (145KB, 2턴). 명령:
  `npm run cli -- import claude claude:code:local_9200d944-3cd6-4264-a2ef-f1ba5b76716d --to codex`
- 결과: ChatGPT(Codex) 앱이 종료 → 등록 → 재실행되고, `base-docs` 프로젝트 아래에 `[Claude] Learning resource comparison` 이 생겼다. 원래 날짜(6월 10일)와 서식이 그대로 보였고, 이어서 보낸 메시지에 정상적으로 답이 왔다.

### 검증 중 발견한 Codex 앱의 요구사항 (세 번의 시도로 확인)

| 시도 | 증상 | 원인 (앱 로그 `thread_history_materialization` 기준) | 수정 |
|---|---|---|---|
| 1 | 목록·프로젝트엔 보이나 대화가 비어 있음 | 앱의 대화 표시(`thread_history_1.sqlite` 의 `thread_items`)는 `response_item` 이 아니라 **`event_msg/item_completed`**(`UserMessage` / `AgentMessage`)로 만들어진다 | 메시지마다 `item_completed` 이벤트 추가 (`2d27c2a`) |
| 2 | 대화 항목은 생겼으나 여전히 빈 화면, `thread_turns` 0개 | `task_started`/`task_complete` 의 `started_at`/`completed_at` 은 **정수(epoch 초)**, 메시지 메타데이터 `create_time` 은 **숫자(초, 실수)** 여야 한다. 문자열이면 그 줄을 건너뛴다 | 시각 필드를 숫자로 기록 (`329ae9a`) |
| 3 | 정상 | — | — |

- **프로젝트 분류:** 앱은 세션의 작업 폴더(`cwd`)가 프로젝트 루트와 같으면 그 프로젝트 아래에 보여준다. `.codex-global-state.json` 의 `thread-project-assignments` 는 수정하지 않아도 된다.
- **캐시 주의:** 앱은 세션을 한 번 읽으면 읽은 위치(`thread_history_projection_state`)를 기록하고 다시 읽지 않는다. 형식이 잘못된 이관 세션은 파일을 고쳐도 다시 표시되지 않으므로 앱에서 보관/삭제한 뒤 새로 이관해야 한다(`--copy`).
- 앱 로그에서 이관 세션 관련 경고는 "PowerShell 셸 스냅샷 미지원"(일반 경고) 1건만 남았다.

## V6 — Codex → Claude Code (수행 방법)

Claude Desktop 안에서 Claude Code 를 쓰는 중이라면 이관이 Claude Desktop 을 종료하므로 그 대화가 끊긴다. **GUI(`npm run gui`)는 별도 프로세스라 남는다.**

1. `npm run gui` → [라이브러리] → ChatGPT(Codex) → 작은 세션 1개 체크 → [가져오기…]
2. 대상: Claude, 계정: 현재 로그인 계정, 중복: 건너뛰기 → [가져오기 실행]
3. Claude Desktop 이 다시 켜지면 Code 탭 목록에 `[Codex] 제목` 이 있는지, 열었을 때 이관 안내 + 대화가 보이는지, 이어서 메시지 1회 전송이 되는지 확인
4. 문제가 있으면 `%APPDATA%\Claude\logs` 와 이관된 세션 파일(`~\.claude\projects\<폴더>\<id>.jsonl`)로 원인 확인
