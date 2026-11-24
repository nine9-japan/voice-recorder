(() => {
  'use strict';

  const DEFAULT_FOLDER_ID = '1dWUZTYz1n64cyUvk93t3hpqfjaNtuAh9';
  const STORAGE_KEY = 'simple-voice-recorder-drive-settings-v1';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
  const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
  const MULTIPART_LIMIT_BYTES = 5 * 1024 * 1024;
  const DRIVE_UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files';

  // Keep OAuth access tokens strictly in memory (never localStorage).
  let oauthAccessToken = '';
  let oauthTokenExpiresAt = 0;
  let gisLoadPromise = null;

  function extractDriveFolderId(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';

    const urlMatch = raw.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (urlMatch && urlMatch[1]) {
      return urlMatch[1];
    }

    if (/^[a-zA-Z0-9_-]{10,}$/.test(raw)) {
      return raw;
    }

    return '';
  }

  function getFolderUrl(folderId) {
    const validId = extractDriveFolderId(folderId) || DEFAULT_FOLDER_ID;
    return `https://drive.google.com/drive/folders/${encodeURIComponent(validId)}`;
  }

  function normalizeMimeType(mimeType) {
    const base = String(mimeType || 'audio/webm').split(';')[0].trim();
    return base || 'audio/webm';
  }

  function isSafeHttpsUrl(url) {
    try {
      const parsed = new URL(String(url || '').trim());
      return parsed.protocol === 'https:';
    } catch (_err) {
      return false;
    }
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
      mode: 'gas',
      folderId: DEFAULT_FOLDER_ID,
      gasUrl: '',
      gasToken: '',
      oauthClientId: '',
    };
  }

  function normalizeSettings(candidate) {
    const defaults = defaultSettings();
    const raw = candidate && typeof candidate === 'object' ? candidate : {};
    const mode = raw.mode === 'oauth' ? 'oauth' : 'gas';
    const extractedFolder = extractDriveFolderId(raw.folderId);

    return {
      enabled: Boolean(raw.enabled),
      mode,
      folderId: extractedFolder || defaults.folderId,
      gasUrl: String(raw.gasUrl || '').trim(),
      gasToken: String(raw.gasToken || ''),
      oauthClientId: String(raw.oauthClientId || '').trim(),
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

  function hasValidOAuthToken() {
    return Boolean(oauthAccessToken && Date.now() < oauthTokenExpiresAt - 60000);
  }

  function clearOAuthToken() {
    oauthAccessToken = '';
    oauthTokenExpiresAt = 0;
  }

  function hasGisOAuth2Client() {
    return Boolean(
      window.google &&
      window.google.accounts &&
      window.google.accounts.oauth2 &&
      typeof window.google.accounts.oauth2.initTokenClient === 'function'
    );
  }

  function loadGisScript() {
    if (hasGisOAuth2Client()) {
      return Promise.resolve();
    }

    if (gisLoadPromise) {
      return gisLoadPromise;
    }

    gisLoadPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${GIS_SCRIPT_URL}"]`);
      if (existing) {
        existing.addEventListener('load', () => {
          if (hasGisOAuth2Client()) {
            resolve();
          } else {
            gisLoadPromise = null;
            reject(new Error('Google Identity Services の初期化に失敗しました。'));
          }
        }, { once: true });
        existing.addEventListener('error', () => {
          gisLoadPromise = null;
          reject(new Error('Google 認証スクリプトの読み込みに失敗しました。'));
        }, { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = GIS_SCRIPT_URL;
      script.async = true;
      script.defer = true;

      const timer = setTimeout(() => {
        gisLoadPromise = null;
        reject(new Error('Google 認証スクリプトの読み込みがタイムアウトしました。'));
      }, 15000);

      script.onload = () => {
        clearTimeout(timer);
        if (hasGisOAuth2Client()) {
          resolve();
        } else {
          gisLoadPromise = null;
          reject(new Error('Google Identity Services が利用できません。'));
        }
      };

      script.onerror = () => {
        clearTimeout(timer);
        gisLoadPromise = null;
        reject(new Error('Google 認証スクリプトの読み込みに失敗しました。ネットワーク接続を確認してください。'));
      };

      document.head.appendChild(script);
    });

    return gisLoadPromise;
  }

  async function connectOAuth(clientId) {
    const trimmedClientId = String(clientId || '').trim();
    if (!trimmedClientId) {
      throw new Error('Google OAuth クライアント ID を入力してください。');
    }

    await loadGisScript();

    return new Promise((resolve, reject) => {
      let settled = false;
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: trimmedClientId,
        scope: DRIVE_SCOPE,
        callback: (response) => {
          if (settled) return;
          settled = true;

          if (!response || response.error || !response.access_token) {
            clearOAuthToken();
            const msg = response && response.error_description
              ? response.error_description
              : (response && response.error ? `Google 認証エラー (${response.error})` : 'Google アクセストークンの取得に失敗しました。');
            reject(new Error(msg));
            return;
          }

          oauthAccessToken = response.access_token;
          const expiresSec = Number(response.expires_in) || 3600;
          oauthTokenExpiresAt = Date.now() + expiresSec * 1000;
          resolve({ connected: true });
        },
        error_callback: (err) => {
          if (settled) return;
          settled = true;
          clearOAuthToken();
          const detail = err && err.type === 'popup_closed'
            ? 'Google ログインのポップアップが閉じられました。'
            : 'Google ログインポップアップの起動に失敗しました。ポップアップブロック設定を確認してください。';
          reject(new Error(detail));
        },
      });

      tokenClient.requestAccessToken({ prompt: '' });
    });
  }

  function disconnectOAuth() {
    const token = oauthAccessToken;
    clearOAuthToken();

    if (
      token &&
      window.google &&
      window.google.accounts &&
      window.google.accounts.oauth2 &&
      typeof window.google.accounts.oauth2.revoke === 'function'
    ) {
      try {
        window.google.accounts.oauth2.revoke(token, () => {});
      } catch (_err) {
        // Ignore revoke errors.
      }
    }
  }

  function canUploadNow(settings) {
    const s = settings || loadSettings();
    const folderId = extractDriveFolderId(s.folderId);
    if (!folderId) {
      return {
        ok: false,
        reasonCode: 'needs_config',
        message: '有効な Google Drive フォルダ ID または URL を設定してください。',
      };
    }

    if (s.mode === 'oauth') {
      if (!String(s.oauthClientId || '').trim()) {
        return {
          ok: false,
          reasonCode: 'needs_config',
          message: 'Google OAuth クライアント ID を設定してください。',
        };
      }
      if (!hasValidOAuthToken()) {
        return {
          ok: false,
          reasonCode: 'needs_login',
          message: 'Google アカウントに接続（ログイン）してください。',
        };
      }
      return { ok: true, reasonCode: 'ready', message: '' };
    }

    if (!isSafeHttpsUrl(s.gasUrl)) {
      return {
        ok: false,
        reasonCode: 'needs_config',
        message: 'Google Apps Script のウェブアプリ URL（https://...）を設定してください。',
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
        detail: s.mode === 'oauth' ? '録音完了後に OAuth で自動保存します' : '録音完了後に GAS 経由で自動保存します',
      };
    }

    return {
      ready: false,
      code: check.reasonCode,
      label: check.reasonCode === 'needs_login' ? '要接続' : '設定が必要',
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

  async function uploadViaGas({ blob, filename, mimeType, folderId, gasUrl, gasToken }) {
    if (!isSafeHttpsUrl(gasUrl)) {
      throw new Error('有効な GAS ウェブアプリ URL（https://...）を設定してください。');
    }

    const resolvedFolderId = extractDriveFolderId(folderId) || DEFAULT_FOLDER_ID;
    const cleanMime = normalizeMimeType(mimeType);
    const dataBase64 = await blobToBase64(blob);

    // Use text/plain to avoid CORS preflight failures on Google Apps Script Web Apps.
    const response = await fetch(String(gasUrl).trim(), {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: JSON.stringify({
        folderId: resolvedFolderId,
        filename,
        mimeType: cleanMime,
        dataBase64,
        token: gasToken || '',
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

  async function readDriveErrorMessage(response) {
    try {
      const text = await response.text();
      if (!text) return `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.error && parsed.error.message) {
          return parsed.error.message;
        }
      } catch (_err) {
        // Fallback to plain status message.
      }
      return `HTTP ${response.status}`;
    } catch (_err) {
      return `HTTP ${response.status}`;
    }
  }

  function buildOAuthHttpError(status, detail) {
    if (status === 401) {
      clearOAuthToken();
      return new Error('Google の認証期限が切れました。設定から「再接続」してください。');
    }
    if (status === 403 || status === 404) {
      return new Error('保存先フォルダへのアクセス権限がないか、フォルダが見つかりません。フォルダ ID とアクセス権を確認してください。');
    }
    return new Error(`Google Drive アップロードに失敗しました (${detail})。`);
  }

  async function uploadViaOAuth({ blob, filename, mimeType, folderId }) {
    if (!hasValidOAuthToken()) {
      throw new Error('Google アカウントに接続されていません。設定から接続してください。');
    }

    const resolvedFolderId = extractDriveFolderId(folderId);
    if (!resolvedFolderId) {
      throw new Error('有効な Google Drive フォルダ ID が指定されていません。');
    }

    const cleanMime = normalizeMimeType(mimeType);
    const metadata = {
      name: filename,
      mimeType: cleanMime,
      parents: [resolvedFolderId],
    };

    let response;
    if (blob.size <= MULTIPART_LIMIT_BYTES) {
      const boundary = `vr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const multipartBody = new Blob(
        [
          `--${boundary}\r\n`,
          'Content-Type: application/json; charset=UTF-8\r\n\r\n',
          JSON.stringify(metadata),
          `\r\n--${boundary}\r\n`,
          `Content-Type: ${cleanMime}\r\n\r\n`,
          blob,
          `\r\n--${boundary}--`,
        ],
        { type: `multipart/related; boundary=${boundary}` }
      );

      response = await fetch(
        `${DRIVE_UPLOAD_ENDPOINT}?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${oauthAccessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
          },
          body: multipartBody,
        }
      );
    } else {
      const initResponse = await fetch(
        `${DRIVE_UPLOAD_ENDPOINT}?uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${oauthAccessToken}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': cleanMime,
            'X-Upload-Content-Length': String(blob.size),
          },
          body: JSON.stringify(metadata),
        }
      );

      if (!initResponse.ok) {
        const detail = await readDriveErrorMessage(initResponse);
        throw buildOAuthHttpError(initResponse.status, detail);
      }

      const uploadUrl = initResponse.headers && typeof initResponse.headers.get === 'function'
        ? initResponse.headers.get('Location')
        : '';
      if (!uploadUrl) {
        throw new Error('5MB 超のファイル用アップロード URL (Location ヘッダー) を取得できませんでした。GAS 経由方式の利用をご検討ください。');
      }

      response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': cleanMime,
        },
        body: blob,
      });
    }

    if (!response.ok) {
      const detail = await readDriveErrorMessage(response);
      throw buildOAuthHttpError(response.status, detail);
    }

    const data = await response.json();
    const id = String(data && data.id ? data.id : '');
    return {
      id,
      name: String(data && data.name ? data.name : filename),
      webViewLink: sanitizeWebViewLink(data && data.webViewLink, id),
    };
  }

  async function uploadRecording({ blob, filename, mimeType, settings }) {
    const s = settings || loadSettings();
    const folderId = extractDriveFolderId(s.folderId) || DEFAULT_FOLDER_ID;

    if (s.mode === 'oauth') {
      return uploadViaOAuth({ blob, filename, mimeType, folderId });
    }

    return uploadViaGas({
      blob,
      filename,
      mimeType,
      folderId,
      gasUrl: s.gasUrl,
      gasToken: s.gasToken,
    });
  }

  window.DriveUploader = {
    DEFAULT_FOLDER_ID,
    STORAGE_KEY,
    DRIVE_SCOPE,
    MULTIPART_LIMIT_BYTES,
    extractDriveFolderId,
    getFolderUrl,
    normalizeMimeType,
    isSafeHttpsUrl,
    blobToBase64,
    loadSettings,
    saveSettings,
    hasValidOAuthToken,
    clearOAuthToken,
    connectOAuth,
    disconnectOAuth,
    canUploadNow,
    getReadiness,
    uploadViaGas,
    uploadViaOAuth,
    uploadRecording,
  };
})();
