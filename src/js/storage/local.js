// local storage backend
export const STORAGE_MODE_KEY = 'storage_mode';
export const STORAGE_MODES = { LOCAL:'local', FOLDER:'folder', DROPBOX:'dropbox', GOOGLE:'google', ONEDRIVE:'onedrive' };

export function loadTransactionsLocal() {
  const raw = localStorage.getItem('transactions');
  return raw ? JSON.parse(raw) : [];
}
export function saveTransactionsLocal(transactions) {
  localStorage.setItem('transactions', JSON.stringify(transactions));
}

export function getStorageMode() {
  return localStorage.getItem(STORAGE_MODE_KEY) || STORAGE_MODES.LOCAL;
}
export function setStorageModeLocalValue(mode) {
  localStorage.setItem(STORAGE_MODE_KEY, mode);
  try {
    const el = document.querySelector(`input[name="storage-mode"][value="${mode}"]`);
    if (el) el.checked = true;
  } catch(_) {}
}

export default { loadTransactionsLocal, saveTransactionsLocal, getStorageMode, setStorageModeLocalValue, STORAGE_MODES };
