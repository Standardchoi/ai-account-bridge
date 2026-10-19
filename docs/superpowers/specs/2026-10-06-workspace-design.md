# 작업공간(Workspace) — 설계 문서

- 작성: 2026-10-06
- 상태: 초안 — Plan 4 착수 전
- 관련: [전체 설계](2026-09-23-ai-account-bridge-design.md) · [아키텍처](../../architecture.md) · [Plan 4](../plans/2026-10-06-plan4-workspace-claude.md)

## 1. 목적

지금은 Claude 데스크탑, ChatGPT(Codex) 앱, Gemini 를 쓰려면 앱마다 프로젝트를 만들고 그 안에서 작업해야 한다. 도구를 바꾸려면 세션을 이관하고 대상 앱을 다시 띄워야 해서 바로 바꿀 수 없다.

작업공간은 **이 앱 안에 프로젝트 폴더 하나를 등록하고**, 그 안에서 대화를 여러 개 열어 **메시지마다 Claude · GPT · Gemini 중 하나를 골라** 보내는 화면이다. 같은 대화를 다른 도구로 이어 갈 수 있다. 실제 작업은 각 회사의 공식 CLI(`claude`, `codex`, `gemini`)를 자식 프로세스로 실행해서 하고, 이 앱은 입력을 넘기고 출력 스트림을 받아 보여 주는 중계를 맡는다.

## 2. 범위

### 2.1 포함
- 작업공간(폴더) 등록·제거, 작업공간별 대화 목록, 대화 삭제(이 앱의 기록만)
- 메시지마다 도구 선택, 도구별 권한 모드 선택, 보내기·멈추기, 실시간 출력(글·도구 호출)
- 도구 전환: 그 도구가 못 본 메시지를 요약해 붙여 이어 가기
- 여러 git 저장소를 모은 폴더(예: multi-repo) 지원: 저장소·브랜치·지침 파일 안내, 저장소별 변경 목록
- 턴별 토큰 사용량 표시
- (Plan 7) 기존 Codex/Claude 대화를 작업공간으로 가져오기, 작업공간 대화를 공식 앱에서 열기

### 2.2 제외
- **승인 팝업**(도구가 "실행할까요?" 를 물을 때 이 앱이 사용자에게 묻기) — 다음 버전. Claude 는 도움말에 없는 플래그 `--permission-prompt-tool`(MCP 도구), Codex 는 실험 기능 `app-server` 가 필요하다
- 여러 대화 동시 실행, 도구별 worktree 격리
- 공식 앱 화면 기능 따라가기(플랜 모드 화면, 체크포인트·되돌리기, diff 리뷰, 인앱 브라우저)
- 데스크탑 앱 창 직접 조작 — 외부에서 대화를 보낼 공개 API 가 없고, 화면 자동 조작은 앱 업데이트마다 깨진다
- CLI 의 로그인 토큰을 꺼내 API 를 직접 부르기(약관 위반 소지) — 항상 공식 CLI 를 실행한다
- 한 대화를 작업공간과 공식 앱에서 동시에 이어 쓰기

## 3. 핵심 결정 (Decision Log)

