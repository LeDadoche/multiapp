// Helpers sans crash
const $$ = (s, ctx=document) => Array.from(ctx.querySelectorAll(s));
const onAll = (sel, evt, fn) => $$(sel).forEach(el => el.addEventListener(evt, fn));

// --- PATCH A: sécurité pour openIconPicker (existe partout, ne plante jamais)
if (typeof window.openIconPicker !== 'function') {
  window.openIconPicker = function (e) {
    try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch {}
    const trg = e?.currentTarget || e?.target || null;
    const inputId   = trg?.dataset?.targetInput   || 'category';
    const previewId = trg?.dataset?.targetPreview || 'selected-category';

    // Si le bottom sheet V2 est dispo, on l'utilise
    if (typeof window.__openIconSheet === 'function') {
      window.__openIconSheet(inputId, previewId);
      return;
    }
    // Fallback: ancien dropdown
    const root = trg ? trg.closest('#category-picker, .category-picker, .category-picker-v2') : null;
    const dd   = root?.querySelector('.category-dropdown');
    if (dd) dd.style.display = (getComputedStyle(dd).display === 'none' ? 'block' : 'none');
  };
}

// Exemple d’usage (tolérant si un bloc n’existe pas)
onAll('#category-picker .category-icon-preview, .category-picker-v2 .cat-trigger', 'click', openIconPicker);

// --- FIX: pont unique pour ouvrir le picker d'icônes depuis partout ---
function openIconPicker(e){
  try {
    e?.preventDefault?.();
    e?.stopPropagation?.();
  } catch {}
  const trg = e?.currentTarget || e?.target || null;
  const inputId   = trg?.dataset?.targetInput   || 'category';
  const previewId = trg?.dataset?.targetPreview || 'selected-category';

  // Si le bottom sheet V2 est chargé, on l'utilise
  if (typeof window.__openIconSheet === 'function') {
    window.__openIconSheet(inputId, previewId);
    return;
  }

  // Sinon: fallback vers l'ancien dropdown si présent
  const root = trg ? trg.closest('#category-picker, .category-picker, .category-picker-v2') : null;
  const dd   = root?.querySelector('.category-dropdown');
  if (dd) dd.style.display = (getComputedStyle(dd).display === 'none' ? 'block' : 'none');
}

// --- Configuration Dropbox ---
const DROPBOX_APP_KEY = "sx9tl18fkusxm05";
const DROPBOX_FILE = "/transactions.json";

// --- Configuration pour d'autres services cloud (Google Drive et Microsoft OneDrive)
// Remplacez ces identifiants client par les vôtres pour activer l'authentification OAuth.
const GOOGLE_CLIENT_ID = "REPLACE_WITH_GOOGLE_CLIENT_ID";
const MICROSOFT_CLIENT_ID = "REPLACE_WITH_MICROSOFT_CLIENT_ID";

// Jetons d'accès pour les différents services
let googleAccessToken = null;
let msAccessToken = null;

let dbx, accessToken = null;
let transactions = [];
let currentMonth = new Date();
let selectedDate = null; // mémorise la case sélectionnée (YYYY-MM-DD)
let monthSortMode = 'date-asc'; // valeur initiale
let selectedTxId = null; // id de la transaction sélectionnée dans #day-details

// Utilitaires date
function addMonths(date, months) {
  const d = new Date(date);
  const newDate = new Date(d.getFullYear(), d.getMonth() + months, d.getDate());
  if (newDate.getDate() !== d.getDate()) newDate.setDate(0);
  return newDate;
}
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function parseDate(str) {
  const [y, m, d] = str.split('-').map(n => parseInt(n, 10));
  return new Date(y, m - 1, d);
}
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();
}
function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
}

// ====== Données locales (fallback quand pas de Cloud) ======
function loadTransactionsLocal() {
  const raw = localStorage.getItem('transactions');
  transactions = raw ? JSON.parse(raw) : [];
}
function saveTransactionsLocal() {
  localStorage.setItem('transactions', JSON.stringify(transactions));
}

// ====== Stockage : abstraction (Local, Dossier, Dropbox) ======
const STORAGE_MODE_KEY = 'storage_mode';
const STORAGE_MODES = { LOCAL:'local', FOLDER:'folder', DROPBOX:'dropbox', GOOGLE:'google', ONEDRIVE:'onedrive' };

// Handles pour le mode "Dossier local" (File System Access)
let __folderDirHandle = null;
let __folderFileHandle = null;

function getStorageMode() {
  return localStorage.getItem(STORAGE_MODE_KEY) || STORAGE_MODES.LOCAL;
}
function setStorageModeLocalValue(mode) {
  localStorage.setItem(STORAGE_MODE_KEY, mode);
  // coche les radios si présentes
  try {
    const el = document.querySelector(`input[name="storage-mode"][value="${mode}"]`);
    if (el) el.checked = true;
  } catch(_) {}
}

function isFsaSupported() {
  return typeof window.showDirectoryPicker === 'function';
}

function loadTransactionsLocal() {
  const raw = localStorage.getItem('transactions');
  transactions = raw ? JSON.parse(raw) : [];
}
function saveTransactionsLocal() {
  localStorage.setItem('transactions', JSON.stringify(transactions));
}

async function ensureFolderFile() {
  if (!isFsaSupported()) throw new Error('File System Access non supporté');
  if (!__folderDirHandle) {
    __folderDirHandle = await window.showDirectoryPicker();
  }
  // Sous-dossier "AssistantPersonnel"
  const appDir = await __folderDirHandle.getDirectoryHandle('AssistantPersonnel', { create: true });
  __folderFileHandle = await appDir.getFileHandle('transactions.json', { create: true });

  const opts = { mode: 'readwrite' };
  if (await __folderFileHandle.queryPermission(opts) !== 'granted') {
    const p = await __folderFileHandle.requestPermission(opts);
    if (p !== 'granted') throw new Error('Permission refusée');
  }
}

async function loadTransactionsFolder() {
  await ensureFolderFile();
  const file = await __folderFileHandle.getFile();
  const text = await file.text().catch(()=>'[]');
  try {
    transactions = text?.trim() ? JSON.parse(text) : [];
  } catch {
    transactions = [];
  }
  // on garde aussi une copie locale pour le cache/offline
  saveTransactionsLocal();
}

async function saveTransactionsFolder() {
  await ensureFolderFile();
  const writable = await __folderFileHandle.createWritable();
  await writable.write(new Blob([JSON.stringify(transactions, null, 2)], { type: 'application/json' }));
  await writable.close();
  // copie locale pour offline
  saveTransactionsLocal();
}

// Charge selon le mode sélectionné (avec fallback)
async function loadTransactions() {
  const mode = getStorageMode();

  if (mode === STORAGE_MODES.DROPBOX && typeof isDropboxConnected === 'function' && isDropboxConnected() && window.Dropbox && Dropbox.Dropbox) {
    try {
      dbx = new Dropbox.Dropbox({ accessToken });
      await loadTransactionsDropbox();
      return;
    } catch (e) {
      console.warn('[Storage] Dropbox KO → fallback local:', e);
    }
  }
  if (mode === STORAGE_MODES.FOLDER && isFsaSupported()) {
    try {
      await loadTransactionsFolder();
      return;
    } catch (e) {
      console.warn('[Storage] Dossier local KO → fallback local:', e);
    }
  }

  // Fallback
  loadTransactionsLocal();
}

async function persistTransactions() {
  const mode = getStorageMode();

  if (mode === STORAGE_MODES.DROPBOX && typeof isDropboxConnected === 'function' && isDropboxConnected()) {
    await saveTransactionsDropbox().catch(e => {
      console.warn('[Storage] save Dropbox KO → copie locale seulement', e);
      saveTransactionsLocal();
    });
    return;
  }
  if (mode === STORAGE_MODES.FOLDER && isFsaSupported()) {
    await saveTransactionsFolder().catch(e => {
      console.warn('[Storage] save dossier KO → copie locale seulement', e);
      saveTransactionsLocal();
    });
    return;
  }

  // Local par défaut
  saveTransactionsLocal();
}

// UI : radios + bouton choisir dossier
function renderStorageModeUI() {
  const hint = document.getElementById('storage-hint');
  const folderRadio = document.getElementById('mode-folder');
  const folderBtn   = document.getElementById('pick-folder-btn');

  // activer/désactiver "Dossier local" si non supporté
  if (folderRadio) {
    const ok = isFsaSupported();
    folderRadio.disabled = !ok;
    folderBtn.style.display = ok ? '' : 'none';
    if (!ok && getStorageMode() === STORAGE_MODES.FOLDER) {
      setStorageModeLocalValue(STORAGE_MODES.LOCAL);
    }
  }

  // état visuel du choix
  const mode = getStorageMode();
  const el = document.querySelector(`input[name="storage-mode"][value="${mode}"]`);
  if (el) el.checked = true;

  // message d’aide
  if (hint) {
    if (mode === STORAGE_MODES.LOCAL) {
      hint.textContent = "Stockage dans le navigateur (persistant si possible).";
    } else if (mode === STORAGE_MODES.FOLDER) {
      hint.textContent = "Le fichier sera créé dans : [dossier]/AssistantPersonnel/transactions.json";
    } else if (mode === STORAGE_MODES.DROPBOX) {
      hint.textContent = "Utilise l’app-folder Dropbox (scope minimal).";
    } else {
      hint.textContent = "";
    }
  }
}

const DEFAULT_CATEGORY = "autre";

// ====== Jours fériés FR (année courante + adjacentes) ======
const HOLIDAYS_CACHE = new Map();
function getFrenchHolidays(year) {
  if (HOLIDAYS_CACHE.has(year)) return HOLIDAYS_CACHE.get(year);
  const d = date => formatDate(date);
  const fixed = {
    [`${year}-01-01`]: "Jour de l'an",
    [`${year}-05-01`]: "Fête du Travail",
    [`${year}-05-08`]: "Victoire 1945",
    [`${year}-07-14`]: "Fête Nationale",
    [`${year}-08-15`]: "Assomption",
    [`${year}-11-01`]: "Toussaint",
    [`${year}-11-11`]: "Armistice",
    [`${year}-12-25`]: "Noël",
    ...(() => {
      // Calcul Pâques (algorithme de Butcher)
      function calcEaster(y) {
        const a = y % 19;
        const b = Math.floor(y / 100);
        const c = y % 100;
        const d0 = Math.floor(b / 4);
        const e = b % 4;
        const f = Math.floor((b + 8) / 25);
        const g = Math.floor((b - f + 1) / 3);
        const h = (19 * a + b - d0 - g + 15) % 30;
        const i = Math.floor(c / 4);
        const k = c % 4;
        const l = (32 + 2 * e + 2 * i - h - k) % 7;
        const m = Math.floor((a + 11 * h + 22 * l) / 451);
        const month = Math.floor((h + l - 7 * m + 114) / 31);
        const day = ((h + l - 7 * m + 114) % 31) + 1;
        return new Date(y, month - 1, day);
      }
      const easter = calcEaster(year);
      const easterMonday = new Date(easter); easterMonday.setDate(easter.getDate() + 1);
      const ascension = new Date(easter); ascension.setDate(easter.getDate() + 39);
      const pentecostMonday = new Date(easter); pentecostMonday.setDate(easter.getDate() + 50);
      return {
        [d(easterMonday)]: "Lundi de Pâques",
        [d(ascension)]: "Ascension",
        [d(pentecostMonday)]: "Lundi de Pentecôte"
      };
    })()
  };
  HOLIDAYS_CACHE.set(year, fixed);
  return fixed;
}

// --- Auth Dropbox
function isDropboxConnected() {
  return !!accessToken;
}
function loginDropbox() {
  const redirectUri = window.location.origin + window.location.pathname;
  const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${DROPBOX_APP_KEY}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}`;
  window.location.href = authUrl;
}
function parseDropboxTokenFromUrl() {
  if (window.location.hash.startsWith("#access_token=")) {
    const params = new URLSearchParams(window.location.hash.substr(1));
    accessToken = params.get("access_token");
    window.localStorage.setItem("dropbox_token", accessToken);
    window.location.hash = "";
  }
}
function restoreDropboxSession() {
  const saved = window.localStorage.getItem("dropbox_token");
  if (saved) accessToken = saved;
}
function updateDropboxStatus() {
  const status = document.getElementById('dropbox-status');
  const logoutBtn = document.getElementById('dropbox-logout');
  const loginBtn = document.getElementById('dropbox-login');
  if (!status || !logoutBtn || !loginBtn) return;

  if (isDropboxConnected()) {
    status.textContent = "Connecté";
    status.style.color = "#27524b";
    loginBtn.style.display = "none";
    logoutBtn.style.display = "";
  } else {
    status.textContent = "Non connecté";
    status.style.color = "#d32f2f";
    loginBtn.style.display = "";
    logoutBtn.style.display = "none";
  }
}

// Handler déconnexion
function logoutDropbox() {
  accessToken = null;
  localStorage.removeItem('dropbox_token');
  updateDropboxStatus();

  // repasse en Local
  setStorageModeLocalValue('local');
  renderStorageModeUI();

  loadTransactionsLocal();
  updateViews();
}

async function loadTransactionsDropbox() {
  try {
    const response = await dbx.filesDownload({path: DROPBOX_FILE});
    const blob = response.result.fileBlob || response.result.fileBinary;
    const text = await blob.text();
    transactions = JSON.parse(text);
    saveTransactionsLocal();
    updateViews();
  } catch (e) {
    transactions = [];
    updateViews();
  }
}

async function saveTransactionsDropbox() {
  if (!dbx || !accessToken) return;
  try {
    await dbx.filesUpload({
      path: DROPBOX_FILE,
      contents: JSON.stringify(transactions, null, 2),
                          mode: { ".tag": "overwrite" }
    });
  } catch (e) {
    alert("Erreur lors de la sauvegarde Dropbox : " + JSON.stringify(e.error || e));
    throw e;
  }
}

// === Fonctions utilitaires pour l'intégration d'autres services cloud ===
function isGoogleConnected() { return !!googleAccessToken; }
function isMSConnected() { return !!msAccessToken; }

function loginGoogle() {
  const redirectUri = window.location.origin + window.location.pathname;
  sessionStorage.setItem('oauth_service', 'google');
  const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}` +
  `&response_type=token` +
  `&redirect_uri=${encodeURIComponent(redirectUri)}` +
  `&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.file')}` +
  `&include_granted_scopes=true` +
  `&state=google`;
  window.location.href = authUrl;
}
function loginMS() {
  const redirectUri = window.location.origin + window.location.pathname;
  sessionStorage.setItem('oauth_service', 'ms');
  const authUrl =
  `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${MICROSOFT_CLIENT_ID}` +
  `&response_type=token` +
  `&redirect_uri=${encodeURIComponent(redirectUri)}` +
  `&scope=${encodeURIComponent('Files.ReadWrite offline_access')}` +
  `&state=ms`;
  window.location.href = authUrl;
}
function parseCloudTokensFromUrl() {
  if (window.location.hash.startsWith('#access_token=')) {
    const params = new URLSearchParams(window.location.hash.substr(1));
    const token = params.get('access_token');
    const state = params.get('state') || sessionStorage.getItem('oauth_service');
    window.location.hash = '';
    if (!token) return;
    if (state === 'google') {
      googleAccessToken = token;
      localStorage.setItem('google_token', googleAccessToken);
    } else if (state === 'ms') {
      msAccessToken = token;
      localStorage.setItem('ms_token', msAccessToken);
    }
    sessionStorage.removeItem('oauth_service');
    updateGoogleStatus();
    updateMSStatus();
  }
}
function restoreGoogleSession() {
  const saved = localStorage.getItem('google_token');
  if (saved) googleAccessToken = saved;
}
function restoreMicrosoftSession() {
  const saved = localStorage.getItem('ms_token');
  if (saved) msAccessToken = saved;
}
function updateGoogleStatus() {
  const status = document.getElementById('google-status');
  const loginBtn = document.getElementById('google-login');
  const logoutBtn = document.getElementById('google-logout');
  if (!status || !loginBtn || !logoutBtn) return;
  if (isGoogleConnected()) {
    status.textContent = "Connecté";
    status.style.color = "#27524b";
    loginBtn.style.display = "none";
    logoutBtn.style.display = "";
  } else {
    status.textContent = "Non connecté";
    status.style.color = "#d32f2f";
    loginBtn.style.display = "";
    logoutBtn.style.display = "none";
  }
}
function logoutGoogle() {
  googleAccessToken = null;
  localStorage.removeItem('google_token');
  updateGoogleStatus();
}
function updateMSStatus() {
  const status = document.getElementById('ms-status');
  const loginBtn = document.getElementById('ms-login');
  const logoutBtn = document.getElementById('ms-logout');
  if (!status || !loginBtn || !logoutBtn) return;
  if (isMSConnected()) {
    status.textContent = "Connecté";
    status.style.color = "#27524b";
    loginBtn.style.display = "none";
    logoutBtn.style.display = "";
  } else {
    status.textContent = "Non connecté";
    status.style.color = "#d32f2f";
    loginBtn.style.display = "";
    logoutBtn.style.display = "none";
  }
}
function logoutMS() {
  msAccessToken = null;
  localStorage.removeItem('ms_token');
  updateMSStatus();
}

// ====== UI : Profil / Menu ======
(function setupProfileMenu() {
  const trigger = document.getElementById('profile-trigger');
  const menu = document.getElementById('profile-dropdown');
  if (!trigger || !menu) return;

  function closeMenu() {
    menu.style.display = 'none';
    trigger.setAttribute('aria-expanded', 'false');
  }
  function openMenu() {
    menu.style.display = 'block';
    trigger.setAttribute('aria-expanded', 'true');
  }
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.style.display === 'block') closeMenu();
    else openMenu();
  });
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && e.target !== trigger) {
        closeMenu();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });
})();

// ===== Toggle de thème sombre (switch avec persistance) =====
(function setupThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;

  const STORAGE_KEY = 'theme';
  const root = document.documentElement; // ✅ un seul endroit (html)

// état initial : respecte localStorage sinon prefers-color-scheme
const saved = localStorage.getItem(STORAGE_KEY);
const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
const initialDark = saved ? (saved === 'dark') : prefersDark;

root.classList.toggle('dark-mode', initialDark);
btn.setAttribute('aria-pressed', initialDark ? 'true' : 'false');

btn.addEventListener('click', () => {
  const enabled = root.classList.toggle('dark-mode');
  localStorage.setItem(STORAGE_KEY, enabled ? 'dark' : 'light');
  btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');

  // rafraîchis ce qui dépend du thème si besoin
  if (typeof renderCalendar === 'function') renderCalendar();
  if (typeof renderMonthSummary === 'function') renderMonthSummary();
  if (typeof applyStoredCalendarColors === 'function') applyStoredCalendarColors();
  if (typeof updateLegendSwatches === 'function') updateLegendSwatches();
});
})();

// ====== CATEGORY PICKER (icônes multi-librairies) ======
const ICON_SETS = {
  fa: [
    "fa-solid fa-utensils","fa-solid fa-cart-shopping","fa-solid fa-bus","fa-solid fa-house",
    "fa-solid fa-heart-pulse","fa-solid fa-dumbbell","fa-solid fa-gamepad","fa-solid fa-gift",
    "fa-solid fa-paw","fa-solid fa-tv","fa-solid fa-mobile-screen","fa-solid fa-bolt",
    "fa-solid fa-book","fa-solid fa-plane","fa-solid fa-car","fa-solid fa-ticket",
    "fa-regular fa-circle-question"
  ],
  mi: [
    "restaurant","shopping_cart","directions_bus","home","favorite","sports_esports",
    "redeem","pets","local_movies","devices","bolt","book","flight","directions_car","confirmation_number","help"
  ],
  bs: [
    "bi-basket2-fill","bi-bag-fill","bi-bus-front-fill","bi-house-fill","bi-heart-pulse-fill",
    "bi-controller","bi-gift-fill","bi-unity","bi-camera-reels-fill","bi-phone-fill","bi-lightning-charge-fill",
    "bi-book-fill","bi-airplane-fill","bi-car-front-fill","bi-ticket-perforated-fill","bi-question-circle"
  ]
};

// Charge les Bootstrap Icons si pas déjà fait (sécurité)
if (!document.querySelector('link[href*="bootstrap-icons"]')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css';
  document.head.appendChild(link);
}

// ====== CATEGORY PICKER (formulaire principal) ======
function renderCategoryPicker() {
  const picker = document.getElementById('category-dropdown');
  const selectedCat = document.getElementById('selected-category');
  const input = document.getElementById('category');
  if (!picker || !selectedCat || !input) return;

  // ⚠️ Onglets désormais SCOPÉS au picker (et plus au document)
  const tabs = picker.querySelectorAll('.icon-tab');

  const listFA = picker.querySelector('.icon-picker-list[data-tab="fa"]');
  const listMI = picker.querySelector('.icon-picker-list[data-tab="mi"]');
  const listBS = picker.querySelector('.icon-picker-list[data-tab="bs"]');

  function makeItem(set, name) {
    const span = document.createElement('span');
    span.className = 'cat-icon';
    if (set === 'fa') {
      const i = document.createElement('i'); i.className = name; span.appendChild(i);
    } else if (set === 'mi') {
      const m = document.createElement('span'); m.className = 'material-icons'; m.textContent = name; span.appendChild(m);
    } else if (set === 'bs') {
      const i = document.createElement('i'); i.className = `bi ${name}`; span.appendChild(i);
    }

    // Empêche le submit du form quand on choisit une icône
    span.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      input.value = `${set}::${name}`;
      selectedCat.innerHTML = '';
      if (set === 'fa') {
        const i = document.createElement('i'); i.className = name; selectedCat.appendChild(i);
      } else if (set === 'mi') {
        const m = document.createElement('span'); m.className = 'material-icons'; m.textContent = name; selectedCat.appendChild(m);
      } else {
        const i = document.createElement('i'); i.className = `bi ${name}`; selectedCat.appendChild(i);
      }
      picker.style.display = 'none';
    });

    return span;
  }

  if (listFA && listFA.children.length === 0) ICON_SETS.fa.forEach(n => listFA.appendChild(makeItem('fa', n)));
  if (listMI && listMI.children.length === 0) ICON_SETS.mi.forEach(n => listMI.appendChild(makeItem('mi', n)));
  if (listBS && listBS.children.length === 0) ICON_SETS.bs.forEach(n => listBS.appendChild(makeItem('bs', n)));

  // Sécurise seulement les onglets du PICKER
  tabs.forEach(tab => {
    if (tab.tagName.toLowerCase() === 'button' && !tab.getAttribute('type')) {
      tab.setAttribute('type', 'button');
    }
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // ⚠️ On opère uniquement dans le picker
      picker.querySelectorAll('.icon-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      picker.querySelectorAll('.icon-picker-list').forEach(list => {
        list.style.display = (list.getAttribute('data-tab') === target) ? '' : 'none';
      });
    });
  });

  // Toggle + fermeture extérieure (une seule fois)
  if (picker.dataset.bound !== '1') {
    selectedCat.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isHidden = getComputedStyle(picker).display === 'none';
      picker.style.display = isHidden ? 'block' : 'none';
    });
    picker.addEventListener('click', (e) => { e.stopPropagation(); });
    document.addEventListener('click', () => { picker.style.display = 'none'; });
    picker.dataset.bound = '1';
  }

  if (!input.value && selectedCat.innerHTML.trim() === '') {
    selectedCat.innerHTML = '<i class="fa-regular fa-circle-question"></i>';
  }
}

