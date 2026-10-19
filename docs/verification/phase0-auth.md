# Phase 0 — 인증 전환 검증 (V1~V4)

## 준비
- GPT 계정 2개(A, B), Claude 계정 2개(A, B) — 본인 소유
- Claude 뿐 아니라 **Codex 전환도** 앱 안의 터미널에서 실행하지 말 것 — 앱이 닫힐 때 CLI 도 같이 종료될 수 있다. 별도 Windows Terminal/PowerShell 에서 `npm run cli -- ...` 로 실행한다.
- 각 단계 전후로 `npm run cli -- current <tool>` 결과를 기록한다.
- 독립 실행 중인 `claude`/`codex` CLI(앱이 띄운 것이 아니라 터미널에서 직접 실행한 것)가 있으면 `switch` 시 "그래도 진행할까요?" 확인이 뜬다 — 검증 중에는 미리 닫아 둔다.
- `switch`/`restore` 전에 앱을 트레이 메뉴에서 **완전 종료**하는 것을 권장한다.
  - 창 닫기만 하면 트레이로 숨거나 보조 프로세스(claude-ssh-broker, codex-code-mode-host, `OpenAI\Codex\runtimes` 의 node 등)가 남아, 10초 뒤 "강제 종료할까요?" 가 뜬다.
  - y 도 안전하지만 앱이 아직 저장하지 않은 쿠키/설정이 유실될 수 있다.
  - N 이나 Ctrl+C 로 빠지면 아무 파일도 쓰지 않지만, 앱은 닫힌(또는 트레이에 숨은) 채로 남는다 — 직접 다시 연다.
- `save` 때 준 `--with-app-profile` 옵션은 같은 계정으로 `switch` 할 때도 똑같이 줘야 한다. 다르면(예: A 는 `--with-app-profile` 없이 저장하고 B 는 붙여서 저장) 범위 불일치로 전환이 취소된다.
- 두 번째 이후 계정을 등록할 때는 **앱에서 로그아웃하지 말 것**. GUI 의 [새 계정 추가] 버튼(또는 `npm run cli -- add <tool>`)을 쓴다 — 현재 계정을 저장·백업한 뒤 로그아웃 없이 로그인 정보만 비우고 앱을 다시 연다. 그 상태에서 앱에 새 계정으로 로그인한 뒤 `save <tool> <라벨>` 로 등록한다.
  - **경고: 앱 안에서 직접 로그아웃하면 그 계정의 저장된 토큰이 서버에서 즉시 폐기(revoke)된다.** "저장 → 로그아웃 → 다른 계정 로그인" 순서로 등록하면 방금 저장한 스냅샷이 곧바로 무효화된다 — 관찰(2026-09-23): `account/logout` 호출이 15:28:19 에 찍힌 직후, 그 계정의 저장된 스냅샷으로 복원해도 401 "Encountered invalidated oauth token" 이 발생했다. 이미 로그아웃해버렸다면 그 계정에 다시 로그인한 뒤 같은 라벨로 `save` 를 다시 실행해 스냅샷을 갱신해야 한다.