| # | 결정 | 이유 |
|---|---|---|
| W1 | 공식 CLI 를 자식 프로세스로 실행 | 데스크탑 앱도 같은 엔진(Codex 앱 안의 `codex.exe`, Claude 데스크탑 Code 탭의 Claude Code)을 쓰므로 모델·도구·답변 품질이 같다. 구독 요금제로 돌고 사용 한도는 데스크탑 앱과 같이 쓴다 |
| W2 | ACP 를 쓰지 않고 도구별로 직접 연동 | 이 PC 에 ACP 어댑터가 없고 Claude 는 ACP 를 기본 지원하지 않는다. Claude(`stream-json`)·Codex(`exec --json`)의 자체 출력으로 충분하다 |
| W3 | 작업공간 > 대화 > 메시지. 도구는 메시지마다 고른다 | 사용자 결정(2026-10-01) |
| W4 | 대화의 원본은 이 앱 DB(IR 블록). 각 도구의 세션은 이어 하기용 | 도구가 섞인 대화를 한곳에서 보여 주고 요약하려면 공통 기록이 필요하다. Gemini 처럼 세션 파일을 읽는 코드가 없는 도구도 같은 방식으로 다룬다 |
| W5 | 도구를 바꿀 때 그 도구가 못 본 메시지만 요약해 다음 프롬프트 앞에 붙인다 | 즉시 전환, 앱 재시작·템플릿 세션 불필요. 기존 설계 D3(이관은 실제 세션으로 변환)과 다른 선택이다 — 이관은 공식 앱 목록에 남기는 게 목적이고, 작업공간은 빠른 전환이 목적이다 |
| W6 | 폴더는 복사하지 않고 같이 쓴다. 모든 도구가 같은 실제 경로에서 실행 | 파일·산출물·git 상태가 그대로 공유된다. 경로 별칭(`C:\Users\olduser` → `C:\Users\me`)은 `canonicalPath` 로 풀어 저장한다 — Claude 는 경로 문자열로 프로젝트를 나누기 때문 |
| W7 | 작업공간 안내를 각 도구 세션의 첫 메시지에 붙이고, 지침 파일은 새로 만들지 않는다 | 도구마다 읽는 지침 파일이 다르다(Claude `CLAUDE.md`, Codex `AGENTS.md`, Gemini `GEMINI.md`). 하위 저장소에 `CLAUDE.md` 를 만들면 사용자 저장소에 추적 안 된 파일이 생기므로, 대신 안내 글에 그 도구가 읽어야 할 지침 파일을 나열한다 |
| W8 | 권한은 도구 고유 모드를 그대로 고른다 | 사용자 결정. Claude `--permission-mode`, Codex `--sandbox`, Gemini `--approval-mode`(Phase 0 확인) |
| W9 | 작업공간 전체에서 한 번에 한 턴만 실행 | 같은 폴더를 두 도구가 동시에 고치는 충돌을 막고 단순하게 유지한다 |
| W10 | 턴 실행 중에는 계정 전환·복원·새 계정 추가·가져오기를 거절하고, 그 작업 중에는 턴을 시작하지 않는다 | 실행 중에 인증 파일이 바뀌거나, 대상 앱 종료 과정에서 우리 CLI 가 "떠도는 CLI" 로 잡히는 것을 막는다 |
| W11 | 턴마다 CLI 를 띄우고 끝나면 종료. 다음 턴은 그 도구의 세션 이어 하기 | 긴 프로세스 관리가 필요 없다. 프롬프트 캐시는 서버 쪽이라 같은 세션을 이어 가면 프로세스를 유지하지 않아도 캐시를 쓴다 |
| W12 | 프롬프트는 표준 입력으로 넘긴다 | Windows 명령줄 길이(약 32K 자)·따옴표 문제를 피한다. 요약을 붙이면 길어진다 |
| W13 | 멈추기는 프로세스 트리 종료(`taskkill /T /F`) | CLI 가 띄운 셸 명령까지 끝낸다 |
| W14 | `AgentId`(작업공간 도구)를 `ToolId`(계정 도구)와 분리 | Gemini 는 계정 전환 대상이 아니다. 계정 코드(auth·switch)를 건드리지 않고 도구를 늘린다 |

## 4. 사용자 흐름

### 4.1 작업공간 추가
상단 막대 `작업공간` → 왼쪽 `폴더 추가` → 폴더 선택. 백엔드가 확인한다: 절대 경로, 있는 폴더, 드라이브 루트가 아님. 실제 경로로 풀어 저장하고(이름 기본값 = 폴더 이름), 이미 등록된 폴더면 거절한다.

### 4.2 대화
- 작업공간을 고르면 그 안의 대화 목록이 보인다. `새 대화` 또는 기존 대화를 고른다.
- 입력창 아래: 도구 선택(설치된 도구만), 권한 모드, 보내기(Ctrl+Enter)·멈추기.
- 보내면 사용자 말풍선 → 도구의 출력이 실시간으로(글은 조각 단위, 도구 호출은 한 줄씩) → 끝나면 사용량(입력·출력·캐시 토큰)을 표시한다.
- 실패는 대화 안에 빨간 줄과 알림으로, 멈춘 턴은 "멈췄습니다" 로 남는다.

### 4.3 도구 바꿔 이어 가기 (Plan 5)
도구 선택을 바꿔 보낸다. 그 도구가 이 대화를 처음 보면 새 세션 + 작업공간 안내 + 지금까지 대화 요약을, 예전에 본 적 있으면 그 세션을 이어 하고 그 뒤에 다른 도구가 한 부분만 요약해 붙인다. 대화 안에 "Claude → ChatGPT" 같은 전환 표시를 남긴다.