// ===== Picker catégorie de la modale d’ajout rapide =====
function renderQuickAddPicker() {
  const picker = document.getElementById('add-category-dropdown');
  const selectedCat = document.getElementById('add-selected-category');
  const input = document.getElementById('add-category');
  const tabs = picker?.querySelectorAll('.icon-tab') || [];
  if (!picker || !selectedCat || !input) return;

  const listFA = picker.querySelector('.icon-picker-list[data-tab="fa"]');
  const listMI = picker.querySelector('.icon-picker-list[data-tab="mi"]');
  const listBS = picker.querySelector('.icon-picker-list[data-tab="bs"]');

  function makeItem(set, name) {
    const span = document.createElement('span');
    span.className = 'cat-icon';
    if (set === 'fa') {
      const i = document.createElement('i');
      i.className = name;
      span.appendChild(i);
    } else if (set === 'mi') {
      const m = document.createElement('span');
      m.className = 'material-icons';
      m.textContent = name;
      span.appendChild(m);
    } else if (set === 'bs') {
      const i = document.createElement('i');
      i.className = `bi ${name}`;
      span.appendChild(i);
    }

    // Empêche toute soumission de formulaire lors du choix d'une icône
    span.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      input.value = `${set}::${name}`;
      selectedCat.innerHTML = '';
      if (set === 'fa') {
        const i = document.createElement('i');
        i.className = name;
        selectedCat.appendChild(i);
      } else if (set === 'mi') {
        const m = document.createElement('span');
        m.className = 'material-icons';
        m.textContent = name;
        selectedCat.appendChild(m);
      } else {
        const i = document.createElement('i');
        i.className = `bi ${name}`;
        selectedCat.appendChild(i);
      }
      picker.style.display = 'none';
    });

    return span;
  }

  if (listFA && listFA.children.length === 0) ICON_SETS.fa.forEach(n => listFA.appendChild(makeItem('fa', n)));
  if (listMI && listMI.children.length === 0) ICON_SETS.mi.forEach(n => listMI.appendChild(makeItem('mi', n)));
  if (listBS && listBS.children.length === 0) ICON_SETS.bs.forEach(n => listBS.appendChild(makeItem('bs', n)));

  // Sécurise les onglets : pas de submit
  tabs.forEach(tab => {
    if (tab.tagName.toLowerCase() === 'button' && !tab.getAttribute('type')) {
      tab.setAttribute('type', 'button');
    }
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      picker.querySelectorAll('.icon-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      picker.querySelectorAll('.icon-picker-list').forEach(list => {
        list.style.display = (list.getAttribute('data-tab') === target) ? '' : 'none';
      });
    });
  });

  // Toggle + fermeture extérieure (une seule fois)
  if (picker.dataset.bound !== '1') {
    selectedCat.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isHidden = getComputedStyle(picker).display === 'none';
      picker.style.display = isHidden ? 'block' : 'none';
    });
    picker.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    document.addEventListener('click', () => {
      picker.style.display = 'none';
    });
    picker.dataset.bound = '1';
  }

  if (!input.value && selectedCat.innerHTML.trim() === '') {
    selectedCat.innerHTML = '<i class="fa-regular fa-circle-question"></i>';
  }
}

// --- Helper : ouvre la modale d’ajout rapide pour une date donnée
function openQuickAddForDate(dStr) {
  const modal = document.getElementById('modal-add-transaction');
  if (!modal) return;

  modal.style.display = 'block';

  const dateInput = document.getElementById('add-date');
  if (dateInput) writeDateInput('add-date', dStr); // dStr = ISO -> affichage dd-mm-aaaa

  const desc = document.getElementById('add-description');
  if (desc) setTimeout(() => desc.focus(), 50);

  // Réattache (idempotent grâce à data-bound)
  renderQuickAddPicker();
}

// ===== RÉCURRENCES VIRTUELLES =====
function lastDayOfMonth(y, m0) { // m0 = 0..11
  return new Date(y, m0 + 1, 0).getDate();
}

/**
 * Retourne true si la transaction "tx" a une occurrence le jour ISO "iso"
 * (tx est stockée une seule fois ; on calcule les occurrences à la volée)
 */
function occursOnDate(tx, iso) {
  const d = parseDate(iso);
  const a = parseDate(tx.date); // ancre
  const until = tx.until ? parseDate(tx.until) : null;
  const applyPrev = !!tx.applyPrev;

  // borne haute “Jusqu’à”
  if (until && d > until) return false;

  // si pas de récurrence
  if (!tx.recurrence || tx.recurrence === 'none') {
    return iso === tx.date;
  }

  // si pas applyPrev, on ne commence pas avant l’ancre
  if (!applyPrev && d < a) return false;

  // helpers
  const monthsBetween = (from, to) =>
  (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());

  if (tx.recurrence === 'monthly') {
    const wantedDay = Math.min(a.getDate(), lastDayOfMonth(d.getFullYear(), d.getMonth()));
    return (d.getDate() === wantedDay);
  }

  if (tx.recurrence === 'yearly') {
    const wantedDay = Math.min(a.getDate(), lastDayOfMonth(d.getFullYear(), d.getMonth()));
    return (d.getMonth() === a.getMonth()) && (d.getDate() === wantedDay);
  }

  if (tx.recurrence === 'installments') {
    const total = Number(tx.installments || 0);
    if (!total || total < 2) return iso === tx.date;
    const months = monthsBetween(a, d);
    // installments commencent à l’ancre, pas d’infini vers le passé
    if (months < 0 || months >= total) return false;
    const wantedDay = Math.min(a.getDate(), lastDayOfMonth(d.getFullYear(), d.getMonth()));
    return d.getDate() === wantedDay;
  }

  return false;
}

/**
 * Renvoie toutes les occurrences "virtuelles" des transactions
 * dans l’intervalle [startIso .. endIso] (incluses).
 * Chaque occurrence renvoyée est une copie superficielle avec date
 * positionnée sur l’occurrence et un flag __instance = true.
 */
function expandTransactionsBetween(startIso, endIso) {
  const start = parseDate(startIso), end = parseDate(endIso);
  const out = [];
  // Itère jour par jour (suffisant pour l’UI ; on ne manipule pas de gros volumes)
  for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const dayIso = formatDate(cursor);
    for (const tx of transactions) {
      if (occursOnDate(tx, dayIso)) {
        out.push({ ...tx, date: dayIso, __instance: true });
      }
    }
  }
  return out;
}

// --- Calendrier : rendu + écouteurs (click + double‑click propre)
function renderCalendar() {
  const table = document.getElementById('calendar');
  const details = document.getElementById('day-details');
  const monthTitle = document.getElementById('current-month');
  if (!table || !details || !monthTitle) return;

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  // Mois + année avec majuscule
  const label = currentMonth.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  monthTitle.textContent = label.charAt(0).toUpperCase() + label.slice(1);

  const firstDay = new Date(year, month, 1);
  const startDay = firstDay.getDay() || 7; // Lundi=1 ... Dimanche=7
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const holidays = {
    ...getFrenchHolidays(year - 1),
    ...getFrenchHolidays(year),
    ...getFrenchHolidays(year + 1)
  };

  let html = `
  <thead>
  <tr>
  <th>Lun</th><th>Mar</th><th>Mer</th><th>Jeu</th><th>Ven</th><th>Sam</th><th>Dim</th>
  </tr>
  </thead>
  <tbody>
  `;

  let day = 1;
  for (let row = 0; row < 6; row++) {
    html += '<tr>';
    for (let col = 1; col <= 7; col++) {
      if ((row === 0 && col < startDay) || day > daysInMonth) {
        html += '<td></td>';
      } else {
        const d = new Date(year, month, day);
        const dStr = formatDate(d);
        const isWeekend = (col >= 6);
        const isHoliday = holidays[dStr] !== undefined;
        const isToday = sameDay(d, new Date());

        let cls = '';
        if (isWeekend) cls += ' calendar-weekend';
        if (isHoliday) cls += ' calendar-holiday';
        if (isToday) cls += ' calendar-today';
        if (selectedDate === dStr) cls += ' selected';

        const dayTx = transactions.filter(t => occursOnDate(t, dStr));

        html += `<td class="${cls.trim()}" data-date="${dStr}">
        <div class="day-number">${day}</div>
        ${dayTx.map(t => `<span class="event-dot" title="${t.description}">${renderCategoryIconInline(t.category)}</span>`).join('')}
        </td>`;
        day++;
      }
    }
    html += '</tr>';
  }
  html += '</tbody>';
  table.innerHTML = html;

  // CLICK : sélection + détails + bouton
  table.onclick = (e) => {
    const td = e.target.closest('td[data-date]');
    if (!td) return;

    // met à jour la sélection visuelle
    table.querySelectorAll('td.selected').forEach(c => c.classList.remove('selected'));
    td.classList.add('selected');

    // mémorise la date sélectionnée
    selectedDate = td.getAttribute('data-date');

    const d = parseDate(selectedDate);
    const dayTx = transactions.filter(t => occursOnDate(t, selectedDate));

    details.innerHTML = `
    <strong>${d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).replace(/^\w/, c=>c.toUpperCase())}</strong>
    <div id="day-tx-list" style="margin-top:.5em;">
    ${
      dayTx.length ? dayTx.map(tx => `
      <div class="tx-line" data-tx-id="${tx.id}" tabindex="0" style="padding:.2em .3em;border-radius:6px;outline:none;cursor:pointer;">
      ${renderCategoryIconInline(tx.category)} ${tx.description} — <strong>${(tx.type === 'income' ? '+' : '-')}${Number(tx.amount).toFixed(2)}€</strong>
      </div>`).join('') : '<em>Aucune transaction</em>'
    }
    </div>
    <div style="margin-top:.6em;">
    <button id="open-quick-add" style="background:#27524b;color:#fff;border:none;border-radius:6px;padding:.4em .8em;cursor:pointer;">
    Ajouter une transaction
    </button>
    </div>
    `;

    // NEW: gestion de la sélection visuelle + mémorisation de l'id
    selectedTxId = null; // reset à chaque jour cliqué
    const listEl = details.querySelector('#day-tx-list');

    // Auto-sélection de la première ligne si présente
    const firstLine = listEl?.querySelector('.tx-line');
    if (firstLine) {
      firstLine.classList.add('is-selected');
      selectedTxId = firstLine.dataset.txId;
    }

    // Gestion du clic manuel sur les lignes
    listEl?.querySelectorAll('.tx-line').forEach(el => {
      el.addEventListener('click', () => {
        listEl.querySelectorAll('.tx-line').forEach(n => n.classList.remove('is-selected'));
        el.classList.add('is-selected');
        selectedTxId = el.dataset.txId;
      });
    });

    // (facultatif) style inline si tu préfères éviter le CSS
    const styleSelected = 'rgba(101,184,247,0.20)';
    listEl?.querySelectorAll('.tx-line').forEach(n => n.addEventListener('click', () => {
      listEl.querySelectorAll('.tx-line').forEach(m => m.style.background = '');
      n.style.background = styleSelected;
    }));

    const btn = document.getElementById('open-quick-add');
    if (btn) btn.onclick = () => openQuickAddForDate(selectedDate);
  };

    // DOUBLE‑CLICK : ouvre directement la modale
    table.ondblclick = (e) => {
      const td = e.target.closest('td[data-date]');
      if (!td) return;
      selectedDate = td.getAttribute('data-date');
      openQuickAddForDate(selectedDate);
    };
}

// ===== Sélecteur annuel de mois =====
const MONTH_NAMES_FR = Array.from({length:12}, (_,i) => {
  const s = new Date(2000, i, 1).toLocaleString('fr-FR', { month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
});

function setupMonthPicker() {
  const trigger = document.getElementById('current-month');
  const panel   = document.getElementById('month-picker');
  if (!trigger || !panel) return;

  let panelYear = new Date().getFullYear(); // année affichée dans le picker

  const MONTH_NAMES_FR = Array.from({length:12}, (_,i) => {
    const s = new Date(2000, i, 1).toLocaleString('fr-FR', { month: 'long' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  });

  function renderMonthGrid() {
    const curM = currentMonth.getMonth();
    const curY = currentMonth.getFullYear();

    panel.innerHTML = `
    <div class="mp-header">
    <button class="mp-nav" id="mp-prev-year" aria-label="Année précédente">«</button>
    <div class="mp-title">${panelYear}</div>
    <button class="mp-nav" id="mp-next-year" aria-label="Année suivante">»</button>
    </div>
    <div class="mp-grid">
    ${MONTH_NAMES_FR.map((name, idx) => `
      <button class="mp-cell ${(panelYear===curY && idx===curM) ? 'active' : ''}"
      data-month="${idx}">
      ${name}
      </button>
      `).join('')}
      </div>
      `;

      // Flèche année précédente : change l'année + met à jour le calendrier tout de suite (même mois)
      document.getElementById('mp-prev-year').onclick = (e) => {
        e.stopPropagation();
        panelYear -= 1;
        currentMonth = new Date(currentMonth.getFullYear() - 1, currentMonth.getMonth(), 1);
        updateViews();
        renderMonthGrid();
      };

      // Flèche année suivante : idem
      document.getElementById('mp-next-year').onclick = (e) => {
        e.stopPropagation();
        panelYear += 1;
        currentMonth = new Date(currentMonth.getFullYear() + 1, currentMonth.getMonth(), 1);
        updateViews();
        renderMonthGrid();
      };

      // Clic sur un mois : saute directement (année = panelYear), puis ferme le panneau
      panel.querySelectorAll('.mp-cell').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const m = parseInt(btn.dataset.month, 10);
          currentMonth = new Date(panelYear, m, 1);
          updateViews();
          closePanel();
        };
      });
  }

  function openPanel() {
    panelYear = currentMonth.getFullYear();
    renderMonthGrid();
    panel.style.display = 'block';
    setTimeout(() => {
      document.addEventListener('click', onOutside, { once: true });
      document.addEventListener('keydown', onEsc, { once: true });
    }, 0);
  }
  function closePanel() { panel.style.display = 'none'; }
  function onOutside(e) { if (!panel.contains(e.target) && e.target !== trigger) closePanel(); }
  function onEsc(e) { if (e.key === 'Escape') closePanel(); }

  trigger.style.cursor = 'pointer';
  trigger.title = 'Cliquer pour choisir un mois';
  trigger.onclick = (e) => {
    e.stopPropagation();
    const visible = getComputedStyle(panel).display !== 'none';
    visible ? closePanel() : openPanel();
  };
}

// Rendu d’une icône de catégorie inline (pour listes)
function renderCategoryIconInline(cat) {
  const val = String(cat || '').trim();
  if (!val) return `<i class="fa-regular fa-circle-question" aria-hidden="true"></i>`;

  // 1) Ancien format set::name
  if (val.includes('::')) {
    const [set, name] = val.split('::');
    if (set === 'fa') return `<i class="${name}" aria-hidden="true"></i>`;
    if (set === 'mi') return `<span class="material-icons" aria-hidden="true">${name}</span>`;
    if (set === 'bs') return `<i class="bi ${name}" aria-hidden="true"></i>`;
  }

  // 2) Nouveau format: classes directes
  // Font Awesome : contient "fa-"
  if (/\bfa-/.test(val)) {
    return `<i class="${val}" aria-hidden="true"></i>`;
  }
  // Bootstrap Icons : "bi ..." ou "bi-..."
  if (/^bi\b/.test(val) || /\bbi-/.test(val)) {
    const cls = val.startsWith('bi ') ? val : (val.startsWith('bi-') ? `bi ${val}` : val);
    return `<i class="${cls}" aria-hidden="true"></i>`;
  }

  // 3) Fallback : on considère un nom Material Icons
  return `<span class="material-icons" aria-hidden="true">${val}</span>`;
}

// ===============================
//  Historique — rendu avec data-id + clic crayon câblé directement
// ===============================
function renderTransactionList() {
  const ul = document.getElementById('transactions-list');
  if (!ul) return;

  // ---- Où trouver les transactions ?
  function getTxs() {
    try { if (Array.isArray(window.transactions) && window.transactions.length) return window.transactions; } catch(_) {}
    try { if (Array.isArray(window.allTransactions) && window.allTransactions.length) return window.allTransactions; } catch(_) {}
    try { if (Array.isArray(window.txs) && window.txs.length) return window.txs; } catch(_) {}
    // localStorage (plusieurs clés possibles)
    const keys = ['transactions','finance_transactions','finances:transactions','txs','data_transactions'];
    for (const k of keys) {
      try {
        const raw = localStorage.getItem(k);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) return parsed;
        if (parsed && Array.isArray(parsed.items) && parsed.items.length) return parsed.items;
      } catch(_) {}
    }
    return [];
  }

  const txs = getTxs().slice();

  // ---- Helpers
  const fmtDate = (d) => {
    const dd = new Date(d);
    return isNaN(dd) ? String(d) : dd.toLocaleDateString('fr-FR');
  };
  const sign = (t, v) => (t === 'income' ? '+' : t === 'expense' ? '−' : (Number(v) >= 0 ? '+' : '−'));
  const num  = (v) => Math.abs(Number(v || 0)).toFixed(2);
  const iconHtml = (cat) => (/fa-/.test(String(cat||'')) ? `<i class="${cat}" aria-hidden="true"></i>` : '');

  // ---- Tri (récent -> ancien)
  txs.sort((a, b) => {
    const ta = Date.parse(a?.date || a?.day || 0) || 0;
    const tb = Date.parse(b?.date || b?.day || 0) || 0;
    return tb - ta;
  });

  // ---- Rendu
  ul.innerHTML = '';

  if (!txs.length) {
    const li = document.createElement('li');
    li.style.opacity = '.75';
    li.textContent = 'Aucune transaction trouvée.';
    ul.appendChild(li);
    return;
  }

  txs.forEach((tx, idx) => {
    const id = String(tx.id || tx._id || tx.uuid || `${(tx.date || 'unk')}-${idx}`);

    const li = document.createElement('li');
    li.dataset.id = id;
    li.id = `tx-${id}`;

    // Colonne gauche: icône + description
    const left = document.createElement('span');
    left.style.display = 'inline-flex';
    left.style.alignItems = 'center';
    left.style.gap = '.4rem';
    left.innerHTML = `${iconHtml(tx.category)} ${tx.description || tx.label || ''}`;

    // Colonne droite: date + montant
    const right = document.createElement('span');
    right.style.marginLeft = 'auto';
    right.innerHTML = `${fmtDate(tx.date || tx.day)} — <strong>${sign(tx.type, tx.amount)}${num(tx.amount)}€</strong>`;

    // Bouton Éditer (clic direct -> openEditModal)
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.title = 'Modifier';
    editBtn.className = 'edit-btn';
    editBtn.setAttribute('data-action', 'edit');
    editBtn.setAttribute('data-id', id);
    editBtn.style.background = 'none';
    editBtn.style.border = 'none';
    editBtn.style.cursor = 'pointer';
    editBtn.innerHTML = `<i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>`;
    editBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const fn = (typeof window.openEditModal === 'function') ? window.openEditModal
      : (typeof openEditModal === 'function') ? openEditModal
      : null;
      if (!fn) { console.warn('openEditModal indisponible'); return; }
      fn(id);
    }, false);

    // Bouton Supprimer (simple)
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.title = 'Supprimer';
    delBtn.className = 'remove-btn';
    delBtn.setAttribute('data-action', 'delete');
    delBtn.setAttribute('data-id', id);
    delBtn.style.background = 'none';
    delBtn.style.border = 'none';
    delBtn.style.cursor = 'pointer';
    delBtn.style.color = '#d32f2f';
    delBtn.innerHTML = `<i class="fa-solid fa-trash" aria-hidden="true"></i>`;
    delBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm('Supprimer cette transaction ?')) return;

      // Essaie de supprimer dans la source globale
      try {
        if (Array.isArray(window.transactions)) {
          const i = window.transactions.findIndex(t => String(t.id || t._id || t.uuid) === String(id));
          if (i >= 0) window.transactions.splice(i, 1);
          localStorage.setItem('transactions', JSON.stringify(window.transactions));
        } else {
          // fallback localStorage
          const s = localStorage.getItem('transactions');
          if (s) {
            const arr = JSON.parse(s);
            const j = arr.findIndex(t => String(t.id || t._id || t.uuid) === String(id));
            if (j >= 0) {
              arr.splice(j, 1);
              localStorage.setItem('transactions', JSON.stringify(arr));
            }
          }
        }
      } catch(_) {}

      renderTransactionList();
      document.dispatchEvent(new Event('transactions:changed'));
    }, false);

    // Assemblage
    li.appendChild(left);
    li.appendChild(right);
    li.appendChild(editBtn);
    li.appendChild(delBtn);
    ul.appendChild(li);
  });
}

// Période des stats (synchro avec les <select> HTML)
let STATS_PERIOD = 'month'; // 'day' | 'month' | 'year'

