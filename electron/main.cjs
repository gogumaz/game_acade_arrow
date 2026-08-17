// Electron 메인 프로세스 (§9.3 안전 쓰기 · §9.4 치명 오류 · §1.4 키오스크)
// - 전체화면·키오스크는 패키징 빌드에서만 활성
// - 모든 쓰기는 safe-write.cjs의 단일 직렬 큐를 통과한다 (§9.3)
// - 저장 위치: 실행 폴더 기준 ./log/ (§9.1 · 부록 E.3)
//
// WU-06 부팅 순서 (계획 §4)
//   ① 잔존 `.tmp` 정리(P-2) → ② 크래시 창 로드·판정(P-9 · ADM-306)
//   → ③ `machine.json` 기록(P-11) → ④ 창 생성(SERVICE REQUIRED면 게임 대신 정비 화면)

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const {
  createSafeWriter,
  createCrashWindow,
  isStorageLow,
  machineInfo,
  newMachineId,
  CRASH_WINDOW_FILE,
  MACHINE_FILE,
  SYSTEM_ERROR_RESTART_MS,
} = require('./safe-write.cjs');

// portable 빌드는 임시 폴더에서 실행되므로 실제 exe 위치(PORTABLE_EXECUTABLE_DIR)를 우선한다
const LOG_DIR = app.isPackaged
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe')), 'log')
  : path.join(process.cwd(), 'log');

const ERROR_LOG_RETENTION_DAYS = 90; // §9.1

let win = null;
/** ADM-306 — 이번 부팅이 정비 필요 상태로 시작했는가 (게임을 로드하지 않는다) */
let serviceRequiredAtBoot = false;
/** §12.1 — 이번 부팅에 기록한 machine.json 본문 (렌더러 health로 노출) */
let machine = null;

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

/**
 * 저장 큐 드레인 (ADM-307 · §11.1 "모든 저장이 성공한 뒤에만 종료").
 *
 * 큐는 직렬이므로 **빈 작업 하나를 뒤에 붙여 기다리면** 앞선 모든 쓰기가 끝난 것이 된다.
 * 실패한 쓰기도 큐를 진행시키므로(§9.3) 이 대기는 절대 영원히 매달리지 않는다.
 */
function drainQueue() {
  return storage.enqueue(() => Promise.resolve()).catch(() => undefined);
}

// 관리자 3초 홀드 종료가 쓰는 채널. Esc 종료 경로는 두지 않는다 (§13 G8).
ipcMain.handle('app:quit', async () => {
  await drainQueue();
  app.quit();
});

// 관리자 `SYSTEM ACTIONS > RESTART GAME`(H 2초). 저장 완료 뒤 앱만 다시 띄운다 (admin §10.6).
// 기기 재부팅·종료는 OS 권한 구성이 필요해 `[보류]`다 (§17 #3).
ipcMain.handle('app:restart', async () => {
  await drainQueue();
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('gamefs:write', (_e, name, content) => storage.write(name, String(content)));
ipcMain.handle('gamefs:read', (_e, name) => storage.read(name));
ipcMain.handle('gamefs:append', (_e, name, line) => storage.append(name, line));

// §12.3 — 렌더러가 STORAGE LOW·SERVICE REQUIRED·machine.json을 읽는 유일한 창구 (WU-06 P-8)
ipcMain.handle('gamefs:health', async () => {
  const freeBytes = await storage.freeBytes();
  return {
    fatalCount: crashWindow.count,
    serviceRequired: serviceRequiredAtBoot || crashWindow.count >= 3,
    freeBytes,
    storageLow: isStorageLow(freeBytes),
    machine,
  };
});

// SAV-702 — 렌더러의 저장 실패를 오류 로그에 남긴다 (WU-06 P-13)
ipcMain.handle('app:logError', (_e, message) => {
  appendErrorLog(`RENDERER ${String(message)}`);
});

// ── 창·치명 오류 자동 복구 (§9.4 · ADM-306) ──

/**
 * 60초 창을 `log/crash_window.json`으로 영속한다 (WU-06 P-9 · ADM-306).
 *
 * WU-01은 `createCrashWindow()`를 인자 없이 썼고 기록이 메모리에만 남았다 — 프로세스째
 * 죽는 종류의 치명 오류에서는 매 부팅마다 창이 비어 `SERVICE REQUIRED`에 닿지 못했다.
 */
const crashWindow = createCrashWindow({
  load: () => {
    try {
      const raw = fs.readFileSync(path.join(LOG_DIR, CRASH_WINDOW_FILE), 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : parsed.times;
    } catch {
      return [];
    }
  },
  save: (times) => {
    try {
      ensureLogDir();
      fs.writeFileSync(
        path.join(LOG_DIR, CRASH_WINDOW_FILE),
        JSON.stringify({ times, updatedAt: new Date().toISOString() }),
        'utf8'
      );
    } catch {
      /* 무시 */
    }
  },
});

/** §12.1 — 최초 부팅 1회만 만들고 이후 유지되는 기기 식별자 (WU-06 P-11) */
function loadOrCreateMachineId() {
  try {
    const raw = fs.readFileSync(path.join(LOG_DIR, MACHINE_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.machineId === 'string' && parsed.machineId !== '') return parsed.machineId;
  } catch {
    /* 없으면 새로 만든다 */
  }
  return newMachineId(crypto.randomBytes(8).toString('hex'));
}

async function writeMachineJson() {
  machine = machineInfo({
    machineId: loadOrCreateMachineId(),
    appVersion: app.getVersion(),
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    updatedAt: new Date().toISOString(),
  });
  try {
    await storage.write(MACHINE_FILE, `${JSON.stringify(machine, null, 2)}\n`);
  } catch (err) {
    appendErrorLog(`machine.json write failed: ${String(err)}`);
  }
}

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
    serviceRequiredAtBoot = true;
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
  // ADM-306 — 60초 내 3회 치명 오류로 시작한 부팅은 게임을 로드하지 않는다
  if (serviceRequiredAtBoot) {
    win.loadFile(path.join(__dirname, 'service-required.html'));
    return;
  }
  loadGame();
}

// 메인 프로세스의 처리되지 않은 예외도 오류 로그에 기록한다 (§9.4)
process.on('uncaughtException', (err) => {
  appendErrorLog(`main uncaught: ${err.stack || err.message}`);
});

app.whenReady().then(async () => {
  ensureLogDir();
  console.log(`[electron] log dir: ${LOG_DIR}`);
  void pruneOldErrorLogs();
  // ① 잔존 `.tmp` 정리 (ADM-301)
  const strays = await storage.recoverStrays();
  if (strays.promoted.length > 0 || strays.removed.length > 0) {
    const line = `stray recovery: promoted=${strays.promoted.join('|')} removed=${strays.removed.join('|')}`;
    console.log(`[electron] ${line}`);
    appendErrorLog(line);
  }
  // ② 크래시 창 판정 (ADM-306)
  const verdict = crashWindow.boot();
  serviceRequiredAtBoot = verdict.serviceRequired;
  console.log(
    `[electron] crash window: count=${verdict.count} serviceRequired=${verdict.serviceRequired}`
  );
  // ③ machine.json (§12.1)
  await writeMachineJson();
  console.log(`[electron] machine: ${machine ? machine.machineId : '—'}`);
  // ④ 창
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
