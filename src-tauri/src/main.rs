// AI Account Bridge 창 껍데기. 화면은 gui/ 의 정적 파일이고, 백엔드 사이드카(aab-backend) 실행과 줄 단위 JSON 통신은
// gui/bridge.js 가 셸 플러그인으로 맡는다 — 여기서는 플러그인만 등록한다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        // 두 번 실행하면 새 창을 띄우지 않고 이미 열린 창을 앞으로 가져온다(백엔드가 둘 뜨지 않게). 가장 먼저 등록해야 한다.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("AI Account Bridge 를 시작하지 못했습니다");
}
