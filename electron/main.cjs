// Electron 메인 프로세스 (§9.3 안전 쓰기 · §9.4 치명 오류 · §1.4 키오스크)
// - 전체화면·키오스크는 패키징 빌드에서만 활성
// - 모든 쓰기는 safe-write.cjs의 단일 직렬 큐를 통과한다 (§9.3)
// - 저장 위치: 실행 폴더 기준 ./log/ (§9.1 · 부록 E.3)
//
// WU-01 범위는 골격이다. 저장 실패 화면·오류 문구 마감(§9.6 · 부록 A)과
// DIA-001·DIA-002 실동작 판정은 WU-06이다.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const {
  createSafeWriter,
  createCrashWindow,
  SYSTEM_ERROR_RESTART_MS,
} = require('./safe-write.cjs');

// portable 빌드는 임시 폴더에서 실행되므로 실제 exe 위치(PORTABLE_EXECUTABLE_DIR)를 우선한다
const LOG_DIR = app.isPackaged
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe')), 'log')
  : path.join(process.cwd(), 'log');

const ERROR_LOG_RETENTION_DAYS = 90; // §9.1

let win = null;

function dateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function appendErrorLog(message) {
  try {
    ensureLogDir();
    const file = path.join(LOG_DIR, `error_${dateStr()}.log`);
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    /* 로그 실패는 무시 */
  }
}

/** 90일 지난 오류 로그 삭제 (§9.1) */
async function pruneOldErrorLogs() {
  try {
    const files = await fsp.readdir(LOG_DIR);
    const cutoff = Date.now() - ERROR_LOG_RETENTION_DAYS * 24 * 3600 * 1000;
    for (const f of files) {
      const m = /^error_(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (m && new Date(m[1]).getTime() < cutoff) {
        await fsp.unlink(path.join(LOG_DIR, f));
      }
    }
  } catch {
    /* 무시 */
  }
}

// ── 단일 직렬 쓰기 큐 (§9.3) ──

const storage = createSafeWriter({ fsp, dir: LOG_DIR, ensureDir: ensureLogDir });

// 관리자 3초 홀드 종료가 쓰는 채널 (WU-06). Esc 종료 경로는 두지 않는다 (§13 G8).
ipcMain.handle('app:quit', () => {
  app.quit();
});

ipcMain.handle('gamefs:write', (_e, name, content) => storage.write(name, String(content)));
ipcMain.handle('gamefs:read', (_e, name) => storage.read(name));
ipcMain.handle('gamefs:append', (_e, name, line) => storage.append(name, line));

// ── 창·치명 오류 자동 복구 (§9.4) ──

/** 최근 치명 오류 시각을 60초 창으로 관리한다 (§9.4) */
const crashWindow = createCrashWindow();

function loadGame() {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function handleFatal(reason) {
  appendErrorLog(`FATAL ${reason}`);
  const { serviceRequired } = crashWindow.record();
  if (serviceRequired) {
    // 60초 내 3회: 자동 재실행 중지 (§9.4)
    appendErrorLog('SERVICE REQUIRED — auto-restart stopped');
    if (win) win.loadFile(path.join(__dirname, 'service-required.html'));
    return;
  }
  if (win) {
    win.loadFile(path.join(__dirname, 'system-error.html'));
    setTimeout(() => {
      if (win) loadGame();
    }, SYSTEM_ERROR_RESTART_MS);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1920,
    height: 1080,
    backgroundColor: '#05070F',
    fullscreen: app.isPackaged,
    kiosk: app.isPackaged,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.on('closed', () => {
    win = null;
  });
  // 부팅 진단 로그 — GUI 없이 렌더러 로드 성공을 판정하기 위한 stdout 증거
  win.webContents.on('did-finish-load', () => {
    console.log(`[electron] did-finish-load ${win ? win.webContents.getURL() : ''}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[electron] did-fail-load ${code} ${desc} ${url}`);
    appendErrorLog(`renderer load failed: ${code} ${desc} ${url}`);
  });
  // 렌더러 종료·무응답 → 오류 로그 → SYSTEM ERROR → 5초 후 재실행 (§9.4)
  win.webContents.on('render-process-gone', (_e, details) => {
    handleFatal(`renderer gone: ${details.reason}`);
  });
  win.webContents.on('unresponsive', () => {
    handleFatal('renderer unresponsive');
  });
  loadGame();
}

// 메인 프로세스의 처리되지 않은 예외도 오류 로그에 기록한다 (§9.4)
process.on('uncaughtException', (err) => {
  appendErrorLog(`main uncaught: ${err.stack || err.message}`);
});

app.whenReady().then(() => {
  ensureLogDir();
  console.log(`[electron] log dir: ${LOG_DIR}`);
  void pruneOldErrorLogs();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