function getStatsRange() {
  const today = new Date();
  if (STATS_PERIOD === 'day') {
    const d = selectedDate ? parseDate(selectedDate) : today;
    const iso = formatDate(d);
    return { startIso: iso, endIso: iso, label: d.toLocaleDateString('fr-FR') };
  }
  if (STATS_PERIOD === 'year') {
    const y = currentMonth.getFullYear();
    return {
      startIso: formatDate(new Date(y, 0, 1)),
      endIso:   formatDate(new Date(y, 11, 31)),
      label: `Année ${y}`
    };
  }
  // default: month
  const y = currentMonth.getFullYear(), m0 = currentMonth.getMonth();
  const label = currentMonth.toLocaleDateString('fr-FR',{ month:'long', year:'numeric' });
  return {
    startIso: formatDate(new Date(y, m0, 1)),
    endIso:   formatDate(new Date(y, m0 + 1, 0)),
    label
  };
}

// ====== STATS ======
let pieChart;
function renderStats() {
  const canvas = document.getElementById('pie-chart');
  const info = document.getElementById('stats-info');
  if (!canvas || !info) return;

  const { startIso, endIso, label } = getStatsRange();

  // Développe les occurrences uniquement dans la plage demandée
  const inst = expandTransactionsBetween(startIso, endIso);

  // On calcule sur les DÉPENSES uniquement (comme avant)
  const expense = inst.filter(t => t.type === 'expense');
  const byCat = {};
  for (const tx of expense) {
    const key = tx.category || DEFAULT_CATEGORY;
    byCat[key] = (byCat[key] || 0) + Number(tx.amount || 0);
  }
  const labels = Object.keys(byCat);
  const values = labels.map(k => byCat[k]);

  if (pieChart) { pieChart.destroy(); pieChart = null; }
  if (typeof Chart === 'undefined') {
    info.textContent = 'Stats indisponibles (Chart.js non chargé)';
    return;
  }
  pieChart = new Chart(canvas.getContext('2d'), {
    type: 'pie',
    data: { labels, datasets: [{ data: values }] },
    options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
  });

  const total = values.reduce((a,b)=>a+b,0);
  info.textContent = `Total dépenses (${label}) : ${total.toFixed(2)} €`;
}

function renderMonthSummary() {
  const list = document.getElementById('month-tx-list');
  if (!list) return;

  const sortIcon = document.getElementById('month-sort-icon');
  const groupCheckbox = document.getElementById('group-by-category');

  // Libellé humain depuis une classe fa-...
  function humanLabel(raw){
    if (!raw) return 'Divers';
    const s = String(raw).trim();
    const allFa = s.match(/fa-[a-z0-9-]+/gi) || [];
    const variants = new Set(['fa-solid','fa-regular','fa-light','fa-thin','fa-duotone','fa-brands']);
    const lastFa = allFa.reverse().find(k => !variants.has(k.toLowerCase())) || s;

    const MAP = {
      // Transport
      'fa-bus':'Transport','fa-bus-simple':'Transport','fa-train':'Transport',
      'fa-car':'Auto','fa-gas-pump':'Carburant',
      // Vie courante
      'fa-cart-shopping':'Courses','fa-basket-shopping':'Courses',
      'fa-utensils':'Restauration',
      // Finance
      'fa-briefcase':'Salaire','fa-money-bill':'Salaire','fa-sack-dollar':'Revenu','fa-coins':'Revenu'
    };
    if (MAP[lastFa]) return MAP[lastFa];
    const simple = lastFa.replace(/^fa-/, '').replace(/-/g, ' ');
    return simple.charAt(0).toUpperCase() + simple.slice(1);
  }

  // Période = mois courant
  const y = currentMonth.getFullYear();
  const m0 = currentMonth.getMonth();
  const startIso = formatDate(new Date(y, m0, 1));
  const endIso   = formatDate(new Date(y, m0 + 1, 0));
  const filtered = expandTransactionsBetween(startIso, endIso);

  // Tri
  const sorted = [...filtered].sort((a, b) => {
    if (monthSortMode === 'date-asc')   return new Date(a.date) - new Date(b.date);
    if (monthSortMode === 'date-desc')  return new Date(b.date) - new Date(a.date);
    if (monthSortMode === 'amount-asc') return Number(a.amount) - Number(b.amount);
    if (monthSortMode === 'amount-desc')return Number(b.amount) - Number(a.amount);
    return new Date(a.date) - new Date(b.date);
  });

  // (optionnel) Icône de tri
  if (sortIcon) {
    sortIcon.className = ({
      'date-asc':   'fa-solid fa-arrow-up-1-9',
      'date-desc':  'fa-solid fa-arrow-down-9-1',
      'amount-asc': 'fa-solid fa-arrow-down-1-9',
      'amount-desc':'fa-solid fa-arrow-up-9-1'
    })[monthSortMode] || 'fa-solid fa-calendar-day';
  }

  list.innerHTML = '';

  if (groupCheckbox && groupCheckbox.checked) {
    // Regrouper par catégorie
    const groups = {};
    for (const tx of sorted) {
      const k = tx.category || DEFAULT_CATEGORY;
      (groups[k] = groups[k] || []).push(tx);
    }

    // Rendu des groupes
    Object.keys(groups).forEach(cat => {
      const items = groups[cat];
      const sum = items.reduce((s,t)=> s + Number(t.amount || 0), 0);
      const label = humanLabel(cat);

      // Header = icône + libellé + total + " · N tx"
      const header = document.createElement('li');
      header.style.fontWeight = '700';
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.innerHTML = `${renderCategoryIconInline(cat)}&nbsp;${label} — ${sum.toFixed(2)}€ · ${items.length}x`;

      // Bouton (▾)
      const toggleBtn = document.createElement('button');
      toggleBtn.textContent = '▾';
      toggleBtn.style.marginLeft = 'auto';
      toggleBtn.style.border = 'none';
      toggleBtn.style.background = 'transparent';
      toggleBtn.style.cursor = 'pointer';
      header.appendChild(toggleBtn);
      list.appendChild(header);

      // Lignes du groupe (ul imbriqué)
      const ul = document.createElement('ul');
      ul.style.listStyle = 'none';
      ul.style.paddingLeft = '1em';

      items.forEach(tx => {
        const li = document.createElement('li');
        const sign = tx.type === 'income' ? '+' : '−';
        li.innerHTML = `${new Date(tx.date).toLocaleDateString('fr-FR')} — ${tx.description} — <strong>${sign}${Number(tx.amount).toFixed(2)}€</strong>`;
        ul.appendChild(li);
      });
      list.appendChild(ul);

      // Ouvrir/fermer
      let open = true;
      toggleBtn.addEventListener('click', () => {
        open = !open;
        ul.style.display = open ? '' : 'none';
        toggleBtn.textContent = open ? '▾' : '▸';
      });
    });

  } else {
    // Liste simple
    for (const tx of sorted) {
      const li = document.createElement('li');
      const sign = tx.type === 'income' ? '+' : '−';
      li.innerHTML = `
      <span>${renderCategoryIconInline(tx.category)} ${tx.description}</span>
      <span>${new Date(tx.date).toLocaleDateString('fr-FR')} — <strong>${sign}${Number(tx.amount).toFixed(2)}€</strong></span>
      `;
      list.appendChild(li);
    }
  }
}

// ====== Formulaires ======
async function addTransaction(ev) {
  ev.preventDefault();
  const type = document.getElementById('type').value;
  const category = document.getElementById('category').value || (typeof DEFAULT_CATEGORY !== 'undefined' ? DEFAULT_CATEGORY : 'Autre');
  const description = document.getElementById('description').value.trim();
  const amount = Number(document.getElementById('amount').value);
  const dateISO = typeof readDateInput === 'function' ? readDateInput('date') : (document.getElementById('date').value || '').trim();
  const recurrence = document.getElementById('recurrence')?.value || 'none';
  const untilISO = typeof readDateInput === 'function' ? readDateInput('recurrence-end') : (document.getElementById('recurrence-end')?.value || '').trim();
  const installmentsEl = document.getElementById('installments');
  const installments = installmentsEl ? Number(installmentsEl.value || 0) : 0;
  const applyPrev = document.getElementById('apply-previous')?.checked || false;

  if (!description || !amount || !dateISO) return;

  const tx = {
    id: (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
    type, category, description,
    amount, date: dateISO,
    recurrence, applyPrev
  };
  if (recurrence === 'installments' && installments > 1) tx.installments = installments;
  if (recurrence !== 'none' && untilISO) tx.until = untilISO;

  // Ajoute la transaction en mémoire
  if (!Array.isArray(window.transactions)) window.transactions = [];
  window.transactions.push(tx);

  // Sauvegarde prioritaire : dossier local (si choisi) > Dropbox (si connecté) > Local navigateur
  try {
    if (window.__folderDirHandle && typeof saveTransactionsFolder === 'function') {
      await saveTransactionsFolder();
    } else if (typeof isDropboxConnected === 'function' && isDropboxConnected() && typeof saveTransactionsDropbox === 'function') {
      await saveTransactionsDropbox();
    } else if (typeof saveTransactionsLocal === 'function') {
      saveTransactionsLocal();
    } else {
      // fallback minimaliste
      localStorage.setItem('transactions', JSON.stringify(window.transactions));
    }
  } catch (e) {
    console.warn('[persist] échec principal → copie locale', e);
    try { localStorage.setItem('transactions', JSON.stringify(window.transactions)); } catch(_) {}
  }

  // Rafraîchit l’UI
  if (typeof updateViews === 'function') updateViews();

  // Reset du formulaire
  ev.target.reset?.();
  const ap = document.getElementById('apply-previous-row'); if (ap) ap.style.display = 'none';
  const re = document.getElementById('recurrence-end-row'); if (re) re.style.display = 'none';
  const ins = document.getElementById('installments-row'); if (ins) ins.style.display = 'none';
}

function openEditModal(tx) {
  const modal = document.getElementById('modal-edit-transaction');
  if (!modal) return;

  // Champs de base
  document.getElementById('edit-id').value = tx.id;
  document.getElementById('edit-description').value = tx.description;
  document.getElementById('edit-amount').value = tx.amount;
  writeDateInput('edit-date', tx.date);
  document.getElementById('edit-type').value = tx.type;

  // === Catégorie (nouveau : on alimente l'input caché + l'aperçu)
  const editCatInput = document.getElementById('edit-category');
  const editCatPreview = document.getElementById('edit-selected-category');
  const catVal = tx.category || DEFAULT_CATEGORY;
  if (editCatInput) editCatInput.value = catVal;
  if (editCatPreview) editCatPreview.innerHTML = renderCategoryIconInline(catVal);

  // Récurrence
  const r = tx.recurrence || 'none';
  const recSel = document.getElementById('edit-recurrence');
  recSel.value = r;

  // “Jusqu’à”
  if (tx.until) writeDateInput('edit-until', tx.until);
  else writeDateInput('edit-until', '');

  // Appliquer aux mois antérieurs
  const applyPrevEl = document.getElementById('edit-apply-previous');
  applyPrevEl.checked = !!tx.applyPrev;

  // Échéances
  const instRow = document.getElementById('edit-installments-row');
  const instInput = document.getElementById('edit-installments');
  if (r === 'installments') {
    instRow.style.display = '';
    instInput.value = tx.installments ? Number(tx.installments) : '';
  } else {
    instRow.style.display = 'none';
    instInput.value = '';
  }

  // Lignes conditionnelles
  const endRow = document.getElementById('edit-end-row');
  const applyPrevRow = document.getElementById('edit-apply-previous-row');
  const hasUntil = (r === 'monthly' || r === 'yearly');
  endRow.style.display = hasUntil ? '' : 'none';
  applyPrevRow.style.display = hasUntil ? '' : 'none';

  // Sync change
  recSel.onchange = () => {
    const v = recSel.value;
    const vHasUntil = (v === 'monthly' || v === 'yearly');
    endRow.style.display = vHasUntil ? '' : 'none';
    applyPrevRow.style.display = vHasUntil ? '' : 'none';
    instRow.style.display = (v === 'installments') ? '' : 'none';
  };

  modal.style.display = 'block';
}

function closeEditModal() {
  const modal = document.getElementById('modal-edit-transaction');
  if (modal) modal.style.display = 'none';
}

document.getElementById('edit-cancel-btn')?.addEventListener('click', closeEditModal);

document.getElementById('edit-delete-btn')?.addEventListener('click', () => {
  const id = document.getElementById('edit-id')?.value;
  const tx = transactions.find(t => t.id === id);
  if (!tx) return;
  if (!confirm(`Supprimer "${tx.description}" ?`)) return;

  transactions = transactions.filter(t => t.id !== id);
  saveTransactionsLocal();
  if (isDropboxConnected()) saveTransactionsDropbox();
  updateViews();
  closeEditModal();
});

document.getElementById('edit-transaction-form')?.addEventListener('submit', (ev) => {
  ev.preventDefault();

  const id = document.getElementById('edit-id').value;
  const description = document.getElementById('edit-description').value.trim();
  const amount = Number(document.getElementById('edit-amount').value);
  const dateISO = readDateInput('edit-date');
  const type = document.getElementById('edit-type').value;
  const recurrence = document.getElementById('edit-recurrence').value;
  const untilISO = readDateInput('edit-until');
  const applyPrev = document.getElementById('edit-apply-previous')?.checked || false;
  const installments = Number(document.getElementById('edit-installments')?.value || 0);
  const category = document.getElementById('edit-category')?.value || DEFAULT_CATEGORY; // ✅ NEW

  const tx = transactions.find(t => t.id === id);
  if (!tx) return;

  // Validation simple
  if (!description || !dateISO || Number.isNaN(amount)) {
    alert('Merci de remplir correctement le formulaire.');
    return;
  }
  if (recurrence === 'installments' && (!installments || installments < 2)) {
    alert('Indique un nombre d’échéances (≥ 2).');
    return;
  }

  // Mise à jour
  tx.description = description;
  tx.amount = amount;
  tx.date = dateISO;
  tx.type = type;
  tx.category = category;                 // ✅ NEW
  tx.recurrence = recurrence || 'none';
  tx.applyPrev = applyPrev;

  if (untilISO) tx.until = untilISO; else delete tx.until;

  if (tx.recurrence === 'installments') tx.installments = installments;
  else delete tx.installments;

  saveTransactionsLocal();
  if (isDropboxConnected()) saveTransactionsDropbox();
  updateViews();
  closeEditModal();
});

// ====== Modale Ajout rapide ======
document.getElementById('add-transaction-form')?.addEventListener('submit', function(e){
  e.preventDefault();

  const description = document.getElementById('add-description').value.trim();
  const amount = Number(document.getElementById('add-amount').value);
  const dateISO = readDateInput('add-date');
  const type = document.getElementById('add-type').value;
  const category = document.getElementById('add-category').value || DEFAULT_CATEGORY;

  const recurrence = document.getElementById('add-recurrence')?.value || 'none';
  const untilDateISO = readDateInput('add-until');
  const installments = Number(document.getElementById('add-installments')?.value || 0);
  const applyPrev = !!document.getElementById('add-apply-previous')?.checked;

  if (!description || Number.isNaN(amount) || !dateISO) {
    alert('Merci de compléter la description, le montant et la date.');
    return;
  }

  const baseTx = {
    id: crypto.randomUUID(),
                                                                  type, category, description, amount,
                                                                  date: dateISO,
                                                                  recurrence: recurrence || 'none',
                                                                  applyPrev: applyPrev || false
  };
  if (untilDateISO) baseTx.until = untilDateISO;
  if (baseTx.recurrence === 'installments' && installments >= 2) {
    baseTx.installments = installments;
  }

  transactions.push(baseTx);
  saveTransactionsLocal();
  if (isDropboxConnected()) saveTransactionsDropbox();
  updateViews();
  document.getElementById('modal-add-transaction').style.display = 'none';
});

// 1) Modale d'ajout rapide (évite le crash si absente)
const modalAddTx = document.getElementById('modal-add-transaction');
modalAddTx?.addEventListener('click', function(e){
  if (e.target.id === 'modal-add-transaction' || e.target.id === 'add-cancel-btn') {
    modalAddTx.style.display = 'none';
  }
});

// ====== Export ======
document.getElementById('export-json')?.addEventListener('click', () => {
  const data = JSON.stringify(transactions, null, 2);
  const blob = new Blob([data], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'transactions.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

function updateViews() {
  renderCalendar();
  renderTransactionList();
  renderStats();
  renderMonthSummary();
}

// === Auth application (mot de passe local simple) — BYPASS SÛR ===
async function hashPassword(pwd) {
  const enc = new TextEncoder();
  const buffer = await crypto.subtle.digest('SHA-256', enc.encode(pwd));
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function setupAuthentication(callback) {
  const overlay      = document.getElementById('auth-overlay');
  const form         = document.getElementById('auth-form');
  const titleEl      = document.getElementById('auth-title');
  const confirmRow   = document.getElementById('auth-confirm-row');
  const pwdInput     = document.getElementById('auth-password');
  const confirmInput = document.getElementById('auth-password-confirm');

  const storedHash = localStorage.getItem('appPasswordHash');

  // 🔧 Flag simple pour (dés)activer l'auth. Laisse FALSE le temps de débugger.
  const AUTH_ENABLED = false;

  // 1) Auth désactivée → on débloque toujours l’appli
  if (!AUTH_ENABLED) {
    sessionStorage.setItem('unlocked', '1');
    if (overlay) overlay.style.display = 'none';
    if (typeof callback === 'function') callback();
    return;
  }

  // 2) Si markup incomplet, on ne bloque pas l’appli
  if (!overlay || !form || !pwdInput) {
    sessionStorage.setItem('unlocked', '1');
    if (typeof callback === 'function') callback();
    return;
  }

  // 3) Session déjà déverrouillée
  if (sessionStorage.getItem('unlocked') === '1') {
    overlay.style.display = 'none';
    if (typeof callback === 'function') callback();
    return;
  }

  // 4) Affiche l’overlay d’auth (si activée)
  if (titleEl)    titleEl.textContent = storedHash ? 'Saisir le mot de passe' : 'Créer un mot de passe';
  if (confirmRow) confirmRow.style.display = storedHash ? 'none' : '';

  overlay.style.display = 'block';

  form.onsubmit = async (e) => {
    e.preventDefault();
    const pwd = pwdInput.value;

    // Création
    if (!storedHash) {
      const confirm = confirmInput?.value || '';
      if (!pwd || pwd !== confirm) { alert('Les mots de passe ne correspondent pas.'); return; }
      const hash = await hashPassword(pwd);
      localStorage.setItem('appPasswordHash', hash);
      sessionStorage.setItem('unlocked', '1');
      overlay.style.display = 'none';
      if (typeof callback === 'function') callback();
      return;
    }

    // Connexion
    if (!pwd) { alert('Merci de saisir votre mot de passe.'); return; }
    const hash = await hashPassword(pwd);
    if (hash === storedHash) {
      sessionStorage.setItem('unlocked', '1');
      overlay.style.display = 'none';
      if (typeof callback === 'function') callback();
    } else {
      alert('Mot de passe incorrect.');
    }
  };

  // 5) Sécurité: si l’overlay est masqué par le CSS, on ne bloque pas l’appli
  requestAnimationFrame(() => {
    const visible = overlay.offsetParent !== null || getComputedStyle(overlay).display !== 'none';
    if (!visible) {
      sessionStorage.setItem('unlocked', '1');
      if (typeof callback === 'function') callback();
    }
  });
}

// --- INIT ---
document.addEventListener('DOMContentLoaded', () => {
  // Démarre l'authentification avant de charger l'application
  setupAuthentication(() => {
    parseDropboxTokenFromUrl();
    parseCloudTokensFromUrl();

    restoreDropboxSession();
    restoreGoogleSession();
    restoreMicrosoftSession();

    const hasDropboxSDK = !!(window.Dropbox && Dropbox.Dropbox);

    function ensureEssentialDom() {
      const need = ['current-month','calendar','day-details','stats-period','pie-chart','stats-info','transactions-list','month-tx-list','prev-month','next-month','go-today','theme-toggle'];
      const missing = need.filter(id => !document.getElementById(id));
      if (!missing.length) return;

      // conteneur cible
      const root = document.getElementById('app') || document.body;

      // Header calendrier
      if (!document.getElementById('theme-toggle')) {
        const t = document.createElement('button'); t.id='theme-toggle'; t.textContent='🌓'; root.appendChild(t);
      }
      if (!document.getElementById('current-month')) {
        const bar = document.createElement('div'); bar.style.cssText='display:flex;gap:8px;align-items:center;margin:8px 0;';
        bar.innerHTML = `
        <button id="prev-month">◀</button>
        <strong id="current-month" style="min-width:200px;display:inline-block"></strong>
        <button id="next-month">▶</button>
        <button id="go-today">Aujourd’hui</button>
        `;
        root.appendChild(bar);
      }
      if (!document.getElementById('calendar')) {
        const t = document.createElement('table'); t.id='calendar'; t.style.cssText='width:100%;border-collapse:collapse;'; root.appendChild(t);
      }
      if (!document.getElementById('day-details')) {
        const d = document.createElement('div'); d.id='day-details'; d.style.marginTop='8px'; root.appendChild(d);
      }

      // Stats
      if (!document.getElementById('stats-period')) {
        const wrap = document.createElement('div'); wrap.style.marginTop='16px';
        wrap.innerHTML = `
        <label for="stats-period">Période :</label>
        <select id="stats-period">
        <option value="day">Jour</option>
        <option value="month" selected>Mois</option>
        <option value="year">Année</option>
        </select>
        <div style="display:flex;align-items:center;gap:16px;margin-top:8px;">
        <canvas id="pie-chart" width="280" height="280"></canvas>
        <div id="stats-info"></div>
        </div>
        `;
        root.appendChild(wrap);
      }

      // Liste + récap
      if (!document.getElementById('transactions-list')) {
        const h = document.createElement('h3'); h.textContent='Transactions'; root.appendChild(h);
        const ul = document.createElement('ul'); ul.id='transactions-list'; root.appendChild(ul);
      }
      if (!document.getElementById('month-tx-list')) {
        const h = document.createElement('h3'); h.textContent='Récapitulatif'; root.appendChild(h);
        const ctr = document.createElement('div');
        ctr.innerHTML = `
        <button id="month-sort-btn" title="Changer tri"><i id="month-sort-icon" class="fa-solid fa-calendar-day"></i></button>
        <label style="margin-left:8px;"><input type="checkbox" id="group-by-category"> Grouper par catégorie</label>
        <ul id="month-tx-list"></ul>
        `;
        root.appendChild(ctr);
      }

      console.warn('[Bootstrap UI] éléments manquants injectés:', missing);
    }

    // …dans ton init:
ensureEssentialDom();

(async () => {
  let loaded = false;

  try {
    // 1) On tente de restaurer le dossier choisi (si permission toujours OK)
    if (await restoreFolderHandles()) {
      await loadTransactionsFolder();
      loaded = true;
    }

    // 2) Sinon Dropbox si dispo et connecté
    if (!loaded && typeof isDropboxConnected === 'function' && isDropboxConnected() && typeof loadTransactionsDropbox === 'function') {
      await loadTransactionsDropbox();
      loaded = true;
    }

    // 3) Sinon, Local navigateur
    if (!loaded) {
      try {
        const raw = localStorage.getItem('transactions');
        window.transactions = raw ? JSON.parse(raw) : [];
      } catch {
        window.transactions = [];
      }
    }
  } catch (e) {
    console.warn('Initial load failed → fallback local', e);
    try {
      const raw = localStorage.getItem('transactions');
      window.transactions = raw ? JSON.parse(raw) : [];
    } catch {
      window.transactions = [];
    }
  }

  if (typeof updateViews === 'function') updateViews();

  // Statuts services
  if (typeof updateFolderStatus  === 'function') updateFolderStatus();
  if (typeof updateDropboxStatus === 'function') updateDropboxStatus();
  if (typeof updateGoogleStatus  === 'function') updateGoogleStatus();
  if (typeof updateMSStatus      === 'function') updateMSStatus();

  if (typeof __attachDatePickers === 'function') __attachDatePickers();
})();

    // Pickers catégories — SAFE
    initCategoryPickerSafe({
      picker:   'category-picker',
      input:    'category',
      preview:  'selected-category',
      dropdown: 'category-dropdown',
      search:   'cp-search-input',
      cats:     'cp-cats',
      icons:    'cp-icons'
    });
    initCategoryPickerSafe({
      picker:   'add-category-picker',
      input:    'add-category',
      preview:  'add-selected-category',
      dropdown: 'add-category-dropdown',
      search:   'add-cp-search-input',
      cats:     'add-cp-cats',
      icons:    'add-cp-icons'
    });
    initCategoryPickerSafe({
      picker:   'edit-category-picker',
      input:    'edit-category',
      preview:  'edit-selected-category',
      dropdown: 'edit-category-dropdown',
      search:   'edit-cp-search-input',
      cats:     'edit-cp-cats',
      icons:    'edit-cp-icons'
    });

    // Légende calendrier : applique les couleurs stockées puis branche les pickers
    applyStoredCalendarColors();
    setupLegendColorPickers();

    setupMonthPicker();

    // Rafraîchit certains éléments visuels au changement de thème
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      renderCalendar();
      renderMonthSummary();
      applyStoredCalendarColors();
      updateLegendSwatches(); // <- rafraîchir juste l’affichage des pastilles
    });

    // Écouteurs pour les services cloud + stockage
// === Helpers Dossier local (File System Access) ===
function isFsaSupported() {
  return typeof window.showDirectoryPicker === 'function';
}

// --- IndexedDB minimal pour stocker les handles FSA (persistance après reload)
const FSA_DB_NAME = 'fsa-handles';
const FSA_STORE   = 'kv';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FSA_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FSA_STORE)) db.createObjectStore(FSA_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
function idbGet(key) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(FSA_STORE, 'readonly');
    const st = tx.objectStore(FSA_STORE);
    const r = st.get(key);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror   = () => reject(r.error);
  }));
}
function idbSet(key, val) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(FSA_STORE, 'readwrite');
    const st = tx.objectStore(FSA_STORE);
    const r = st.put(val, key);
    r.onsuccess = () => resolve();
    r.onerror   = () => reject(r.error);
  }));
}
function idbDel(key) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(FSA_STORE, 'readwrite');
    const st = tx.objectStore(FSA_STORE);
    const r = st.delete(key);
    r.onsuccess = () => resolve();
    r.onerror   = () => reject(r.error);
  }));
}

