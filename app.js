(() => {
  'use strict';

  const DB_NAME = 'simple-voice-recorder-db';
  const DB_VERSION = 1;
  const STORE_NAME = 'recordings';

  const PREFERRED_MIME_TYPES = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];

  // DOM elements
  const statusBadge = document.getElementById('status-badge');
  const statusText = document.getElementById('status-text');
  const timerEl = document.getElementById('timer');
  const visualizerCanvas = document.getElementById('visualizer');
  const recordBtn = document.getElementById('record-btn');
  const recordBtnLabel = document.getElementById('record-btn-label');
  const pauseBtn = document.getElementById('pause-btn');
  const pauseBtnLabel = document.getElementById('pause-btn-label');
  const errorBanner = document.getElementById('error-banner');
  const recordingCountEl = document.getElementById('recording-count');
  const emptyStateEl = document.getElementById('empty-state');
  const recordingsListEl = document.getElementById('recordings-list');

  // Google Drive DOM elements
  const driveAutoUploadToggle = document.getElementById('drive-auto-upload-toggle');
  const driveStatusBadge = document.getElementById('drive-status-badge');
  const driveSettingsToggle = document.getElementById('drive-settings-toggle');
  const driveFolderLink = document.getElementById('drive-folder-link');
  const driveHintText = document.getElementById('drive-hint-text');
  const driveSettingsPanel = document.getElementById('drive-settings-panel');
  const driveModeSelect = document.getElementById('drive-mode-select');
  const driveGasFields = document.getElementById('drive-gas-fields');
  const driveOauthFields = document.getElementById('drive-oauth-fields');
  const driveGasUrlInput = document.getElementById('drive-gas-url');
  const driveGasTokenInput = document.getElementById('drive-gas-token');
  const driveOauthClientIdInput = document.getElementById('drive-oauth-client-id');
  const driveOauthConnectBtn = document.getElementById('drive-oauth-connect-btn');
  const driveOauthDisconnectBtn = document.getElementById('drive-oauth-disconnect-btn');
  const driveOauthStatus = document.getElementById('drive-oauth-status');
  const driveFolderInput = document.getElementById('drive-folder-input');
  const driveFolderResetBtn = document.getElementById('drive-folder-reset-btn');
  const driveSettingsMessage = document.getElementById('drive-settings-message');

  // Application state: 'idle' | 'starting' | 'recording' | 'paused' | 'stopping'
  let state = 'idle';

  // Active recording refs
  let mediaStream = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let selectedMimeType = '';
  let finalDurationMs = 0;

  // Drift-free timer refs
  let accumulatedMs = 0;
  let segmentStartMs = 0;
  let timerIntervalId = null;

  // Web Audio visualizer refs
  let audioContext = null;
  let analyser = null;
  let sourceNode = null;
  let animationFrameId = null;
  let freqData = null;

  // Saved recordings, DOM element refs, and Object URL cache
  let recordings = [];
  const objectUrls = new Map();
  const recordingItemElements = new Map();

  // Google Drive uploader state
  const DriveUploader = window.DriveUploader;
  let driveSettings = DriveUploader.loadSettings();
  let activeUploadsCount = 0;

  // ---- Utility Helpers ----

  function pickSupportedMimeType() {
    if (typeof window.MediaRecorder === 'undefined' || typeof window.MediaRecorder.isTypeSupported !== 'function') {
      return '';
    }
    for (const type of PREFERRED_MIME_TYPES) {
      if (window.MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return '';
  }

  function getExtensionFromMimeType(mimeType) {
    const lower = (mimeType || '').toLowerCase();
    if (lower.includes('mp4')) return 'm4a';
    if (lower.includes('ogg')) return 'ogg';
    if (lower.includes('wav')) return 'wav';
    if (lower.includes('webm')) return 'webm';
    return 'webm';
  }

  function sanitizeFilename(name) {
    const cleaned = String(name || '')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .trim();
    return cleaned || 'recording';
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function pad2(num) {
    return String(num).padStart(2, '0');
  }

  function formatDateTime(timestamp) {
    const d = new Date(timestamp);
    return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function formatDefaultTitle(timestamp) {
    const d = new Date(timestamp);
    return `録音 ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function generateId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `rec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // ---- Error & UI State Helpers ----

  function showError(message) {
    errorBanner.textContent = message;
    errorBanner.hidden = false;
  }

  function hideError() {
    errorBanner.textContent = '';
    errorBanner.hidden = true;
  }

  function mapGetUserMediaError(err) {
    const name = err && err.name ? err.name : '';
    switch (name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return 'マイクの使用が許可されませんでした。ブラウザのサイト設定からマイクへのアクセスを許可してください。';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return '利用可能なマイクが見つかりませんでした。マイクが接続されているか確認してください。';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'マイクにアクセスできません。他のアプリがマイクを使用中か、デバイスに問題がある可能性があります。';
      case 'SecurityError':
        return 'セキュリティ制限によりマイクを使用できません。https:// または http://localhost で開いてください。';
      default:
        return 'マイクの初期化中にエラーが発生しました。接続やブラウザ設定を確認してください。';
    }
  }

  function updateControlsUI() {
    const isRecordingOrPaused = state === 'recording' || state === 'paused';
    const isBusy = state === 'starting' || state === 'stopping';

    statusBadge.dataset.state = isRecordingOrPaused ? state : 'idle';

    if (state === 'starting') {
      statusText.textContent = '準備中...';
      recordBtnLabel.textContent = '準備中...';
      recordBtn.setAttribute('aria-label', '録音準備中');
    } else if (state === 'recording') {
      statusText.textContent = '録音中';
      recordBtnLabel.textContent = '録音停止';
      recordBtn.setAttribute('aria-label', '録音停止');
    } else if (state === 'paused') {
      statusText.textContent = '一時停止中';
      recordBtnLabel.textContent = '録音停止';
      recordBtn.setAttribute('aria-label', '録音停止');
    } else if (state === 'stopping') {
      statusText.textContent = '保存中...';
      recordBtnLabel.textContent = '保存中...';
      recordBtn.setAttribute('aria-label', '録音保存中');
    } else {
      statusText.textContent = '待機中';
      recordBtnLabel.textContent = '録音開始';
      recordBtn.setAttribute('aria-label', '録音開始');
    }

    recordBtn.dataset.recording = isRecordingOrPaused ? 'true' : 'false';
    recordBtn.disabled = isBusy;

    const canPause = Boolean(mediaRecorder && typeof mediaRecorder.pause === 'function' && typeof mediaRecorder.resume === 'function');
    if (isRecordingOrPaused && canPause) {
      pauseBtn.hidden = false;
      pauseBtn.disabled = false;
      pauseBtnLabel.textContent = state === 'paused' ? '再開' : '一時停止';
    } else {
      pauseBtn.hidden = true;
      pauseBtn.disabled = true;
      pauseBtnLabel.textContent = '一時停止';
    }
  }

  function updateListMetaUI() {
    recordingCountEl.textContent = String(recordings.length);
    emptyStateEl.hidden = recordings.length > 0;
  }

  // ---- Drift-free Timer ----

  function getElapsedMs() {
    if (state === 'recording') {
      return accumulatedMs + (performance.now() - segmentStartMs);
    }
    return accumulatedMs;
  }

  function renderTimer() {
    timerEl.textContent = formatDuration(getElapsedMs());
  }

  function clearTimerInterval() {
    if (timerIntervalId !== null) {
      clearInterval(timerIntervalId);
      timerIntervalId = null;
    }
  }

  function startTimer() {
    clearTimerInterval();
    accumulatedMs = 0;
    segmentStartMs = performance.now();
    renderTimer();
    timerIntervalId = setInterval(renderTimer, 100);
  }

  function pauseTimer() {
    if (state === 'recording') {
      accumulatedMs += performance.now() - segmentStartMs;
    }
    clearTimerInterval();
    renderTimer();
  }

  function resumeTimer() {
    clearTimerInterval();
    segmentStartMs = performance.now();
    renderTimer();
    timerIntervalId = setInterval(renderTimer, 100);
  }

  function stopAndResetTimer() {
    clearTimerInterval();
    accumulatedMs = 0;
    segmentStartMs = 0;
    timerEl.textContent = '00:00';
  }

  // ---- Web Audio Visualizer ----

  function getAccentColor() {
    const computed = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    return computed || '#e11d48';
  }

  function getIdleLineColor() {
    const computed = getComputedStyle(document.documentElement).getPropertyValue('--border-strong').trim();
    return computed || '#cbd5e1';
  }

  function syncCanvasResolution() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = visualizerCanvas.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.round(rect.width || 500));
    const cssHeight = Math.max(1, Math.round(rect.height || 84));
    const targetWidth = Math.round(cssWidth * dpr);
    const targetHeight = Math.round(cssHeight * dpr);

    if (visualizerCanvas.width !== targetWidth || visualizerCanvas.height !== targetHeight) {
      visualizerCanvas.width = targetWidth;
      visualizerCanvas.height = targetHeight;
    }
    return { dpr, cssWidth, cssHeight };
  }

  function drawRoundedBar(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
  }

  function drawIdleVisualizer() {
    const ctx = visualizerCanvas.getContext('2d');
    if (!ctx) return;

    const { dpr, cssWidth, cssHeight } = syncCanvasResolution();
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const barCount = 40;
    const gap = 4;
    const totalGap = gap * (barCount - 1);
    const barWidth = Math.max(2, (cssWidth - totalGap) / barCount);
    const centerY = cssHeight / 2;

    ctx.fillStyle = getIdleLineColor();
    for (let i = 0; i < barCount; i += 1) {
      const x = i * (barWidth + gap);
      const height = 4;
      drawRoundedBar(ctx, x, centerY - height / 2, barWidth, height, 2);
    }

    ctx.restore();
  }

  function drawLiveFrame() {
    if (state !== 'recording' || !analyser || !freqData) {
      animationFrameId = null;
      return;
    }

    const ctx = visualizerCanvas.getContext('2d');
    if (!ctx) return;

    const { dpr, cssWidth, cssHeight } = syncCanvasResolution();
    analyser.getByteFrequencyData(freqData);

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const usableBins = Math.min(48, freqData.length);
    const gap = 4;
    const totalGap = gap * (usableBins - 1);
    const barWidth = Math.max(2, (cssWidth - totalGap) / usableBins);
    const centerY = cssHeight / 2;
    const maxBarHeight = cssHeight - 10;

    ctx.fillStyle = getAccentColor();

    for (let i = 0; i < usableBins; i += 1) {
      const normalized = freqData[i] / 255;
      const barHeight = Math.max(4, normalized * maxBarHeight);
      const x = i * (barWidth + gap);
      drawRoundedBar(ctx, x, centerY - barHeight / 2, barWidth, barHeight, barWidth / 2);
    }

    ctx.restore();
    animationFrameId = requestAnimationFrame(drawLiveFrame);
  }

  function startVisualizerLoop() {
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    if (analyser && freqData && state === 'recording') {
      animationFrameId = requestAnimationFrame(drawLiveFrame);
    }
  }

  function stopVisualizerLoop(resetToIdle) {
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    if (resetToIdle) {
      drawIdleVisualizer();
    }
  }

  function setupVisualizer(stream) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        return;
      }
      audioContext = new AudioCtx();
      if (audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {});
      }
      sourceNode = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      // Connect source -> analyser ONLY; never connect to audioContext.destination (prevents feedback).
      sourceNode.connect(analyser);
      freqData = new Uint8Array(analyser.frequencyBinCount);
      startVisualizerLoop();
    } catch (_err) {
      // Visualizer is progressive enhancement; keep recording working if AudioContext fails.
      teardownVisualizer();
    }
  }

  function teardownVisualizer() {
    stopVisualizerLoop(true);
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch (_err) {
        // Ignore disconnect errors during cleanup.
      }
      sourceNode = null;
    }
    analyser = null;
    freqData = null;
    if (audioContext) {
      const ctx = audioContext;
      audioContext = null;
      ctx.close().catch(() => {});
    }
  }

  // ---- IndexedDB Persistence (Best-Effort) ----

  function openDb() {
    return new Promise((resolve, reject) => {
      if (typeof window.indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
    });
  }

  async function getAllRecordingsFromDb() {
    let db = null;
    try {
      db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
        req.onerror = () => reject(req.error);
      });
    } catch (_err) {
      return [];
    } finally {
      if (db) db.close();
    }
  }

  async function putRecordingInDb(record) {
    let db = null;
    try {
      db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put({
          id: record.id,
          title: record.title,
          createdAt: record.createdAt,
          durationMs: record.durationMs,
          mimeType: record.mimeType,
          size: record.size,
          blob: record.blob,
          driveStatus: record.driveStatus || 'idle',
          driveFileId: record.driveFileId || null,
          driveFileUrl: record.driveFileUrl || null,
          driveError: record.driveError || null,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (_err) {
      // Degrade gracefully to in-memory storage if IndexedDB fails.
    } finally {
      if (db) db.close();
    }
  }

  async function deleteRecordingFromDb(id) {
    let db = null;
    try {
      db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (_err) {
      // Ignore IndexedDB deletion errors.
    } finally {
      if (db) db.close();
    }
  }

  // ---- Google Drive UI & Upload ----

  function showDriveMessage(message, isError) {
    driveSettingsMessage.textContent = message;
    driveSettingsMessage.dataset.tone = isError ? 'error' : 'info';
    driveSettingsMessage.hidden = false;
  }

  function hideDriveMessage() {
    driveSettingsMessage.textContent = '';
    delete driveSettingsMessage.dataset.tone;
    driveSettingsMessage.hidden = true;
  }

  function setDrivePanelOpen(isOpen) {
    driveSettingsPanel.hidden = !isOpen;
    driveSettingsToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  }

  function updateDriveUI() {
    driveAutoUploadToggle.checked = Boolean(driveSettings.enabled);
    driveModeSelect.value = driveSettings.mode;

    const isOAuth = driveSettings.mode === 'oauth';
    driveGasFields.hidden = isOAuth;
    driveOauthFields.hidden = !isOAuth;

    if (document.activeElement !== driveGasUrlInput) {
      driveGasUrlInput.value = driveSettings.gasUrl || '';
    }
    if (document.activeElement !== driveGasTokenInput) {
      driveGasTokenInput.value = driveSettings.gasToken || '';
    }
    if (document.activeElement !== driveOauthClientIdInput) {
      driveOauthClientIdInput.value = driveSettings.oauthClientId || '';
    }
    if (document.activeElement !== driveFolderInput) {
      driveFolderInput.value = driveSettings.folderId || DriveUploader.DEFAULT_FOLDER_ID;
    }

    driveFolderLink.href = DriveUploader.getFolderUrl(driveSettings.folderId);

    const isConnected = DriveUploader.hasValidOAuthToken();
    driveOauthStatus.textContent = isConnected ? '接続済み' : '未接続';
    driveOauthStatus.dataset.connected = isConnected ? 'true' : 'false';
    driveOauthConnectBtn.textContent = isConnected ? '再接続' : 'Google に接続';
    driveOauthDisconnectBtn.hidden = !isConnected;

    const readiness = DriveUploader.getReadiness(driveSettings);
    if (activeUploadsCount > 0) {
      driveStatusBadge.dataset.status = 'uploading';
      driveStatusBadge.textContent = 'アップロード中...';
    } else if (readiness.code === 'ready') {
      driveStatusBadge.dataset.status = 'ready';
      driveStatusBadge.textContent = readiness.label;
    } else if (readiness.code === 'off') {
      driveStatusBadge.dataset.status = 'off';
      driveStatusBadge.textContent = readiness.label;
    } else {
      driveStatusBadge.dataset.status = 'warn';
      driveStatusBadge.textContent = readiness.label;
    }

    driveHintText.textContent = readiness.detail;
  }

  function bindDriveEvents() {
    driveAutoUploadToggle.addEventListener('change', () => {
      driveSettings = DriveUploader.saveSettings({ enabled: driveAutoUploadToggle.checked });
      hideDriveMessage();
      updateDriveUI();

      if (driveSettings.enabled) {
        const check = DriveUploader.canUploadNow(driveSettings);
        if (!check.ok) {
          setDrivePanelOpen(true);
          showDriveMessage(check.message, false);
        }
      }
    });

    driveSettingsToggle.addEventListener('click', () => {
      setDrivePanelOpen(driveSettingsPanel.hidden);
    });

    driveModeSelect.addEventListener('change', () => {
      driveSettings = DriveUploader.saveSettings({ mode: driveModeSelect.value });
      hideDriveMessage();
      updateDriveUI();
    });

    const handleGasUrlUpdate = () => {
      driveSettings = DriveUploader.saveSettings({ gasUrl: driveGasUrlInput.value.trim() });
      hideDriveMessage();
      updateDriveUI();
    };
    driveGasUrlInput.addEventListener('input', handleGasUrlUpdate);
    driveGasUrlInput.addEventListener('change', handleGasUrlUpdate);

    const handleGasTokenUpdate = () => {
      driveSettings = DriveUploader.saveSettings({ gasToken: driveGasTokenInput.value });
      updateDriveUI();
    };
    driveGasTokenInput.addEventListener('input', handleGasTokenUpdate);
    driveGasTokenInput.addEventListener('change', handleGasTokenUpdate);

    const handleClientIdUpdate = () => {
      driveSettings = DriveUploader.saveSettings({ oauthClientId: driveOauthClientIdInput.value.trim() });
      hideDriveMessage();
      updateDriveUI();
    };
    driveOauthClientIdInput.addEventListener('input', handleClientIdUpdate);
    driveOauthClientIdInput.addEventListener('change', handleClientIdUpdate);

    const commitFolderInput = () => {
      const extracted = DriveUploader.extractDriveFolderId(driveFolderInput.value);
      if (!extracted) {
        showDriveMessage('有効な Google Drive フォルダ URL または ID を入力してください。', true);
        return;
      }
      hideDriveMessage();
      driveSettings = DriveUploader.saveSettings({ folderId: extracted });
      driveFolderInput.value = extracted;
      updateDriveUI();
    };
    driveFolderInput.addEventListener('change', commitFolderInput);
    driveFolderInput.addEventListener('blur', commitFolderInput);

    driveFolderResetBtn.addEventListener('click', () => {
      driveSettings = DriveUploader.saveSettings({ folderId: DriveUploader.DEFAULT_FOLDER_ID });
      driveFolderInput.value = DriveUploader.DEFAULT_FOLDER_ID;
      hideDriveMessage();
      updateDriveUI();
    });

    driveOauthConnectBtn.addEventListener('click', async () => {
      const clientId = driveOauthClientIdInput.value.trim();
      if (!clientId) {
        showDriveMessage('Google OAuth クライアント ID を入力してください。', true);
        driveOauthClientIdInput.focus();
        return;
      }

      driveSettings = DriveUploader.saveSettings({ oauthClientId: clientId });
      driveOauthConnectBtn.disabled = true;
      showDriveMessage('Google アカウントに接続しています...', false);

      try {
        await DriveUploader.connectOAuth(clientId);
        showDriveMessage('Google アカウントに接続しました。', false);
      } catch (err) {
        showDriveMessage(err && err.message ? err.message : 'Google 接続に失敗しました。', true);
      } finally {
        driveOauthConnectBtn.disabled = false;
        updateDriveUI();
      }
    });

    driveOauthDisconnectBtn.addEventListener('click', () => {
      DriveUploader.disconnectOAuth();
      showDriveMessage('Google アカウントから切断しました。', false);
      updateDriveUI();
    });
  }

  function updateRecordingDriveRow(record) {
    const refs = recordingItemElements.get(record.id);
    if (!refs) return;

    const { driveStatusEl, driveBtn } = refs;
    const status = record.driveStatus || 'idle';

    driveStatusEl.replaceChildren();
    driveStatusEl.dataset.driveStatus = status;

    if (status === 'uploading') {
      driveStatusEl.hidden = false;
      driveStatusEl.textContent = 'Google Drive にアップロード中...';
      driveBtn.disabled = true;
      driveBtn.textContent = 'アップロード中...';
    } else if (status === 'uploaded') {
      driveStatusEl.hidden = false;
      if (record.driveFileUrl && DriveUploader.isSafeHttpsUrl(record.driveFileUrl)) {
        const link = document.createElement('a');
        link.className = 'recording-drive-link';
        link.href = record.driveFileUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Drive 保存済み ↗';
        driveStatusEl.appendChild(link);
      } else {
        driveStatusEl.textContent = 'Drive 保存済み';
      }
      driveBtn.disabled = false;
      driveBtn.textContent = '再アップロード';
    } else if (status === 'error') {
      driveStatusEl.hidden = false;
      driveStatusEl.textContent = `Drive エラー: ${record.driveError || 'アップロードに失敗しました'}`;
      driveBtn.disabled = false;
      driveBtn.textContent = '再試行';
    } else {
      driveStatusEl.hidden = true;
      driveBtn.disabled = false;
      driveBtn.textContent = 'Drive に保存';
    }
  }

  async function uploadRecordToDrive(record, options) {
    const triggeredManually = Boolean(options && options.triggeredManually);
    if (!record || record.driveStatus === 'uploading') {
      return;
    }

    let check = DriveUploader.canUploadNow(driveSettings);
    if (
      !check.ok &&
      triggeredManually &&
      driveSettings.mode === 'oauth' &&
      check.reasonCode === 'needs_login' &&
      driveSettings.oauthClientId
    ) {
      try {
        await DriveUploader.connectOAuth(driveSettings.oauthClientId);
        updateDriveUI();
        check = DriveUploader.canUploadNow(driveSettings);
      } catch (err) {
        check = {
          ok: false,
          reasonCode: 'needs_login',
          message: err && err.message ? err.message : 'Google 接続に失敗しました。',
        };
      }
    }

    if (!check.ok) {
      record.driveStatus = 'error';
      record.driveError = check.message;
      updateRecordingDriveRow(record);
      await putRecordingInDb(record);
      if (triggeredManually) {
        setDrivePanelOpen(true);
        showDriveMessage(check.message, true);
      }
      return;
    }

    record.driveStatus = 'uploading';
    record.driveError = null;
    activeUploadsCount += 1;
    updateDriveUI();
    updateRecordingDriveRow(record);

    const ext = getExtensionFromMimeType(record.mimeType);
    const filename = `${sanitizeFilename(record.title)}.${ext}`;

    try {
      const result = await DriveUploader.uploadRecording({
        blob: record.blob,
        filename,
        mimeType: record.mimeType,
        settings: driveSettings,
      });

      if (!recordings.some((item) => item.id === record.id)) {
        return;
      }

      record.driveStatus = 'uploaded';
      record.driveFileId = result.id || null;
      record.driveFileUrl = result.webViewLink || null;
      record.driveError = null;
      updateRecordingDriveRow(record);
      await putRecordingInDb(record);
    } catch (err) {
      if (!recordings.some((item) => item.id === record.id)) {
        return;
      }

      record.driveStatus = 'error';
      record.driveError = err && err.message ? err.message : 'アップロードに失敗しました。';
      updateRecordingDriveRow(record);
      await putRecordingInDb(record);
    } finally {
      activeUploadsCount = Math.max(0, activeUploadsCount - 1);
      updateDriveUI();
    }
  }

  // ---- Recording Share (Minimal) ----

  async function shareRecording(record, shareBtn) {
    hideError();
    const ext = getExtensionFromMimeType(record.mimeType);
    const filename = `${sanitizeFilename(record.title)}.${ext}`;
    const mimeType = DriveUploader.normalizeMimeType(record.mimeType);

    if (typeof navigator.share === 'function' && typeof window.File === 'function') {
      const file = new window.File([record.blob], filename, { type: mimeType });
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ title: record.title, files: [file] });
        } catch (err) {
          if (!err || err.name !== 'AbortError') {
            showError('共有に失敗しました。');
          }
        }
        return;
      }
    }

    if (record.driveFileUrl && DriveUploader.isSafeHttpsUrl(record.driveFileUrl)) {
      if (typeof navigator.share === 'function') {
        try {
          await navigator.share({ title: record.title, url: record.driveFileUrl });
        } catch (err) {
          if (!err || err.name !== 'AbortError') {
            showError('共有に失敗しました。');
          }
        }
        return;
      }

      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(record.driveFileUrl);
          if (shareBtn && shareBtn.isConnected) {
            shareBtn.textContent = 'コピーしました';
            setTimeout(() => {
              if (shareBtn.isConnected) {
                shareBtn.textContent = '共有';
              }
            }, 2000);
          }
        } catch (_err) {
          showError('共有リンクのコピーに失敗しました。');
        }
        return;
      }
    }

    showError('このブラウザでは音声ファイルの直接共有に対応していません。「Drive に保存」後に共有するか、ダウンロードして共有してください。');
  }

  // ---- Recordings List Rendering ----

  function getOrCreateObjectUrl(record) {
    let url = objectUrls.get(record.id);
    if (!url) {
      url = URL.createObjectURL(record.blob);
      objectUrls.set(record.id, url);
    }
    return url;
  }

  function createRecordingItemElement(record) {
    const li = document.createElement('li');
    li.className = 'recording-item';
    li.dataset.id = record.id;

    const topDiv = document.createElement('div');
    topDiv.className = 'recording-top';

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'recording-title';
    titleInput.value = record.title;
    titleInput.maxLength = 120;
    titleInput.setAttribute('aria-label', '録音タイトル');

    const metaDiv = document.createElement('div');
    metaDiv.className = 'recording-meta';
    metaDiv.textContent = `${formatDateTime(record.createdAt)} ・ ${formatDuration(record.durationMs)} ・ ${formatBytes(record.size)}`;

    topDiv.append(titleInput, metaDiv);

    const objectUrl = getOrCreateObjectUrl(record);

    const audioEl = document.createElement('audio');
    audioEl.className = 'recording-audio';
    audioEl.controls = true;
    audioEl.preload = 'metadata';
    audioEl.src = objectUrl;

    const driveStatusEl = document.createElement('div');
    driveStatusEl.className = 'recording-drive-status';
    driveStatusEl.hidden = true;

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'recording-actions';

    const shareBtn = document.createElement('button');
    shareBtn.type = 'button';
    shareBtn.className = 'btn btn-small btn-share';
    shareBtn.textContent = '共有';

    const driveBtn = document.createElement('button');
    driveBtn.type = 'button';
    driveBtn.className = 'btn btn-small btn-drive';
    driveBtn.textContent = 'Drive に保存';

    const ext = getExtensionFromMimeType(record.mimeType);
    const downloadLink = document.createElement('a');
    downloadLink.className = 'btn btn-small btn-download';
    downloadLink.href = objectUrl;
    downloadLink.download = `${sanitizeFilename(record.title)}.${ext}`;
    downloadLink.textContent = 'ダウンロード';

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-small btn-danger';
    deleteBtn.textContent = '削除';

    actionsDiv.append(shareBtn, driveBtn, downloadLink, deleteBtn);

    recordingItemElements.set(record.id, { li, driveStatusEl, driveBtn });
    updateRecordingDriveRow(record);

    shareBtn.addEventListener('click', () => {
      shareRecording(record, shareBtn);
    });

    driveBtn.addEventListener('click', () => {
      uploadRecordToDrive(record, { triggeredManually: true });
    });

    titleInput.addEventListener('input', () => {
      const candidate = titleInput.value.trim() || record.title;
      downloadLink.download = `${sanitizeFilename(candidate)}.${ext}`;
    });

    const commitTitle = () => {
      const trimmed = titleInput.value.trim();
      if (!trimmed) {
        titleInput.value = record.title;
        downloadLink.download = `${sanitizeFilename(record.title)}.${ext}`;
        return;
      }
      if (trimmed !== record.title) {
        record.title = trimmed;
        titleInput.value = trimmed;
        downloadLink.download = `${sanitizeFilename(trimmed)}.${ext}`;
        putRecordingInDb(record);
      }
    };

    titleInput.addEventListener('change', commitTitle);
    titleInput.addEventListener('blur', commitTitle);
    titleInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        titleInput.blur();
      }
    });

    deleteBtn.addEventListener('click', () => {
      audioEl.pause();
      audioEl.removeAttribute('src');
      audioEl.load();

      const cachedUrl = objectUrls.get(record.id);
      if (cachedUrl) {
        URL.revokeObjectURL(cachedUrl);
        objectUrls.delete(record.id);
      }

      recordings = recordings.filter((item) => item.id !== record.id);
      recordingItemElements.delete(record.id);
      li.remove();
      updateListMetaUI();
      deleteRecordingFromDb(record.id);
    });

    li.append(topDiv, audioEl, driveStatusEl, actionsDiv);
    return li;
  }

  function renderAllRecordings() {
    recordingItemElements.clear();
    recordingsListEl.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const record of recordings) {
      fragment.appendChild(createRecordingItemElement(record));
    }
    recordingsListEl.appendChild(fragment);
    updateListMetaUI();
  }

  function prependRecording(record) {
    recordings.unshift(record);
    const itemEl = createRecordingItemElement(record);
    recordingsListEl.prepend(itemEl);
    updateListMetaUI();
  }

  // ---- Media Stream & Recording Lifecycle ----

  function stopMediaStream() {
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) {
        track.stop();
      }
      mediaStream = null;
    }
  }

  function cleanupActiveRecordingResources() {
    stopMediaStream();
    teardownVisualizer();
    stopAndResetTimer();
    mediaRecorder = null;
    recordedChunks = [];
    selectedMimeType = '';
    finalDurationMs = 0;
  }

  async function startRecording() {
    if (state !== 'idle') return;

    hideError();
    state = 'starting';
    updateControlsUI();

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      state = 'idle';
      updateControlsUI();
      showError(mapGetUserMediaError(err));
      return;
    }

    try {
      mediaStream = stream;
      recordedChunks = [];
      finalDurationMs = 0;
      selectedMimeType = pickSupportedMimeType();

      mediaRecorder = selectedMimeType
        ? new window.MediaRecorder(mediaStream, { mimeType: selectedMimeType })
        : new window.MediaRecorder(mediaStream);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunks.push(event.data);
        }
      };

      mediaRecorder.onerror = () => {
        if (mediaRecorder) {
          mediaRecorder.ondataavailable = null;
          mediaRecorder.onstop = null;
          mediaRecorder.onerror = null;
        }
        cleanupActiveRecordingResources();
        state = 'idle';
        updateControlsUI();
        showError('録音中にエラーが発生しました。もう一度お試しください。');
      };

      mediaRecorder.onstop = async () => {
        const durationMs = finalDurationMs > 0 ? finalDurationMs : getElapsedMs();
        const recorderMimeType = mediaRecorder ? mediaRecorder.mimeType : '';
        const chunks = recordedChunks.slice();
        const fallbackMime = selectedMimeType;

        cleanupActiveRecordingResources();
        state = 'idle';
        updateControlsUI();

        const firstChunkType = chunks[0] && chunks[0].type ? chunks[0].type : '';
        const actualMimeType = firstChunkType || recorderMimeType || fallbackMime || 'audio/webm';
        const blob = new Blob(chunks, { type: actualMimeType });

        if (blob.size === 0) {
          showError('録音データが空のため保存できませんでした。');
          return;
        }

        const createdAt = Date.now();
        const record = {
          id: generateId(),
          title: formatDefaultTitle(createdAt),
          createdAt,
          durationMs,
          mimeType: actualMimeType,
          size: blob.size,
          blob,
          driveStatus: 'idle',
          driveFileId: null,
          driveFileUrl: null,
          driveError: null,
        };

        prependRecording(record);
        await putRecordingInDb(record);

        if (driveSettings.enabled) {
          void uploadRecordToDrive(record, { triggeredManually: false });
        }
      };

      // Start without a timeslice argument for reliable container output across browsers (e.g. Safari MP4).
      mediaRecorder.start();
      state = 'recording';
      startTimer();
      setupVisualizer(mediaStream);
      updateControlsUI();
    } catch (_err) {
      cleanupActiveRecordingResources();
      state = 'idle';
      updateControlsUI();
      showError('録音の開始に失敗しました。ブラウザが音声録音に対応しているか確認してください。');
    }
  }

  function togglePause() {
    if (!mediaRecorder) return;

    if (state === 'recording') {
      try {
        mediaRecorder.pause();
        pauseTimer();
        state = 'paused';
        stopVisualizerLoop(false);
        updateControlsUI();
      } catch (_err) {
        showError('録音の一時停止に失敗しました。');
      }
    } else if (state === 'paused') {
      try {
        mediaRecorder.resume();
        state = 'recording';
        resumeTimer();
        startVisualizerLoop();
        updateControlsUI();
      } catch (_err) {
        showError('録音の再開に失敗しました。');
      }
    }
  }

  function stopRecording() {
    if (state !== 'recording' && state !== 'paused') return;

    finalDurationMs = getElapsedMs();
    state = 'stopping';
    clearTimerInterval();
    updateControlsUI();

    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      cleanupActiveRecordingResources();
      state = 'idle';
      updateControlsUI();
      return;
    }

    try {
      mediaRecorder.stop();
    } catch (_err) {
      cleanupActiveRecordingResources();
      state = 'idle';
      updateControlsUI();
      showError('録音の停止処理中にエラーが発生しました。');
    }
  }

  // ---- Initialization ----

  function checkBrowserSupport() {
    const hasGetUserMedia = Boolean(
      navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function'
    );
    const hasMediaRecorder = typeof window.MediaRecorder !== 'undefined';

    if (!hasGetUserMedia || !hasMediaRecorder) {
      recordBtn.disabled = true;
      showError(
        'このブラウザ環境では音声録音機能を利用できません。対応ブラウザを使用し、https:// または http://localhost 経由でアクセスしてください。'
      );
      return false;
    }
    return true;
  }

  async function init() {
    drawIdleVisualizer();
    updateControlsUI();
    updateListMetaUI();
    bindDriveEvents();
    updateDriveUI();

    const isSupported = checkBrowserSupport();

    if (isSupported) {
      recordBtn.addEventListener('click', () => {
        if (state === 'idle') {
          startRecording();
        } else if (state === 'recording' || state === 'paused') {
          stopRecording();
        }
      });

      pauseBtn.addEventListener('click', togglePause);
    }

    window.addEventListener('resize', () => {
      if (state !== 'recording') {
        drawIdleVisualizer();
      }
    });

    window.addEventListener('beforeunload', (event) => {
      if (state === 'recording' || state === 'paused' || activeUploadsCount > 0) {
        event.preventDefault();
        event.returnValue = '';
      }
    });

    const stored = await getAllRecordingsFromDb();
    recordings = stored
      .filter((item) => item && item.id && item.blob instanceof Blob)
      .map((item) => ({
        ...item,
        driveStatus: item.driveStatus === 'uploading' ? 'idle' : (item.driveStatus || 'idle'),
        driveFileId: item.driveFileId || null,
        driveFileUrl: item.driveFileUrl || null,
        driveError: item.driveError || null,
      }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    renderAllRecordings();
  }

  init();
})();
