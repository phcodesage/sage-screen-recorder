const elements = {
  sourceSelect: document.getElementById('sourceSelect'),
  refreshButton: document.getElementById('refreshButton'),
  resolutionSelect: document.getElementById('resolutionSelect'),
  fpsSelect: document.getElementById('fpsSelect'),
  startButton: document.getElementById('startButton'),
  stopButton: document.getElementById('stopButton'),
  statusBadge: document.getElementById('statusBadge'),
  statusText: document.getElementById('statusText'),
  currentTime: document.getElementById('currentTime'),
  timer: document.getElementById('timer'),
  preview: document.getElementById('preview'),
  outputMeta: document.getElementById('outputMeta')
};

const state = {
  sources: [],
  mediaRecorder: null,
  recordingMimeType: 'video/webm',
  recordingChunks: [],
  sourceStream: null,
  outputStream: null,
  captureVideo: null,
  animationFrameId: null,
  timerId: null,
  clockId: null,
  startedAt: 0,
  isClosing: false
};

const RESOLUTION_PRESETS = {
  native: null,
  '480p': { width: 854, height: 480, label: '480p' },
  '720p': { width: 1280, height: 720, label: '720p' },
  '1080p': { width: 1920, height: 1080, label: '1080p' }
};

const MAX_OUTPUT_WIDTH = 1920;
const MAX_OUTPUT_HEIGHT = 1080;

function setStatus(label, text, tone = 'idle') {
  elements.statusBadge.textContent = label;
  elements.statusBadge.dataset.tone = tone;
  elements.statusText.textContent = text;
}

function setOutputMeta(text) {
  elements.outputMeta.textContent = text;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function formatClock(date) {
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function updateCurrentTime() {
  elements.currentTime.textContent = `Now ${formatClock(new Date())}`;
}

function startClock() {
  updateCurrentTime();

  if (state.clockId) {
    return;
  }

  state.clockId = window.setInterval(() => {
    updateCurrentTime();
  }, 1_000);
}

function stopClock() {
  if (state.clockId) {
    window.clearInterval(state.clockId);
    state.clockId = null;
  }
}

function startTimer() {
  stopTimer();
  state.startedAt = Date.now();
  elements.timer.textContent = '00:00';
  state.timerId = window.setInterval(() => {
    elements.timer.textContent = formatDuration(Date.now() - state.startedAt);
  }, 250);
}

function stopTimer() {
  if (state.timerId) {
    window.clearInterval(state.timerId);
    state.timerId = null;
  }
}

function isNativeResolutionSelected() {
  return elements.resolutionSelect.value === 'native';
}

function updateControls(isRecording) {
  elements.sourceSelect.disabled = isRecording;
  elements.refreshButton.disabled = isRecording;
  elements.resolutionSelect.disabled = isRecording;
  elements.fpsSelect.disabled = isRecording;
  elements.startButton.disabled = isRecording || state.sources.length === 0;
  elements.stopButton.disabled = !isRecording;
}

function fillSourceOptions(selectedId) {
  elements.sourceSelect.replaceChildren();

  if (state.sources.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No screens found';
    elements.sourceSelect.append(option);
    return;
  }

  state.sources.forEach((source) => {
    const option = document.createElement('option');
    option.value = source.id;
    option.textContent = source.name;
    elements.sourceSelect.append(option);
  });

  if (selectedId && state.sources.some((source) => source.id === selectedId)) {
    elements.sourceSelect.value = selectedId;
  }
}

async function loadSources() {
  const selectedId = elements.sourceSelect.value;
  setStatus('Loading', 'Refreshing available displays.', 'saving');

  try {
    state.sources = await window.recorderAPI.listSources();
    fillSourceOptions(selectedId);
    updateControls(Boolean(state.mediaRecorder));

    if (state.sources.length === 0) {
      setStatus('Idle', 'No displays were found.', 'idle');
      setOutputMeta('No active capture');
      return;
    }

    setStatus('Ready', 'Pick a screen and start recording.', 'ready');
  } catch (error) {
    setStatus('Error', error.message, 'idle');
  }
}

function getSelectedSourceId() {
  return elements.sourceSelect.value;
}

function getOutputResolution(sourceWidth, sourceHeight) {
  const presetKey = elements.resolutionSelect.value;

  if (presetKey === 'native') {
    const cappedSource = fitWithinBounds(
      sourceWidth,
      sourceHeight,
      MAX_OUTPUT_WIDTH,
      MAX_OUTPUT_HEIGHT
    );

    return {
      width: cappedSource.width,
      height: cappedSource.height,
      label: cappedSource.wasCapped ? 'Source (1080p cap)' : 'Source'
    };
  }

  const preset = RESOLUTION_PRESETS[presetKey];
  if (!preset) {
    throw new Error('Choose a valid resolution preset.');
  }

  return preset;
}

function fitWithinBounds(sourceWidth, sourceHeight, maxWidth, maxHeight) {
  if (sourceWidth <= maxWidth && sourceHeight <= maxHeight) {
    return {
      width: sourceWidth,
      height: sourceHeight,
      wasCapped: false
    };
  }

  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
    wasCapped: true
  };
}

function fitContain(sourceWidth, sourceHeight, outputWidth, outputHeight) {
  const scale = Math.min(outputWidth / sourceWidth, outputHeight / sourceHeight);
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);
  return {
    width,
    height,
    x: Math.floor((outputWidth - width) / 2),
    y: Math.floor((outputHeight - height) / 2)
  };
}

