; 설치 마법사 보완 (tauri.conf.json 의 bundle.windows.nsis.installerHooks) — 스크립트 앞부분에 포함된다.
; 설치 범위(나만/모든 사용자) 화면 문구: NSIS 의 Korean.nsh 에 없어 영어로 나오던 것을 MUI_LANGUAGE 보다 먼저 정의해 채운다.
!define MULTIUSER_TEXT_INSTALLMODE_TITLE "설치 범위 선택"
!define MULTIUSER_TEXT_INSTALLMODE_SUBTITLE "$(^NameDA)을(를) 누가 쓰도록 설치할지 선택하세요."
!define MULTIUSER_INNERTEXT_INSTALLMODE_TOP "$(^NameDA)을(를) 나만 쓰도록 설치할지, 이 컴퓨터의 모든 사용자가 쓰도록 설치할지 선택하세요. $(^ClickNext)"
!define MULTIUSER_INNERTEXT_INSTALLMODE_ALLUSERS "이 컴퓨터를 쓰는 모든 사용자"
!define MULTIUSER_INNERTEXT_INSTALLMODE_CURRENTUSER "나만 쓰기"
