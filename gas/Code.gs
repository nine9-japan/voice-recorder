const DEFAULT_FOLDER_ID = '1dWUZTYz1n64cyUvk93t3hpqfjaNtuAh9';
const SHARED_TOKEN = '';
const ALLOW_CUSTOM_FOLDER_ID = false;

function getExpectedToken_() {
  if (SHARED_TOKEN) {
    return SHARED_TOKEN;
  }
  try {
    const prop = PropertiesService.getScriptProperties().getProperty('UPLOAD_TOKEN');
    return prop ? String(prop).trim() : '';
  } catch (_err) {
    return '';
  }
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function normalizeMimeType_(mimeType) {
  const base = String(mimeType || 'audio/webm').split(';')[0].trim();
  return base || 'audio/webm';
}

function sanitizeFilename_(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .trim();
  const fallback = cleaned || ('recording-' + Date.now() + '.webm');
  return fallback.slice(0, 180);
}

function extractBase64Payload_(raw) {
  const value = String(raw || '').trim();
  if (!value) {
    return '';
  }
  if (value.indexOf('data:') === 0) {
    const commaIndex = value.indexOf(',');
    return commaIndex >= 0 ? value.slice(commaIndex + 1) : '';
  }
  return value;
}

function doGet() {
  return jsonResponse_({
    ok: true,
    service: 'voice-recorder-drive-uploader',
    folderId: DEFAULT_FOLDER_ID,
  });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse_({ ok: false, error: 'Empty request body' });
    }

    const payload = JSON.parse(e.postData.contents);
    const expectedToken = getExpectedToken_();
    if (expectedToken && String(payload.token || '') !== expectedToken) {
      return jsonResponse_({ ok: false, error: 'Unauthorized: invalid token' });
    }

    const base64Data = extractBase64Payload_(payload.dataBase64);
    if (!base64Data) {
      return jsonResponse_({ ok: false, error: 'Missing audio payload (dataBase64)' });
    }

    const folderId = (ALLOW_CUSTOM_FOLDER_ID && payload.folderId)
      ? String(payload.folderId).trim()
      : DEFAULT_FOLDER_ID;
    const mimeType = normalizeMimeType_(payload.mimeType);
    const filename = sanitizeFilename_(payload.filename);

    const bytes = Utilities.base64Decode(base64Data);
    const blob = Utilities.newBlob(bytes, mimeType, filename);
    const folder = DriveApp.getFolderById(folderId);
    const file = folder.createFile(blob);

    return jsonResponse_({
      ok: true,
      id: file.getId(),
      name: file.getName(),
      webViewLink: file.getUrl(),
    });
  } catch (err) {
    return jsonResponse_({
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }
}