// Handles globaux FSA
window.__folderDirHandle  = window.__folderDirHandle  || null;
window.__folderFileHandle = window.__folderFileHandle || null;

async function ensureFolderFile() {
  if (!isFsaSupported()) throw new Error('File System Access non supporté par ce navigateur');

  if (!window.__folderDirHandle) {
    window.__folderDirHandle = await window.showDirectoryPicker();
  }
  const appDir = await window.__folderDirHandle.getDirectoryHandle('AssistantPersonnel', { create: true });
  window.__folderFileHandle = await appDir.getFileHandle('transactions.json', { create: true });

  // Permission lecture/écriture
  const permQuery = await window.__folderFileHandle.queryPermission({ mode: 'readwrite' });
  if (permQuery !== 'granted') {
    const perm = await window.__folderFileHandle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') throw new Error('Permission refusée');
  }

  // Persiste les handles (pour retrouver le dossier au prochain chargement)
  try {
    await idbSet('dir',  window.__folderDirHandle);
    await idbSet('file', window.__folderFileHandle);
  } catch (e) {
    console.warn('[FSA] impossible de persister les handles IDB (non bloquant)', e);
  }
}

async function restoreFolderHandles() {
  if (!isFsaSupported()) return false;
  try {
    const dir  = await idbGet('dir');
    const file = await idbGet('file');
    if (!dir || !file) return false;

    window.__folderDirHandle  = dir;
    window.__folderFileHandle = file;

    const perm = await window.__folderFileHandle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') return true;
    if (perm === 'prompt') {
      const p = await window.__folderFileHandle.requestPermission({ mode: 'readwrite' });
      return p === 'granted';
    }
    return false;
  } catch (e) {
    console.warn('[FSA] restore handles échoué', e);
    return false;
  }
}

async function loadTransactionsFolder() {
  await ensureFolderFile();
  const file = await window.__folderFileHandle.getFile();
  const text = await file.text().catch(() => '[]');
  try {
    window.transactions = text.trim() ? JSON.parse(text) : [];
  } catch {
    window.transactions = [];
  }
  try { localStorage.setItem('transactions', JSON.stringify(window.transactions)); } catch(_) {}
}

async function saveTransactionsFolder() {
  await ensureFolderFile();
  const writable = await window.__folderFileHandle.createWritable();
  await writable.write(new Blob([JSON.stringify(window.transactions, null, 2)], { type: 'application/json' }));
  await writable.close();
  try { localStorage.setItem('transactions', JSON.stringify(window.transactions)); } catch(_) {}
}

function updateFolderStatus() {
  const st = document.getElementById('folder-status');
  const clearBtn = document.getElementById('clear-folder-btn');
  if (!st) return;

  if (!isFsaSupported()) {
    st.textContent = 'Non supporté par ce navigateur';
    if (clearBtn) clearBtn.style.display = 'none';
    return;
  }
  if (window.__folderDirHandle) {
    st.textContent = 'Connecté';
    if (clearBtn) clearBtn.style.display = '';
  } else {
    st.textContent = 'Non configuré';
    if (clearBtn) clearBtn.style.display = 'none';
  }
}

// === Écouteurs pour les services cloud + dossier local ===
document.getElementById('dropbox-login') ?.addEventListener('click', loginDropbox);
document.getElementById('dropbox-logout')?.addEventListener('click', logoutDropbox);
document.getElementById('google-login')  ?.addEventListener('click', loginGoogle);
document.getElementById('google-logout') ?.addEventListener('click', logoutGoogle);
document.getElementById('ms-login')      ?.addEventListener('click', loginMS);
document.getElementById('ms-logout')     ?.addEventListener('click', logoutMS);

// Dossier local : choisir et charger
document.getElementById('pick-folder-btn')?.addEventListener('click', async () => {
  try {
    await ensureFolderFile();
    await loadTransactionsFolder();
    if (typeof updateViews === 'function') updateViews();
  } catch (e) {
    console.warn('[FSA] Choix/chargement dossier échoué:', e);
  } finally {
    updateFolderStatus();
  }
});

// Dossier local : oublier (revient au local navigateur) + supprime handles persistés
document.getElementById('clear-folder-btn')?.addEventListener('click', async () => {
  window.__folderDirHandle  = null;
  window.__folderFileHandle = null;
  try { await idbDel('dir'); await idbDel('file'); } catch(_) {}
  updateFolderStatus();

  // Recharge depuis le local navigateur
  try {
    const raw = localStorage.getItem('transactions');
    window.transactions = raw ? JSON.parse(raw) : [];
  } catch {
    window.transactions = [];
  }
  if (typeof updateViews === 'function') updateViews();
});

// Met à jour le statut à l’ouverture
updateFolderStatus();

// Dossier local : oublier (revient au local navigateur)
document.getElementById('clear-folder-btn')?.addEventListener('click', () => {
  window.__folderDirHandle = null;
  window.__folderFileHandle = null;
  updateFolderStatus();
  // On recharge depuis le local navigateur
  try {
    const raw = localStorage.getItem('transactions');
    window.transactions = raw ? JSON.parse(raw) : [];
  } catch {
    window.transactions = [];
  }
  if (typeof updateViews === 'function') updateViews();
});

// Met à jour le statut à l’ouverture
updateFolderStatus();

    // Radios du mode de stockage
    document.querySelectorAll('input[name="storage-mode"]').forEach(r => {
      r.addEventListener('change', async (e) => {
        const val = e.target.value;
        setStorageModeLocalValue(val);

        // si on choisit Dropbox et pas connecté → ouvrir login
        if (val === 'dropbox' && !(typeof isDropboxConnected==='function' && isDropboxConnected())) {
          loginDropbox();
          return;
        }
        // si on choisit Dossier local → demander le dossier si pas encore choisi
        if (val === 'folder' && isFsaSupported()) {
          try {
            await ensureFolderFile();
            document.getElementById('folder-picked')?.style && (document.getElementById('folder-picked').style.display = '');
          } catch (e) {
            console.warn('Choix dossier annulé / refusé, retour en local.', e);
            setStorageModeLocalValue('local');
          }
        }

        renderStorageModeUI();
        await loadTransactions();
        updateViews();
      });
    });

    // Bouton "Choisir…" du dossier local
    document.getElementById('pick-folder-btn')?.addEventListener('click', async () => {
      try {
        await ensureFolderFile();
        setStorageModeLocalValue('folder');
        document.getElementById('folder-picked')?.style && (document.getElementById('folder-picked').style.display = '');
        renderStorageModeUI();
        await loadTransactions();
        updateViews();
      } catch (e) {
        console.warn('Choix dossier annulé / refusé', e);
      }
    });


    // Onglets finances
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(tab => tab.style.display = 'none');
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).style.display = 'block';
      });
    });

    // Affiche l’option "Appliquer aux mois antérieurs" uniquement si "Mensuelle"
    // Formulaire principal
    const recSel = document.getElementById('recurrence');
    const applyPrevRow = document.getElementById('apply-previous-row');
    const endRow = document.getElementById('recurrence-end-row');
    const instRow = document.getElementById('installments-row');

    if (recSel) {
      const syncMainRows = () => {
        const v = recSel.value;
        const hasUntil = (v === 'monthly' || v === 'yearly');
        applyPrevRow.style.display = hasUntil ? '' : 'none';
        endRow.style.display = hasUntil ? '' : 'none';
        instRow.style.display = (v === 'installments') ? '' : 'none';
      };
      recSel.addEventListener('change', syncMainRows);
      syncMainRows();
    }

    // Ajout rapide
    const qaRecSel = document.getElementById('add-recurrence');
    const qaApplyPrevRow = document.getElementById('add-apply-previous-row');
    const qaInstRow = document.getElementById('add-installments-row');
    const qaEndRow = document.getElementById('add-end-row');

    if (qaRecSel) {
      const syncQaRows = () => {
        const v = qaRecSel.value;
        const hasUntil = (v === 'monthly' || v === 'yearly');
        if (qaApplyPrevRow) qaApplyPrevRow.style.display = hasUntil ? '' : 'none';
        if (qaEndRow) qaEndRow.style.display = hasUntil ? '' : 'none';
        if (qaInstRow) qaInstRow.style.display = (v === 'installments') ? '' : 'none';
      };
        qaRecSel.addEventListener('change', syncQaRows);
        syncQaRows();
    }

    // Édition
    const editRecSel = document.getElementById('edit-recurrence');
    const editEndRow = document.getElementById('edit-end-row');
    const editApplyPrevRow = document.getElementById('edit-apply-previous-row');

    if (editRecSel) {
      const syncEditRows = () => {
        const v = editRecSel.value;
        const hasUntil = (v === 'monthly' || v === 'yearly');
        editEndRow.style.display = hasUntil ? '' : 'none';
        editApplyPrevRow.style.display = hasUntil ? '' : 'none';
      };
      editRecSel.addEventListener('change', syncEditRows);
      syncEditRows();
    }

    // Navigation multi‑modules
    document.querySelectorAll('.app-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.app-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.app-section').forEach(sec => sec.style.display = 'none');
        btn.classList.add('active');
        document.getElementById(`app-${btn.dataset.app}`).style.display = 'block';
      });
    });

    // Formulaire principal + navigation calendrier
    // 3) Form principal + nav calendrier (tous en ?.)
    document.getElementById('transaction-form')?.addEventListener('submit', addTransaction);
    document.getElementById('prev-month')      ?.addEventListener('click', () => {
      currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
      renderCalendar();
      renderMonthSummary();
    });
    document.getElementById('next-month')      ?.addEventListener('click', () => {
      currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
      renderCalendar();
      renderMonthSummary();
    });
    document.getElementById('go-today')        ?.addEventListener('click', () => {
      currentMonth = new Date();
      updateViews();
    });

    // --- Période des statistiques (sélecteurs synchronisés)
    const statsSel = document.getElementById('stats-period');
    const editStatsSel = document.getElementById('edit-stats-period');

    function syncStatsPeriod(from) {
      if (from === 'stats' && statsSel) {
        STATS_PERIOD = statsSel.value;
        if (editStatsSel) editStatsSel.value = STATS_PERIOD;
      } else if (from === 'edit' && editStatsSel) {
        STATS_PERIOD = editStatsSel.value;
        if (statsSel) statsSel.value = STATS_PERIOD;
      }
      renderStats();
    }

    statsSel?.addEventListener('change', () => syncStatsPeriod('stats'));
    editStatsSel?.addEventListener('change', () => syncStatsPeriod('edit'));

    // Valeur initiale
    if (statsSel) STATS_PERIOD = statsSel.value;
    if (editStatsSel) editStatsSel.value = STATS_PERIOD;

    // NEW: suppression par Delete ou Backspace, même si la ligne n'a pas été cliquée
    document.addEventListener('keydown', (e) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (['input','textarea','select'].includes(tag)) return;

      if (e.key !== 'Delete' && e.key !== 'Backspace') return;

      // essaie d'abord la sélection explicite
      let sel = document.querySelector('#day-details .tx-line.is-selected');
      // sinon, si on a le focus sur une ligne, prends-la
      if (!sel) sel = document.querySelector('#day-details .tx-line:focus');
      if (sel) selectedTxId = sel.dataset.txId;

      if (!selectedTxId) return;

      e.preventDefault(); // évite le "back" navigateur avec Backspace

      const tx = transactions.find(t => t.id === selectedTxId);
      if (!tx) return;

      const ok = confirm(`Supprimer "${tx.description}" du ${toDisplayFromISO(tx.date)} ?`);
      if (!ok) return;

      transactions = transactions.filter(t => t.id !== selectedTxId);
      selectedTxId = null;
      saveTransactionsLocal();
      if (isDropboxConnected()) saveTransactionsDropbox();
      updateViews();
    });

    // Tri / regroupement recap mois
    document.getElementById('month-sort-btn')?.addEventListener('click', () => {
      monthSortMode = {
        'date-asc':  'date-desc',
        'date-desc': 'amount-asc',
        'amount-asc':'amount-desc',
        'amount-desc':'date-asc'
      }[monthSortMode] || 'date-asc';
      renderMonthSummary();
    });
    document.getElementById('group-by-category')?.addEventListener('change', renderMonthSummary);
  });
});

// ====== Dynamic calendar colors (legend pickers) — version singleton (fix) ======
const CAL_COLOR_VARS = ['--color-weekend','--color-holiday','--color-today','--color-primary'];

function getThemeStorageKey() {
  return document.documentElement.classList.contains('dark-mode') ? 'calendarColors_dark' : 'calendarColors_light';
}