### 4.4 제거
작업공간·대화 삭제는 이 앱의 기록만 지운다. 폴더·파일과 각 도구의 세션 파일은 그대로 둔다.

## 5. 도구별 연동

| | Claude Code | Codex | Gemini |
|---|---|---|---|
| 실행 파일 | PATH 의 `claude.exe`(없으면 `claude.cmd`) | Codex 앱 번들 `%LOCALAPPDATA%\OpenAI\Codex\bin\<해시>\codex.exe` 중 가장 최근 것, 없으면 PATH | PATH 의 `gemini.cmd`(npm) — Phase 0 |
| 첫 턴 | `-p --output-format stream-json --verbose --include-partial-messages --permission-mode <m> [--model <m>] --session-id <새 UUID>` | `exec --json -C <폴더> -s <sandbox> [-m <m>] --skip-git-repo-check -` | Phase 0 |
| 다음 턴 | 같은 옵션에서 `--session-id` 대신 `--resume <세션 ID>` | `exec resume <thread_id> --json … -` | Phase 0 |
| 프롬프트 | stdin | stdin(`-`) | Phase 0 |
| 세션 ID | `system/init` 줄의 `session_id`(첫 턴은 우리가 정한 UUID) | `thread.started` 의 `thread_id` | Phase 0 |
| 권한 모드 | `plan`, `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions` | `read-only`, `workspace-write`, `danger-full-access` | `default`, `auto_edit`, `yolo`(예상) |
| 스스로 읽는 지침 파일 | `CLAUDE.md` | `AGENTS.md` | `GEMINI.md` |

확인한 버전(2026-10-01): claude 2.1.159, codex-cli 0.159.2, gemini 미설치.

도구별 파서는 CLI 출력 한 줄(JSON)을 공통 이벤트(`AgentEvent`)로 바꾼다: `session`, `textDelta`, `text`, `toolStart`, `toolEnd`, `done(ok, error?, usage?)`. 화면과 저장은 공통 이벤트만 안다.

## 6. 도구를 바꿀 때 넘어가는 것

| 구분 | 내용 |
|---|---|
| 그대로 공유 | 작업 폴더 안의 모든 파일·하위 폴더·git 상태(같은 디스크, 같은 경로) |
| 요약해서 넘김 | 사용자 메시지·답변 글은 원문, 도구 호출은 한 줄(`render.ts` 의 `toolLine`), 실패한 출력은 앞 300자. 그 사이 바뀐 파일(저장소별 `git status --porcelain`) |
| 넘어가지 않음 | 추론, 성공한 도구 출력 원문, 도구 내부 상태(할 일 목록·플랜, 메모리, 권한 허용 기록, MCP·스킬), 첨부 이미지(첫 버전) |

요약 상한은 기본 40,000자. 넘으면 오래된 메시지부터 빼고 "앞의 N개 메시지는 생략했습니다" 를 남긴다.

핸드오프 글 형식(Plan 5):

```
[작업공간 안내]
작업 폴더: C:\Users\me\Documents\work\multi-repo — 다른 AI 도구와 같이 쓰는 폴더입니다. 파일은 디스크의 현재 상태가 최신입니다.
git 저장소: app-agent (master), app-backend (feat/new-api), app-deploy (master), app-docs (master)
지침 파일: app-agent/AGENTS.md — 해당 폴더에서 작업하기 전에 읽고 따르세요.
만드는 파일·산출물은 작업 폴더 안에 두세요.

[이전 대화 — 이 대화의 앞부분은 ChatGPT 가 진행했습니다]
(사용자) …
(ChatGPT) …
🔧 [ChatGPT: shell] git -C app-backend status

[그 사이 바뀐 파일]
app-backend (feat/new-api): M app/api/router.py, ?? migrations/0001_init.py

---

<이번 요청>
```

비용: 같은 도구로 이어 가면 그 도구의 세션과 캐시를 그대로 쓴다. 바꾸는 순간에는 요약 글과 새 도구가 파일을 다시 읽는 만큼 더 쓴다. 메시지마다 번갈아 바꾸면 늘어난다.

## 7. 여러 저장소를 모은 폴더