- `save` 가 "이미 'A' 로 등록되어 있습니다 … 아무것도 저장하지 않았습니다" 로 거부하면, 앱의 계정 변경이 아직 인증 파일에 반영되지 않은 것이다. 다른 라벨로 재시도하지 말고 `current` 로 확인한다. 두 번 저장한 뒤 `list` 에 두 줄이 보여야 한다.
- 이미 활성 상태인 계정으로 다시 `switch` 해도 안전하다 — 인증 파일을 새로 쓰지 않고 해당 계정 스냅샷만 최신 상태로 갱신한 뒤 앱을 실행한다.
- 백업은 `%APPDATA%\ai-account-bridge\backups\<tool>\` 에 쌓인다. 자체 DB(`app.db`)와 계정 스냅샷(`profiles\<tool>\`)도 `%APPDATA%\ai-account-bridge\` 아래에 있다.
- `restore` 는 대상 앱을 트레이에서 **완전 종료한 뒤** 실행한다. `--with-app-profile` 이면 필수 — 앱 실행 중에는 쿠키 파일이 잠겨 범위 확인 단계에서 EBUSY 로 실패한다(아무것도 쓰지 않음).
- **복구**: 모든 `switch`/`restore` 는 쓰기 직전 상태를 `%APPDATA%\ai-account-bridge\backups\<tool>\*.bin` 에 남긴다. 되돌리려면 `npm run cli -- restore <tool> "<백업 경로>"` 를 실행한다.
  - 원래 전환에 `--with-app-profile` 을 썼다면 restore 에도 붙인다.
  - restore 도 직전 상태를 새 백업으로 남기고 그 경로를 출력한다.
  - "롤백 실패" 오류에는 실행할 restore 명령이 포함되어 있다. 계정 스냅샷의 직전 버전(`profiles\<tool>\<키>.prev.bin`)도 같은 명령으로 복원할 수 있다.
- restore 하려는데 현재 로그인이 정상인 등록 계정이면, 먼저 `save <tool> <그 라벨>` 로 스냅샷을 갱신한다. restore 는 스냅샷을 갱신하지 않는다.
- 검증 중에는 "미등록입니다. 저장할 라벨" 질문에 항상 라벨을 입력한다.
- `~/.claude.json` 이 손상되면(JSON 오류) Claude 쪽은 switch 와 restore 모두 거부된다. Claude Code 가 만든 `~\.claude.json.backup` 으로 먼저 복구한다.
- 로그인 저장소는 로그인/로그아웃 전후의 **수정 시각 비교**로 확인한다(파일 내용은 열지 않음): `Get-Item <경로> | Select FullName, LastWriteTime`
  - Codex: `~\.codex\auth.json`, `%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Roaming\Codex\web\Codex\Local State`, `...\web\Codex\Default\Network\Cookies`
  - Claude: `~\.claude\.credentials.json`, `~\.claude.json`, `%APPDATA%\Claude\config.json`, `%APPDATA%\Claude\Network\Cookies`

## V1 — Codex: auth.json 만 교체
1. ChatGPT 앱에서 A 로그인 → `npm run cli -- save codex A`
2. GUI [새 계정 추가] (또는 `npm run cli -- add codex`) → 앱이 로그인 화면으로 열리면 B 로그인 → `npm run cli -- save codex B` (**앱 안의 로그아웃 금지**)
3. `npm run cli -- switch codex A`
4. 앱이 자동 실행되면 **Codex(코드) 화면**에서 계정/설정의 이메일 확인, 간단한 작업 1회 실행
- 통과: 코드 쪽이 A 로 동작

## V2 — ChatGPT 채팅 쪽 로그인 출처
1. V1 직후 상태에서 **채팅 화면**의 계정 이메일 확인
2. A 면 → 채팅도 auth.json 을 따름 (최소 세트 = auth.json)
3. B 면 → 채팅은 Electron 프로필을 따름. 앱 종료 후 `--with-app-profile` 로 A/B 를 다시 `save` 하고 `switch` 재시도, 채팅 이메일 확인
- 기록: 채팅/코드 각각 어떤 파일을 따르는지 → 분리 전환(v1.1) 가능 여부
- `--with-app-profile` 는 앱 실행 중에 쿠키 파일이 잠겨 save 가 EBUSY 로 실패한다. 순서:
  1. 앱에서 A 로그인 → 앱 완전 종료 → `npm run cli -- save codex A --with-app-profile`
  2. 앱 실행, B 로그인 → 앱 완전 종료 → `npm run cli -- save codex B --with-app-profile`
  3. `npm run cli -- switch codex A --with-app-profile`
  - 두 계정 모두 같은 옵션으로 저장해야 한다(현재 로그인 계정도 범위 검사를 받는다).
  - 프로필 범위 = `web\Codex\Local State`, `web\Codex\Default\Network`, `web\Codex\Default\Local Storage`.

## V3 — Claude: .credentials.json + oauthAccount 교체
1. Claude 앱에서 A 로그인 → (별도 터미널) `npm run cli -- save claude A`
2. GUI [새 계정 추가] (또는 `npm run cli -- add claude`, 별도 터미널) → Claude 가 로그인 화면으로 열리면 B 로그인 → `npm run cli -- save claude B` (**앱 안의 로그아웃 금지** — Claude 도 로그아웃 시 토큰이 폐기될 수 있음)
3. `npm run cli -- switch claude A`
4. Desktop 채팅 화면 계정, Code 탭 계정, `claude` CLI 의 `/status` 계정 확인
- B 로 남는 화면이 있으면 → `--with-app-profile` 로 재등록·재시도 후 기록
- 기본 범위 = `~\.claude\.credentials.json` + `~/.claude.json` 의 `oauthAccount` + `%APPDATA%\Claude\config.json` 의 `oauth:tokenCache`, `oauth:tokenCacheV2`, `lastKnownAccountUuid`. `--with-app-profile` 은 여기에 `Network`, `Local State`, `Local Storage` 를 더한다.
- Desktop 에서 계정을 바꾼 직후 save 가 "계정 정보 불일치" 로 거부되면, Desktop 의 Code 탭을 한 번 열어 `~/.claude.json` 이 갱신되게 한 뒤 앱을 완전 종료하고 다시 save 한다.
- switch 후 `current claude` 가 "계정 정보 불일치" 를 내거나 이전 계정으로 돌아가면, Desktop 이 쿠키 쪽 로그인으로 되돌린 분리 상태다.
  - **추가 switch 를 하지 말고** 기록한 뒤, `restore` 로 전환 직전 백업을 되돌린다.
  - 그다음 두 계정을 `--with-app-profile` 로 다시 save 하고(앱 완전 종료 상태에서) 재시도한다.
- `.credentials.json` 은 2026-06-20 이후 갱신되지 않았다(Desktop 은 이 파일을 쓰지 않음). A/B 사이에 수정 시각이 안 바뀌면 `claude /status` 로는 계정을 구분할 수 없다. CLI 계정까지 검증하려면 별도 터미널에서 `claude /login` 으로 각 계정에 로그인한 뒤 save 한다.

## V4 — 토큰 rotation
1. A 로 전환 후 30분 이상 실제 사용 (토큰 갱신 유도)
2. B 로 전환 → 다시 A 로 전환
3. A 가 로그인 상태로 열리는지 확인 (Codex, Claude 각각)
- 통과: 재로그인 없이 사용 가능
- rotation 발생 여부를 수정 시각으로 확인한다.
  - Codex `auth.json` 은 수일 단위로만 갱신된다(현재 파일은 9/14 수정). Claude Desktop 토큰은 `config.json` 에 있다.
  - 전환 전후로 변화가 없으면 V4 는 **미검증**으로 기록한다.

## 결과
| ID | 도구 | 결과 (통과/실패) | 최소 교체 세트 | 메모 |
|---|---|---|---|---|
| V1 | Codex | 통과 | auth.json | 두 계정 간 전환 후 재로그인 없이 동작 (단, 로그아웃으로 토큰이 폐기됐던 계정은 재로그인 후). 검증 중 MSIX 업데이트 대기(오류 0x80073D28)로 앱이 실행되지 않는 문제가 발생 — 관리자 권한으로 업데이트해 해결. 이후 도구는 전환/복원 후 앱이 뜨지 않으면 경고를 표시한다 |
| V2 | ChatGPT 채팅 | | | |
| V3 | Claude | | | |
| V4 | 둘 다 | | | |