function rgbToHex(rgb) {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!m) return rgb;
  const toHex = (n)=>(+n).toString(16).padStart(2,'0');
  return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`.toUpperCase();
}

let DEFAULT_CAL_COLORS_LIGHT = null;
let DEFAULT_CAL_COLORS_DARK  = null;

function readDefaultCalendarColors() {
  const root = getComputedStyle(document.documentElement);
  const light = {};
  CAL_COLOR_VARS.forEach(v => light[v] = rgbToHex(root.getPropertyValue(v).trim()));

  // Simule .dark-mode pour lire les valeurs par défaut du thème sombre
  document.body.classList.add('dark-mode');
  const darkBody = getComputedStyle(document.body);
  const dark = {};
  CAL_COLOR_VARS.forEach(v => {
    let val = darkBody.getPropertyValue(v).trim() || root.getPropertyValue(v).trim();
    dark[v] = rgbToHex(val);
  });
  document.body.classList.remove('dark-mode');

  DEFAULT_CAL_COLORS_LIGHT = light;
  DEFAULT_CAL_COLORS_DARK  = dark;
}

function applyCalendarColors(map) {
  if (!map) return;
  Object.entries(map).forEach(([v, c]) => {
    if (CAL_COLOR_VARS.includes(v) && c) document.body.style.setProperty(v, c);
  });
    if (typeof renderCalendar === 'function') renderCalendar();
}
function applyStoredCalendarColors() {
  const key = getThemeStorageKey();
  try { applyCalendarColors(JSON.parse(localStorage.getItem(key)) || {}); } catch {}
}
function saveOneCalendarColor(varName, color) {
  const key = getThemeStorageKey();
  let map = {};
  try { map = JSON.parse(localStorage.getItem(key)) || {}; } catch {}
  map[varName] = color;
  localStorage.setItem(key, JSON.stringify(map));
}

function restoreDefaultCalendarColor(varName) {
  if (!DEFAULT_CAL_COLORS_LIGHT || !DEFAULT_CAL_COLORS_DARK) readDefaultCalendarColors();
  const defaults = document.documentElement.classList.contains('dark-mode') ? DEFAULT_CAL_COLORS_DARK : DEFAULT_CAL_COLORS_LIGHT;
  const color = defaults[varName];
  document.body.style.setProperty(varName, color);
  const key = getThemeStorageKey();
  let map = {};
  try { map = JSON.parse(localStorage.getItem(key)) || {}; } catch {}
  delete map[varName];
  localStorage.setItem(key, JSON.stringify(map));
  if (typeof renderCalendar === 'function') renderCalendar();
  const sw = document.querySelector(`.legend-color[data-var="${varName}"]`);
  if (sw) sw.style.background = color;
}

function updateLegendSwatches() {
  document.querySelectorAll('.legend-color[data-var]').forEach(el => {
    const v = el.getAttribute('data-var');
    const cur = getComputedStyle(document.body).getPropertyValue(v).trim()
    || getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    el.style.background = rgbToHex(cur || '#FFFFFF');
  });
}

// === Color picker singleton (caché et réutilisé) ===
let COLOR_PICKER_SINGLETON = null;
let COLOR_PICKER_TARGET_VAR = null;

function ensureColorPicker() {
  if (COLOR_PICKER_SINGLETON) return COLOR_PICKER_SINGLETON;
  const inp = document.createElement('input');
  inp.type = 'color';
  inp.id = 'calendar-color-picker';
  Object.assign(inp.style, { position:'fixed', left:'-9999px', width:'0', height:'0', opacity:'0', pointerEvents:'none' });

  // Aperçu live
  inp.addEventListener('input', () => {
    if (!COLOR_PICKER_TARGET_VAR) return;
    document.body.style.setProperty(COLOR_PICKER_TARGET_VAR, inp.value);
    if (typeof renderCalendar === 'function') renderCalendar();
  });

    // Validation (sauvegarde + pastille)
    inp.addEventListener('change', () => {
      if (!COLOR_PICKER_TARGET_VAR) return;
      saveOneCalendarColor(COLOR_PICKER_TARGET_VAR, inp.value);
      const sw = document.querySelector(`.legend-color[data-var="${COLOR_PICKER_TARGET_VAR}"]`);
      if (sw) sw.style.background = inp.value;
      COLOR_PICKER_TARGET_VAR = null; // on libère APRÈS change (pas sur blur)
    });

    document.body.appendChild(inp);
    COLOR_PICKER_SINGLETON = inp;
    return inp;
}

function setupLegendColorPickers() {
  if (!DEFAULT_CAL_COLORS_LIGHT || !DEFAULT_CAL_COLORS_DARK) readDefaultCalendarColors();
  const picker = ensureColorPicker();

  document.querySelectorAll('.legend-color[data-var]').forEach(el => {
    el.onclick = () => {
      const varName = el.getAttribute('data-var');
      COLOR_PICKER_TARGET_VAR = varName;
      const cur = getComputedStyle(document.body).getPropertyValue(varName).trim()
      || getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
      picker.value = rgbToHex(cur || '#FFFFFF');
      picker.click();
    };
  });

  document.querySelectorAll('.legend-reset[data-var]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      restoreDefaultCalendarColor(btn.getAttribute('data-var'));
    };
  });

  updateLegendSwatches();
}

// ===== Helpers format affichage <-> ISO =====
function toISOFromDisplay(ddmmyyyy) {
  // accepte "jj-mm-aaaa" ou "jj/mm/aaaa"
  const m = ddmmyyyy.trim().match(/^(\d{2})[-\/](\d{2})[-\/](\d{4})$/);
  if (!m) return null;
  const [_, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}
function toDisplayFromISO(iso) {
  const m = iso.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const [_, yyyy, mm, dd] = m;
  return `${dd}-${mm}-${yyyy}`;
}
function readDateInput(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  // si on a déjà un ISO stocké en data, l'utiliser (fiable)
  if (el.dataset.iso) return el.dataset.iso;
  const iso = toISOFromDisplay(el.value);
  return iso;
}
function writeDateInput(id, iso) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = iso ? toDisplayFromISO(iso) : '';
  if (iso) el.dataset.iso = iso; else delete el.dataset.iso;
}

// ===== Mini datepicker (lundi en premier) =====
(function initDatePicker() {
  let openDp = null;
  let dpInputEl = null; // NEW

  function buildMonthGrid(year, month) {
    // month: 0..11 ; lundi=1er jour
    const first = new Date(year, month, 1);
    let start = new Date(first);
    // getDay(): 0=Dim..6=Sam ; on veut lundi=1 -> nombre de cases vides devant :
    const jsDay = first.getDay(); // 0..6
    const gaps = (jsDay === 0 ? 6 : jsDay - 1); // Dim -> 6, Lun -> 0, Mar ->1 ...
    start.setDate(first.getDate() - gaps);
    const cells = [];
    for (let i=0;i<42;i++) {
      const d = new Date(start);
      d.setDate(start.getDate()+i);
      cells.push(d);
    }
    return cells;
  }

  function closeDp() {
    if (openDp) { openDp.remove(); openDp = null; }
    dpInputEl = null; // NEW
    document.removeEventListener('click', onOutside, true);
    document.removeEventListener('keydown', onEsc, true);
  }
  function onOutside(e){
    if (!openDp) return;
    if (!openDp.contains(e.target) && e.target !== dpInputEl) closeDp();
  }

  function onEsc(e){ if(e.key==='Escape') closeDp(); }

  function renderPickerFor(input) {
    closeDp();
    dpInputEl = input; // NEW
    const rect = input.getBoundingClientRect();
    const dp = document.createElement('div');
    dp.className = 'dp-popup';
    const today = new Date();
    let cur = (input.dataset.iso ? parseDate(input.dataset.iso) : today);
    cur.setHours(12,0,0,0); // éviter DST

    function rerender() {
      const year = cur.getFullYear(), month = cur.getMonth();
      const cells = buildMonthGrid(year, month);
      const monthLabel = cur.toLocaleDateString('fr-FR',{month:'long', year:'numeric'});
      dp.innerHTML = `
      <div class="dp-header">
      <button class="dp-nav" data-nav="-1">«</button>
      <div>${monthLabel.charAt(0).toUpperCase()+monthLabel.slice(1)}</div>
      <button class="dp-nav" data-nav="1">»</button>
      </div>
      <div class="dp-grid dp-dows">
      <div class="dp-dow">L</div><div class="dp-dow">M</div><div class="dp-dow">M</div>
      <div class="dp-dow">J</div><div class="dp-dow">V</div><div class="dp-dow">S</div><div class="dp-dow">D</div>
      </div>
      <div class="dp-grid dp-days"></div>
      `;
      const days = dp.querySelector('.dp-days');
      const monthStart = new Date(year, month, 1);
      const nextMonth = new Date(year, month+1, 1);
      const isoSel = input.dataset.iso || '';
      const isoToday = formatDate(today);
      cells.forEach(d=>{
        const btn = document.createElement('div');
        btn.className = 'dp-cell';
        btn.textContent = d.getDate();
        const iso = formatDate(d);
        if (d < monthStart || d >= nextMonth) btn.classList.add('disabled');
        if (iso === isoToday) btn.classList.add('today');
        if (iso === isoSel) btn.classList.add('selected');
        btn.addEventListener('click', ()=>{
          if (btn.classList.contains('disabled')) return;
          writeDateInput(input.id, iso);
          input.dispatchEvent(new Event('change'));
          closeDp();
        });
        days.appendChild(btn);
      });
      dp.querySelectorAll('.dp-nav').forEach(b=>{
        b.addEventListener('click', ()=>{
          cur = addMonths(cur, parseInt(b.dataset.nav,10));
          rerender();
        });
      });
    }

    rerender();
    document.body.appendChild(dp);
    // position sous l’input
    const top = window.scrollY + rect.bottom + 6;
    const left = Math.min(window.scrollX + rect.left, window.scrollX + window.innerWidth - 280);
    dp.style.top = `${top}px`; dp.style.left = `${left}px`;
    openDp = dp;
    setTimeout(()=>{
      document.addEventListener('click', onOutside, true);
      document.addEventListener('keydown', onEsc, true);
    },0);
  }

  // Attache aux inputs
  function attach(input){
    input.addEventListener('focus', ()=> renderPickerFor(input));
    // icône/btn non nécessaire : un focus suffit. Ajoute Enter pour re‑ouvrir
    input.addEventListener('keydown', (e)=>{
      if (e.key==='Enter') { e.preventDefault(); renderPickerFor(input); }
    });
  }

  // à l’init DOM :
  window.__attachDatePickers = function(){
    document.querySelectorAll('input.date-input').forEach(attach);
  };
})();

// Remplir les icônes (exemple de set cohérent)
function buildIconSet(container, lib) {
  if (!container) return;
  const icons = (lib === 'fa') ? [
    'fa-solid fa-utensils','fa-solid fa-cart-shopping','fa-solid fa-bus',
    'fa-solid fa-house','fa-solid fa-heart-pulse','fa-solid fa-dumbbell',
    'fa-solid fa-gamepad','fa-solid fa-gift','fa-solid fa-paw',
    'fa-solid fa-mobile-screen','fa-solid fa-bolt','fa-solid fa-sack-dollar',
    'fa-solid fa-plane','fa-solid fa-car','fa-solid fa-tv',
    'fa-solid fa-circle-question'
  ] : (lib === 'mi') ? [
    'restaurant','shopping_cart','directions_bus','home','favorite','fitness_center',
    'sports_esports','card_giftcard','pets','smartphone','bolt','savings',
    'flight','directions_car','tv','help'
  ] : [
    'bi bi-egg-fried','bi bi-basket3','bi bi-bus-front','bi bi-house-door',
    'bi bi-heart-pulse','bi bi-barbell','bi bi-controller','bi bi-gift',
    'bi bi-universal-access','bi bi-phone','bi bi-lightning','bi bi-piggy-bank',
    'bi bi-airplane','bi bi-car-front','bi bi-tv','bi bi-question-circle'
  ];

  container.innerHTML = icons.map(icon => `
  <button type="button" class="cat-icon"
  data-lib="${lib}"
  data-icon="${lib==='mi' ? icon : icon}">
  ${
    lib === 'fa' ? `<i class="${icon}"></i>` :
    lib === 'mi' ? `<span class="material-icons">${icon}</span>` :
    `<i class="${icon}"></i>`
  }
  </button>
  `).join('');
}

/* ================== Category Picker v2 (SAFE) ================== */

/* Jeu d’icônes par catégories (Font Awesome) */
const CP_DATA = {
  "Essentiels": ["fa-house","fa-utensils","fa-cart-shopping","fa-receipt","fa-plug","fa-droplet","fa-fire-burner","fa-wifi"],
  "Logement": ["fa-house-chimney","fa-key","fa-screwdriver-wrench","fa-soap","fa-couch","fa-box"],
  "Transport": ["fa-car","fa-bus","fa-train-subway","fa-gas-pump","fa-bicycle","fa-plane","fa-motorcycle"],
  "Vie quotidienne": ["fa-basket-shopping","fa-bread-slice","fa-apple-whole","fa-shirt","fa-soap","fa-scissors","fa-gift"],
  "Loisirs": ["fa-gamepad","fa-film","fa-music","fa-futbol","fa-dumbbell","fa-person-hiking","fa-camera"],
  "Santé": ["fa-heart-pulse","fa-kit-medical","fa-pills","fa-tooth","fa-notes-medical"],
  "Animaux": ["fa-paw","fa-bone","fa-fish","fa-shield-dog"],
  "Télécom": ["fa-mobile-screen-button","fa-phone","fa-sim-card","fa-tower-cell"],
  "Travail/Études": ["fa-briefcase","fa-laptop","fa-graduation-cap","fa-book","fa-chalkboard-user"],
  "Autres": ["fa-circle-question","fa-sack-dollar","fa-sparkles"]
};

/**
 * Initialise un picker.
 * Accepte EITHER des IDs (cfg.picker/cfg.input/...) OU une structure en classes à l’intérieur du conteneur.
 */
function initCategoryPickerSafe(cfg) {
  // 1) on cherche le conteneur
  let root = null;
  if (cfg.picker && document.getElementById(cfg.picker)) root = document.getElementById(cfg.picker);
  if (!root) {
    // fallback: s’il existe AU MOINS un .category-picker, on les initialisera en mode "auto"
    return;
  }

  // 2) on résout les éléments, en essayant d’abord par ID, sinon par classes internes
  const byId = (id) => id ? document.getElementById(id) : null;
  const orInside = (el, sel) => el ? (el.querySelector(sel) || null) : null;

  const elInput    = byId(cfg.input)    || orInside(root, 'input[type="hidden"][name="category"]');
  const elPreview  = byId(cfg.preview)  || orInside(root, '.selected-category, #selected-category');
  const elDropdown = byId(cfg.dropdown) || orInside(root, '.category-dropdown');
  const elSearch   = byId(cfg.search)   || orInside(root, '.cp-search-input');
  const elCats     = byId(cfg.cats)     || orInside(root, '.cp-cats');
  const elIcons    = byId(cfg.icons)    || orInside(root, '.cp-icons, .icon-picker-list');

  // si un indispensable manque, on sort proprement
  if (!elInput || !elPreview || !elDropdown || !elIcons) {
    // (silence) console.warn('CategoryPicker: éléments manquants pour', cfg);
    return;
  }

  // Construit les chips de catégories (une seule fois)
  if (elCats && !elCats.dataset.built) {
    const catNames = Object.keys(CP_DATA);
    catNames.forEach((name, idx) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'cp-chip' + (idx === 0 ? ' active' : '');
      chip.textContent = name;
      chip.dataset.cat = name;
      chip.addEventListener('click', () => {
        elCats.querySelectorAll('.cp-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        if (elSearch) elSearch.value = '';
        renderIcons(name, '');
      });
      elCats.appendChild(chip);
    });
    elCats.dataset.built = '1';
  }

  function renderIcons(cat, filter) {
    const icons = CP_DATA[cat] || [];
    const q = (filter || '').trim().toLowerCase();
    elIcons.innerHTML = '';
    icons
    .filter(cls => !q || cls.replace('fa-','').includes(q))
    .forEach(cls => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cat-icon';
      b.innerHTML = `<i class="fa-solid ${cls}"></i>`;
      b.title = cls.replace('fa-','');
      b.addEventListener('click', () => {
        elInput.value = cls;
        elPreview.innerHTML = `<i class="fa-solid ${cls}"></i>`;
        closeDropdown();
      });
      elIcons.appendChild(b);
    });
    if (!elIcons.children.length) {
      const p = document.createElement('div');
      p.style.cssText = 'grid-column:1 / -1; opacity:.7; padding:.4em 0;';
      p.textContent = 'Aucun résultat';
      elIcons.appendChild(p);
    }
  }

  // Catégorie initiale
  const firstCat = Object.keys(CP_DATA)[0];
  renderIcons(firstCat, '');

  // Recherche
  if (elSearch && !elSearch.dataset.bound) {
    elSearch.addEventListener('input', () => {
      const active = elCats?.querySelector('.cp-chip.active')?.dataset.cat || firstCat;
      renderIcons(active, elSearch.value);
    });
    elSearch.dataset.bound = '1';
  }

  // Ouverture / fermeture
  function openDropdown() {
    elDropdown.style.display = 'block';
    // flip si manque d’espace
    const rect = elDropdown.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.top;
    if (spaceBelow < 260) { elDropdown.classList.add('open-top'); }
    else { elDropdown.classList.remove('open-top'); }
    requestAnimationFrame(() => elDropdown.classList.add('open'));
    document.addEventListener('mousedown', onDocClick, true);
    window.addEventListener('resize', onResize);
  }
  function closeDropdown() {
    elDropdown.classList.remove('open');
    setTimeout(() => { elDropdown.style.display = 'none'; }, 150);
    document.removeEventListener('mousedown', onDocClick, true);
    window.removeEventListener('resize', onResize);
  }
  function onDocClick(e) { if (!root.contains(e.target)) closeDropdown(); }
  function onResize() {
    const rect = elDropdown.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.top;
    if (spaceBelow < 260) elDropdown.classList.add('open-top');
    else elDropdown.classList.remove('open-top');
  }

  if (!elPreview.dataset.bound) {
    elPreview.addEventListener('click', () => {
      const isOpen = elDropdown.classList.contains('open');
      if (isOpen) closeDropdown(); else openDropdown();
    });
      elPreview.dataset.bound = '1';
  }
}

/* ==== Bootstrap : on initialise SANS planter, seulement si le root existe ==== */
document.addEventListener('DOMContentLoaded', () => {
  // Principale
  if (document.getElementById('category-picker')) {
    initCategoryPickerSafe({
      picker: 'category-picker',
      input: 'category',
      preview: 'selected-category',
      dropdown: 'category-dropdown',
      search: 'cp-search-input',
      cats: 'cp-cats',
      icons: 'cp-icons'
    });
  }
  // Ajout rapide
  if (document.getElementById('add-category-picker')) {
    initCategoryPickerSafe({
      picker: 'add-category-picker',
      input: 'add-category',
      preview: 'add-selected-category',
      dropdown: 'add-category-dropdown',
      search: 'add-cp-search-input',
      cats: 'add-cp-cats',
      icons: 'add-cp-icons'
    });
  }
  // Édition
  if (document.getElementById('edit-category-picker')) {
    initCategoryPickerSafe({
      picker: 'edit-category-picker',
      input: 'edit-category',
      preview: 'edit-selected-category',
      dropdown: 'edit-category-dropdown',
      search: 'edit-cp-search-input',
      cats: 'edit-cp-cats',
      icons: 'edit-cp-icons'
    });
  }
});

  // Si tu as mis les blocs dans l’Ajout rapide et l’Édition, décommente/ajuste :
  /*
   *  initCategoryPicker({
   *    picker:   'add-category-picker',
   *    input:    'add-category',
   *    preview:  'add-selected-category',
   *    dropdown: 'add-category-dropdown',
   *    search:   'add-cp-search-input',
   *    cats:     'add-cp-cats',
   *    icons:    'add-cp-icons'
});

initCategoryPicker({
picker:   'edit-category-picker',
input:    'edit-category',
preview:  'edit-selected-category',
dropdown: 'edit-category-dropdown',
search:   'edit-cp-search-input',
cats:     'edit-cp-cats',
icons:    'edit-cp-icons'
});
*/

// Pont universel : ouvre la feuille d’icônes si présente
document.addEventListener('click', (e) => {
  const trg = e.target.closest('.cat-trigger');
  if (!trg) return;
  e.preventDefault(); e.stopPropagation();
  const inputId   = trg.dataset.targetInput  || 'category';
  const previewId = trg.dataset.targetPreview || 'selected-category';
  if (typeof window.__openIconSheet === 'function') {
    window.__openIconSheet(inputId, previewId);
  } else {
    // fallback très simple si la sheet n’est pas chargée
    const dd = trg.closest('.category-picker, .category-picker-v2')?.querySelector('.category-dropdown');
    if (dd) dd.style.display = getComputedStyle(dd).display === 'none' ? 'block' : 'none';
  }
});

// === IconPickerV2 — autonome (ouvre + sélection + valider/annuler/fermer) ===
(function(){
  const SHEET = document.getElementById('icon-sheet');
  if (!SHEET) return;

  // Toujours sous <body> (évite les parents en display:none)
  if (SHEET.parentElement !== document.body) {
    document.body.appendChild(SHEET);
  }

  // Refs
  const PANEL  = SHEET.querySelector('.sheet__panel');
  const GRID   = document.getElementById('ip-grid');
  const CHIPS  = document.getElementById('ip-chips');
  const SEARCH = document.getElementById('ip-search');
  const BTN_CLOSE    = SHEET.querySelector('.sheet__close');
  const BTN_CANCEL   = document.getElementById('ip-cancel');
  const BTN_VALIDATE = document.getElementById('ip-validate');

  // Jeu d'icônes
  const ICONS = {
    "Récents": [],
    "Essentiels": [
      "fa-solid fa-utensils","fa-solid fa-cart-shopping","fa-solid fa-gas-pump",
      "fa-solid fa-bus","fa-solid fa-sack-dollar","fa-solid fa-gift"
    ],
    "Logement": ["fa-solid fa-house","fa-solid fa-bolt","fa-solid fa-fire","fa-solid fa-droplet"],
    "Transport": ["fa-solid fa-car","fa-solid fa-motorcycle","fa-solid fa-train-subway","fa-solid fa-plane"],
    "Vie quotidienne": ["fa-solid fa-bread-slice","fa-solid fa-shirt","fa-solid fa-basket-shopping"],
    "Santé": ["fa-solid fa-briefcase-medical","fa-solid fa-capsules","fa-solid fa-tooth"],
    "Télécom": ["fa-solid fa-wifi","fa-solid fa-mobile-screen-button","fa-solid fa-phone"],
    "Loisirs": ["fa-solid fa-futbol","fa-solid fa-music","fa-solid fa-gamepad","fa-solid fa-film"],
    "Animaux": ["fa-solid fa-paw","fa-solid fa-bone"],
    "Travail/Études": ["fa-solid fa-briefcase","fa-solid fa-graduation-cap"],
    "Autres": ["fa-regular fa-circle-question","fa-solid fa-ellipsis"]
  };
  const RECENTS_KEY = 'ip.recents';
  const loadRecents = () => JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
  const saveRecents = (arr) => localStorage.setItem(RECENTS_KEY, JSON.stringify(arr.slice(0,12)));

  const state = { icon:null, targetInput:null, targetPreview:null, category:'Essentiels' };

  function openSheet(inputId, previewId){
    state.targetInput   = document.getElementById(inputId);
    state.targetPreview = document.getElementById(previewId);
    state.icon = state.targetInput?.value || null;

    ICONS["Récents"] = loadRecents();
    renderChips();
    renderGrid();

    // (ré)initialise Valider
    if (BTN_VALIDATE) {
      BTN_VALIDATE.disabled = !state.icon;
      if (!state.icon) BTN_VALIDATE.setAttribute('aria-disabled','true');
      else BTN_VALIDATE.removeAttribute('aria-disabled');
    }

    // Ouvre visuellement
    SHEET.classList.add('is-open');
    SHEET.setAttribute('aria-hidden','false');
    if (PANEL) PANEL.style.transform = 'translateY(0)';
    setTimeout(()=> SEARCH?.focus(), 0);
  }

  function closeSheet(){
    SHEET.classList.remove('is-open');
    SHEET.setAttribute('aria-hidden','true');
    SHEET.style.display = 'none';         // ⬅️ indispensable pour annuler le display:block mis à l’ouverture
    if (PANEL) PANEL.style.transform = ''; // (facultatif) reset
  }

  function renderChips(){
    if (!CHIPS) return;
    CHIPS.innerHTML = '';
    Object.keys(ICONS).forEach(cat => {
      if (cat === 'Récents' && ICONS['Récents'].length === 0) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cp-chip' + (cat === state.category ? ' active' : '');
      b.textContent = cat;
      b.addEventListener('click', () => {
        state.category = cat;
        CHIPS.querySelectorAll('.cp-chip').forEach(x=>x.classList.remove('active'));
        b.classList.add('active');
        renderGrid();
      });
      CHIPS.appendChild(b);
    });
  }

  function renderGrid(){
    if (!GRID) return;
    const q = (SEARCH?.value || '').trim().toLowerCase();
    const base = state.category ? ICONS[state.category] : Object.values(ICONS).flat();
    const list = q ? base.filter(c => c.toLowerCase().includes(q)) : base;

    GRID.innerHTML = '';
    list.forEach(cls => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ip-icon' + (cls === state.icon ? ' is-selected' : '');
      btn.innerHTML = `<i class="${cls}"></i>`;
      btn.addEventListener('click', () => {
        state.icon = cls;
        GRID.querySelectorAll('.ip-icon').forEach(x=>x.classList.remove('is-selected'));
        btn.classList.add('is-selected');
        if (BTN_VALIDATE) {
          BTN_VALIDATE.disabled = false;            // <- débloque vraiment
          BTN_VALIDATE.removeAttribute('disabled'); // <- au cas où
          BTN_VALIDATE.removeAttribute('aria-disabled');
        }
      });
      GRID.appendChild(btn);
    });

    if (!list.length) {
      GRID.innerHTML = `<div style="grid-column:1/-1;opacity:.7;text-align:center;">Aucun résultat…</div>`;
    }
  }

  function applySelection(){
    if (!state.icon || !state.targetInput || !state.targetPreview) return;
    state.targetInput.value = state.icon;
    state.targetPreview.innerHTML = `<i class="${state.icon}"></i>`;

    const r = loadRecents();
    const i = r.indexOf(state.icon);
    if (i !== -1) r.splice(i,1);
    r.unshift(state.icon);
    saveRecents(r);

    closeSheet();
  }

  // 👉 Écouteurs des boutons (capture = true pour passer avant tout autre code)
  BTN_CLOSE    && BTN_CLOSE.addEventListener('click',  (e)=>{ e.preventDefault(); e.stopPropagation(); closeSheet(); }, true);
  BTN_CANCEL   && BTN_CANCEL.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); closeSheet(); }, true);
  BTN_VALIDATE && BTN_VALIDATE.addEventListener('click',(e)=>{ e.preventDefault(); e.stopPropagation(); if(!state.icon) return; applySelection(); }, true);

  // Expose pour test console
  window.__openIconSheet = openSheet;

  // === Délégation des clics (garantie de capture des boutons) ===
  document.addEventListener('click', (e) => {
    // Ouvrir depuis n'importe quel .cat-trigger
    const trigger = e.target.closest('.cat-trigger');
    if (trigger) {
      e.preventDefault();
      openSheet(trigger.dataset.targetInput, trigger.dataset.targetPreview);
      return;
    }
  });

  SHEET.addEventListener('click', (e) => {
    // Fermer via backdrop
    if (e.target.classList && e.target.classList.contains('sheet__backdrop')) {
      e.preventDefault(); closeSheet(); return;
    }
    // Fermer via croix
    const cross = e.target.closest('.sheet__close');
    if (cross) { e.preventDefault(); closeSheet(); return; }

    // Annuler
    const cancel = e.target.closest('#ip-cancel');
    if (cancel) { e.preventDefault(); closeSheet(); return; }

    // Valider (fonctionne même si l'attribut disabled traîne)
    const validate = e.target.closest('#ip-validate');
    if (validate) {
      e.preventDefault();
      if (!state.icon) return;
      applySelection();
    }
  });

  // Recherche
  SEARCH && SEARCH.addEventListener('input', renderGrid);

  // Accessibilité: Enter sur un bouton sélectionné -> valider
  SHEET.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && SHEET.classList.contains('is-open')) {
      if (state.icon) { e.preventDefault(); applySelection(); }
    }
    if (e.key === 'Escape' && SHEET.classList.contains('is-open')) {
      e.preventDefault(); closeSheet();
    }
  });

  window.__closeIconSheet = closeSheet;
  window.__applyIconSelection = applySelection;

  // Sync preview si une valeur existe déjà
  document.querySelectorAll('.cat-trigger').forEach(btn => {
    const input = document.getElementById(btn.dataset.targetInput);
    const preview = document.getElementById(btn.dataset.targetPreview);
    if (input?.value) preview.innerHTML = `<i class="${input.value}"></i>`;
  });

  console.log('[IconPickerV2] prêt. triggers =', document.querySelectorAll('.cat-trigger').length);
})();

// Filet de sécurité global (prioritaire) pour les boutons de la feuille d'icônes
document.addEventListener('click', function(e){
  const closeBtn = e.target.closest('.sheet__close');
  const cancelBtn = e.target.closest('#ip-cancel');
  const validateBtn = e.target.closest('#ip-validate');

  if (!closeBtn && !cancelBtn && !validateBtn) return;

  e.preventDefault();
  e.stopPropagation();

  if (closeBtn || cancelBtn) {
    window.__closeIconSheet && window.__closeIconSheet();
    return;
  }
  if (validateBtn) {
    window.__applyIconSelection && window.__applyIconSelection();
  }
}, true); // <-- "true" = priorité maximale

// ===============================
//  EXPORT PDF — UI + Génération (aperçu + compression JPEG + bon nom)
// ===============================
(function setupPdfExport() {
  const $ = (sel, ctx = document) => ctx.querySelector(sel);

  // Mise en page PDF
  const LAYOUT = { MARGIN: 12, HEADER_H: 10, FOOTER_H: 8, GAP: 6 };

  // Réglages poids/qualité
  const JPEG_QUALITY = 0.72;              // 0.6–0.8 = bon compromis
  const CAPTURE_SCALE = Math.min(1.4, Math.max(1.0, window.devicePixelRatio || 1)); // moins “zoomé” = plus léger

  // Boutons & modale
  const btnOpen   = $('#export-pdf');
  const modal     = $('#export-pdf-modal');
  const btnRun    = $('#export-pdf-run');
  const btnCancel = $('#export-pdf-cancel');

  const cbCalendar = $('#exp-calendar');
  const cbMonth    = $('#exp-month');
  const cbStats    = $('#exp-stats');
  const cbHistory  = $('#exp-history');
  const fileInput  = $('#export-filename');

  // Nom par défaut YYYY-MM
  try {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    if (fileInput && fileInput.value.includes('{{YYYY-MM}}')) {
      fileInput.value = fileInput.value.replace('{{YYYY-MM}}', `${y}-${m}`);
    }
  } catch(e){}

  function openModal(){ modal && (modal.style.display = 'block'); }
  function closeModal(){ modal && (modal.style.display = 'none'); }

  modal?.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal?.style.display === 'block') closeModal(); });
  btnOpen?.addEventListener('click', openModal);
  btnCancel?.addEventListener('click', closeModal);

  // ---- Helpers capture PDF ----
  async function ensureVisibleForCapture(el) {
    const touched = [];
    let node = el;
    while (node && node !== document.body) {
      const cs = window.getComputedStyle(node);
      if (cs && cs.display === 'none') {
        touched.push({ node, old: node.style.display });
        node.style.display = 'block';
      }
      node = node.parentElement;
    }
    return () => { touched.forEach(({ node, old }) => node.style.display = old); };
  }

  // conversion mm -> pixels pour préparer une image à la "bonne" largeur
  const mmToPx = (mm) => Math.round((mm / 25.4) * 130); // ~130 dpi: net et léger

  async function captureSelectorToPdf(pdf, title, selector) {
    const el = document.querySelector(selector);
    if (!el) return;

    const restore = await ensureVisibleForCapture(el);
    try {
      const { MARGIN, HEADER_H, FOOTER_H, GAP } = LAYOUT;
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();

      // Point de départ sûr sous l'en-tête
      let y = pdf.__cursorY ?? (MARGIN + HEADER_H + 4);

      // Titre de section
      if (title) {
        pdf.setFontSize(16);
        pdf.setTextColor(0, 0, 0);
        pdf.text(title, MARGIN, y);
        y += GAP;
      }

      // 1) Capture DOM -> canvas (échelle modérée)
      const canvas = await html2canvas(el, {
        backgroundColor: null,
        scale: CAPTURE_SCALE
      });

      // 2) Downscale vers la largeur utile du PDF (en px), puis export JPEG compressé
      const targetWmm = pageW - 2*MARGIN;
      const targetWpx = Math.min(canvas.width, mmToPx(targetWmm));
      const targetHpx = Math.round(canvas.height * (targetWpx / canvas.width));

      const tmp = document.createElement('canvas');
      tmp.width = targetWpx;
      tmp.height = targetHpx;
      const ctx = tmp.getContext('2d');
      ctx.drawImage(canvas, 0, 0, targetWpx, targetHpx);

      const imgData = tmp.toDataURL('image/jpeg', JPEG_QUALITY); // <<< JPEG compressé

      // 3) Placement dans la page
      const targetHmm = targetWmm;
      const targetHmmH = (targetHpx / targetWpx) * targetHmm; // conserve ratio en mm
      const remaining = pageH - y - MARGIN - FOOTER_H;

      if (targetHmmH > remaining) {
        pdf.addPage();
        y = MARGIN + HEADER_H + 4;
      }

      pdf.addImage(imgData, 'JPEG', MARGIN, y, targetHmm, targetHmmH);
      pdf.__cursorY = y + targetHmmH + GAP;

      if (pdf.__cursorY > pageH - MARGIN - FOOTER_H) {
        pdf.addPage();
        pdf.__cursorY = MARGIN + HEADER_H + 4;
      }
    } finally {
      restore();
    }
  }

  // En-tête / pied de page
  function addHeaderFooter(pdf, titleText) {
    const { MARGIN, HEADER_H, FOOTER_H } = LAYOUT;
    const pageCount = pdf.getNumberOfPages();
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();

    for (let i = 1; i <= pageCount; i++) {
      pdf.setPage(i);

      // Header
      pdf.setFontSize(11);
      pdf.setTextColor(80);
      const dateStr = new Date().toLocaleString('fr-FR');
      pdf.text(titleText, MARGIN, MARGIN);
      const wDate = pdf.getTextWidth(dateStr);
      pdf.text(dateStr, pageW - MARGIN - wDate, MARGIN);

      // Trait sous l'en-tête
      pdf.setDrawColor(200);
      pdf.line(MARGIN, MARGIN + HEADER_H - 4, pageW - MARGIN, MARGIN + HEADER_H - 4);

      // Footer
      const footer = `Page ${i}/${pageCount}`;
      const wFooter = pdf.getTextWidth(footer);
      pdf.text(footer, pageW - MARGIN - wFooter, pageH - (FOOTER_H/2));
    }
  }

  // --- Aperçu avec BON NOM : onglet HTML + bouton Télécharger (download=filename)
  function previewPdf(pdf, filename) {
    // sécurité nom
    filename = (filename || 'finances.pdf').trim();
    if (!/\.pdf$/i.test(filename)) filename += '.pdf';
    filename = filename.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');

    const blob = pdf.output('blob');
    const url = URL.createObjectURL(blob);

    // Ouvre une page viewer simple (iframe + barre d’actions)
    const w = window.open('', '_blank');
    if (!w) {
      // Popups bloquées → on propose le téléchargement direct
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a);
      a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return;
    }

    const html = `<!doctype html>
    <html lang="fr">
    <head>
    <meta charset="utf-8">
    <title>${filename}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
    body{margin:0;background:#111;color:#ddd;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial;}
    header{position:sticky;top:0;display:flex;gap:.5rem;align-items:center;padding:.6rem .8rem;background:#181818;border-bottom:1px solid #333;}
    header .spacer{flex:1}
    header .name{font-weight:700}
    header a, header button{
      appearance:none;border:1px solid #2c2c2c;background:#2a2a2a;color:#eee;border-radius:8px;
      padding:.45rem .8rem;cursor:pointer;font-weight:700;text-decoration:none;
    }
    header a:hover, header button:hover{background:#333}
    iframe{width:100%;height:calc(100vh - 52px);border:0;background:#222}
    </style>
    </head>
    <body>
    <header>
    <span class="name">${filename}</span>
    <span class="spacer"></span>
    <button id="printBtn">Imprimer</button>
    <a id="dl" href="${url}" download="${filename}">Télécharger</a>
    </header>
    <iframe id="frame" src="${url}" title="${filename}"></iframe>
    <script>
    const url = '${url}';
    document.getElementById('printBtn').addEventListener('click', () => {
      document.getElementById('frame').contentWindow?.print?.();
    });
    window.addEventListener('unload', () => { try{ URL.revokeObjectURL(url); }catch(e){} });
    </script>
    </body>
    </html>`;
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  async function runExport() {
    const wantCalendar = cbCalendar?.checked;
    const wantMonth    = cbMonth?.checked;
    const wantStats    = cbStats?.checked;
    const wantHistory  = cbHistory?.checked;

    if (!wantCalendar && !wantMonth && !wantStats && !wantHistory) {
      alert('Sélectionne au moins un élément à exporter.');
      return;
    }

    // UI lock
    const oldText = btnRun.innerHTML;
    btnRun.disabled = true;
    btnRun.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Génération…';

    try {
      const { jsPDF } = window.jspdf || {};
      if (!jsPDF || !window.html2canvas) {
        alert('Librairies PDF manquantes. Vérifie les balises <script> html2canvas et jsPDF.');
        return;
      }

      // Prépare le nom de fichier choisi
      let fileName = (fileInput?.value || 'finances.pdf').trim();
      if (!/\.pdf$/i.test(fileName)) fileName += '.pdf';

      const pdf = new jsPDF('p', 'mm', 'a4');
      pdf.__cursorY = LAYOUT.MARGIN + LAYOUT.HEADER_H + 4;

      // Ordre logique
      if (wantCalendar) await captureSelectorToPdf(pdf, 'Calendrier', '#calendar-section');
      if (wantMonth)    await captureSelectorToPdf(pdf, 'Récapitulatif du mois', '#month-summary');
      if (wantStats)    await captureSelectorToPdf(pdf, 'Statistiques', '#stats-section');
      if (wantHistory)  await captureSelectorToPdf(pdf, 'Historique', '#transactions-section');

      addHeaderFooter(pdf, 'Finances — Export');

      // 👉 Aperçu avec bouton "Télécharger" (download=filename)
      previewPdf(pdf, fileName);

      closeModal();
    } catch (err) {
      console.error('Erreur export PDF:', err);
      alert('Échec de la génération du PDF. Regarde la console pour les détails.');
    } finally {
      btnRun.disabled = false;
      btnRun.innerHTML = oldText;
    }
  }

  btnRun?.addEventListener('click', runExport);
})();

// ===============================
//  TOTAL DU MOIS — Revenus / Dépenses / Solde [MODULE FIX v3: classification robuste]
// ===============================
(function setupMonthTotal() {
  const $ = (s, ctx = document) => ctx.querySelector(s);

  // Accès données (module d'abord, puis window en secours)
  const getTransactions = () => {
    try { if (Array.isArray(transactions)) return transactions; } catch(_) {}
    try { if (Array.isArray(window.transactions)) return window.transactions; } catch(_) {}
    return [];
  };
  const getCurrentMonth = () => {
    try { if (currentMonth instanceof Date && !isNaN(currentMonth)) return currentMonth; } catch(_) {}
    try { if (window.currentMonth instanceof Date && !isNaN(window.currentMonth)) return window.currentMonth; } catch(_) {}
    return new Date();
  };

  // Helpers
  function euros(n){ return Number(n||0).toLocaleString('fr-FR',{style:'currency',currency:'EUR'}); }
  function parseAppDate(raw){
    if(!raw) return null;
    if(raw instanceof Date && !isNaN(raw)) return raw;
    if(typeof raw==='number') return new Date(raw);
    const s=String(raw).trim();
    let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(m) return new Date(+m[1],+m[2]-1,+m[3]); // YYYY-MM-DD
    m=s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);   if(m) return new Date(+m[3],+m[2]-1,+m[1]); // JJ/MM/AAAA
    const d=new Date(s); return isNaN(d)?null:d;
  }
  function parseAmount(v){
    if(typeof v==='number') return v;
    if(v==null) return 0;
    let t=String(v)
    .replace(/[€\s\u00A0]/g,'')
    .replace(/[−—–]/g,'-') // tirets typographiques -> '-'
    .replace(/,/g,'.')
    .replace(/\.(?=.*\.)/g,'') // retire les points de milliers
    .replace(/[^0-9.\-]/g,''); // garde chiffres/point/signe
    const n=parseFloat(t);
    return isNaN(n)?0:n;
  }
  const sameMonth=(d,ref)=> d.getFullYear()===ref.getFullYear() && d.getMonth()===ref.getMonth();

  // Détermine si une transaction est une dépense (même si le montant est positif)
  function isExpenseTx(tx, val){
    // 1) Booléen explicite
    if (typeof tx?.isExpense === 'boolean') return tx.isExpense;

    // 2) Propriétés textuelles usuelles
    const fields = [
      tx?.type, tx?.kind, tx?.nature, tx?.flow, tx?.sens,
      tx?.categoryType, tx?.catType
    ].filter(Boolean).map(x=>String(x).toLowerCase());

    const isExpenseByText = fields.some(s =>
    /(expense|d[ée]pense|out|sortie|d[ée]bit)/.test(s)
    );
    const isIncomeByText  = fields.some(s =>
    /(income|revenu|entr[ée]e|cr[ée]dit)/.test(s)
    );
    if (isExpenseByText) return true;
    if (isIncomeByText)  return false;

    // 3) Catégorie “indicative” (optionnel, améliore la détection)
    const cat = String(tx?.category || tx?.categorie || '').toLowerCase();
    if (/(salaire|paie|pay|prime|remboursement|dividende|loyer perçu)/.test(cat)) return false;
    if (/(courses|essence|resto|facture|loyer|abonnement|transport|sant[ée]|imp[oô]ts)/.test(cat)) return true;

    // 4) Signe du montant si présent
    if (typeof val === 'number' && val !== 0) return val < 0;

    // 5) Signe textuel au début (ex: "−45,00")
    const raw = String(tx.amount ?? tx.montant ?? tx.value ?? tx.prix ?? tx.price ?? '').trim();
    if (/^[−—–-]/.test(raw)) return true;

    // Par défaut: on considère “revenu”
    return false;
  }

  // Calculs
  function computeBreakdown(){
    const txs=getTransactions();
    const ref=getCurrentMonth();
    let income=0, expense=0;
    for(const tx of txs){
      const d=parseAppDate(tx.date ?? tx.day ?? tx.createdAt ?? tx.timestamp);
      if(!d || !sameMonth(d,ref)) continue;

      const valSigned=parseAmount(tx.amount ?? tx.montant ?? tx.value ?? tx.prix ?? tx.price);
      const isExp=isExpenseTx(tx, valSigned);
      const mag=Math.abs(valSigned || 0);

      if (isExp) expense -= mag;     // on impose un signe négatif aux dépenses
      else       income  += mag;     // revenus toujours positifs
    }
    const net = income + expense;
    return { income, expense, net };
  }

  // UI
  function ensureContainer(){
    const host=$('#month-summary'); if(!host) return null;
    let box=host.querySelector('#month-total-box');
    if(!box){
      const h2=host.querySelector('h2') || host.firstElementChild;
      box=document.createElement('div');
      box.id='month-total-box';
      box.className='month-total';
      box.innerHTML = [
        '<div class="kpi kpi--income"><span class="label">Revenus</span><span id="month-income" class="amount">0,00 €</span></div>',
        '<div class="kpi kpi--expense"><span class="label">Dépenses</span><span id="month-expense" class="amount">0,00 €</span></div>',
        '<div class="kpi kpi--net"><span class="label">Solde</span><span id="month-net" class="amount">0,00 €</span></div>'
      ].join('');
      if (h2 && h2.nextSibling) h2.parentNode.insertBefore(box, h2.nextSibling);
      else host.prepend(box);
    }
    return box;
  }

  function updateMonthTotal(){
    const box=ensureContainer(); if(!box) return;
    const { income, expense, net } = computeBreakdown();
    box.querySelector('#month-income').textContent = euros(income);
    box.querySelector('#month-expense').textContent= euros(expense); // affiché en négatif
    box.querySelector('#month-net').textContent    = euros(net);
    const netEl = box.querySelector('#month-net');
    netEl.classList.toggle('negative', net < 0);
    netEl.classList.toggle('positive', net > 0);
  }

  // Expose
  window.updateMonthTotal = updateMonthTotal;

  // Initial
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', updateMonthTotal);
  else updateMonthTotal();

  // Recalcul si DOM du récap change
  const host=$('#month-summary');
  if(host && window.MutationObserver){
    let t=null;
    const mo=new MutationObserver(()=>{ clearTimeout(t); t=setTimeout(updateMonthTotal,100); });
    mo.observe(host,{childList:true,subtree:true,characterData:true});
  }

  // Recalcul sur navigation de mois (si présents)
  ['#prev-month','#next-month','#today-btn'].forEach(sel=>{
    const btn=document.querySelector(sel);
    if(btn) btn.addEventListener('click', ()=> setTimeout(updateMonthTotal,0));
  });

    // Events personnalisés éventuels
    document.addEventListener('transactions:changed', updateMonthTotal);
    document.addEventListener('month:changed', updateMonthTotal);
})();

// ===============================
//  Regroupement par catégorie — noms lisibles (mode texte robuste)
// ===============================
(function setupReadableCategoryNamesV2(){
  // Dictionnaire icône/clé -> libellé humain
  const CATEGORY_LABELS = {
    // Transport
    'fa-bus': 'Transport', 'fa-bus-simple': 'Transport', 'fa-train':'Transport',
    'fa-car':'Auto', 'fa-taxi':'Transport', 'fa-motorcycle':'Transport',
    'fa-gas-pump':'Carburant',

    // Vie courante
    'fa-cart-shopping':'Courses', 'fa-basket-shopping':'Courses',
    'fa-utensils':'Restauration',
    'fa-house':'Logement', 'fa-home':'Logement',
    'fa-bolt':'Énergie', 'fa-lightbulb':'Électricité', 'fa-droplet':'Eau',
    'fa-wifi':'Internet', 'fa-tv':'Abonnements',

    // Finance / travail
    'fa-briefcase':'Salaire', 'fa-money-bill':'Salaire', 'fa-sack-dollar':'Revenu', 'fa-coins':'Revenu',
    'fa-piggy-bank':'Épargne',

    // Santé / divers
    'fa-heart-pulse':'Santé', 'fa-notes-medical':'Santé',
    'fa-dog':'Animaux',
    'fa-gift':'Cadeaux',
    'fa-futbol':'Loisirs',
    'fa-ticket':'Divertissement',
  };

  // Mots-clés fallback -> libellé
  const TEXT_FALLBACKS = {
    'bus':'Transport', 'transport':'Transport', 'train':'Transport', 'carburant':'Carburant',
    'courses':'Courses', 'resto':'Restauration', 'restaurant':'Restauration',
    'logement':'Logement', 'internet':'Internet', 'abonnement':'Abonnements',
    'salaire':'Salaire', 'paie':'Salaire', 'revenu':'Revenu', 'épargne':'Épargne',
    'santé':'Santé', 'animaux':'Animaux', 'cadeaux':'Cadeaux',
    'loisirs':'Loisirs', 'divertissement':'Divertissement', 'auto':'Auto', 'voiture':'Auto'
  };

  const FA_VARIANTS = new Set(['fa-solid','fa-regular','fa-light','fa-thin','fa-duotone','fa-brands']);

  function mapToLabel(raw){
    if (!raw) return 'Divers';
    const s = String(raw).trim();

    // Récupère la DERNIÈRE clé fa-xxx (ex: "fa-solid fa-bus" -> "fa-bus")
    const allFa = s.match(/fa-[a-z0-9-]+/gi) || [];
    const lastFa = allFa.reverse().find(k => !FA_VARIANTS.has(k.toLowerCase()));

    if (lastFa && CATEGORY_LABELS[lastFa]) return CATEGORY_LABELS[lastFa];

    // Sinon, mots-clés simples
    const low = s.toLowerCase();
    for (const key in TEXT_FALLBACKS) {
      if (low.includes(key)) return TEXT_FALLBACKS[key];
    }

    // Fallback lisible: "fa-briefcase" -> "Briefcase"
    if (lastFa) {
      const simple = lastFa.replace(/^fa-/, '').replace(/-/g,' ');
      return simple.charAt(0).toUpperCase() + simple.slice(1);
    }
    // Dernier recours
    const firstWord = low.split(/\s+/)[0].replace(/^fa-/, '').replace(/-/g,' ');
    return firstWord ? firstWord.charAt(0).toUpperCase() + firstWord.slice(1) : 'Divers';
  }

  // Remplace les TEXT NODES contenant "fa-..." en gardant le suffixe (" — 45,00€  ▾")
  function relabelTextNodes(){
    const host = document.querySelector('#month-summary');
    if (!host) return;

    const sepRegex = /\s[—–-]\s/; // séparateur: " — " ou " - " ou " – "
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, null, false);
    const nodes = [];
    while (walker.nextNode()) {
      const t = walker.currentNode.nodeValue;
      if (t && /fa-[a-z0-9-]+/i.test(t)) nodes.push(walker.currentNode);
    }

    nodes.forEach(node => {
      const full = node.nodeValue;
      let labelPart = full, suffix = '';
      const m = full.match(sepRegex);
      if (m) {
        const idx = full.indexOf(m[0]);
        labelPart = full.slice(0, idx);
        suffix = full.slice(idx); // ex: " — 45,00€  ▾"
      }
      const newLabel = mapToLabel(labelPart);
      if (newLabel && newLabel !== labelPart) {
        node.nodeValue = newLabel + (suffix || '');
      }
    });
  }

  // Lance maintenant + observe les changements (quand tu coches/décoches "Regrouper par catégorie")
  const host = document.querySelector('#month-summary');
  if (!host) return;
  relabelTextNodes();

  if (window.MutationObserver) {
    let t = null;
    const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(relabelTextNodes, 50); });
    mo.observe(host, { childList: true, subtree: true, characterData: true });
  }

  document.addEventListener('month-summary:grouping-changed', relabelTextNodes);
})();

// ===============================
//  Calendrier — ESC pour quitter le mode "double-clic" / fermer l'ajout rapide
// ===============================
(function enableCalendarEscExit(){
  const $ = (s, ctx=document) => ctx.querySelector(s);

  function clearCalendarSelection(){
    document.querySelectorAll('#calendar td.selected, #calendar td.is-adding')
    .forEach(td => td.classList.remove('selected','is-adding'));
  }

  function closeQuickAddModal(){
    const modal = $('#modal-add-transaction');
    if (modal && getComputedStyle(modal).display !== 'none') {
      modal.style.display = 'none';
      const f = $('#add-transaction-form');
      if (f) f.reset();
      clearCalendarSelection();
      return true;
    }
    return false;
  }

  // Hooks facultatifs si ton code les expose
  function exitCustomDblMode(){
    let done = false;
    if (typeof window.exitCalendarDblMode === 'function') {
      try { window.exitCalendarDblMode(); done = true; } catch(_) {}
    }
    if (document.body.classList.contains('calendar-dbl-active')) {
      document.body.classList.remove('calendar-dbl-active');
      done = true;
    }
    return done;
  }

  function handleEsc(e){
    if (e.key !== 'Escape') return;

    // 1) Si l’ajout rapide (ou autre modale liée au calendrier) est ouvert → on ferme
    if (closeQuickAddModal()) return;

    // 2) Sinon, on tente de sortir d’un éventuel “mode double-clic” custom
    if (exitCustomDblMode()) return;

    // 3) À défaut, on nettoie la sélection visuelle éventuelle
    clearCalendarSelection();
  }

  // Capture au niveau fenêtre (en phase de capture pour passer avant certains handlers)
  window.addEventListener('keydown', handleEsc, true);
})();

// ===============================
//  EDIT — Patch béton (wiring direct + délégué global)
// ===============================
(() => {
  const $ = (s, ctx=document) => ctx.querySelector(s);

  // ---- Récup données (globales ou localStorage)
  function getTxs(){
    try { if (Array.isArray(window.transactions) && window.transactions.length) return window.transactions; } catch(_){}
    try { if (Array.isArray(window.allTransactions) && window.allTransactions.length) return window.allTransactions; } catch(_){}
    try { if (Array.isArray(window.txs) && window.txs.length) return window.txs; } catch(_){}
    try {
      const raw = localStorage.getItem('transactions');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr;
        if (arr && Array.isArray(arr.items)) return arr.items;
      }
    } catch(_){}
    return [];
  }
  function findTxById(id){
    const list = getTxs();
    return list.find(t => String(t.id||t._id||t.uuid) === String(id));
  }
  const toInputDate = (raw) => {
    if (!raw) return '';
    const d = new Date(raw);
    if (isNaN(d)) return String(raw);
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const yy = d.getFullYear();
    return `${dd}-${mm}-${yy}`;
  };

  // ---- Ouvre + remplit la modale (tolérant)
  function openEditModal(id){
    if (!id) { console.warn('[edit] id manquant'); return; }
    const tx = findTxById(id);
    if (!tx) { console.warn('[edit] transaction introuvable pour id=', id); return; }

    // Champs
    const setVal = (sel, val) => { const el = $(sel); if (el) el.value = val ?? ''; };
    const setChk = (sel, val) => { const el = $(sel); if (el) el.checked = !!val; };

    setVal('#edit-id', String(id));
    setVal('#edit-description', tx.description ?? tx.label ?? '');
    setVal('#edit-amount', Math.abs(Number(tx.amount ?? 0)).toFixed(2));
    setVal('#edit-date', toInputDate(tx.date ?? tx.day ?? tx.createdAt));
    {
      const t = String(tx.type||'').toLowerCase();
      const v = Number(tx.amount||0);
      setVal('#edit-type', t==='income' ? 'income' : t==='expense' ? 'expense' : (v>=0 ? 'income' : 'expense'));
    }
    setVal('#edit-category', tx.category ?? tx.categorie ?? '');

    const rec = String(tx.recurrence || 'none');
    setVal('#edit-recurrence', ['none','monthly','yearly','installments'].includes(rec) ? rec : 'none');
    setVal('#edit-until', toInputDate(tx.until ?? tx.recurrenceEnd ?? tx.end));
    setVal('#edit-installments', tx.installments ?? '');
    setChk('#edit-apply-previous', !!(tx.applyPrev || tx.applyPrevious));

    // Affiche/cache lignes dépendantes
    (function toggleRecRows(){
      const v = $('#edit-recurrence')?.value || 'none';
      const show = (sel, on) => { const r = $(sel); if (r) r.style.display = on ? '' : 'none'; };
      show('#edit-end-row', ['monthly','yearly','installments'].includes(v));
      show('#edit-installments-row', v === 'installments');
      show('#edit-apply-previous-row', v === 'monthly');
    })();

    // Ouvre + focus
    const modal = $('#modal-edit-transaction');
    if (!modal) { console.error('[edit] #modal-edit-transaction introuvable'); return; }
    modal.style.display = 'block';
    setTimeout(() => { $('#edit-description')?.focus(); }, 0);

    console.debug('[edit] modal ouverte pour id=', id, tx);
  }

  // Expose global
  window.openEditModal = openEditModal;

  // ---- Wiring DIRECT sur chaque bouton crayon
  function wireEditButtons(){
    const btns = document.querySelectorAll('button[data-action="edit"].edit-btn, li[data-id] button[data-action="edit"]');
    let count = 0;
    btns.forEach(btn => {
      if (btn.dataset._wired === '1') return;
      btn.dataset._wired = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        let id = btn.dataset.id || btn.getAttribute('data-id');
        if (!id) {
          const li = btn.closest('li[data-id],[id^="tx-"]');
          if (li) id = li.dataset.id || (li.id.match(/^tx-(.+)$/)||[])[1];
        }
        if (!id) return console.warn('[edit] pas d’id sur le bouton/LI');
        openEditModal(id);
      }, false);
      count++;
    });
    if (count) console.debug(`[edit] boutons câblés: ${count}`);
  }

  // ---- Délégué GLOBAL (backup)
  function onGlobalClick(e){
    const btn = e.target.closest('button[data-action="edit"], .edit-btn, .fa-pen-to-square');
    if (!btn) return;
    // Ne double-pas si wiring direct a déjà stoppé
    if (e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    let id = btn.dataset.id || btn.getAttribute('data-id');
    if (!id) {
      const li = btn.closest('li[data-id],[id^="tx-"]');
      if (li) id = li.dataset.id || (li.id.match(/^tx-(.+)$/)||[])[1];
    }
    if (!id) return console.warn('[edit] (global) pas d’id détecté');
    openEditModal(id);
  }

  // ---- Boot + ré-attach si rerendus
  function boot(){
    wireEditButtons();
    document.removeEventListener('click', onGlobalClick, true);
    document.addEventListener('click', onGlobalClick, true);

    // Observe la liste pour recâbler automatiquement
    const holder = document.getElementById('transactions-list') || document.body;
    if (window.MutationObserver && holder) {
      const mo = new MutationObserver(() => wireEditButtons());
      mo.observe(holder, { childList: true, subtree: true });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once:true });
  } else {
    boot();
  }

  console.debug('[edit] patch béton chargé.');
})();

// ==== FORCE PATCH clic "crayon" -> openEditModal (ignore preventDefault / stopPropagation) ====
(() => {
  function onForceEditClick(e){
    const btn = e.target.closest('button[data-action="edit"], .edit-btn, .fa-pen-to-square');
    if (!btn) return;

    // NE PAS se laisser bloquer par d'autres handlers
    let id =
    btn.dataset.id ||
    btn.getAttribute('data-id') ||
    btn.closest('li[data-id],[id^="tx-"]')?.dataset?.id ||
    (btn.closest('[id^="tx-"]')?.id.match(/^tx-(.+)$/) || [])[1];

    console.debug('[edit][force] clic crayon capté, id=', id);

    if (id && typeof window.openEditModal === 'function') {
      window.openEditModal(id);
    } else {
      console.warn('[edit][force] pas d’id OU openEditModal absent');
    }
  }

  // capture = true pour passer avant tout le monde, et on NE teste pas e.defaultPrevented
  document.addEventListener('click', onForceEditClick, true);
})();

// ==== PATCH VISIBILITÉ — forcer #modal-edit-transaction au premier plan ====
(() => {
  function ensureEditModalOnTop() {
    const modal = document.getElementById('modal-edit-transaction');
    if (!modal) return console.error('[edit][ensure] #modal-edit-transaction introuvable');

    // 1) ferme tout overlay qui pourrait masquer
    const sheet = document.getElementById('icon-sheet');
    if (sheet) {
      sheet.classList.remove('is-open');
      sheet.setAttribute('aria-hidden', 'true');
      sheet.style.display = 'none';
      sheet.style.pointerEvents = 'none';
    }

    // 2) force l’affichage et le z-index
    modal.style.setProperty('display','block','important');
    modal.style.setProperty('visibility','visible','important');
    modal.style.setProperty('opacity','1','important');
    modal.style.setProperty('pointer-events','auto','important');
    modal.style.setProperty('z-index','1000000','important');

    const content = modal.querySelector('.modal-content');
    if (content) {
      content.style.setProperty('position','absolute','important');
      content.style.setProperty('top','50%','important');
      content.style.setProperty('left','50%','important');
      content.style.setProperty('transform','translate(-50%, -50%)','important');
      content.style.setProperty('z-index','1000001','important');
      content.style.setProperty('display','block','important');
      // petit focus pour la voir “vivre”
      const desc = document.getElementById('edit-description');
      if (desc) setTimeout(() => desc.focus(), 0);
    }

    // 3) re-applique au cas où un autre handler la “re-cache” juste après
    setTimeout(() => {
      if (getComputedStyle(modal).display === 'none') {
        console.warn('[edit][ensure] ré-application (quelque chose la cache)');
        ensureEditModalOnTop();
      }
    }, 0);
  }

  // On “wrappe” la fonction existante openEditModal : elle fait son travail, puis on force l’affichage par-dessus tout.
  const prev = window.openEditModal;
  window.openEditModal = function(id){
    try { if (typeof prev === 'function') prev(id); } catch(e){ console.error(e); }
    ensureEditModalOnTop();
  };

  // Et on force aussi lors d’un clic crayon (au cas où l’appli appelle une autre routine)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action="edit"], .edit-btn, .fa-pen-to-square');
    if (!btn) return;
    setTimeout(ensureEditModalOnTop, 0);
  }, true);
})();

// ===============================
//  EDIT — Unstick modal (doublons, z-index, re-close fixes)
// ===============================
(() => {
  const $ = (s, ctx=document) => ctx.querySelector(s);

  // Choisit "la bonne" modale s'il y en a plusieurs puis la met tout en haut du DOM et de la pile
  function bringEditModalToFront() {
    const all = Array.from(document.querySelectorAll('#modal-edit-transaction'));
    if (!all.length) { console.error('[edit][front] aucune modale #modal-edit-transaction'); return null; }

    // On prend la dernière (souvent celle nouvellement injectée / correcte)
    const modal = all[all.length - 1];

    // Cache les autres doublons si présents
    all.forEach((m, i) => { if (m !== modal) m.style.display = 'none'; });

    // La met en fin de body pour éviter tout parent invisible
    if (modal.parentElement !== document.body) {
      document.body.appendChild(modal);
    }

    // Ferme toute feuille d’icônes / overlay potentielle
    const sheet = document.getElementById('icon-sheet');
    if (sheet) {
      sheet.classList.remove('is-open');
      sheet.setAttribute('aria-hidden', 'true');
      sheet.style.display = 'none';
      sheet.style.pointerEvents = 'none';
    }

    // Affichage + priorité max
    modal.style.setProperty('display', 'block', 'important');
    modal.style.setProperty('visibility', 'visible', 'important');
    modal.style.setProperty('opacity', '1', 'important');
    modal.style.setProperty('pointer-events', 'auto', 'important');
    modal.style.setProperty('position', 'fixed', 'important');
    modal.style.setProperty('inset', '0', 'important');
    modal.style.setProperty('z-index', '2147483647', 'important'); // tout en haut

    const content = modal.querySelector('.modal-content');
    if (content) {
      content.style.setProperty('position', 'absolute', 'important');
      content.style.setProperty('top', '50%', 'important');
      content.style.setProperty('left', '50%', 'important');
      content.style.setProperty('transform', 'translate(-50%, -50%)', 'important');
      content.style.setProperty('z-index', '2147483647', 'important');
      content.style.setProperty('display', 'block', 'important');
    }

    // Focus description si possible
    const desc = document.getElementById('edit-description');
    if (desc) setTimeout(() => desc.focus(), 0);

    return modal;
  }

  // Empêche une fermeture immédiate par un autre handler "global"
  function armCloseShield(ms = 120) {
    const until = Date.now() + ms;
    function shield(e){
      // si un autre handler tente de cacher la modale juste après l'ouverture
      const modal = document.getElementById('modal-edit-transaction');
      if (!modal) return;
      const isTryingToClose = getComputedStyle(modal).display === 'none';
      if (isTryingToClose) {
        e.stopImmediatePropagation();
        e.preventDefault();
        bringEditModalToFront(); // on la remet
      }
      if (Date.now() > until) {
        document.removeEventListener('click', shield, true);
      }
    }
    document.addEventListener('click', shield, true);
    setTimeout(() => document.removeEventListener('click', shield, true), ms + 50);
  }

  // Wrappe la fonction existante
  const prev = window.openEditModal;
  window.openEditModal = function(id){
    try { if (typeof prev === 'function') prev(id); } catch(e){ console.error(e); }
    armCloseShield(150);
    const modal = bringEditModalToFront();
    // Ré-applique 2 fois au cas où un code async la referme encore
    setTimeout(bringEditModalToFront, 0);
    setTimeout(bringEditModalToFront, 50);
    return modal;
  };

  // ESC pour fermer proprement
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('modal-edit-transaction');
    if (modal && getComputedStyle(modal).display !== 'none') {
      modal.style.display = 'none';
    }
  }, true);
})();

// ===============================
//  EDIT — sauver la transaction depuis la modale
// ===============================
(() => {
  const $ = (s, ctx=document) => ctx.querySelector(s);

  function parseInputDate(d) {
    if (!d) return '';
    // attend "jj-mm-aaaa" → renvoie "aaaa-mm-jj"
    const m = String(d).trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    // fallback: si déjà ISO/date valide, renvoyer tel quel
    const dd = new Date(d);
    return isNaN(dd) ? '' : dd.toISOString().slice(0,10);
  }

  function getStore() {
    // Source globale si dispo
    try { if (Array.isArray(window.transactions)) return { arr: window.transactions, src: 'global' }; } catch(_){}
    // Sinon localStorage (clé standard)
    try {
      const raw = localStorage.getItem('transactions');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return { arr, src: 'ls' };
      }
    } catch(_){}
    // Dernier recours: tableau vide (on évite de planter)
    return { arr: [], src: 'none' };
  }

  function setStore(store) {
    if (store.src === 'ls') {
      try { localStorage.setItem('transactions', JSON.stringify(store.arr)); } catch(_){}
      // si une globale existe, on la synchronise aussi
      try { if (Array.isArray(window.transactions)) { window.transactions.length = 0; window.transactions.push(...store.arr); } } catch(_){}
    }
    if (store.src === 'global') {
      try { localStorage.setItem('transactions', JSON.stringify(store.arr)); } catch(_){}
    }
  }

  function closeEditModal() {
    const modal = $('#modal-edit-transaction');
    if (modal) modal.style.display = 'none';
  }

  const form = $('#edit-transaction-form');
  if (!form) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    // -- Récup champs
    const idEl  = $('#edit-id');
    const id    = (idEl?.value || idEl?.getAttribute('value') || '').trim();
    const desc  = $('#edit-description')?.value?.trim() ?? '';
    const amtS  = $('#edit-amount')?.value ?? '0';
    const type  = $('#edit-type')?.value === 'income' ? 'income' : 'expense';
    const dateI = $('#edit-date')?.value ?? '';
    const cat   = $('#edit-category')?.value ?? '';

    const rec   = $('#edit-recurrence')?.value || 'none';
    const untilI= $('#edit-until')?.value || '';
    const instS = $('#edit-installments')?.value || '';
    const prevB = !!$('#edit-apply-previous')?.checked;

    // -- Normalisations
    let amount = Math.abs(parseFloat(amtS.replace(',', '.')) || 0);
    if (type === 'expense') amount = -amount; // convention: dépenses négatives

                        const isoDate  = parseInputDate(dateI);
    const isoUntil = parseInputDate(untilI);
    const installments = instS ? parseInt(instS, 10) : undefined;

    // -- Trouve et met à jour
    const store = getStore();
    const idx = store.arr.findIndex(t => String(t.id||t._id||t.uuid) === String(id));
    if (idx === -1) {
      console.warn('[edit][save] pas trouvé id=', id, '→ rien modifié');
      closeEditModal();
      return;
    }

    const txOld = store.arr[idx];
    const idKey = ('id' in txOld) ? 'id' : (('_id' in txOld) ? '_id' : ('uuid' in txOld ? 'uuid' : 'id'));

    const txNew = {
      ...txOld,
      [idKey]: String(id),
                        description: desc,
                        amount,
                        date: isoDate || txOld.date,           // garde l’ancienne si parsing vide
                        type,
                        category: cat || txOld.category,
                        recurrence: rec,
                        until: isoUntil || undefined,
                        installments,
                        applyPrev: prevB,
                        applyPrevious: prevB                    // alias si autre code l’emploie
    };

    store.arr.splice(idx, 1, txNew);
    setStore(store);

    // -- Fermer + refresh UI
    closeEditModal();

    // Rafraîchis l’historique
    if (typeof window.renderTransactionList === 'function') {
      try { window.renderTransactionList(); } catch(_){}
    }
    // Notifie les autres vues (récap, stats, calendrier…)
    document.dispatchEvent(new Event('transactions:changed'));
    if (typeof window.updateViews === 'function') {
      try { window.updateViews(); } catch(_){}
    }
  });
})();

// ===============================
//  EDIT — Icon Picker V2 (clic, double-clic = Valider, clavier) — FIX restore modal
// ===============================
(() => {
  const $ = (s, ctx=document) => ctx.querySelector(s);

  const ICON_LABELS = {
    'fa-solid fa-bus': 'Transport',
    'fa-solid fa-cart-shopping': 'Courses',
    'fa-solid fa-gas-pump': 'Carburant',
    'fa-solid fa-briefcase': 'Salaire',
    'fa-solid fa-basket-shopping': 'Courses',
    'fa-solid fa-car': 'Voiture',
    'fa-solid fa-house': 'Logement',
    'fa-solid fa-utensils': 'Restaurant',
    'fa-solid fa-bolt': 'Énergie',
    'fa-solid fa-shield-heart': 'Santé',
  };
  const getLabel = (cls) => ICON_LABELS[String(cls).trim()] || '';

  const state = { inputId: null, previewId: null };

  function normalizeIconClass(cell) {
    let cls = cell.getAttribute('data-icon');
    if (cls) return cls.trim();
    const i = cell.querySelector('i');
    if (i && i.className) return String(i.className).trim();
    return '';
  }

  function selectCell(grid, cell) {
    grid.querySelectorAll('.ip-icon').forEach(el => {
      el.classList.remove('is-selected');
      el.setAttribute('aria-selected', 'false');
    });
    cell.classList.add('is-selected');
    cell.setAttribute('aria-selected', 'true');
    if (!cell.hasAttribute('tabindex')) cell.setAttribute('tabindex', '0');
    cell.focus({ preventScroll: true });
  }

  function updatePreview(previewId, iconClass) {
    const badge = document.getElementById(previewId);
    if (!badge) return;
    badge.innerHTML = iconClass
    ? `<i class="${iconClass}" aria-hidden="true"></i>`
    : '<i class="fa-regular fa-circle-question" aria-hidden="true"></i>';
    const picker = badge.closest('.category-picker-v2');
    const lbl = picker?.querySelector('.cat-current-label');
    if (lbl) {
      const txt = getLabel(iconClass);
      lbl.textContent = txt || (iconClass ? 'Catégorie' : 'Choisir');
    }
  }

  function openIconSheet() {
    const sheet = document.getElementById('icon-sheet');
    if (!sheet) return console.error('[icon] #icon-sheet introuvable');
    sheet.classList.add('is-open');
    sheet.setAttribute('aria-hidden', 'false');

    const grid = document.getElementById('ip-grid');
    if (grid) {
      const all = grid.querySelectorAll('.ip-icon');
      all.forEach(el => { if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex','0'); });

      const current = document.getElementById(state.inputId)?.value || '';
      if (current) {
        const match = grid.querySelector(`.ip-icon[data-icon="${CSS.escape(current)}"]`)
        || Array.from(all).find(el => normalizeIconClass(el) === current);
        if (match) selectCell(grid, match);
      }
      setTimeout(() => (grid.querySelector('.ip-icon.is-selected') || all[0])?.focus(), 0);
    }

    // Si on a le patch z-index, on le déclenche aussi
    if (typeof window.bringIconSheetOnTop === 'function') {
      setTimeout(window.bringIconSheetOnTop, 0);
    }
  }

  function closeIconSheet() {
    const sheet = document.getElementById('icon-sheet');
    if (!sheet) return;
    sheet.classList.remove('is-open');
    sheet.setAttribute('aria-hidden', 'true');
  }

  // >>> FIX: utilise __closeIconSheet (qui RESTAURE pointer-events de la modale)
  function closeSheetAndRestore() {
    if (typeof window.__closeIconSheet === 'function') {
      window.__closeIconSheet();   // vient du patch "ICON SHEET > MODALE"
    } else {
      closeIconSheet();            // fallback (au cas où)
// petit secours : réactive la modale si besoin
const modal = document.getElementById('modal-edit-transaction');
if (modal) modal.style.pointerEvents = 'auto';
    }
  }

  function applySelection() {
    const grid = document.getElementById('ip-grid');
    if (!grid) return;
    const sel = grid.querySelector('.ip-icon.is-selected') || grid.querySelector('.ip-icon[aria-selected="true"]');
    if (!sel) return;
    const iconClass = normalizeIconClass(sel);

    const input = document.getElementById(state.inputId);
    if (input) input.value = iconClass;

    updatePreview(state.previewId, iconClass);

    // <<< ICI : on ferme + on RESTAURE la modale (fix du blocage après double-clic)
    closeSheetAndRestore();
  }

  // 1) Bouton "Catégorie"
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.cat-trigger');
    if (!btn) return;
    e.preventDefault();
    state.inputId = btn.getAttribute('data-target-input');
    state.previewId = btn.getAttribute('data-target-preview');
    if (!state.inputId || !state.previewId) {
      console.warn('[icon] data-target-* manquants');
      return;
    }
    openIconSheet();
  }, true);

  // 2) Grille : clic = sélectionner
  const grid = document.getElementById('ip-grid');
  if (grid) {
    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.ip-icon');
      if (!cell) return;
      selectCell(grid, cell);
      const ok = document.getElementById('ip-validate');
      if (ok) ok.disabled = false;
    });

      // ✅ 3) Double-clic = sélectionner + appliquer + RESTAURER MODALE
      grid.addEventListener('dblclick', (e) => {
        const cell = e.target.closest('.ip-icon');
        if (!cell) return;
        selectCell(grid, cell);
        applySelection(); // appelle closeSheetAndRestore()
      });

      // ✅ 4) Clavier : Enter/Espace = sélectionner + appliquer + RESTAURER
      grid.addEventListener('keydown', (e) => {
        const cell = e.target.closest('.ip-icon');
        if (!cell) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectCell(grid, cell);
          applySelection();
        }
      });
  }

  // 5) Boutons du sheet
  if (typeof window.__applyIconSelection !== 'function') {
    window.__applyIconSelection = applySelection;
  }
  // remplace (ou utilise) la fermeture qui RESTAURE la modale
  window.__closeIconSheet = closeSheetAndRestore;

  // 6) Ouverture modale d’édition -> refléter l’icône actuelle
  const prevOpen = window.openEditModal;
  window.openEditModal = function(id) {
    try { if (typeof prevOpen === 'function') prevOpen(id); } catch(e){ console.error(e); }
    const currentClass = document.getElementById('edit-category')?.value || '';
    updatePreview('edit-selected-category', currentClass);
  };
})();

// ===============================
//  ICON SHEET > MODALE — priorité d'affichage et clics
// ===============================
(() => {
  const SHEET_TOP = 2147483647; // tout en haut (même niveau que la modale forcée)

function openSheetOverModal() {
  const sheet = document.getElementById('icon-sheet');
  if (!sheet) return;
  const panel = sheet.querySelector('.sheet__panel');
  const modal = document.getElementById('modal-edit-transaction');

  // Mettre le sheet APRÈS la modale dans le DOM
  if (sheet.parentElement !== document.body) document.body.appendChild(sheet);

  // Ouvrir le sheet
  sheet.classList.add('is-open');
  sheet.setAttribute('aria-hidden', 'false');

  // Empiler au-dessus de la modale (mêmes valeurs mais sheet au-dessus)
  sheet.style.setProperty('z-index', String(SHEET_TOP), 'important');
  panel?.style.setProperty('z-index', String(SHEET_TOP), 'important');

  // Laisser passer les clics vers le sheet uniquement
  if (modal) {
    modal.style.setProperty('z-index', String(SHEET_TOP - 1), 'important');
    modal.style.pointerEvents = 'none';
    const content = modal.querySelector('.modal-content');
    content?.style.setProperty('z-index', String(SHEET_TOP - 1), 'important');
  }
}

function closeSheetRestore() {
  const sheet = document.getElementById('icon-sheet');
  const modal = document.getElementById('modal-edit-transaction');
  if (sheet) {
    sheet.classList.remove('is-open');
    sheet.setAttribute('aria-hidden', 'true');
  }
  if (modal) {
    // Restaure la modale “au-dessus” de l’overlay général
    modal.style.setProperty('z-index', String(SHEET_TOP), 'important');
    modal.style.pointerEvents = 'auto';
    const content = modal.querySelector('.modal-content');
    content?.style.setProperty('z-index', String(SHEET_TOP), 'important');
  }
}

// Ouvrir au-dessus quand on clique "Catégorie"
document.addEventListener('click', (e) => {
  if (e.target.closest('.cat-trigger')) {
    // Le sheet s’ouvre d’abord → on élève immédiatement après
    setTimeout(openSheetOverModal, 0);
  }
  // Fermer / valider / backdrop
  if (e.target.closest('#ip-validate, #ip-cancel, .sheet__close, .sheet__backdrop')) {
    setTimeout(closeSheetRestore, 0);
  }
}, true);

// Expose la fermeture si d'autres bouts de code l'appellent
window.__closeIconSheet = closeSheetRestore;
})();

// ======================================================
//  STATS — Plotly (unique) — périodes FR OK + libellés humains
// ======================================================
window.renderStats = function renderStatsPlotly(){
  const el = document.getElementById('pie-chart');
  if (!el || !window.Plotly) return;

  const CHART_W = 706;
  const CHART_H = 345;

  // --- Détecte sombre/clair via la VRAIE couleur de fond
  function getBgColor(node){
    let e = node;
    while (e && e !== document.documentElement){
      const c = getComputedStyle(e).backgroundColor;
      if (c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)') return c;
      e = e.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor || 'rgb(255,255,255)';
  }
  function rgbToLum(cstr){
    const m = cstr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    let r=255,g=255,b=255; if (m){ r=+m[1]; g=+m[2]; b=+m[3]; }
    const s=[r,g,b].map(v=>{ v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); });
    return 0.2126*s[0] + 0.7152*s[1] + 0.0722*s[2];
  }
  const isDark = rgbToLum(getBgColor(el)) < 0.5;

  // --- Couleurs
  const PALETTE_LIGHT = ['#2E86C1','#F39C12','#27AE60','#E74C3C','#8E44AD','#16A085','#F1C40F'];
  const PALETTE_DARK  = ['#1f77b4','#ff7f0e','#2ca02c','#d62728','#9467bd','#17becf','#bcbd22'];
  const GRID_BG       = 'rgba(0,0,0,0)';
  const SLICE_BORDER  = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.12)';
  const PLACEHOLDER   = isDark ? '#2b2f36' : '#e9ecef';
  const HOVER_BG      = isDark ? '#111827' : '#ffffff';
  const HOVER_BORDER  = isDark ? '#374151' : '#d1d5db';
  const HOVER_TEXT    = isDark ? '#e5e7eb' : '#111827';
  const TEXT          = isDark ? '#e6edf3' : '#1f2937'; // texte global
  const LEGEND_FILL   = isDark ? '#e6edf3' : '#324a52'; // **exigence**: sombre=#e6edf3, clair=#fff

  // --- Patch CSS légende (couleur + opacité) — réécrit à chaque rendu
  (function applyLegendFix(){
    const ID = 'stats-legend-fix';
    let s = document.getElementById(ID);
    if (!s) { s = document.createElement('style'); s.id = ID; document.head.appendChild(s); }
    s.textContent = `
    #pie-chart .legend,
    #pie-chart .legend g,
    #pie-chart .legend .groups,
    #pie-chart .legend .traces { opacity: 1 !important; }
    #pie-chart .legend text,
    #pie-chart .legend .legendtext,
    #pie-chart .legend .legendtoggle { fill: ${LEGEND_FILL} !important; opacity: 1 !important; }
    #pie-chart .hovertext text { fill: ${HOVER_TEXT} !important; }`;
  })();

  // --- Utils
  function normalizePeriod(val){
    const s = String(val||'').toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/\s+/g,'').replace(/-/g,'');
    if (['day','today','jour','aujourdhui','auj','cejour'].includes(s)) return 'day';
    if (['year','annee','anneeencours','currentyear','yearcurrent','ytd','yeartodate'].includes(s)) return 'year';
    return 'month';
  }
  function parseDateAny(raw){
    if (!raw) return null;
    const str = String(raw).trim();
    const m = str.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (m) return new Date(+m[3], +m[2]-1, +m[1]);
    const d = new Date(str);
    return isNaN(d) ? null : d;
  }
  const LABELS = {
    'fa-solid fa-bus': 'Transport',
    'fa-solid fa-cart-shopping': 'Courses',
    'fa-solid fa-basket-shopping': 'Courses',
    'fa-solid fa-gas-pump': 'Carburant',
    'fa-solid fa-briefcase': 'Salaire',
    'fa-solid fa-car': 'Voiture',
    'fa-solid fa-house': 'Logement',
    'fa-solid fa-utensils': 'Restaurant',
    'fa-solid fa-bolt': 'Énergie',
    'fa-solid fa-shield-heart': 'Santé',
  };
  const toHuman = (cat)=>{
    const s = String(cat||'').trim();
    if (LABELS[s]) return LABELS[s];
    const m = s.match(/fa-[a-z0-9-]+/gi);
    if (m && m.length) {
      const last = m[m.length-1].replace(/^fa-/,'').replace(/-/g,' ');
      return last.charAt(0).toUpperCase()+last.slice(1);
    }
    return s || 'Autre';
  };
  const fmtEUR = (n)=>Number(n||0).toLocaleString('fr-FR',{style:'currency',currency:'EUR'});
  function getTxs(){
    if (Array.isArray(window.transactions)) return window.transactions;
    try { const raw = localStorage.getItem('transactions'); return raw ? JSON.parse(raw) : []; } catch(_) { return []; }
  }
  function filterByPeriod(txs, periodRaw){
    const period = normalizePeriod(periodRaw);
    const now = new Date(), y=now.getFullYear(), m=now.getMonth(), d=now.getDate();
    return txs.filter(t=>{
      const dt = parseDateAny(t.date || t.day || t.createdAt);
      if (!dt) return false;
      if (period==='day')  return dt.getFullYear()===y && dt.getMonth()===m && dt.getDate()===d;
      if (period==='year') return dt.getFullYear()===y;
      return dt.getFullYear()===y && dt.getMonth()===m;
    });
  }

  // --- Données
  const periodRaw = document.getElementById('stats-period')?.value || 'month';
  const period = normalizePeriod(periodRaw);
  const txs = filterByPeriod(getTxs(), period);
  const expenses = txs.filter(t => String(t.type).toLowerCase()==='expense' || Number(t.amount) < 0);

  const by = new Map();
  for (const t of expenses){
    const k = toHuman(t.category);
    const v = Math.abs(Number(t.amount)||0);
    by.set(k, (by.get(k)||0)+v);
  }
  const labels = Array.from(by.keys());
  const values = Array.from(by.values());

  // --- Traces
  const data = !values.length ? [{
    type:'pie',
    labels:['Aucune donnée'],
    values:[1],
    textinfo:'none',
    hoverinfo:'none',
    marker:{ colors:[PLACEHOLDER] }
  }] : [{
    type:'pie',
    labels, values,
    textinfo:'label+percent',
    hovertemplate:'%{label}: %{value:,.2f} € (%{percent})<extra></extra>',
                         sort:false,
                         marker:{
                           colors: isDark ? PALETTE_DARK : PALETTE_LIGHT,
                           line:{ color: SLICE_BORDER, width:1 }
                         },
                         insidetextfont:{ color: isDark ? '#f9fafb' : '#ffffff' },
                         outsidetextfont:{ color: isDark ? '#eaeef3' : '#1f2937' }
  }];

  // --- Layout (espace bas pour éviter le chevauchement)
  const layoutCommon = {
    width: CHART_W, height: CHART_H,
    paper_bgcolor: GRID_BG, plot_bgcolor: GRID_BG,
    margin:{ l:0, r:0, t:0, b:60 },
    font:{ color: TEXT },
    hoverlabel:{ bgcolor:HOVER_BG, bordercolor:HOVER_BORDER, font:{ color:HOVER_TEXT }},
    legend:{ orientation:'h', y:-0.02, yanchor:'top', font:{ color: TEXT }, bgcolor: GRID_BG }
  };
  const layout = !values.length
  ? { ...layoutCommon, showlegend:false,
    annotations:[{ text:'Aucune dépense sur la période', font:{color:TEXT}, showarrow:false, y:0.5 }] }
    : { ...layoutCommon, showlegend:true };

    Plotly.react(el, data, layout, {
      responsive:false, displaylogo:false,
      modeBarButtonsToRemove:['lasso2d','select2d']
    });

    // --- Total
    const info = document.getElementById('stats-info');
    if (info){
      const total = values.reduce((a,b)=>a+b,0);
      const txtPer = period==='day' ? 'aujourd’hui' : period==='year' ? 'cette année' : 'ce mois';
      info.textContent = values.length
      ? `Total des dépenses ${txtPer} : ${fmtEUR(total)}`
      : `Aucune dépense ${txtPer}.`;
    }

    // === Re-rendu auto au changement de thème (sans reload) ===
    (function installThemeObserver(){
      if (window.__statsThemeObserver) return; // une seule fois
      const targets = [document.documentElement, document.body, el, el.parentElement].filter(Boolean);
      const obs = new MutationObserver(() => {
        clearTimeout(window.__statsThemeTick);
        window.__statsThemeTick = setTimeout(() => window.renderStats(), 60); // debounce
      });
      for (const t of targets){
        obs.observe(t, { attributes:true, attributeFilter:['class','style','data-theme'] });
      }
      // Écoute la préférence OS aussi (au cas où)
      try {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const fn = () => window.renderStats();
        if (mq.addEventListener) mq.addEventListener('change', fn);
        else if (mq.addListener) mq.addListener(fn);
        window.__statsThemeMQ = mq;
      } catch(_) {}
      window.__statsThemeObserver = obs;
    })();
};