관찰(2026-10-06, `Documents\work\multi-repo`): 상위 폴더는 git 저장소가 아니고, 아래에 저장소 4개(`app-agent`, `-backend`, `-deploy`, `-docs`)와 설계 문서·로그가 있다. 이 폴더를 다룬 GPT 대화들은 상위 폴더를 작업 폴더로 썼고 Codex 앱에 프로젝트로 등록돼 있다. 지침 파일은 `app-agent/AGENTS.md` 하나다. 옛 대화의 작업 폴더는 `C:\Users\olduser\…`, 최근 대화는 `C:\Users\me\…` 로 기록돼 있다.

- **저장소 찾기:** 작업 폴더 자신과 그 아래 2단계까지에서 `.git`(폴더 또는 파일)을 찾는다. 숨김 폴더·`node_modules`·빌드 폴더는 건너뛴다. 브랜치는 `HEAD` 파일을 직접 읽는다(git 을 실행하지 않음).
- **지침 파일:** 같은 범위에서 `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` 를 찾는다. 안내 글에는 **그 도구가 스스로 읽지 않는 것**만 나열한다(같은 폴더에 그 도구의 파일이 있으면 생략).
- **변경 목록(Plan 5):** 저장소마다 `git -C <저장소> status --porcelain`. git 이 없으면 생략한다.

## 8. 데이터 모델 (app.db 마이그레이션 4)

```
workspaces        (id, name, folder UNIQUE NOCASE, created_at)
ws_conversations  (id, workspace_id → workspaces ON DELETE CASCADE, title, agent, created_at, updated_at)
ws_messages       (id, conversation_id → ws_conversations ON DELETE CASCADE, seq, role, agent, blocks_json,
                   status, error, usage_json, created_at, UNIQUE(conversation_id, seq))
ws_agent_sessions (conversation_id → ws_conversations ON DELETE CASCADE, agent, native_session_id, seen_seq,
                   PRIMARY KEY(conversation_id, agent))
```

- `blocks_json`: IR 블록 배열(`text`, `tool`). 도구 입력·출력은 IR 규칙대로 2,048자까지.
- `seen_seq`: 그 도구의 세션이 본 마지막 메시지. 핸드오프 범위는 `seq > seen_seq` 인 메시지다.

## 9. 백엔드 ↔ 화면 프로토콜 추가

- 백엔드 → 화면: `{ type: 'event', id, data }` — 오래 걸리는 요청(`wsSend`)의 중간 이벤트. `data = { conversationId, event: AgentEvent }`.
- 화면 → 백엔드: `{ type: 'cancel', id }` — 그 요청의 `AbortSignal` 을 끊는다.
- 화면이 닫혀 백엔드 stdin 이 닫히면 진행 중인 요청을 모두 취소한다.
- RPC: `wsAgents`, `wsList`, `wsAdd`, `wsRemove`, `wsConversations`, `wsNewConversation`, `wsConversation`, `wsDeleteConversation`, `wsSend`.
- 화면은 작업공간 id·대화 id 만 보낸다. 폴더 경로는 `wsAdd` 에서 한 번만 받아 검증한다(전체 설계 §8 — 화면이 넘긴 임의 경로를 그대로 쓰지 않는다).

## 10. 검증 단계 (Phase 0 — 각 Plan 착수 전)