function pickMimeType() {
  const preferredTypes = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];

  return preferredTypes.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function calculateBitrate(width, height, fps) {
  const estimated = Math.round(width * height * fps * 0.12);
  return Math.min(Math.max(estimated, 4_000_000), 50_000_000);
}

async function getSourceStream(sourceId, fps) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: MAX_OUTPUT_WIDTH,
        maxHeight: MAX_OUTPUT_HEIGHT,
        maxFrameRate: fps
      }
    }
  });
}

async function createOutputStream(sourceStream, fps) {
  const track = sourceStream.getVideoTracks()[0];
  const settings = track.getSettings();
  const sourceWidth = settings.width || 1920;
  const sourceHeight = settings.height || 1080;
  const outputResolution = getOutputResolution(sourceWidth, sourceHeight);

  if (outputResolution.width === sourceWidth && outputResolution.height === sourceHeight) {
    return {
      outputStream: sourceStream,
      outputWidth: sourceWidth,
      outputHeight: sourceHeight,
      sourceWidth,
      sourceHeight,
      outputLabel: outputResolution.label
    };
  }

  const { width, height, label } = outputResolution;
  const captureVideo = document.createElement('video');
  captureVideo.srcObject = sourceStream;
  captureVideo.muted = true;
  captureVideo.playsInline = true;
  await captureVideo.play();

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  state.captureVideo = captureVideo;

  const drawFrame = () => {
    context.fillStyle = '#f5f7fb';
    context.fillRect(0, 0, width, height);
    const fit = fitContain(
      captureVideo.videoWidth || sourceWidth,
      captureVideo.videoHeight || sourceHeight,
      width,
      height
    );
    context.drawImage(captureVideo, fit.x, fit.y, fit.width, fit.height);
    state.animationFrameId = window.requestAnimationFrame(drawFrame);
  };

  drawFrame();

  return {
    outputStream: canvas.captureStream(fps),
    outputWidth: width,
    outputHeight: height,
    sourceWidth,
    sourceHeight,
    outputLabel: label
  };
}

function resetPreview() {
  elements.preview.pause();
  elements.preview.srcObject = null;
  setOutputMeta('No active capture');
}

function stopTracks(stream) {
  if (!stream) {
    return;
  }

  stream.getTracks().forEach((track) => {
    track.stop();
  });
}

function cleanupCapture() {
  if (state.animationFrameId) {
    window.cancelAnimationFrame(state.animationFrameId);
    state.animationFrameId = null;
  }

  if (state.captureVideo) {
    state.captureVideo.pause();
    state.captureVideo.srcObject = null;
    state.captureVideo = null;
  }

  if (state.outputStream && state.outputStream !== state.sourceStream) {
    stopTracks(state.outputStream);
  }

  stopTracks(state.sourceStream);
  state.outputStream = null;
  state.sourceStream = null;
  state.recordingChunks = [];
  resetPreview();
}

function defaultFileName() {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replace(/\..+/, '');
  return `sage-recording-${timestamp}.mp4`;
}