// ===============================
//  "Reste à vivre" — bouton #calculate-saving
// ===============================
(function setupResteAVivre() {
  const $ = (s, ctx=document) => ctx.querySelector(s);

  // --- Versionning pour détecter des changements APRES calcul ---
  let txVersion = 0;        // incrémenté à chaque sauvegarde
  let lastCalcVersion = -1; // version au moment du dernier calcul
  let suppressChange = false; // ignore les changements internes (insertion salaire pendant le calcul)

function parseNum(v){
  const n = Number(String(v ?? '').replace(',', '.'));
  return isFinite(n) ? n : 0;
}
function sameMonth(a,b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth(); }
function euros(n){
  try { return n.toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2})+' €'; }
  catch(_) { return (Math.round(n*100)/100).toFixed(2)+' €'; }
}
function getAllTransactions(){
  try { if (Array.isArray(window.transactions)) return window.transactions; } catch(_){}
  try { if (Array.isArray(transactions)) return transactions; } catch(_){}
  return [];
}
function getCurrentRefMonth(){
  try { if (window.currentMonth instanceof Date && !isNaN(window.currentMonth)) return window.currentMonth; } catch(_){}
  try { if (currentMonth instanceof Date && !isNaN(currentMonth)) return currentMonth; } catch(_){}
  return new Date();
}
function parseIsoDate(iso){ const d = new Date(iso); return isNaN(d) ? null : d; }

