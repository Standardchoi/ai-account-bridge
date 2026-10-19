# AI Account Bridge — 설계 문서 (Design Spec)

- 작성일: 2026-09-23
- 상태: 초안 (사용자 리뷰 대기)
- 관련 문서: [architecture.md](../../architecture.md) — 모듈 구조, 인터페이스, 파일 포맷 레퍼런스

---

## 1. 목적

ChatGPT(Codex) 데스크탑 앱과 Claude 데스크탑 앱을 **여러 계정으로 번갈아 쓰는 사람**을 위한 Windows 데스크탑 도구.

1. 도구별로 여러 계정을 등록해 두고, 클릭 한 번으로 계정을 전환한다.
2. 등록된 각 계정의 **로컬** 프로젝트·세션·대화 내용을 조회한다.
3. 조회한 프로젝트/세션을 골라 **다른 계정 또는 다른 도구(Codex ↔ Claude)** 로 가져가서, 대상 앱에서 목록에 뜨고 이어서 작업할 수 있게 한다.

참고 선례: [ZOONGG/codex-swap-account](https://github.com/ZOONGG/codex-swap-account) — Codex `auth.json` 만 교체하고 `.codex` 폴더는 공유하는 방식. 본 프로젝트는 이 방식을 Claude까지 확장하고 도구 간 세션 변환을 추가한다.

## 2. 범위

### 2.1 포함 (v1)

| ID | 기능 |
|---|---|
| F1 | 계정 등록: 현재 앱에 로그인된 계정을 이름 붙여 스냅샷 저장 (Claude n개, GPT n개) |
| F2 | 계정 전환: 대상 앱 종료 → 현재 계정 스냅샷 갱신 → 백업 → 인증 교체 → 재실행 → 검증 → 실패 시 롤백 |
| F3 | 라이브러리 조회: 계정 필터 → 프로젝트 → 세션 → 대화 미리보기 (Codex: Code 세션, Claude: Code 세션 + Cowork 읽기) |
| F4 | 같은 도구 내 계정 간 공유: Claude = **포크**(전사 복사본 + 대상 계정 인덱스 생성, Code 세션만), Codex = 자동 공유(태그만) |
| F5 | 도구 간 이관 (양방향 변환): Codex → Claude Code, Claude Code → Codex. 세션 단위 / 프로젝트 단위 일괄 |
| F6 | 이관 이력 관리: 원본 ID ↔ 대상 ID 기록, 중복 이관 시 "건너뛰기 / 새 복사본" 선택 |

### 2.2 제외 (v1)

- ChatGPT / Claude **일반 채팅 대화** (서버 저장, 로컬에 원본 없음)
- Codex **클라우드 태스크** (서버 저장)
- 채팅/코드를 **서로 다른 계정으로 분리 전환** → v1.1 후보 (검증 V2 결과에 따라)
- Cowork 세션 **쓰기(가져오기 대상)** → 검증 V8 이후
- macOS / Linux → 이후 (경로 계층을 추상화해 두어 확장 가능하게만 함)
- 사용량 제한 우회를 목적으로 한 자동 로테이션 기능 (약관 위반 소지)

## 3. 핵심 결정 사항 (Decision Log)

| # | 결정 | 이유 | 대안(기각) |
|---|---|---|---|
| D1 | **인증 파일만 교체**, 세션/프로젝트 폴더는 공유 | 전환 빠름, SQLite 잠금 충돌 없음, 모든 계정에서 로컬 기록 유지. 선례에서 검증된 방식 | 도구 폴더 전체를 계정별로 통째 교체 — 느리고 잠금 충돌 |
| D2 | Codex 세션의 계정 구분은 **전환 이력 기반 태그**(자체 DB) | Codex 세션 파일에 계정 정보가 없음. 원본 파일을 건드리지 않음 | 계정별 `.codex` 분리 (D1 과 충돌) |
| D3 | 도구 간 이관은 **실제 세션으로 변환** (대상 앱 목록에 뜨고 resume 가능) | 사용자 요구: "가져와서 이어서 쓴다" | 새 세션 + 컨텍스트 주입 — 연속성 약함 |
| D4 | 변환은 **중간 표현(IR)** 을 경유 (Codex ↔ IR ↔ Claude) | reader/writer 를 독립적으로 테스트, 도구 추가 시 한 쌍만 구현 | 도구 간 직접 변환 (N² 조합) |
| D5 | 텍스트 메시지는 원문 보존, **도구 호출/결과는 텍스트 요약 블록**, reasoning/thinking 은 폐기 | 도구 스키마가 서로 호환되지 않음. Codex reasoning 은 `encrypted_content` 로 계정/조직 종속 가능성 | 도구 호출 구조 매핑 — 대상 도구가 존재하지 않는 도구 ID 를 받으면 resume 실패 위험 |
| D6 | **원본은 절대 수정하지 않음**. 대상 쪽에는 새 세션을 "추가"만 함 | 되돌리기 쉬움, 데이터 손실 방지 | — |
| D7 | 대상 도구 파일(SQLite/인덱스)에 **쓰기 전 대상 앱 종료** 필수 | 앱이 인덱스를 메모리에 들고 있다가 덮어쓰거나 SQLite 잠금 충돌 | 앱 실행 중 쓰기 |
| D8 | 스택: **Electron + TypeScript + React**, SQLite 는 `better-sqlite3` | 핵심은 JSONL/SQLite 변환 로직 → 한 언어로 빠르게 수정/테스트, 이후 크로스플랫폼 용이 | Tauri(Rust 필요), C# WPF(Windows 전용) |
| D9 | 인증 스냅샷은 **DPAPI(CurrentUser)로 암호화 저장**, 값은 UI/로그에 절대 출력 안 함. Plan 1(CLI)은 PowerShell `ProtectedData`, Plan 4(Electron)는 `safeStorage` — 둘 다 `SecretStore` 인터페이스 뒤 | `auth.json`, `.credentials.json` 은 평문 토큰 | 평문 복사 |
| D10 | v1 은 **도구 단위 전환**(채팅+코드 동시) | 분리 전환은 인증 저장소 간 덮어쓰기 여부가 미검증 | — |
| D11 | **같은 계정으로의 전환은 아무것도 쓰지 않음** — 현재 신원이 이미 대상 계정이면 백업/교체 없이 전환 이력만 기록 | 불필요한 파일 쓰기·백업 누적 방지, `switch` 를 반복 실행해도 안전(idempotent) | 항상 재작성 — 디스크 쓰기와 롤백 경로가 불필요하게 늘어남 |
| D12 | 앱이 관리하지 않는 **독립 실행 CLI**(`claude`/`codex` 를 터미널에서 직접 실행 중)가 있으면 진행 여부를 사용자에게 확인, 거부 시 앱을 건드리기 전에 취소 | 전환 후 그 CLI 가 이전 계정 토큰으로 인증 파일을 되덮어쓸 위험 | 자동 강제 종료 — 사용자의 다른 작업을 임의로 끊음 / 조용히 무시 — 인증 파일이 슬쩍 되돌아가는 사고 위험 |
| D13 | 계정 스냅샷의 **범위**(`bundleScope` — 교체 대상 경로/키 집합, `--with-app-profile` 포함 여부)는 저장 시점과 전환 시점이 같아야 하며, 다르면 아무것도 쓰지 않고 전환을 취소 | 범위가 다르면 일부 파일만 교체되어 계정이 반쯤 섞인 상태가 될 수 있음 | 범위가 다른 스냅샷도 병합 적용 — 최종 상태 예측 불가 |
| D14 | Claude 계정 A → B 공유는 **포크** — 새 `cliSessionId` 로 전사를 복사하고 대상 계정 폴더에 새 인덱스를 만든다. Code 세션만 대상 | 한 전사 파일을 두 계정이 함께 쓰면 두 계정의 대화가 한 파일에 섞여 이어진다. 복사본이면 원본 계정의 세션과 따로 이어진다 | 인덱스만 복사해 전사를 공유 — 계정 간 대화 혼합 |

## 4. 사용자 흐름

### 4.1 계정 등록 (F1)

1. 사용자가 평소대로 ChatGPT 또는 Claude 앱에서 로그인한다.
2. 본 앱에서 `[현재 계정 저장]` → 표시 이름 입력.
3. 앱이 인증 파일 세트를 읽어 **신원(identity)** 을 추출하고(이메일, 계정 ID), 스냅샷을 암호화 저장.
   - 이미 같은 신원이 등록돼 있으면 새로 만들지 않고 스냅샷 갱신.
   - 그 신원이 **다른 라벨로 이미 등록**돼 있으면 저장을 거부한다(아무것도 쓰지 않음) — 앱에서 계정을 바꿨지만 인증 파일에 아직 반영되지 않았을 가능성이 있으므로, 새 라벨로 잘못 이중 등록되는 것을 막는다.
4. 다른 계정 추가 = `[새 계정 추가]` (CLI: `add <tool>`) → 현재 계정을 저장·백업하고 **로그아웃 없이** 로그인 정보만 비운 뒤 앱을 다시 엶 → 그 앱에서 새 계정으로 로그인 → `[현재 계정 저장]`.
   - **앱 안에서 직접 로그아웃해 계정을 바꾸지 않는다** — 로그아웃은 그 계정의 토큰을 서버에서 즉시 폐기해 저장해 둔 스냅샷을 무효화한다 (관찰 기록: `docs/verification/phase0-auth.md`).
5. 등록된 계정은 `[이름 변경]`으로 라벨을 바꾸거나(다른 계정이 쓰는 라벨과 충돌하면 거부) `[삭제]`로 등록을 지울 수 있다. 삭제는 DB 등록과 저장된 스냅샷(`.bin`/`.prev.bin`, 베스트 에포트)만 지우며, 앱의 실제 로그인 상태와 `switch_events` 기록(해당 계정 참조만 NULL 로 남김)은 건드리지 않는다.

신원 추출 기준:

| 도구 | 계정 ID | 표시용 |
|---|---|---|
| GPT(Codex) | `auth.json` → `tokens.account_id` | `tokens.id_token` JWT 의 `email`, `name` 클레임 |
| Claude | `~/.claude.json` → `oauthAccount.accountUuid` + `organizationUuid` | `oauthAccount.emailAddress`, `organizationName` |

### 4.2 계정 전환 (F2)

```
0. 다른 전환이 이미 진행 중이면 즉시 취소 (동시 실행 방지)
1. 선택한 계정의 스냅샷을 먼저 복호화
   - 실패 시: 아무것도 건드리지 않고 취소, 해당 계정은 "재등록 필요" 상태로 표시 (§9 알려진 제한 참고: 일시적 오류에도 표시될 수 있음)
2. 대상 앱 프로세스 확인
   - 앱이 관리하지 않는 독립 실행 CLI(codex / claude) 발견 시 "그래도 진행할까요?" 확인 → 거부 시 앱을 건드리지 않고 취소 (D12)
   - 데스크탑 앱이 실행 중이면 정상 종료 요청 → GUI/CLI 기본값(`autoKill`)은 3초 대기 후 사용자 확인 없이 자동으로 강제 종료 (창을 닫아도 트레이로 숨는 실측 때문에 도입) → 그래도 남아 있으면 취소. `autoKill` 을 끈 호출자(테스트 등)는 기존처럼 10초 대기 후 강제 종료 여부를 확인 → 거부/실패 시 취소
3. 전환 준비 (아래 중 하나라도 실패하면 취소하고, 앱이 원래 실행 중이었으면 재실행 후 종료)
   a. 현재 인증 파일에서 신원을 읽는다. 그 범위(교체 대상 경로/키 집합, `--with-app-profile` 포함 여부)가 1번에서 복호화한 스냅샷과 다르면 취소 (D13)
      - 신원 조회에서 "로그인 안 됨"이 아닌 다른 오류(예: Claude 의 계정 정보 불일치 — `~/.claude.json` 과 Desktop `config.json` 의 계정이 다름)가 나면 로그인 안 된 것으로 취급하지 않고 즉시 전환을 취소한다. 조용히 넘어가 잘못된 계정 위에 그대로 덮어쓰는 것을 막기 위함.
   b. 현재 활성 계정의 스냅샷을 디스크의 최신 인증 파일로 갱신 ← 토큰 rotation 대응
      - 현재 신원이 등록된 계정이면: 그 계정의 기존 스냅샷 범위와도 비교해 다르면 취소, 같으면 스냅샷 갱신
      - 미등록 신원이면(사용자가 앱에서 직접 계정을 바꾼 경우): "새 계정으로 저장?" 확인 (저장하지 않아도 계속 진행)
      - 여기서도 "로그인 안 됨" 이외의 신원 오류는 a 와 동일하게 취소로 이어진다
   c. 현재 신원 == 선택한 계정이면(이미 그 계정으로 로그인된 상태): 아무 인증 파일도 쓰지 않고 전환 이력을 "성공"으로 기록 → 앱 실행 → 종료 (D11, 4~5 생략)
   d. 현재 인증 파일 세트를 backups/ 에 암호화 백업 (타임스탬프)
4. 선택한 계정 스냅샷을 원위치로 복원
5. 검증: 복원된 인증 파일의 신원 == 선택한 계정
   - 성공: 전환 이력을 "성공"으로 기록 → 앱 실행
   - 실패: 4번 백업으로 롤백 시도
     - 롤백 성공: 전환 이력을 "롤백됨"으로 기록 → 앱이 원래 실행 중이었으면 재실행 → 오류 + 백업 위치 표시
     - 롤백 자체도 실패: 백업 경로를 포함한 오류를 그대로 던짐(실행할 `npm run cli -- restore <tool> "<백업 경로>"` 명령을 오류 메시지에 포함, 전환에 `--with-app-profile` 을 썼다면 그 옵션도 붙여서) — 인증 파일이 불완전한 상태일 수 있어 `restore` 로 수동 복원 필요
```

전환/복원/새 계정 추가 진행 중에는 위 단계에 대응하는 한글 문구(예: '스냅샷 확인', '앱 종료 중', '강제 종료 중', '현재 계정 저장', '백업', '로그인 정보 교체', '계정 확인', '앱 실행', '앱 실행 확인')를 진행 상황 이벤트로 흘려보낸다. GUI 는 해당 도구 섹션에 스피너와 함께 표시하고, CLI 는 `  · <문구>` 로 출력한다.

새 계정 추가(F1 의 4번)는 전환과 같은 준비 단계(0~2, 3-a/b)를 거치되 대상 계정으로 교체하는 대신 현재 인증 파일을 비운(모든 파일 데이터/JSON 키 값을 null 로 — 다루는 경로 집합 자체는 그대로 유지) 뒤 앱을 다시 연다. 서버 로그아웃은 절대 호출하지 않으며, `switch_events` 에도 기록하지 않는다. 3-b 에서 미등록 신원인데 저장을 거부하면(라벨 미입력) "현재 로그인을 먼저 저장해야 새 계정을 추가할 수 있습니다" 로 취소하고, 앱이 실행 중이었으면 재실행한다.

### 4.3 라이브러리 조회 (F3)

- 좌측: 도구 탭(GPT / Claude) + 계정 필터 (전체 / 계정별 / 미분류)
- 중앙: 프로젝트(작업 폴더 기준 그룹) → 세션 목록 (제목, 최근 활동, 모델, 메시지 수, "가져온 세션" 표시)
- 우측: 대화 미리보기 (텍스트 메시지 + 도구 호출 요약)
- 조회는 **읽기 전용**이므로 대상 앱 실행 중에도 가능 (SQLite 는 read-only 모드로 연다)

계정 귀속 규칙:

| 도구 | 규칙 |
|---|---|
| Claude | Desktop 인덱스 폴더 `<accountUuid>/<organizationUuid>/` 로 결정. 등록되지 않은 폴더는 "미등록 (이메일 또는 accountId 앞 8자)"로 표시. 인덱스 없는 CLI 전용 세션은 "CLI 세션 (계정 불명)" 그룹 |
| Codex | `threads.created_at` 시점에 활성이던 계정 (전환 이력 기준). 이력 이전 세션은 "미분류" |

전환 이력에는 `switch`/`restore` 로 남는 `ok`/`rolled_back` 외에, 계정을 **등록(저장)한 시점**에도 그 계정이 활성이었음을 남기는 `saved` 이벤트가 있다 — 첫 전환 이전에 만든 세션도 등록 시점 기준으로 귀속되도록 하기 위함(Task 4). Codex 귀속 판정은 `result ∈ {ok, saved}` 인 이벤트를 시각순으로 훑어 세션 생성 시각 이하의 마지막 계정을 쓴다. 계정을 **삭제**하면 그 계정을 가리키던 이벤트의 `account_id` 가 NULL 로 남는데(§4.1), 이 NULL 이벤트도 타임라인에서 걸러내지 않고 "이 시점부터 활성 계정 없음"으로 유지한다 — 그래야 삭제 이후에 만든 세션이 삭제된 계정보다 앞선 다른 계정으로 잘못 되돌아가 귀속되지 않는다.

Claude 세션 중 인덱스는 있지만 원본 JSONL 파일이 디스크에 없는 경우(Claude Code 의 30일 지난 로컬 대화 자동 정리로 추정) 목록에는 그대로 노출하되 배지 "대화 기록 없음"을 달아 미리보기를 열 수 없게 하고, 도구 간 이관(Plan 3) 대상에서는 제외한다.

### 4.4 가져오기 (F4, F5)

1. 라이브러리에서 세션을 체크(복수 선택 가능, 프로젝트 체크박스로 프로젝트 전체 선택) → `[가져오기…]`. 대화 기록이 없는 세션은 체크할 수 없고, 한 번에 최대 200개까지 가져올 수 있다.
2. 대화상자: 대상 도구(Codex 원본은 Claude 고정, Claude 원본은 ChatGPT(Codex) 또는 Claude — Claude 대상은 선택한 세션이 모두 Code 세션일 때만 활성), Claude 대상 계정(현재 로그인 계정 또는 등록된 계정 — 로그인도 등록도 없으면 실행 차단), 이미 이관한 세션의 처리(건너뛰기 / 새 복사본 만들기).
3. 실행: 요청한 세션 키가 하나도 실제 세션으로 풀리지 않으면 앱을 건드리지 않고 취소한다. 그렇지 않으면 대상 앱 종료(D7) → 세션마다 독립된 트랜잭션으로 변환·쓰기·이력 기록 → 앱이 원래 실행 중이었으면 재실행. 진행 단계는 대화상자 안에 표시된다.
4. 결과: 세션별 가져옴 / 공유됨(포크) / 건너뜀 / 실패와 사유. 앱을 자동으로 재실행하므로 별도의 `[대상 앱 열기]` 는 없다. 이관된 세션은 라이브러리에서 `이관됨` 배지로 표시된다.

경로별 동작 요약 (상세는 architecture.md §6):

| 경로 | 동작 | 상태 |
|---|---|---|
| Codex → Claude | IR 변환 → Claude 세션 JSONL 새로 작성 + 대상 계정 폴더의 최신 인덱스를 템플릿으로 복제한 Desktop 인덱스 생성. 제목 `[Codex] 원제목` | `imported` |
| Claude Code / Cowork → Codex | IR 변환 → **paginated** rollout JSONL + `threads` 행(템플릿 행 복제) + `session_index.jsonl` 한 줄. 제목 `[Claude] 원제목`. Cowork 는 인덱스의 `userSelectedFolders[0]` 을 작업 폴더로 사용 | `imported` |
| Claude A → Claude B | **포크**: 새 `cliSessionId` 로 전사를 복사(`sessionId` 필드만 교체)하고, 원본 인덱스에서 템플릿 고유 필드를 제거한 인덱스를 B 폴더에 생성. **Claude Code 세션만**. 제목은 원제목 그대로 | `forked` |
| Codex A → Codex B | 불필요(이미 공유). 태그 재지정만 제공 | — |
| 프로젝트 단위 | GUI 에서 프로젝트 체크박스로 포함 세션을 일괄 선택. `AGENTS.md` ↔ `CLAUDE.md` 복사 제안은 이번 범위에서 **제외**(후속) | — |

공통 규칙:

- 원본은 읽기만 한다(D6). 대상에는 새 파일 생성, `session_index.jsonl` 추가(백업 후), `threads` 행 INSERT 만 한다.
- 이력은 `imports` 테이블에 기록한다(원본 키 · 대상 도구 · 대상 계정 키 · 새 세션 ID · 통계). 중복 정책 `skip` 은 같은 (원본, 대상 도구, 대상 계정) 이력이 있으면 건너뛰고, `copy` 는 새 복사본을 만든다.
- 대상에 템플릿으로 쓸 기존 항목(Claude: 대상 계정 폴더의 `local_*.json`, Codex: `threads` 행 + 그 rollout)이 없으면 "대상 계정에서 Code 세션을 하나 만든 뒤 다시 시도하세요" / "Codex 에서 세션을 하나 만든 뒤 다시 시도하세요" 로 실패한다.
- 작업 폴더를 알 수 없는 세션(예: `hostFolder` 없는 Cowork)은 항목 실패로 처리한다.

## 5. 변환 규칙 (D5 상세)

| 원본 항목 | Codex 표현 | Claude 표현 | 처리 |
|---|---|---|---|
| 사용자 텍스트 | `response_item/message` role=user, `input_text` | `type:user`, `message.content` 문자열 또는 `text` 블록 | 원문 보존 |
| 어시스턴트 텍스트 | `response_item/message` role=assistant, `output_text` | `type:assistant`, `text` 블록 | 원문 보존 |
| 도구 호출+결과 | `custom_tool_call` / `function_call` + `*_output` | `tool_use` 블록 + 다음 user 줄의 `tool_result` | 어시스턴트 텍스트 블록으로 요약: `🔧 [<원본도구>: <이름>] <입력요약>` + `→ <결과요약>` (각 최대 2KB, 초과 시 잘라내고 표시) |
| 추론 | `reasoning` (`encrypted_content`) | `thinking` 블록 | 폐기 |
| 시스템/환경 | `session_meta.base_instructions`, role=developer 메시지, `turn_context`, `world_state` | `system`, `attachment`, `queue-operation`, `mode`, hook 관련 | 폐기 |
| 대화 압축 | `compacted` (replacement_history) | compact 경계 | `replacement_history` 의 텍스트를 "이전 대화 요약" 사용자 메시지로 변환 |
| 서브에이전트 | `agent_message`, `thread_spawn_edges` | `isSidechain: true` | v1 에서 메인 스레드만 이관, 서브에이전트는 요약 한 줄 |
| 이관 표시 | — | — | 대상 세션 첫 메시지 앞에 안내 블록 추가: `이 세션은 <원본도구> '<원제목>' 에서 가져왔습니다 (원본 ID, 원본 일시)` |

역할 교대 규칙: 대상 형식이 user/assistant 교대를 요구하는 경우, 연속된 같은 역할 메시지는 하나로 병합한다.

**구현 기준 (Plan 3, `src/main/core/render.ts`, `src/main/providers/*/writer.ts`)**

- 도구 호출은 `🔧 [Codex: shell] <입력>` + 줄바꿈 + `→ <결과>` 로 렌더링한다(오류면 `→ (오류) …`, 결과가 없으면 `→ (결과 없음)`). 입력/결과는 reader 가 이미 2048자로 잘라 `… (N자 생략)` 을 붙인다. 압축 요약은 `[이전 대화 요약]` + 줄바꿈 + 본문(reader 에서 4096자).
- 서브에이전트 대화는 v1 에서 이관하지 않고 통계(`droppedSidechain`)로만 센다(위 표의 "요약 한 줄"은 구현하지 않음).
- 이관 안내는 IR `importNotice` 블록으로 만들어 항상 첫 user 메시지에 들어간다: `이 세션은 <원본도구> '<원제목>' 에서 가져왔습니다 (원본 ID <id>, <원본 생성 일시 ISO>)`. 원본이 user 메시지로 시작하면 그 앞에 병합하고, assistant 로 시작하면 안내만 담은 user 메시지를 앞에 넣는다.
- 같은 역할의 연속 메시지는 병합하며(더 이른 타임스탬프 유지), 텍스트가 빈 메시지는 버린다. 안내 메시지에 타임스탬프가 없으면 첫 실제 메시지의 것을 물려받는다.
- **Claude 대상(Codex → Claude)**: 새 `cliSessionId` 로 `~\.claude\projects\<enc(cwd)>\<id>.jsonl` 작성 — `parentUuid` 체인(첫 줄 null), `entrypoint:'claude-desktop'`, `version` 은 이 기기의 가장 최근 세션 줄의 값(없으면 `2.1.0`), assistant 줄의 `model` 은 원본 모델(없으면 `imported`), 끝에 `custom-title` 줄. 인덱스는 대상 계정 폴더의 최신 `local_*.json` 을 복제해 `sessionId, cliSessionId, cwd, originCwd, title, titleSource('user'), createdAt/lastActivityAt/lastFocusedAt(현재 시각, 템플릿의 숫자/문자열 타입 유지), isArchived(false), completedTurns(assistant 메시지 수), permissionMode('default'), model` 만 교체하고 아래 필드는 지운다.
- **인덱스에서 제거하는 필드** (템플릿 세션에 묶인 상태를 새 세션이 물려받지 않게): ① 권한·승인 상태(`sessionPermissionUpdates, alwaysAllowedReasons, bypassChosenInApp, chromePermissionMode, cuAllowedApps, cuGrantFlags, autoChosenInApp`) — 새 세션이 템플릿에서 허용한 권한을 그대로 갖지 않도록 제거하고 `permissionMode` 도 `default` 로 되돌린다. ② MCP 설정(`enabledMcpTools, remoteMcpServersConfig`). ③ 원격·SSH 신원(`sshConfig, sshRemoteProcessId, sshRemoteTranscriptPath`). ④ 오류·전사 상태(`error, errorAt, transcriptUnavailable`) — 새 세션이 오류/기록 없음 상태로 표시되지 않게. ⑤ 템플릿 대화 참조(`lastAssistantUuid, forkedFromSessionId, planPath, scratchPromptRecents, spawnSeed, promptAppendSnapshot, toolSurfaceSnapshot, titleTurn, writtenBranches, sourceBranch, publishedArtifacts, initialMessage, systemPrompt`) — 다른 대화의 메시지·브랜치를 가리키는 값.
- **Claude 포크(A → B)**: 원본 전사를 줄 단위로 복사하며 `sessionId` 만 새 `cliSessionId` 로 바꾼다(원본 전사와 같은 프로젝트 폴더에 새 파일, 파싱 안 되는 줄은 그대로). 인덱스는 위 규칙으로 **원본 인덱스를 템플릿 삼아** 만들어 B 계정 폴더에 쓴다 — `cwd`/`title`/`completedTurns` 는 원본 값을 유지한다.
- **Codex 대상(Claude → Codex)**: 실제 앱과 같은 **paginated** 형식으로 쓴다. 봉투는 `{ordinal, timestamp, type, payload}` (`ordinal` 은 0부터 줄마다 +1). `session_meta` 는 템플릿 rollout 의 것을 복제해 `id/session_id/timestamp/cwd` 를 교체하고 `history_mode:'paginated'` + 새 `context_window.window_id` 를 넣는다. `turn_context` 는 템플릿 것에서 템플릿 cwd·`turn_id`·`root_turn_id` 를 치환하고 `comp_hash` 를 제거한다. user 메시지마다 턴 하나: `task_started` → user `response_item/message` + `event_msg/item_completed`(`UserMessage`) → 뒤따르는 assistant 메시지마다 `response_item/message` + `item_completed`(`AgentMessage`, 마지막만 `phase:'final_answer'`, 나머지 `commentary`) → `task_complete`. **`item_completed` 가 없으면 앱이 대화를 빈 화면으로 보여준다**(V7). 시각 필드는 숫자여야 한다: `started_at`/`completed_at` 은 epoch **초** 정수, 메시지 메타데이터 `create_time` 은 **초** 실수, `completed_at_ms`/`duration_ms` 는 **밀리초** 정수(문자열이면 그 줄을 건너뜀 — V7).
- **Codex `threads` 행**: 템플릿 행(`source='vscode'` 중 cwd 가 같은 행, 없으면 가장 최근 행)을 복제해 `id/title/name/preview/first_user_message`, 시각(`created_at`/`updated_at` 초, `*_ms` 밀리초), `has_user_event=1`, `history_mode='paginated'`, `archived=0` 등을 교체한다. `cwd` 에는 `\\?\` 접두어를 붙이고 `rollout_path` 에는 붙이지 않는다(실제 DB 관찰). `sandbox_policy` 와 `turn_context` 안의 템플릿 cwd 는 경로 경계를 인식하는(`C:\work` 가 `C:\work-backup` 을 건드리지 않는) 대소문자 무시 치환으로 새 cwd 로 바꾼다. `session_index.jsonl` 의 `updated_at` 은 ISO 문자열이다. `project_id` 는 cwd 를 포함하는 가장 깊은 `project_roots` 로 정하며, 앱은 cwd 가 프로젝트 루트와 같으면 `.codex-global-state.json` 을 고치지 않아도 그 프로젝트 아래에 보여준다(V7).
- **롤백**: 세션 하나 = `FsTransaction` 하나. 실패하면 생성한 파일 삭제, 수정한 `session_index.jsonl` 원복, 이미 커밋된 `threads` INSERT 는 `onRollback` 으로 등록한 보정 `DELETE` 로 되돌린다. 되돌리기 자체가 실패하면 그 항목을 `failed` 로 두고 사유에 "되돌리기 실패: 수동 확인이 필요합니다 (대상 도구, 새 세션 ID)" 와 원인을 붙인다.

## 6. 검증 단계 (Phase 0 — 구현 전 필수)

비공식 내부 형식에 의존하므로, 기능 구현 전에 아래 항목을 **실제 앱으로 수동/스크립트 검증**한다. 각 항목은 결과에 따라 설계가 어떻게 바뀌는지가 정해져 있다.

| ID | 검증 내용 | 통과 시 | 실패 시 |
|---|---|---|---|
| V1 | Codex: 앱 종료 후 `auth.json` 만 교체 → 재실행 시 B 계정으로 코드 기능 동작 | F2 Codex 확정 | 교체 파일 세트 확장 (Electron 프로필 포함) |
| V2 | ChatGPT 앱의 **채팅** 로그인이 `auth.json` 을 따르는지, 라이브 웹 프로필(`LocalCache\Roaming\Codex\web\Codex\Default\Network\Cookies` 등, 루트 바로 아래 `Network`/`Local State`/`Local Storage` 는 4월 이후 갱신 안 됨)을 따르는지 | 최소 교체 세트 확정, 분리 전환(v1.1) 가능성 판단 | — (결과를 문서에 기록) |
| V3 | Claude: `.credentials.json` + `~/.claude.json` 의 `oauthAccount` + `%APPDATA%\Claude\config.json` 의 `oauth:tokenCache`/`oauth:tokenCacheV2`/`lastKnownAccountUuid` 교체만으로 Desktop 이 B 로 로그인되는지, Desktop 쿠키(`%APPDATA%\Claude\Network\Cookies`)도 필요한지 | 최소 교체 세트 확정 | 쿠키 + `Local State` + `Local Storage` 포함 |
| V4 | 토큰 rotation: A → B → A 전환 후 A 가 로그아웃되지 않는지 (전환 직전 스냅샷 갱신 효과) | F2 확정 | 전환 시 앱 종료 대기 후 재갱신 등 보완 |
| V5 (**→ Plan 3, 포크 방식으로 변경 — 대기**) | Claude A 의 세션을 B 로 **포크**(전사 복사 + B 폴더에 새 인덱스, D14) → B 로그인 상태에서 목록 표시 + resume | F4 Claude 확정 | 인덱스 필드 조정 (`cwd`, 권한 등 — 제거 필드 목록 재검토) |
| V6 (**대기**) | Codex → Claude 변환 JSONL + 인덱스 → Desktop Code 탭 목록 표시, 이어서 대화 가능, `claude --resume` 도 동작 (Claude Desktop 종료가 필요해 별도 세션에서 수행 — [수행 방법](../../verification/phase0-migration.md)) | F5 확정 | 최소 필드 세트 재조사 |
| V7 (**결과: 통과** — [기록](../../verification/phase0-migration.md), 2026-09-29) | Claude → Codex rollout + `threads` 행 → Codex 앱 목록 표시, `thread_history_1.sqlite` 자동 재구성, 이어서 대화 가능 | F5 확정 (**`item_completed` 이벤트 + 숫자 시각 필요** — 아래 실측 참고) | `thread_history` 직접 작성 여부 조사 |
| V8 (**결과: 통과**) | Cowork 세션 구조 (`local-agent-mode-sessions/<acct>/<org>/local_<id>/`, `.claude/`, `audit.jsonl`) 읽기 가능성 | F3 Cowork 읽기 포함 | Cowork 는 v2 로 이동 |
| V9 (**대기**) | Codex 세션을 다른 GPT 계정에서 resume 시 `encrypted_content` reasoning 거부 여부 | 문제 없음 → 추가 작업 없음 | "reasoning 제거 복사본으로 이어하기" 기능 추가 |
| V10 (**결과: 통과, 예외 반영**) | Claude 프로젝트 폴더명 인코딩 규칙 (영숫자 외 문자 → `-`) 이 긴 경로/한글 경로에서도 동일한지 | 인코더 확정 | 예외 규칙 반영 |

**Phase 0 실측 결과 (2026-09-28, 실제 파일 — 키/경로만 관찰):**

- **V5**: 쓰기 검증(대상 계정 폴더에 실제로 복사해 봐야 함)이라 Plan 2(조회 전용)의 범위를 벗어남 → **Plan 3 로 이동**. 구현에서는 인덱스만 복사(전사 공유)하는 대신 **포크**로 바꿨다(D14) — 실기기 검증은 Claude 계정 2개 등록이 필요해 대기.
- **V8 (Cowork) — 통과.** 인덱스는 `local-agent-mode-sessions\<acct>\<org>\local_<id>.json` (키: `sessionId, cliSessionId, cwd(/sessions/<name>), title, createdAt, lastActivityAt, isArchived, userSelectedFolders, emailAddress, accountName, model …`). 본문은 `…\local_<id>\.claude\projects\<enc>\<cliSessionId>.jsonl` 이며 줄 형식이 Claude Code 세션과 동일 → Claude reader 가 Code 와 같은 파서로 Cowork 도 읽는다. 조회 시 Cowork 는 프로젝트 목록에서 별도 그룹(`Cowork 세션`)으로 묶는다.
- **V10 (폴더 인코딩) — 통과, 예외 2건 반영.** 로컬 경로는 `cwd.replace(/[^A-Za-z0-9]/g,'-')` 규칙이 11/11 일치. 예외: (a) 세션 도중 작업 폴더를 옮기면 파일 첫 `cwd` 는 옛 경로로 남는다, (b) SSH 원격 세션은 폴더명이 `ssh-<uuid>`. → 조회는 **폴더명이 아니라 파일 안 마지막 `cwd`** 로 그룹을 묶고, `ssh-*` 폴더는 "원격" 프로젝트로 별도 표시한다. 인코딩 규칙 자체는 Plan 3 writer 가 쓴다.
- **Codex 경로**: `~\.codex` 는 `C:\codex_home` 으로의 **정션(junction)** 이고, `threads.rollout_path`/`cwd` 값에는 `\\?\C:\…` 긴 경로 접두어가 붙는다 → 경로 비교 전 `normalizeWinPath` 로 접두어를 제거한다.
- **Codex 세션**: `threads.source` 컬럼이 `vscode` 같은 단순 문자열이거나 `{"subagent":{"thread_spawn":{"parent_thread_id":…}}}` 형태의 JSON(서브에이전트)일 수 있다. `created_at`/`updated_at` 은 초 단위. 사용자 메시지 안에 `<environment_context>`, `# AGENTS.md instructions` 같은 **주입 문맥**이 role=user 로 실제 프롬프트와 섞여 들어온다 → 서브에이전트는 기본적으로 목록에서 숨기고(부모 스레드에 연결), 주입 문맥은 system 으로 분류해 조회에서 제외한다.

**V7 실측 결과 (2026-09-29, Plan 3 구현 후 실기기 — 상세: [docs/verification/phase0-migration.md](../../verification/phase0-migration.md)):**

- **통과** — 이관한 Claude Code 세션이 Codex 앱의 목록·프로젝트·대화 화면에 나타나고 이어서 보낸 메시지에 응답이 왔다. 세 번의 시도로 다음을 확인했다.
  - 앱의 대화 표시(`thread_history_1.sqlite` 의 `thread_items`)는 `response_item` 이 아니라 **`event_msg/item_completed`**(`UserMessage`/`AgentMessage`)로 만들어진다 → writer 가 메시지마다 `item_completed` 를 쓴다.
  - `task_started`/`task_complete` 의 `started_at`/`completed_at` 은 **정수 epoch 초**, 메시지 메타데이터 `create_time` 은 **초 단위 실수**여야 한다(문자열이면 그 줄을 건너뜀) → 시각 필드를 숫자로 쓴다.
  - **프로젝트 분류**는 세션의 `cwd` 가 프로젝트 루트와 같으면 되며 `.codex-global-state.json` 은 고치지 않아도 된다.
  - **캐시 주의**: 앱은 한 번 읽은 세션의 읽은 위치(`thread_history_projection_state`)를 기록해 다시 읽지 않는다. 형식이 잘못된 이관 세션은 파일을 고쳐도 다시 표시되지 않으므로 앱에서 보관/삭제한 뒤 새로 이관(`--copy`)해야 한다.
- V6(Codex → Claude), V5(Claude 계정 A → B 포크), V9 는 아직 실기기 검증 전이다.

검증 결과는 `docs/verification/` 에 항목별로 기록하고, 이 문서의 해당 결정을 갱신한다.

## 7. 에러 처리

| 상황 | 처리 |
|---|---|
| 대상 앱이 종료되지 않음 | 강제 종료 여부 확인. 거부 시 작업 취소, 아무것도 변경하지 않음 |
| 전환 중 파일 복사 실패 (잠금, 권한) | 백업으로 롤백 → 오류 메시지 + 백업 위치 안내 |
| 전환 후 신원 불일치 (쓴 파일을 다시 읽어 확인하는 검증이라, 실제로는 대부분 **쓰기 자체의 실패**를 잡아냄 — 계정이 다른 게 아니라 교체가 반영되지 않은 경우) | 롤백 + "앱 버전 변경으로 인증 형식이 바뀌었을 수 있음" 안내 |
| 스냅샷 복호화 실패 (다른 Windows 사용자/PC) | 해당 계정 "재등록 필요" 상태로 표시 |
| 이관 중 일부 세션 실패 | 세션 단위로 독립 처리(`FsTransaction`). 실패한 세션만 정리(생성 파일 삭제, `session_index.jsonl` 원복, `threads` INSERT 는 보정 `DELETE`), 나머지는 유지. 결과 요약에 사유 표시. **되돌리기 자체가 실패하면** 그 항목의 사유에 수동 확인이 필요하다는 안내(대상 도구·새 세션 ID)와 원인을 함께 표시 |
| 이관 요청 키가 전부 알 수 없는 세션 (낡은 목록 등) | 대상 앱을 종료/재실행하지 않고 즉시 취소("가져올 수 있는 세션이 없습니다"). 일부만 알 수 없는 키면 그 항목만 실패 |
| SQLite 스키마 불일치 (컬럼 추가/삭제) | 쓰기 전 `PRAGMA table_info` 로 필수 컬럼 확인. 불일치 시 해당 도구 쓰기 비활성화 + 경고 (읽기는 유지) |
| 알 수 없는 JSONL 줄 타입 | 조회/변환 시 건너뛰고 카운트. 미리보기에 "알 수 없는 항목 n개" 표시, 로그에 타입명만 기록 |
| 도구 버전 변경 감지 | 알려진 버전 범위(`cli_version`, Claude `version`) 밖이면 쓰기 전 경고 |
| 백업 누적 | 도구별 최근 20개 유지, 설정에서 변경 가능 |

## 8. 테스트 전략

| 계층 | 내용 | 도구 |
|---|---|---|
| 단위 | reader(원본 → IR), writer(IR → 대상), 요약기, 경로 인코더, 신원 추출 | Vitest |
| 픽스처 | 실제 파일 구조를 본뜬 **합성 픽스처** (실사용 대화/토큰은 저장소에 절대 커밋하지 않음). 줄 타입별 최소 샘플 | `test/fixtures/` |
| 왕복 | Codex → IR → Claude → IR, Claude → IR → Codex → IR 에서 텍스트 메시지 동일성 | Vitest |
| 계약 | writer 출력이 실제 앱 파일에서 도출한 스키마(zod)를 만족하는지 | zod |
| 통합 | 가짜 HOME/APPDATA 임시 폴더 + 임시 SQLite 로 switcher/importer 전체 흐름. 모든 경로는 주입식(`PathProvider`) | Vitest + tmp dir |
| 프로세스 | 앱 종료/실행은 `ProcessController` 인터페이스로 추상화, 테스트에서는 fake | Vitest |
| E2E (수동) | Phase 0 체크리스트(V1~V10)를 릴리스마다 재실행 | 문서화된 체크리스트 |

## 9. 리스크

| 리스크 | 영향 | 완화 |
|---|---|---|
| 앱 업데이트로 내부 형식 변경 | 전환/이관 실패 | 쓰기 전 스키마·버전 검사, 알 수 없는 형식이면 쓰기 차단(읽기는 유지), 변환 로직을 provider 모듈로 격리 |
| 인증 파일 손상 | 로그인 불가 | 모든 쓰기 전 백업 + 자동 롤백 + 수동 복원 UI |
| 약관 문제 | 계정 제재 | 본인 소유 계정 전환 용도로 한정, 자동 로테이션 기능 미제공, README 에 고지 |
| 민감정보 노출 | 토큰 유출 | DPAPI 암호화, 값 로깅 금지, 픽스처는 합성 데이터만 |
| MCP OAuth 토큰 동반 교체 | `.credentials.json` 의 `mcpOAuth` 도 계정별로 바뀜 | 의도된 동작으로 명시 (계정별 MCP 연결 유지) |

**알려진 제한 (Plan 1 구현 기준)**
- 스냅샷 복호화 실패는 손상/다른 PC 뿐 아니라 일시적 오류(디스크 I/O 등)에도 해당 계정을 "재등록 필요" 상태로 표시한다 — 재시도 구분 없음.
- 강제 종료/독립 CLI/미등록 계정 저장 확인 프롬프트 진행 중 Ctrl+C 또는 비TTY 입력은 별도로 처리하지 않는다.
- Claude 쪽 `~/.claude.json` 이 손상된 JSON이면 원본 `SyntaxError` 가 그대로 노출된다 (Codex `auth.json` 손상은 `codex: auth.json 손상됨` 메시지로 별도 처리됨).
- 프로세스 간 잠금이 없다 — `switchTo`/`restoreBackup` 의 진행 중 가드는 프로세스(=CLI 실행 1회) 안에서만 유효해서, 서로 다른 터미널에서 동시에 `switch`/`restore` 를 실행하면 막지 못한다.
- `list` 는 스냅샷 파일 경로는 보여주지만 그 범위(`--with-app-profile` 로 저장했는지)는 보여주지 않는다.
- npm 으로 설치한 `claude`/`codex` CLI 는 대개 `node.exe` 프로세스로 실행되어, 프로세스 이름 기준의 독립 실행 CLI 감지(`classifyProcesses`)에 걸리지 않는다.
- `--with-app-profile` 로 전환할 때마다 대용량 DPAPI 호출(암호화/복호화)이 여러 번 발생해 느리다 — PowerShell 호출은 30초 타임아웃으로 보호되어, 시간 초과 시 아무것도 쓰지 않고 안전하게 중단된다.
- `restore` 는 전환 대상(outgoing) 계정의 스냅샷을 갱신하지 않는다. 복원하려는 시점의 현재 로그인이 정상적으로 등록된 계정이면, `restore` 전에 `save <tool> <라벨>` 로 먼저 갱신해 둔다.
- `.prev.bin` 은 직전 한 세대만 보관한다 — 잘못된 상태로 두 번 연속 갱신하면 두 스냅샷 모두 덮어써지고, 더 오래된 백업 파일만 남는다.

## 10. 마일스톤

| 단계 | 내용 | 완료 조건 |
|---|---|---|
| M0 | Phase 0 검증 (V1~V10) | `docs/verification/` 기록 + 본 문서 갱신 |
| M1 | 코어: PathProvider, 신원 추출, 스냅샷 저장소, switcher (UI 없이 CLI/테스트로 동작) | 통합 테스트 통과, 실제 A↔B 전환 성공 |
| M2 | 조회: Codex/Claude reader, IR, 라이브러리 UI | 실제 로컬 세션 전체가 목록/미리보기에 표시 |
| M3 | 이관: writer 양방향, 인덱스 등록, 이관 이력 | V6/V7 시나리오가 앱에서 재현 |
| M4 | 마감: 에러 처리, 백업 관리, 설치 파일(NSIS) | 수동 E2E 체크리스트 통과 |
