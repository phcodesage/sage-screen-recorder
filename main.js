const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, desktopCapturer, dialog, ipcMain } = require('electron');
const bundledFfmpegPath = require('ffmpeg-static');
const ffmpegPath = bundledFfmpegPath
  ? bundledFfmpegPath.replace('app.asar', 'app.asar.unpacked')
  : null;

function createWindow() {
  const window = new BrowserWindow({
    width: 1120,
    height: 840,
    minWidth: 920,
    minHeight: 700,
    show: false,
    backgroundColor: '#f6f8fc',
    title: 'Sage Recorder',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  window.loadFile('index.html');
  window.once('ready-to-show', () => {
    window.maximize();
    window.show();
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg is not available in this app build.'));
      return;
    }

    const ffmpeg = spawn(ffmpegPath, args, {
      windowsHide: true
    });
    let stderr = '';

    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on('error', (error) => {
      reject(error);
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}.`));
    });
  });
}

async function convertWebmToMp4(arrayBuffer, outputPath) {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-recorder-'));
  const inputPath = path.join(tempDirectory, 'recording.webm');

  try {
    await fs.writeFile(inputPath, Buffer.from(arrayBuffer));
    await runFfmpeg([
      '-y',
      '-i',
      inputPath,
      '-an',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'fast',
      '-movflags',
      '+faststart',
      outputPath
    ]);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

ipcMain.handle('recording:save', async (_event, { arrayBuffer, defaultName }) => {
  const result = await dialog.showSaveDialog({
    title: 'Save recording',
    defaultPath: path.join(app.getPath('videos'), defaultName),
    filters: [
      { name: 'MP4 Video', extensions: ['mp4'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  await convertWebmToMp4(arrayBuffer, result.filePath);
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle('sources:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: 0,
      height: 0
    }
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    displayId: source.display_id
  }));
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
