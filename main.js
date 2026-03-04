const { app, BrowserWindow, screen, session } = require('electron');
const path = require('path');

function createWindow () {
  // Get the primary display's work area (excluding the taskbar)
  const { workArea } = screen.getPrimaryDisplay();

  const win = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    alwaysOnTop: false,
    frame: true,
    transparent: false,
    backgroundColor: '#18141a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  win.loadFile('index.html');
  // Optionally maximize (should be redundant with workArea, but ensures it fills the space)
  win.maximize();
}

app.whenReady().then(() => {
  // Prevent stale JS/CSS bundles after rapid local edits.
  session.defaultSession.clearCache().catch(() => {});

  // YouTube embeds in file:// Electron apps can fail with Error 153 when
  // Referer/Origin headers are missing. Add safe defaults for YouTube requests.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      const url = String(details.url || '');
      const isYouTubeRequest =
        /https:\/\/([a-z0-9-]+\.)?(youtube\.com|youtube-nocookie\.com|ytimg\.com|googlevideo\.com)\//i.test(url);
      if (isYouTubeRequest) {
        const headers = details.requestHeaders || {};
        if (!headers.Referer) headers.Referer = 'https://www.youtube.com/';
        if (!headers.Origin) headers.Origin = 'https://www.youtube.com';
        return callback({ requestHeaders: headers });
      }
    } catch (_) {}
    callback({ requestHeaders: details.requestHeaders });
  });

  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
