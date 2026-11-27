(() => {
  'use strict';

  const FIXED_FOLDER_ID = '1dWUZTYz1n64cyUvk93t3hpqfjaNtuAh9';
  const DEFAULT_FOLDER_ID = FIXED_FOLDER_ID;
  // デプロイ済みの GAS ウェブアプリ URL をここに設定すると、画面上の URL 入力欄が完全に非表示になり ON/OFF スイッチだけで動作します。
  const FIXED_GAS_URL = '';
  const STORAGE_KEY = 'simple-voice-recorder-drive-settings-v1';

  function isSafeHttpsUrl(url) {
    try {
      const parsed = new URL(String(url || '').trim());
      return parsed.protocol === 'https:';
    } catch (_err) {
      return false;
    }
  }

  function isGasUrlFixed() {
    return isSafeHttpsUrl(FIXED_GAS_URL);
  }

  function getFolderUrl() {
    return `https://drive.google.com/drive/folders/${encodeURIComponent(FIXED_FOLDER_ID)}`;
  }

  function normalizeMimeType(mimeType) {
    const base = String(mimeType || 'audio/webm').split(';')[0].trim();
    return base || 'audio/webm';
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    const chunks = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return btoa(chunks.join(''));
  }

  function blobToBase64(blob) {
    if (typeof FileReader !== 'undefined') {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = typeof reader.result === 'string' ? reader.result : '';
          const commaIndex = result.indexOf(',');
          resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
        };
        reader.onerror = () => reject(reader.error || new Error('音声データの読み込みに失敗しました。'));
        reader.readAsDataURL(blob);
      });
    }

    if (blob && typeof blob.arrayBuffer === 'function') {
      return blob.arrayBuffer().then(arrayBufferToBase64);
    }

    return Promise.reject(new Error('音声データを Base64 に変換できませんでした。'));
  }

  function defaultSettings() {
    return {
      enabled: false,
      gasUrl: '',
    };
  }

  function normalizeSettings(candidate) {
    const raw = candidate && typeof candidate === 'object' ? candidate : {};
    return {
      enabled: Boolean(raw.enabled),
      gasUrl: String(raw.gasUrl || '').trim(),
    };
  }

  function loadSettings() {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (!saved) {
        return defaultSettings();
      }
      return normalizeSettings(JSON.parse(saved));
    } catch (_err) {
      return defaultSettings();
    }
  }

  function saveSettings(partial) {
    const current = loadSettings();
    const next = normalizeSettings({ ...current, ...(partial || {}) });
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (_err) {
      // Ignore storage quota / privacy mode errors.
    }
    return next;
  }

  function getEffectiveGasUrl(settings) {
    if (isGasUrlFixed()) {
      return String(FIXED_GAS_URL).trim();
    }
    const s = settings || loadSettings();
    return String(s.gasUrl || '').trim();
  }

  function canUploadNow(settings) {
    const s = settings || loadSettings();
    if (!isSafeHttpsUrl(getEffectiveGasUrl(s))) {
      return {
        ok: false,
        reasonCode: 'needs_config',
        message: '初回のみ GAS ウェブアプリ URL（https://...）を入力してください。',
      };
    }
    return { ok: true, reasonCode: 'ready', message: '' };
  }

  function getReadiness(settings) {
    const s = settings || loadSettings();
    if (!s.enabled) {
      return {
        ready: false,
        code: 'off',
        label: 'OFF',
        detail: '自動アップロードは無効です',
      };
    }

    const check = canUploadNow(s);
    if (check.ok) {
      return {
        ready: true,
        code: 'ready',
        label: '自動保存 ON',
        detail: '録音完了後に指定フォルダへ自動保存します',
      };
    }

    return {
      ready: false,
      code: check.reasonCode,
      label: 'URL 未設定',
      detail: check.message,
    };
  }

  function sanitizeWebViewLink(link, fileId) {
    if (isSafeHttpsUrl(link)) {
      return String(link).trim();
    }
    if (fileId) {
      return `https://drive.google.com/file/d/${encodeURIComponent(String(fileId))}/view`;
    }
    return '';
  }

  async function uploadViaGas({ blob, filename, mimeType, gasUrl }) {
    const resolvedGasUrl = String(gasUrl !== undefined ? gasUrl : getEffectiveGasUrl()).trim();
    if (!isSafeHttpsUrl(resolvedGasUrl)) {
      throw new Error('初回のみ GAS ウェブアプリ URL（https://...）を入力してください。');
    }

    const cleanMime = normalizeMimeType(mimeType);
    const dataBase64 = await blobToBase64(blob);

    // Use text/plain to avoid CORS preflight failures on Google Apps Script Web Apps.
    const response = await fetch(resolvedGasUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: JSON.stringify({
        folderId: FIXED_FOLDER_ID,
        filename,
        mimeType: cleanMime,
        dataBase64,
      }),
    });

    if (!response.ok) {
      throw new Error(`GAS への送信に失敗しました (HTTP ${response.status})。デプロイ設定を確認してください。`);
    }

    const rawText = await response.text();
    let data = null;
    try {
      data = JSON.parse(rawText);
    } catch (_err) {
      throw new Error('GAS から JSON 応答を得られませんでした。ウェブアプリのアクセス権限を「全員」にして再デプロイしてください。');
    }

    if (!data || !data.ok) {
      throw new Error(data && data.error ? `GAS エラー: ${data.error}` : 'GAS アップロードに失敗しました。');
    }

    const id = String(data.id || '');
    return {
      id,
      name: String(data.name || filename),
      webViewLink: sanitizeWebViewLink(data.webViewLink, id),
    };
  }

  async function uploadRecording({ blob, filename, mimeType, settings }) {
    const s = settings || loadSettings();
    return uploadViaGas({
      blob,
      filename,
      mimeType,
      gasUrl: getEffectiveGasUrl(s),
    });
  }

  window.DriveUploader = {
    FIXED_FOLDER_ID,
    DEFAULT_FOLDER_ID,
    FIXED_GAS_URL,
    STORAGE_KEY,
    isGasUrlFixed,
    getEffectiveGasUrl,
    getFolderUrl,
    normalizeMimeType,
    isSafeHttpsUrl,
    blobToBase64,
    loadSettings,
    saveSettings,
    canUploadNow,
    getReadiness,
    uploadViaGas,
    uploadRecording,
  };
})();
