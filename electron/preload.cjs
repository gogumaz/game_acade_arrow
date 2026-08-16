// Renderer에 파일 API 노출 — 게임 코드는 window.gameFS만 사용한다 (§9.2)
// quit()은 WU-06의 관리자 3초 홀드 종료가 쓰는 채널이다. Esc 종료 경로는 두지 않는다 (§13 G8).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gameFS', {
  write: (name, content) => ipcRenderer.invoke('gamefs:write', name, content),
  read: (name) => ipcRenderer.invoke('gamefs:read', name),
  append: (name, line) => ipcRenderer.invoke('gamefs:append', name, line),
  quit: () => ipcRenderer.invoke('app:quit'),
  // 관리자 `RESTART GAME`(H 2초 홀드) 전용 채널 (§11.7 · admin §10.6)
  restart: () => ipcRenderer.invoke('app:restart'),
});