async function handleRecordingStopped() {
  stopTimer();

  if (state.isClosing) {
    cleanupCapture();
    updateControls(false);
    return;
  }

  const chunks = state.recordingChunks;
  state.mediaRecorder = null;
  state.recordingChunks = [];

  if (chunks.length === 0) {
    cleanupCapture();
    updateControls(false);
    setStatus('Idle', 'Recording stopped before any frames were captured.', 'idle');
    return;
  }

  try {
    setStatus('Saving', 'Converting the recording to MP4.', 'saving');
    const blob = new Blob(chunks, { type: state.recordingMimeType || 'video/webm' });
    const arrayBuffer = await blob.arrayBuffer();
    const result = await window.recorderAPI.saveRecording(arrayBuffer, defaultFileName());

    cleanupCapture();
    updateControls(false);

    if (result.canceled) {
      setStatus('Idle', 'Recording finished, but the save dialog was cancelled.', 'idle');
      return;
    }

    const fileName = result.filePath.split(/[\\/]/).pop();
    setStatus('Saved', `Recording saved as ${fileName}.`, 'ready');
  } catch (error) {
    cleanupCapture();
    updateControls(false);
    setStatus('Error', `Could not save recording: ${error.message}`, 'idle');
  }
}

async function startRecording() {
  const sourceId = getSelectedSourceId();

  if (!sourceId) {
    setStatus('Idle', 'Choose a screen before starting.', 'idle');
    return;
  }

  try {
    state.isClosing = false;
    setStatus('Loading', 'Preparing the capture stream.', 'saving');
    updateControls(true);

    const fps = Number.parseInt(elements.fpsSelect.value, 10);
    const sourceStream = await getSourceStream(sourceId, fps);
    sourceStream.getVideoTracks()[0].addEventListener('ended', () => {
      if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
        state.mediaRecorder.stop();
      }
    });

    const { outputStream, outputWidth, outputHeight, sourceWidth, sourceHeight, outputLabel } =
      await createOutputStream(sourceStream, fps);
    const mimeType = pickMimeType();
    const recorderOptions = {
      videoBitsPerSecond: calculateBitrate(outputWidth, outputHeight, fps)
    };

    if (mimeType) {
      recorderOptions.mimeType = mimeType;
    }

    const mediaRecorder = new MediaRecorder(outputStream, recorderOptions);
    mediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) {
        state.recordingChunks.push(event.data);
      }
    });
    mediaRecorder.addEventListener('stop', () => {
      void handleRecordingStopped();
    });

    state.sourceStream = sourceStream;
    state.outputStream = outputStream;
    state.mediaRecorder = mediaRecorder;
    state.recordingMimeType = mediaRecorder.mimeType || mimeType || 'video/webm';
    state.recordingChunks = [];

    elements.preview.srcObject = outputStream;
    await elements.preview.play();
    mediaRecorder.start(1_000);

    updateControls(true);
    startTimer();
    updateCurrentTime();
    setOutputMeta(
      isNativeResolutionSelected()
        ? `${outputLabel} - ${outputWidth}x${outputHeight} at ${fps} fps`
        : `${outputLabel} - ${sourceWidth}x${sourceHeight} into ${outputWidth}x${outputHeight} at ${fps} fps`
    );
    setStatus('Recording', 'Capture is in progress.', 'recording');
  } catch (error) {
    cleanupCapture();
    updateControls(false);
    setStatus('Error', error.message, 'idle');
  }
}

function stopRecording() {
  if (!state.mediaRecorder || state.mediaRecorder.state === 'inactive') {
    return;
  }

  elements.stopButton.disabled = true;
  setStatus('Saving', 'Stopping the capture and preparing MP4 export.', 'saving');
  state.mediaRecorder.stop();
}

elements.refreshButton.addEventListener('click', () => {
  void loadSources();
});

elements.startButton.addEventListener('click', () => {
  void startRecording();
});

elements.stopButton.addEventListener('click', () => {
  stopRecording();
});

window.addEventListener('beforeunload', () => {
  state.isClosing = true;
  state.mediaRecorder = null;
  stopTimer();
  stopClock();
  cleanupCapture();
});

updateControls(false);
startClock();
void loadSources();