// Lecture jj-mm-aaaa ou ISO
function getSalaryIsoDate(){
  if (typeof readDateInput === 'function'){
    const iso = readDateInput('salary-date');
    if (iso) return iso;
  }
  const raw = $('#salary-date')?.value?.trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(raw);
  return isNaN(d) ? null :
  `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function computeMonthFlows(){
  const ref = getCurrentRefMonth();
  let income = 0, expense = 0;
  for (const tx of getAllTransactions()){
    const d = parseIsoDate(tx?.date);
    if (!d || !sameMonth(d, ref)) continue;
    const amt = Math.abs(parseNum(tx?.amount));
    const type = String(tx?.type || '').toLowerCase();
    if (type === 'income') income += amt;
    else if (type === 'expense') expense += amt;
  }
  return { income, expense };
}

function hasSalaryTxInCurrentMonth(){
  const ref = getCurrentRefMonth();
  return getAllTransactions().some(t => t?.isSalary && (()=>{
    const d = parseIsoDate(t.date);
    return d && sameMonth(d, ref);
  })());
}

// Crée / met à jour la transaction Salaire (icône briefcase) PENDANT le calcul
// sans déclencher l'apparition de "Actualiser".
function maybeUpsertSalaryTransaction() {
  const amount = parseNum($('#salary')?.value);
  const iso = getSalaryIsoDate();
  if (!iso || amount <= 0) return false;

  const arr = getAllTransactions();
  let tx = arr.find(t => t?.isSalary === true && t?.date === iso);

  if (tx) {
    tx.amount = amount;
    tx.type = 'income';
    tx.category = 'fa-solid fa-briefcase';
    tx.description = 'Salaire';
    tx.recurrence = 'none';
    tx.applyPrev = false;
  } else {
    tx = {
      id: (crypto?.randomUUID ? crypto.randomUUID() : String(Date.now())),
 type: 'income',
 category: 'fa-solid fa-briefcase',
 description: 'Salaire',
 amount: amount,
 date: iso,
 recurrence: 'none',
 applyPrev: false,
 isSalary: true
    };
    arr.push(tx);
  }

  try {
    suppressChange = true; // ne pas compter cette sauvegarde pour "Actualiser"
    if (typeof saveTransactionsLocal === 'function') saveTransactionsLocal();
    if (typeof isDropboxConnected === 'function' && isDropboxConnected()
      && typeof saveTransactionsDropbox === 'function') saveTransactionsDropbox();
  } finally {
    suppressChange = false;
  }
  try { if (typeof updateViews === 'function') updateViews(); } catch(_){}
  return true;
}

// Bouton "Actualiser"
function showRefresh(show){
  const b = $('#refresh-after-salary');
  if (!b) return;
  b.style.display = show ? 'inline-block' : 'none';
}

// Rendu gelé (jusqu'à clic sur "Actualiser")
function renderResult({income, expense, savings, effectiveSalary}){
  const el = $('#saving-result');
  if (!el) return;
  const totalIncome = income + effectiveSalary;
  const reste = totalIncome - expense - savings;
  const color = reste < 0 ? '#b00020' : '#0a7d28';

  el.innerHTML =
  `<strong>Revenus</strong> : <span id="sr-income">${euros(totalIncome)}</span><br>` +
  `<strong>Dépenses</strong> : <span id="sr-expense">${euros(expense)}</span><br>` +
  `<strong>Épargne</strong> : <span id="sr-savings">${euros(savings)}</span><br>` +
  `<hr style="opacity:.3">` +
  `<strong>Reste à vivre :</strong> <span id="sr-reste" style="font-weight:700; color:${color}">${euros(reste)}</span>`;
}

function recalcAndRender({ignoreSalaryFieldIfTxExists=false} = {}){
  const savings = parseNum($('#savings')?.value);
  const salaryField = parseNum($('#salary')?.value);
  const { income, expense } = computeMonthFlows();
  const effectiveSalary = (ignoreSalaryFieldIfTxExists && hasSalaryTxInCurrentMonth()) ? 0 : salaryField;
  renderResult({ income, expense, savings, effectiveSalary });
}

// Patch: détecter un enregistrement de transactions APRES calcul, sans recalc auto
(function patchSaveFns(){
  try {
    const orig = typeof saveTransactionsLocal === 'function' ? saveTransactionsLocal : null;
    if (orig) {
      window.saveTransactionsLocal = function(...args){
        const r = orig.apply(this, args);
        txVersion++;
        if (!suppressChange && lastCalcVersion >= 0 && txVersion > lastCalcVersion) {
          showRefresh(true); // juste afficher le bouton, ne pas recalculer
        }
        return r;
      };
    }
  } catch(_){}
  try {
    const origDbx = typeof saveTransactionsDropbox === 'function' ? saveTransactionsDropbox : null;
    if (origDbx) {
      window.saveTransactionsDropbox = function(...args){
        const r = origDbx.apply(this, args);
        txVersion++;
        if (!suppressChange && lastCalcVersion >= 0 && txVersion > lastCalcVersion) {
          showRefresh(true); // idem côté Dropbox
        }
        return r;
      };
    }
  } catch(_){}
})();

// Clic "Calculer le reste à vivre"
$('#calculate-saving')?.addEventListener('click', (e) => {
  e.preventDefault();

  // Met à jour / crée le Salaire (sans déclencher le bouton)
  maybeUpsertSalaryTransaction();

  // Calcul instantané (état gelé après)
  recalcAndRender({ ignoreSalaryFieldIfTxExists: true });

  // À partir de maintenant, toute nouvelle sauvegarde affichera "Actualiser"
  lastCalcVersion = txVersion;
  showRefresh(false);
});

// Clic "Actualiser" -> on recharge la vue + on recalcule
$('#refresh-after-salary')?.addEventListener('click', () => {
  try { if (typeof updateViews === 'function') updateViews(); else location.reload(); }
  catch(_){ location.reload(); }
  recalcAndRender({ ignoreSalaryFieldIfTxExists: true });
  lastCalcVersion = txVersion; // on repart de cet état comme baseline
  showRefresh(false);
});

// Option console
window.calculateResteAVivre = () => recalcAndRender({ ignoreSalaryFieldIfTxExists: true });
})();