| # | 확인할 것 | Plan |
|---|---|---|
| W-V1 | Claude `-p` stream-json 이벤트 모양(init·assistant·user·result·stream_event), `--verbose` 필요 여부 | 4 |
| W-V2 | stdin 으로 넘긴 한글 프롬프트가 깨지지 않는지 | 4 |
| W-V3 | `--session-id <UUID>` 첫 턴 → `--resume` 둘째 턴이 같은 세션으로 이어지는지 | 4 |
| W-V4 | `-p` 에서 권한 모드별 동작(`default` 에서 셸 명령이 거부되는 방식, `plan`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`) — 보여 줄 모드와 기본값 결정 | 4 |
| W-V5 | `CLAUDECODE` 환경 변수가 있을 때 중첩 실행으로 막히는지 | 4 |
| W-V6 | 실행 중 트리 종료 뒤 세션 파일이 멀쩡하고 `--resume` 이 되는지 | 4 (실제 CLI 테스트) |
| W-V7 | CLI 로 만든 세션이 Claude 데스크탑 Code 탭에 보이는지(참고) | 7 |
| W-V8 | Codex `exec --json` 이벤트 모양, `exec resume`, stdin 프롬프트, sandbox 별 동작, Codex 앱 실행 중 동시 사용 | 5 |
| W-V9 | Codex 앱 번들 `codex.exe` 를 앱 밖에서 실행해도 되는지(인증·업데이트) | 5 |
| W-V10 | Gemini 설치·로그인 후 헤드리스 플래그(`-p`, 출력 형식, 이어 하기, 승인 모드), Windows 실행 방식(`.cmd`) | 6 |

결과는 `docs/verification/phase0-workspace.md` 에 남긴다.

## 11. 에러 처리

| 상황 | 처리 |
|---|---|
| CLI 없음 | 도구 목록에 "설치 안 됨"(고를 수 없음), 보내기 거절 |
| 로그인 안 됨·만료 | CLI 가 낸 오류(결과 이벤트 또는 stderr 끝부분)를 대화에 표시 |
| 사용 한도 초과 | 같은 방식으로 표시. 다른 도구로 바꿔 이어 갈 수 있다(Plan 5) |
| 실행 중 오류·비정상 종료 | 받은 데까지 저장, 상태 `error`, stderr 마지막 2KB |
| 멈추기 | 프로세스 트리 종료, 받은 데까지 저장, 상태 `cancelled` |
| 폴더가 사라짐 | 보내기 거절: "작업 폴더를 찾을 수 없습니다" |
| 앱이 닫힐 때 실행 중 | 진행 중인 요청을 취소(트리 종료). 사이드카가 강제로 끝나면 CLI 가 그 턴을 끝까지 돌 수 있다(§13) |

## 12. 테스트

- 순수 함수(인자 만들기, 출력 파서, 턴 누적, 안내·핸드오프 글, 실행 파일 찾기): 단위 테스트. 입력은 Phase 0 에서 본 실제 출력 모양.
- 실행기: 가짜 자식 프로세스(스트림 주입)로 줄 나누기·멈추기·종료 코드·stdin 을 확인한다.
- 서비스·RPC: 가짜 실행기 + `AppDb(':memory:')`.
- 실제 CLI: `AAB_LIVE=1` 일 때만 도는 테스트(임시 폴더, 짧은 프롬프트 — 사용 한도를 조금 쓴다).
- 화면: 실제 앱에서 수동 확인(각 Plan 의 마지막 작업).

## 13. 리스크

| 리스크 | 대응 |
|---|---|
| CLI 출력 형식이 업데이트로 바뀜 | 파서는 모르는 줄을 버린다. Phase 0 에서 본 버전을 문서에 남기고, 실제 CLI 테스트로 회귀를 잡는다 |
| Codex 실행 파일 경로가 앱 업데이트마다 바뀜 | 실행할 때마다 다시 찾는다 |
| 사이드카가 강제 종료되면 CLI 가 고아로 남음 | 후속: 띄운 pid 를 기록했다가 다음 시작 때 정리 |
| 도구를 자주 바꾸면 사용 한도를 빨리 씀 | 턴별 사용량 표시, 요약 상한 |
| 공식 앱 기능을 따라가다 범위가 커짐 | §2.2 제외 목록을 지킨다 |
| 도움말에 없는 플래그 의존 | 첫 버전은 쓰지 않는다(승인 팝업 제외) |

## 14. 마일스톤

| Plan | 내용 | 끝나면 되는 것 |
|---|---|---|
| 4 | 기반 + Claude: 스트리밍 프로토콜, 실행기, Claude 연동, 작업공간·대화 저장, 작업공간 안내, 화면 | 이 앱에서 폴더를 등록하고 Claude 와 대화하며 작업 |
| 5 | GPT(Codex) + 도구 전환: Codex 연동, 핸드오프(요약·변경 목록·상한), 대화 안 전환 표시 | 같은 대화를 Claude ↔ GPT 로 이어 가기 |
| 6 | Gemini: Phase 0(설치·로그인 후), 연동 | 세 도구 모두 |
| 7 | 공식 앱과 연결: 기존 Codex/Claude 대화를 작업공간으로 가져오기(예: multi-repo 의 GPT 대화), 작업공간 대화를 공식 앱에서 열기(기존 이관 재사용) | 공식 앱에서 하던 일을 작업공간에서 이어 가고, 그 반대도 |

Plan 6 과 7 은 서로 독립이라 순서를 바꿔도 된다. Plan 5~7 의 상세 계획은 앞 Plan 이 끝나고 해당 Phase 0 을 마친 뒤 쓴다.
