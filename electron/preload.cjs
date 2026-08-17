// Renderer에 파일 API 노출 — 게임 코드는 window.gameFS만 사용한다 (§9.2)
// quit()은 관리자 3초 홀드 종료가 쓰는 채널이다. Esc 종료 경로는 두지 않는다 (§13 G8).
// health()·logError()는 WU-06 §12.3(STORAGE LOW · SERVICE REQUIRED · SAVE FAILED)이 쓴다.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gameFS', {
  write: (name, content) => ipcRenderer.invoke('gamefs:write', name, content),
  read: (name) => ipcRenderer.invoke('gamefs:read', name),
  append: (name, line) => ipcRenderer.invoke('gamefs:append', name, line),
  quit: () => ipcRenderer.invoke('app:quit'),
  // 관리자 `RESTART GAME`(H 2초 홀드) 전용 채널 (§11.7 · admin §10.6)
  restart: () => ipcRenderer.invoke('app:restart'),
  // §12.3 — 치명 오류 횟수 · 디스크 여유 · machine.json (WU-06 P-8 · P-11)
  health: () => ipcRenderer.invoke('gamefs:health'),
  // SAV-702 — 렌더러 저장 실패를 `error_YYYY-MM-DD.log`에 남긴다 (WU-06 P-13)
  logError: (message) => ipcRenderer.invoke('app:logError', message),
});
