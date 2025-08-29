// script.js (shim) — charge le vrai point d'entrée modulaire
import './src/js/index.js';

// Lightweight served-version marker to help detect caching in the browser console
try{ console.log('[SCRIPT] loaded script.js — build ts:', new Date().toISOString()); }catch(e){}

// Pour compatibilité, les autres scripts peuvent toujours s'appuyer sur globales exposées par index.js
// --- PATCH A: sécurité pour openIconPicker (existe partout, ne plante jamais)

// Ensure a global currentMonth exists early: some UI code calls renderCalendar() on load
// before the in-module `let currentMonth` is created. Use window.currentMonth to avoid TDZ.
if (typeof window.currentMonth === 'undefined' || !(window.currentMonth instanceof Date)) {
  window.currentMonth = new Date();
  window.currentMonth.setDate(1);
}

// Hoist calendar color defaults to avoid TDZ when some setup code runs early
var DEFAULT_CAL_COLORS_LIGHT = null;
var DEFAULT_CAL_COLORS_DARK  = null;

// Selected date used by the finance calendar; ensure it's defined early
var selectedDate = null;
// Selected transaction id in day details (hoisted to avoid assignment to undeclared variable)
var selectedTxId = null;
// Month sort mode for the month summary view
var monthSortMode = 'date-asc';

// Provide a top-level helper for File System Access support so early calls don't fail
function isFsaSupported() {
  return typeof window.showDirectoryPicker === 'function';
}

// Ensure token globals exist so early UI helpers won't throw if checked before modules set them
window.accessToken = window.accessToken || null;
window.googleAccessToken = window.googleAccessToken || null;
window.msAccessToken = window.msAccessToken || null;

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
  // Récupère l'identifiant client configuré
  const clientId = getDropboxClientId();
  if (!clientId) {
    alert("Veuillez configurer votre identifiant client Dropbox dans le menu profil (icône engrenage) avant de vous connecter.");
    return;
  }
  const redirectUri = window.location.origin + window.location.pathname;
  const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}`;
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

  const clientId = getDropboxClientId();
  if (!clientId) {
    // Indique qu'aucune configuration n'est définie
    status.textContent = "Non configuré";
    status.style.color = "#d32f2f";
    // On masque les boutons de connexion tant que l'App ID n'est pas renseigné
    loginBtn.style.display = "none";
    logoutBtn.style.display = "none";
  } else if (isDropboxConnected()) {
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
    const response = await dbx.filesDownload({path: getCloudFilePath()});
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
      path: getCloudFilePath(),
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
  const clientId = getGoogleClientId();
  if (!clientId) {
    alert("Veuillez configurer votre identifiant client Google Drive dans le menu profil (icône engrenage) avant de vous connecter.");
    return;
  }
  const redirectUri = window.location.origin + window.location.pathname;
  sessionStorage.setItem('oauth_service', 'google');
  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}` +
    `&response_type=token` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.file')}` +
    `&include_granted_scopes=true` +
    `&state=google`;
  window.location.href = authUrl;
}
function loginMS() {
  const clientId = getMSClientId();
  if (!clientId) {
    alert("Veuillez configurer votre identifiant client Microsoft/OneDrive dans le menu profil (icône engrenage) avant de vous connecter.");
    return;
  }
  const redirectUri = window.location.origin + window.location.pathname;
  sessionStorage.setItem('oauth_service', 'ms');
  const authUrl =
    `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${encodeURIComponent(clientId)}` +
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
  const clientId = getGoogleClientId();
  if (!clientId) {
    status.textContent = "Non configuré";
    status.style.color = "#d32f2f";
    loginBtn.style.display = "none";
    logoutBtn.style.display = "none";
  } else if (isGoogleConnected()) {
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
  const clientId = getMSClientId();
  if (!clientId) {
    status.textContent = "Non configuré";
    status.style.color = "#d32f2f";
    loginBtn.style.display = "none";
    logoutBtn.style.display = "none";
  } else if (isMSConnected()) {
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

// ===== Configurateurs des identifiants client pour les services cloud =====
function configureDropboxClient() {
  const current = getDropboxClientId();
  const id = prompt("Veuillez saisir votre identifiant client Dropbox (App key) :", current || "");
  if (id === null) return;
  const trimmed = id.trim();
  if (trimmed) {
    setDropboxClientId(trimmed);
    alert('Identifiant Dropbox enregistré. Vous pouvez maintenant vous connecter.');
  }
  updateDropboxStatus();
}
function configureGoogleClient() {
  const current = getGoogleClientId();
  const id = prompt("Veuillez saisir votre identifiant client Google Drive :", current || "");
  if (id === null) return;
  const trimmed = id.trim();
  if (trimmed) {
    setGoogleClientId(trimmed);
    alert('Identifiant Google Drive enregistré. Vous pouvez maintenant vous connecter.');
  }
  updateGoogleStatus();
}
function configureMSClient() {
  const current = getMSClientId();
  const id = prompt("Veuillez saisir votre identifiant client Microsoft/OneDrive :", current || "");
  if (id === null) return;
  const trimmed = id.trim();
  if (trimmed) {
    setMSClientId(trimmed);
    alert('Identifiant OneDrive enregistré. Vous pouvez maintenant vous connecter.');
  }
  updateMSStatus();
}

// --- Stockage simple des identifiants clients (localStorage)
function getDropboxClientId() {
  return localStorage.getItem('dropbox_client_id') || null;
}
function setDropboxClientId(id) {
  if (id === null || id === undefined) localStorage.removeItem('dropbox_client_id');
  else localStorage.setItem('dropbox_client_id', String(id));
}

function getGoogleClientId() {
  return localStorage.getItem('google_client_id') || null;
}
function setGoogleClientId(id) {
  if (id === null || id === undefined) localStorage.removeItem('google_client_id');
  else localStorage.setItem('google_client_id', String(id));
}

function getMSClientId() {
  return localStorage.getItem('ms_client_id') || null;
}
function setMSClientId(id) {
  if (id === null || id === undefined) localStorage.removeItem('ms_client_id');
  else localStorage.setItem('ms_client_id', String(id));
}

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
  const start = parseDate(startIso);
  const end   = parseDate(endIso);

  // ✅ Pas de variable globale : on lit la source ici
  const src = getUnifiedTransactions(); // toujours un tableau (hotfix en haut)

  const out = [];
  // Itère jour par jour entre start et end (inclus)
  for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const dayIso = formatDate(cursor);
    for (const tx of src) {
      if (occursOnDate(tx, dayIso)) {
        out.push({ ...tx, date: dayIso, __instance: true });
      }
    }
  }
  return out;
}

// --- Calendrier : rendu + écouteurs (click + double-click propre)
function renderCalendar() {
  const table = document.getElementById('calendar');
  const details = document.getElementById('day-details');
  const monthTitle = document.getElementById('current-month');
  if (!table || !details || !monthTitle) return;

  const TXS = getUnifiedTransactions();
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  const todayIso = formatDate(new Date());
  if (!selectedDate) selectedDate = todayIso;

  const label = currentMonth.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  monthTitle.textContent = label.charAt(0).toUpperCase() + label.slice(1);

  const firstDay = new Date(year, month, 1);
  let startDay = firstDay.getDay(); if (startDay === 0) startDay = 7; // lundi=1
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const holidays = window.__HOLIDAYS__ || {};

  // --- grille
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
        const isWeekend = col >= 6;
        const isHoliday = holidays[dStr] !== undefined;
        const isToday = dStr === todayIso;

        let cls = '';
        if (isWeekend) cls += ' calendar-weekend';
        if (isHoliday) cls += ' calendar-holiday';
        if (isToday) cls += ' calendar-today';
        if (selectedDate === dStr) cls += ' selected';

        const dayTx = TXS.filter(t => occursOnDate(t, dStr));

        html += `<td class="${cls.trim()}" data-date="${dStr}">
          <div class="day-number">${day}</div>
          ${dayTx.map(t => `<span class="event-dot" title="${t.description || ''}">${renderCategoryIconInline(t.category)}</span>`).join('')}
        </td>`;
        day++;
      }
    }
    html += '</tr>';
  }
  html += '</tbody>';
  table.innerHTML = html;

  // --- détails (zone droite)
  function renderDayDetails(dateIso){
    const selDateObj = parseDate(dateIso);
    const selDayTx = TXS.filter(t => occursOnDate(t, dateIso));
    details.innerHTML = `
      <strong>${selDateObj.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</strong>
      <div id="day-tx-list" class="day-tx-list">
        ${selDayTx.length === 0 ? '<div class="empty">Aucune transaction ce jour.</div>' : selDayTx.map((t) => `
          <div class="tx-line" data-tx-id="${t.id || ''}">
            <span class="tx-cat">${renderCategoryIconInline(t.category)}</span>
            <span class="tx-desc">${t.description || ''}</span>
            <span class="tx-amt ${Number(t.amount) < 0 ? 'neg' : 'pos'}">${formatAmount(t.amount)}</span>
          </div>
        `).join('')}
      </div>
      <div style="margin-top:.5rem; display:flex; gap:.5rem; flex-wrap:wrap;">
        <button id="open-quick-add" style="background:#27524b;color:#fff;border:none;border-radius:6px;padding:.4em .8em;cursor:pointer;">Ajouter une transaction</button>
        ${selDayTx.length ? `<button id="open-edit-menu" style="background:#324a52;color:#fff;border:none;border-radius:6px;padding:.4em .8em;cursor:pointer;">Modifier une transaction</button>` : ''}
      </div>
      <div id="edit-picker" style="display:none;"></div>
    `;

    // sélection visuelle dans la liste
    selectedTxId = null;
    const listEl = details.querySelector('#day-tx-list');
    const firstLine = listEl?.querySelector('.tx-line');
    if (firstLine) { firstLine.classList.add('is-selected'); selectedTxId = firstLine.dataset.txId; }
    listEl?.querySelectorAll('.tx-line')?.forEach(n =>
      n.addEventListener('click', () => {
        selectedTxId = n.dataset.txId || null;
        listEl.querySelectorAll('.tx-line').forEach(m => (m.style.background = ''));
        n.style.background = 'rgba(39, 82, 75, 0.1)';
      })
    );

    // Bouton Ajouter
    const btnAdd = document.getElementById('open-quick-add');
    if (btnAdd) btnAdd.onclick = () => openQuickAddForDate(dateIso);

  // Bouton "Modifier" -> modale de choix (délégué, persistant)
  details.addEventListener('click', function onEditClick(e){
    const b = e.target.closest('#open-edit-menu');
    if (!b) return;
    e.preventDefault();
    openEditChoiceForDate(selectedDate);
  });

    function showEditPicker(list) {
      const host = document.getElementById('edit-picker');
      if (!host) return;
      host.style.display = 'block';
      host.innerHTML = `
        <div style="margin-top:.5rem;padding:.6rem;border:1px solid var(--color-primary,#65b8f7);border-radius:8px;background:var(--color-surface,#fff);box-shadow:0 2px 8px rgba(0,0,0,.08);max-width:520px;">
          <div style="font-weight:600;margin-bottom:.4rem;">Quelle transaction modifier ?</div>
          <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;">
            <select id="ep-select" style="flex:1 1 260px;padding:.35rem;border:1px solid #9fb9c6;border-radius:6px;">
              ${list.map(t => `
                <option value="${t.id}">
                  ${formatAmount(t.amount)} — ${ (t.description||'').toString().slice(0,60) }
                </option>
              `).join('')}
            </select>
            <button id="ep-edit"   style="background:#324a52;color:#fff;border:none;border-radius:6px;padding:.4em .8em;cursor:pointer;">Éditer</button>
            <button id="ep-cancel" style="background:#888;color:#fff;border:none;border-radius:6px;padding:.4em .8em;cursor:pointer;">Annuler</button>
          </div>
        </div>
      `;
      const sel = host.querySelector('#ep-select');
      host.querySelector('#ep-edit')  .onclick = () => { tryOpenEdit(sel?.value); host.style.display='none'; };
      host.querySelector('#ep-cancel').onclick = () => { host.style.display='none'; };
    }
  }

  // initial : détails du jour courant
  renderDayDetails(selectedDate);

  // --- Gestion clic vs double-clic (anti-conflit)
  let clickTimer = null;

  table.addEventListener('click', (e) => {
    const td = e.target.closest('td[data-date]');
    if (!td) return;
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      selectedDate = td.getAttribute('data-date');
      table.querySelectorAll('td.selected').forEach(n => n.classList.remove('selected'));
      td.classList.add('selected');
      renderDayDetails(selectedDate);
      clickTimer = null;
    }, 220);
  });

  table.addEventListener('dblclick', (e) => {
    const td = e.target.closest('td[data-date]');
    if (!td) return;
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    selectedDate = td.getAttribute('data-date');
    openQuickAddForDate(selectedDate);
  });
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
  // Fallback par défaut : point d’interrogation FA (pas de Material Icons)
  const FALLBACK = `<i class="fa-regular fa-circle-question" aria-hidden="true"></i>`;
  if (!val) return FALLBACK;

  // Ancien format set::name
  if (val.includes('::')) {
    const [set, name] = val.split('::');
    if (set === 'fa') return `<i class="${name}" aria-hidden="true"></i>`;
    if (set === 'bs') return `<i class="bi ${name}" aria-hidden="true"></i>`;
    // on ne rend plus "mi" (Material Icons) pour éviter du texte brut
    return FALLBACK;
  }

  // Nouvelles classes directes
  if (/\bfa-/.test(val)) {
    // Ensure a Font Awesome style prefix exists (fa-solid, fa-regular, etc.).
    // Some stored values only contain the icon name (e.g. "fa-basket-shopping").
    // In that case prepend the default weight so icons render consistently.
    let cls = String(val).trim();
    if (!/\bfa-(solid|regular|light|thin|duotone|brands)\b/i.test(cls)) {
      cls = `fa-solid ${cls}`;
    }
    return `<i class="${cls}" aria-hidden="true"></i>`;
  }
  if (/^bi\b/.test(val) || /\bbi-/.test(val)) {                                      // Bootstrap Icons
    const cls = val.startsWith('bi ') ? val : (val.startsWith('bi-') ? `bi ${val}` : val);
    return `<i class="${cls}" aria-hidden="true"></i>`;
  }

  // Si c'est un symbole isolé ou un nom inconnu -> fallback FA
  if (!/^[a-z][a-z0-9_-]{2,}$/i.test(val)) return FALLBACK;

  // Par sécurité, on évite d’afficher du texte brut => fallback
  return FALLBACK;
}

// ===============================
//  Historique — rendu avec data-id + clic crayon câblé directement
// ===============================
function renderTransactionList() {
  const ul = document.getElementById('transactions-list');
  if (!ul) return;

  // ---- Où trouver les transactions ? (PRIORITÉ: transactions -> window.transactions -> autres)
  function getTxs() {
    try { if (Array.isArray(transactions) && transactions.length) return transactions; } catch(_) {}
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

    // Bouton Éditer
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

    // Bouton Supprimer
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

      try {
        if (Array.isArray(transactions)) {
          const i = transactions.findIndex(t => String(t.id || t._id || t.uuid) === String(id));
          if (i >= 0) transactions.splice(i, 1);
          // reflète vers window + stockage
          window.transactions = transactions;
          localStorage.setItem('transactions', JSON.stringify(transactions));
        } else if (Array.isArray(window.transactions)) {
          const i = window.transactions.findIndex(t => String(t.id || t._id || t.uuid) === String(id));
          if (i >= 0) window.transactions.splice(i, 1);
          localStorage.setItem('transactions', JSON.stringify(window.transactions));
        }
      } catch(_) {}

      renderTransactionList();
      document.dispatchEvent(new Event('transactions:changed'));
      if (typeof updateViews === 'function') updateViews();
    }, false);

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

let statsCanvas = document.getElementById('stats-canvas');

// Si l'élément existe mais n'est pas un vrai <canvas>, on le remplace.
if (!(statsCanvas instanceof HTMLCanvasElement)) {
  const replacement = document.createElement('canvas');
  replacement.id = 'stats-canvas';

  if (statsCanvas && statsCanvas.parentNode) {
    statsCanvas.parentNode.replaceChild(replacement, statsCanvas);
  } else {
    // fallback si pas de parent connu : on l'ajoute au container #pie-chart si présent
    // cela évite que le canvas prenne la largeur totale du body (ex: 1920px)
    const preferredContainer = document.getElementById('pie-chart') || document.getElementById('stats-section') || document.body;
    // Ensure canvas scales with the container
    replacement.style.width = '100%';
    // let Chart.js compute the pixel backing store based on devicePixelRatio
    preferredContainer.appendChild(replacement);
  }
  statsCanvas = replacement;
}

const ctx = statsCanvas.getContext('2d');
if (!ctx) return;
  const canvasEl = statsCanvas; // on utilise le <canvas id="stats-canvas">
  const info = document.getElementById('stats-info');
  if (!canvasEl || !info) return;


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
  pieChart = new Chart(canvasEl.getContext('2d'), {
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
  const category = document.getElementById('category').value || (typeof DEFAULT_CATEGORY !== 'undefined' ? DEFAULT_CATEGORY : 'autre');
  const description = document.getElementById('description').value.trim();
  const amount = Number(document.getElementById('amount').value);
  const dateISO = (typeof readDateInput === 'function') ? readDateInput('date') : (document.getElementById('date').value || '').trim();

  const recurrence = document.getElementById('recurrence')?.value || 'none';
  const untilISO = (typeof readDateInput === 'function') ? readDateInput('recurrence-end') : (document.getElementById('recurrence-end')?.value || '').trim();
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

  // ✅ Source unique : on pousse dans "transactions"
  if (!Array.isArray(transactions)) transactions = [];
  transactions.push(tx);

  // ✅ Reflect: garde window.transactions pointant sur le même tableau
  window.transactions = transactions;

  // ✅ Persistance (respecte tes modes si dispo)
  try {
    if (typeof persistTransactions === 'function') {
      await persistTransactions();
    } else if (window.__folderDirHandle && typeof saveTransactionsFolder === 'function') {
      await saveTransactionsFolder();
    } else if (typeof isDropboxConnected === 'function' && isDropboxConnected() && typeof saveTransactionsDropbox === 'function') {
      await saveTransactionsDropbox();
    } else if (typeof saveTransactionsLocal === 'function') {
      saveTransactionsLocal();
    } else {
      localStorage.setItem('transactions', JSON.stringify(transactions));
    }
  } catch (e) {
    console.warn('[persist] échec principal → copie locale', e);
    try { localStorage.setItem('transactions', JSON.stringify(transactions)); } catch(_) {}
  }

  // ✅ Rafraîchit l’UI (calendrier + historique + stats + récap)
  if (typeof updateViews === 'function') updateViews();

  // Reset du formulaire + lignes conditionnelles
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
document.getElementById('add-transaction-form')?.addEventListener('submit', async function(e){
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
    id: (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
    type, category, description, amount,
    date: dateISO,
    recurrence: recurrence || 'none',
    applyPrev: applyPrev || false
  };
  if (untilDateISO) baseTx.until = untilDateISO;
  if (baseTx.recurrence === 'installments' && installments >= 2) {
    baseTx.installments = installments;
  }

  // ✅ Source unique
  if (!Array.isArray(transactions)) transactions = [];
  transactions.push(baseTx);

  // ✅ Reflect
  window.transactions = transactions;

  // ✅ Persistance (mêmes priorités)
  try {
    if (typeof persistTransactions === 'function') {
      await persistTransactions();
    } else if (window.__folderDirHandle && typeof saveTransactionsFolder === 'function') {
      await saveTransactionsFolder();
    } else if (typeof isDropboxConnected === 'function' && isDropboxConnected() && typeof saveTransactionsDropbox === 'function') {
      await saveTransactionsDropbox();
    } else if (typeof saveTransactionsLocal === 'function') {
      saveTransactionsLocal();
    } else {
      localStorage.setItem('transactions', JSON.stringify(transactions));
    }
  } catch (e) {
    console.warn('[persist] échec principal → copie locale', e);
    try { localStorage.setItem('transactions', JSON.stringify(transactions)); } catch(_) {}
  }

  if (typeof updateViews === 'function') updateViews();
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

/* ====== Import ====== */
(() => {
  const importBtn   = document.getElementById('import-json');
  const importInput = document.getElementById('import-json-file');

  importBtn?.addEventListener('click', () => importInput?.click());

  importInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const txt = await file.text();
      let data = JSON.parse(txt);

      // Autorise { transactions: [...] } ou directement [...]
      if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.transactions)) {
        data = data.transactions;
      }
      if (!Array.isArray(data)) throw new Error('Le fichier ne contient pas une liste de transactions.');

      // Normalisation + validation
      const allowedRec = new Set(['none','monthly','yearly','installments']);
      const norm = [];
      for (const raw of data) {
        if (!raw) continue;

        const t = {};
        t.id = String(raw.id ?? '');
        if (!t.id) {
          t.id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + Math.random().toString(16).slice(2));
        }
        t.type = raw.type === 'income' ? 'income' : 'expense';
        t.category = String(raw.category ?? '').trim() || 'autre';
        t.description = String(raw.description ?? '').trim() || '(sans libellé)';

        const amt = Number(raw.amount);
        if (!isFinite(amt)) continue;
        t.amount = Math.round(amt * 100) / 100;

        const iso = normalizeToISO(String(raw.date ?? '').trim());
        if (!iso) continue;
        t.date = iso;

        const rec = String(raw.recurrence ?? 'none').toLowerCase();
        t.recurrence = allowedRec.has(rec) ? rec : 'none';

        if (t.recurrence === 'installments') {
          const n = Number(raw.installments || 0);
          if (n >= 2) t.installments = n;
        }
        if (raw.until) {
          const uiso = normalizeToISO(String(raw.until));
          if (uiso) t.until = uiso;
        }
        if (typeof raw.applyPrev === 'boolean') t.applyPrev = !!raw.applyPrev;

        norm.push(t);
      }

      if (!norm.length) throw new Error('Aucune transaction valide trouvée dans ce fichier.');

      // Fusion ou remplacement
      const existing = Array.isArray(transactions) ? transactions : [];
      let newList;
      if (existing.length) {
        const doMerge = confirm(
          `Importer ${norm.length} transaction(s).\n\n` +
          `OK = fusionner (déduplication automatique)\n` +
          `Annuler = remplacer entièrement (écraser mes ${existing.length} transaction(s))`
        );
        newList = doMerge ? mergeTransactions(existing, norm) : norm;
      } else {
        newList = norm;
      }

      // Application + persistance
      transactions = newList;
      window.transactions = transactions;
      try { await persistTransactions(); } catch { saveTransactionsLocal(); }

      // Rafraîchissement UI
      window.dispatchEvent(new Event('transactions-updated'));
      if (typeof updateViews === 'function') updateViews();

      alert(`Import terminé : ${transactions.length} transaction(s) au total.`);
    } catch (err) {
      console.error('Import JSON — erreur :', err);
      alert(`Échec de l’import : ${err.message || err}`);
    } finally {
      if (importInput) importInput.value = ''; // réarme le <input>
    }
  });

  // Helpers
  function normalizeToISO(s) {
    // Accepte 'YYYY-MM-DD' / 'DD-MM-YYYY' / 'YYYY/MM/DD' / 'DD.MM.YYYY'
    const clean = s.replace(/[./]/g, '-');
    const m1 = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m1) {
      const [_, y, m, d] = m1.map(Number);
      const dt = new Date(y, m - 1, d);
      if (!isNaN(dt)) return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
      return null;
    }
    const m2 = clean.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (m2) {
      const d = Number(m2[1]), m = Number(m2[2]), y = Number(m2[3]);
      const dt = new Date(y, m - 1, d);
      if (!isNaN(dt)) return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
    }
    return null;
  }

  function mergeTransactions(existing, imported) {
    const byId = new Map();
    for (const t of existing) if (t && t.id) byId.set(String(t.id), t);

    const key = t => `${t.date}|${t.type}|${t.description}|${t.amount}|${t.category}`;
    const set2 = new Map(existing.map(t => [key(t), t]));

    for (const it of imported) {
      if (it.id && byId.has(String(it.id))) {
        byId.set(String(it.id), it); // remplace par la version importée
        continue;
      }
      const k = key(it);
      if (!set2.has(k)) set2.set(k, it);
    }

    const merged = (byId.size ? Array.from(byId.values()) : Array.from(set2.values()));
    merged.sort((a,b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.description||'').localeCompare(b.description||'')));
    return merged;
  }
})();

function updateViews() {
  // 🔒 Garde-fou de synchronisation des données
  try {
    // 1) Si "transactions" est vide, on essaie d'abord window.transactions, sinon localStorage
    if (!Array.isArray(transactions) || transactions.length === 0) {
      if (Array.isArray(window.transactions) && window.transactions.length) {
        transactions = window.transactions;               // ← même référence que l'historique
      } else {
        const raw = localStorage.getItem('transactions'); // ← fallback démarrage
        const arr = raw ? JSON.parse(raw) : [];
        window.transactions = arr;
        transactions = arr;                               // ← aligne le calendrier
      }
    } else {
      // 2) Si "transactions" a des données, on reflète vers window.transactions pour l'historique
      if (!Array.isArray(window.transactions) || window.transactions !== transactions) {
        window.transactions = transactions;
      }
    }
  } catch (_) {
    // sécurité absolue
    if (!Array.isArray(transactions)) transactions = [];
    window.transactions = transactions;
  }

  // 🔁 Rendus
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
// Legacy-free: ne crée plus le vieux bouton thème et ne log rien
function ensureEssentialDom() {
  // On vérifie juste que les éléments essentiels existent, sans rien injecter
  // (exclut volontairement 'theme-toggle' qui est désormais remplacé)
  const need = ['current-month','calendar','day-details','month-tx-list','prev-month','next-month','go-today'];
  const missing = need.filter(id => !document.getElementById(id));
  if (!missing.length) return;
  // Pas d’injection ni de console.warn : ton HTML les fournit déjà dans index.html
}

    // …dans ton init:
ensureEssentialDom();
// Supprime l'ancien bouton thème (fallback) s'il a été injecté
const legacy = document.getElementById('theme-toggle');
if (legacy) legacy.remove();

(async () => {
  let loaded = false;

  try {
    // 1) On tente de restaurer le dossier choisi (si permission toujours OK)
    if (await restoreFolderHandles()) {
      await loadTransactionsFolder(); // (inner) remplit window.transactions
      loaded = true;
    }

    // 2) Sinon Dropbox si dispo et connecté
    if (!loaded && typeof isDropboxConnected === 'function' && isDropboxConnected() && typeof loadTransactionsDropbox === 'function') {
      await loadTransactionsDropbox(); // (outer) peut remplir transactions
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

  // 🔗 SYNC DE RÉFÉRENCE (critique pour le calendrier)
  // - Si window.transactions existe => on pointe transactions dessus.
  // - Sinon, si transactions existe => on reflète dans window.transactions.
  // - Sinon, on crée un tableau partagé vide.
  if (Array.isArray(window.transactions)) {
    transactions = window.transactions;
  } else if (Array.isArray(transactions)) {
    window.transactions = transactions;
  } else {
    transactions = window.transactions = [];
  }

  // Rafraîchit TOUT (calendrier + historique + stats + récap)
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

  }); // fin setupAuthentication(...)
});   // fin document.addEventListener('DOMContentLoaded', ...)

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

// Configuration des clés clientes (icône engrenage)
document.getElementById('dropbox-config')?.addEventListener('click', configureDropboxClient);
document.getElementById('google-config') ?.addEventListener('click', configureGoogleClient);
document.getElementById('ms-config')     ?.addEventListener('click', configureMSClient);

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

    // Navigation multi-modules (mémoire + hash + hooks init/destroy)
(() => {
  // Éléments UI publiés sur window (utiles ailleurs)
  window.APP_BTNS = Array.from(document.querySelectorAll('.app-btn'));
  window.SECTIONS = Array.from(document.querySelectorAll('.app-section'));
  window.ALLOWED  = new Set(window.APP_BTNS.map(b => b.dataset.app));

  // Registre des hooks par application
  const APP_HOOKS = Object.create(null);
  const initializedApps = new Set();
  window.registerApp = function(name, hooks) {
  try{ console.log('[APP] registerApp', name); } catch(e){}
    APP_HOOKS[name] = {
      init:    (hooks && typeof hooks.init    === 'function') ? hooks.init    : () => {},
      destroy: (hooks && typeof hooks.destroy === 'function') ? hooks.destroy : () => {}
    };
    // If the section is already visible (page loaded with this app open), initialize it now
    try{
      const el = document.getElementById('app-' + name);
      const isVisibleNow = el && window.getComputedStyle(el).display !== 'none';
      const btn = document.querySelector(`.app-btn[data-app="${name}"]`);
      const btnActive = btn && btn.classList.contains('active');
      const saved = (()=>{ try{ return localStorage.getItem('app:last') || (location.hash||'').replace(/^#/,''); }catch(e){return null;} })();
      const shouldInit = (!initializedApps.has(name)) && (isVisibleNow || btnActive || saved === name || (location.hash||'').replace(/^#/,'') === name);
      if (shouldInit) {
        try { console.log('[APP] init-on-register', name); APP_HOOKS[name].init(el || document.getElementById('app-'+name)); initializedApps.add(name); currentApp = name; } catch(e){ console.warn(e); }
      }
    }catch(e){}

    // If the app registered late but should be the active app, ensure activation path runs
    try{
      const saved2 = (()=>{ try{ return localStorage.getItem('app:last') || (location.hash||'').replace(/^#/,''); }catch(e){return null;} })();
      const activeBtn = document.querySelector('.app-btn.active')?.dataset.app;
      const want = saved2 || activeBtn || (window.APP_BTNS && window.APP_BTNS[0] && window.APP_BTNS[0].dataset.app);
      if (want === name && typeof activateApp === 'function' && !initializedApps.has(name)) {
        try { console.log('[APP] registerApp -> activateApp', name); activateApp(name); } catch(e){}
      }
    }catch(e){}
  };

  let currentApp = null;

  function activateApp(app) {
  try{ console.log('[APP] activateApp start', app, { currentApp }); } catch(e){}
    if (!window.ALLOWED.has(app)) app = window.APP_BTNS[0]?.dataset.app || 'finance';

    // 1) Débranche l’ancienne app
    if (currentApp && currentApp !== app) {
      try { APP_HOOKS[currentApp]?.destroy(); } catch (e) { console.warn(e); }
    }

    // 2) UI: boutons + sections
    window.APP_BTNS.forEach(b => b.classList.toggle('active', b.dataset.app === app));
    window.SECTIONS.forEach(sec => { sec.style.display = 'none'; });
    const target = document.getElementById(`app-${app}`);
    if (target) target.style.display = 'block';

    // 3) Persistance + hash
    try { localStorage.setItem('app:last', app); } catch {}
    try { history.replaceState(null, '', '#' + app); } catch { location.hash = app; }

    // 4) Init de la nouvelle app
    if (currentApp !== app) {
      try {
        if (!initializedApps.has(app)) {
          try{ console.log('[APP] init-on-activate', app); } catch(e){}
          // Only attempt to init if we have hooks registered
          if (APP_HOOKS[app] && typeof APP_HOOKS[app].init === 'function') {
            try {
              APP_HOOKS[app].init(document.getElementById(`app-${app}`));
              initializedApps.add(app);
            } catch(initErr) {
              console.error('[APP] init error for', app, initErr);
            }
          } else {
            try { console.log('[APP] no init available yet for', app); } catch(e){}
          }
        }
      } catch (e) { console.warn(e); }
      currentApp = app;
    }
    try{ console.log('[APP] activateApp end', app, { currentApp, initializedApps: Array.from(initializedApps) }); } catch(e){}
  }
  window.activateApp = activateApp;

  // Expose for runtime debugging in the console
  try { window.__APP_HOOKS = APP_HOOKS; window.__initializedApps = initializedApps; } catch(e){}

  // Clics barre d’applis
  window.APP_BTNS.forEach(btn =>
    btn.addEventListener('click', () => activateApp(btn.dataset.app))
  );

  // Choix initial: hash > localStorage > premier bouton
  const rawHash = (location.hash || '').replace(/^#/, '');
  const fromHash = rawHash.startsWith('app=') ? rawHash.slice(4) : rawHash;
  let start = window.ALLOWED.has(fromHash) ? fromHash : null;
  if (!start) {
    try { const saved = localStorage.getItem('app:last'); if (window.ALLOWED.has(saved)) start = saved; } catch {}
  }
  if (!start) start = window.APP_BTNS[0]?.dataset.app || 'finance';

  // Lancement
  activateApp(start);
})(); // <-- fermeture correcte de l’IIFE

// Safety: if some apps register after the IIFE runs, ensure the start app is initialized once DOM is ready
document.addEventListener('DOMContentLoaded', function(){
  try{
    const saved = localStorage.getItem('app:last') || (location.hash||'').replace(/^#/,'');
    const desired = (saved && window.ALLOWED && window.ALLOWED.has(saved)) ? saved : null;
    const toCheck = desired || window.APP_BTNS?.[0]?.dataset.app;
    if (toCheck && !window.__initializedAppsChecked) {
      // activateApp will init if not yet initialized
      if (typeof activateApp === 'function') activateApp(toCheck);
      window.__initializedAppsChecked = true;
    }
  }catch(e){}
});

      // Clics barre d’applis
      APP_BTNS.forEach(btn => btn.addEventListener('click', () => activateApp(btn.dataset.app)));

      // Choix initial: hash > localStorage > premier bouton
      const rawHash = (location.hash || '').replace(/^#/, '');
      const fromHash = rawHash.startsWith('app=') ? rawHash.slice(4) : rawHash;
      let start = ALLOWED.has(fromHash) ? fromHash : null;
      if (!start) {
        try { const saved = localStorage.getItem('app:last'); if (ALLOWED.has(saved)) start = saved; } catch {}
      }
      if (!start) start = APP_BTNS[0]?.dataset.app || 'finance';

      // Hooks par défaut (tu pourras les étoffer plus tard)
      registerApp('finance', { init() { /* logic déjà en place */ }, destroy() {} });
      registerApp('agenda', (function(){
        // ======= CONFIG / CONSTANTES =======
        const ORG_PREFIX = 'MultiappOrg · ';          // Prefix des agendas Google
        const GCAL_SCOPES = 'openid email profile https://www.googleapis.com/auth/calendar';
        const GCAL_API    = 'https://www.googleapis.com/calendar/v3';

        // LocalStorage
        const LS_EVENTS       = 'agenda:events:multiorg:v1';    // [{id, cal, date, title, gid?}]
        const LS_VISIBLE      = 'agenda:visible:multiorg:v1';   // [calKey...]
        const LS_SELECTED_ORG = 'agenda:selectedOrgs:v1';       // [orgName...]
        const LS_G_TOKEN      = 'agenda:gcal:token';
        const LS_G_GRANTED    = 'agenda:gcal:granted';

        // ======= ETAT UI / DONNEES =======
        let container, grid, monthLbl, btnPrev, btnNext, btnToday;
        let whoSel, filtersWrap, quickForm, quickCal, quickTitle, quickAdd, dayTitle, dayList, dayEmpty;

        // Google UI
        let statusEl, btnConnect, btnLogout;
        let orgNameInp, orgMembersInp, orgCreateBtn, orgCreatePersonals, orgSendInvites, orgRefreshBtn;
        let orgOwnedList, orgSharedList, orgImportBtn, orgImportPrimaryBtn;

        // Etat calendrier
        let currentMonth = new Date(); currentMonth.setDate(1);
        let selectedDay = null;
        let events = [];                 // évènements locaux (affichage)
        let visible = new Set();         // calKeys visibles

        // Multi-organisations (détectées sur Google)
        let orgsOwned = [];              // [{name, generalId, members:[{email, calId}], color}]
        let orgsShared = [];             // idem
        let selectedOrgs = new Set();    // noms d'org cochées
        let accessToken = null;

      // ======= HELPERS GÉNÉRIQUES =======
      function pad2(n){ return String(n).padStart(2,'0'); }
      function ymd(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
      function todayYMD(){ return ymd(new Date()); }
      function parseYMD(s){ const m = String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m? new Date(+m[1], +m[2]-1, +m[3]) : null; }
      function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
      function esc(s){ return String(s).replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
      function splitEmails(txt){
        return String(txt||'')
        .split(/[\s,;]+/g)
        .map(s=>s.trim())
        .filter(s=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
      }
          
      // ======= PERSISTENCE =======
      function loadAll(){
        try{ events = JSON.parse(localStorage.getItem(LS_EVENTS)||'[]'); }catch{ events=[]; }
        if (!Array.isArray(events)) events=[];
        try{ const v = JSON.parse(localStorage.getItem(LS_VISIBLE)||'null'); if (Array.isArray(v)) visible = new Set(v); }catch{}
        try{ const s = JSON.parse(localStorage.getItem(LS_SELECTED_ORG)||'null'); if (Array.isArray(s)) selectedOrgs = new Set(s); }catch{}
      }
      function saveEvents(){ try{ localStorage.setItem(LS_EVENTS, JSON.stringify(events)); }catch{} }
      function saveVisible(){ try{ localStorage.setItem(LS_VISIBLE, JSON.stringify(Array.from(visible))); }catch{} }
      function saveSelectedOrgs(){ try{ localStorage.setItem(LS_SELECTED_ORG, JSON.stringify(Array.from(selectedOrgs))); }catch{} }

      // ======= PERSISTENCE ORG / INVITES (local, safe helpers) =======
      const LS_ORGS = 'agenda:orgs:v1';                    // optional cached org metadata
      const LS_INVITES = 'agenda:org:invites:v1';          // queued invites (pending)
      const LS_INVITE_NOTIFS = 'agenda:org:invite-notifs:v1'; // local notifications for invite responses

      function loadOrgsLS(){ try{ return JSON.parse(localStorage.getItem(LS_ORGS)||'[]'); }catch{ return []; } }
      function saveOrgsLS(arr){ try{ localStorage.setItem(LS_ORGS, JSON.stringify(arr||[])); }catch{} }

      function loadInvitesLS(){ try{ return JSON.parse(localStorage.getItem(LS_INVITES)||'[]'); }catch{ return []; } }
      function saveInvitesLS(arr){ try{ localStorage.setItem(LS_INVITES, JSON.stringify(arr||[])); }catch{} }

      function loadInviteNotifs(){ try{ return JSON.parse(localStorage.getItem(LS_INVITE_NOTIFS)||'[]'); }catch{ return []; } }
      function saveInviteNotifs(arr){ try{ localStorage.setItem(LS_INVITE_NOTIFS, JSON.stringify(arr||[])); }catch{} }

      function pushInviteNotif(n){
        try{
          const list = loadInviteNotifs();
          list.unshift(Object.assign({ id: uid(), createdAt: Date.now() }, n));
          saveInviteNotifs(list);
          // notify UI if available
          if (typeof renderOrgLists === 'function') renderOrgLists();
          if (typeof renderInviteNotifs === 'function') renderInviteNotifs();
        }catch{};
      }

      /**
       * Queue invites locally for an organisation.
       * - orgName: string
       * - emails: string | string[] (comma/space separated allowed)
       * - opts: { note?:string }
       * This function does NOT perform Google ACL operations automatically.
       */
      window.__agenda_sendInvitesForOrg = async function(orgName, emails, opts){
        try{
          const raw = Array.isArray(emails) ? emails.join(' ') : String(emails||'');
          const list = splitEmails(raw);
          if (!orgName || !list.length) return { ok:false, reason:'missing' };
          const me = (typeof whoAmI === 'function') ? (await whoAmI().catch(()=>null)) : null;
          const from = me && me.email ? me.email : null;
          const stored = loadInvitesLS();
          for (const to of list){
            const it = { id: uid(), org: orgName, email: to, from: from, status: 'pending', note: opts?.note || '', createdAt: Date.now() };
            stored.push(it);
            // local notification for the inviter (visible in UI)
            pushInviteNotif({ org: orgName, email: to, from, status: 'pending' });
          }
          saveInvitesLS(stored);
          // trigger a UI refresh + optional background scan
          if (typeof scanOrganizations === 'function') scanOrganizations().catch(()=>{});
          if (typeof renderInviteNotifs === 'function') renderInviteNotifs();
          return { ok:true, queued: list.length };
        }catch(e){ return { ok:false, reason: e && e.message || String(e) }; }
      };

      // ======= INVITES UI (render + handlers) =======
      function renderInviteNotifs(){
        try{
          const host = document.getElementById('org-invite-notifs');
          const listRoot = document.getElementById('org-invite-list');
          if (!host || !listRoot) return;
          const list = loadInviteNotifs();
          if (!list || !list.length){ host.textContent = 'Aucune invitation.'; listRoot.innerHTML = ''; return; }
          host.textContent = list.length + ' notification(s)';
          listRoot.innerHTML = '';
          list.forEach(item => {
            const row = document.createElement('div');
            row.className = 'row';
            row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 0;';
            const left = document.createElement('div'); left.style.cssText='display:flex; gap:8px; align-items:center; min-width:0;';
            left.innerHTML = `<div style="font-weight:600; overflow:hidden; text-overflow:ellipsis;">${esc(item.org || '')}</div><div class="muted" style="font-size:.9rem;">${esc(item.email||'')}</div>`;
            const right = document.createElement('div');
            const accept = document.createElement('button'); accept.type='button'; accept.className='btn primary'; accept.textContent='Accepter';
            const decline = document.createElement('button'); decline.type='button'; decline.className='btn ghost'; decline.textContent='Refuser';
            const realSend = document.createElement('button'); realSend.type='button'; realSend.className='btn'; realSend.textContent='Envoyer réel';

            accept.addEventListener('click', async ()=>{
              // Accept locally: mark visible/select org
              // add to selectedOrgs and save
              if (item.org) selectedOrgs.add(item.org);
              saveSelectedOrgs();
              // remove this notif
              const cur = loadInviteNotifs().filter(n=>n.id!==item.id);
              saveInviteNotifs(cur);
              // optionally accept by creating personal calend or other (not automated)
              renderOrgLists(); renderInviteNotifs(); buildFilters(); renderGrid(); renderDayPanel();
            });

            decline.addEventListener('click', ()=>{
              const cur = loadInviteNotifs().filter(n=>n.id!==item.id);
              saveInviteNotifs(cur);
              renderInviteNotifs();
            });

            realSend.addEventListener('click', async ()=>{
              // If connected, offer to perform real ACL send via inviteMembersToOrg
              if (!loadSavedToken() && !accessToken){ alert('Connecte-toi à Google pour envoyer des invitations réelles.'); return; }
              const ok = confirm('Envoyer une invitation réelle via Google Calendar (enverra un e-mail) ?');
              if (!ok) return;
              try{
                await ensureToken(true);
                // inviteMembersToOrg expects orgName field in orgNameInp, and emails in orgMembersInp
                orgNameInp.value = item.org || '';
                orgMembersInp.value = item.email || '';
                await inviteMembersToOrg();
                // mark notif handled
                const cur = loadInviteNotifs().filter(n=>n.id!==item.id);
                saveInviteNotifs(cur);
                renderInviteNotifs();
              }catch(e){ alert(e && e.message ? e.message : e); }
            });

            right.appendChild(accept); right.appendChild(decline); right.appendChild(realSend);
            row.appendChild(left); row.appendChild(right);
            listRoot.appendChild(row);
          });
        }catch(e){}
      }

      // ======= GOOGLE (auth + stockage token) =======
      function setStatus(msg){ if (statusEl) statusEl.textContent = msg; }
      function getClientId(){
        const fromMeta = document.querySelector('meta[name="google-client-id"]')?.content;
        if (fromMeta && !/REPLACE_WITH/i.test(fromMeta)) return fromMeta.trim();
        if (typeof window.GOOGLE_CLIENT_ID === 'string' && window.GOOGLE_CLIENT_ID) return window.GOOGLE_CLIENT_ID;
        return null;
      }
      function loadGisScript(){
        return new Promise((resolve, reject)=>{
          if (window.google?.accounts?.oauth2) return resolve();
          const s=document.createElement('script');
          s.src='https://accounts.google.com/gsi/client'; s.async=true; s.defer=true;
          s.onload=()=> resolve();
          s.onerror=()=> reject(new Error('Impossible de charger Google Identity Services'));
          document.head.appendChild(s);
        });
      }
      function saveToken(access_token, expires_in){
        try{
          const ttl = Math.max(60, Number(expires_in||3600)) - 30;
          const expires_at = Date.now() + ttl*1000;
          localStorage.setItem(LS_G_TOKEN, JSON.stringify({ access_token, expires_at }));
        }catch{}
      }
      function loadSavedToken(){
        try{
          const obj = JSON.parse(localStorage.getItem(LS_G_TOKEN)||'null');
          if (!obj || !obj.access_token || !obj.expires_at) return null;
          if (obj.expires_at <= Date.now()) return null;
          accessToken = obj.access_token;
          return accessToken;
        }catch{ return null; }
      }
      function clearSavedToken(){ try{ localStorage.removeItem(LS_G_TOKEN); }catch{} accessToken=null; }
      function markGranted(flag){ try{ localStorage.setItem(LS_G_GRANTED, flag?'1':'0'); }catch{} }
      function hasGrant(){ try{ return localStorage.getItem(LS_G_GRANTED)==='1'; }catch{ return false; } }

      let tokenClient = null;
      let tokenPromise = null;

      async function ensureToken(interactive){
        if (accessToken) return accessToken;
        const saved = loadSavedToken(); if (saved) return saved;
        const clientId = getClientId();
        if (!clientId){ alert('Client ID Google manquant (<meta name="google-client-id">)'); throw new Error('GOOGLE_CLIENT_ID manquant'); }
        await loadGisScript();
        tokenPromise = new Promise((resolve,reject)=>{
          try{
            if (!tokenClient){
              tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: clientId,
                scope: GCAL_SCOPES,
                ux_mode: 'popup',
                callback: (resp)=>{
                  tokenPromise = null;
                  if (resp && resp.access_token){
                    accessToken = resp.access_token;
                    saveToken(resp.access_token, resp.expires_in);
                    markGranted(true);
                    resolve(accessToken);
                  } else reject(new Error('Aucun jeton reçu'));
                }
              });
            }
            tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
          }catch(e){ tokenPromise=null; reject(e); }
        });
        return tokenPromise;
      }

      async function whoAmI(){
        try{
          if (!loadSavedToken() && !accessToken) return null;
          const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers:{ Authorization:`Bearer ${accessToken}` }});
          if (!r.ok) return null;
          return r.json();
        }catch{ return null; }
      }

      async function gfetch(path, { method='GET', query=null, body=null, interactive=false } = {}){
        // ⬇️ Ne force pas de popup par défaut ; les handlers UI appellent déjà ensureToken(true)
        await ensureToken(interactive);

        const url = new URL(GCAL_API + path);
        if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));

        const resp = await fetch(url.toString(), {
          method,
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: body ? JSON.stringify(body) : null
        });

        if (!resp.ok) {
          let msg = `HTTP ${resp.status}`;
          try { const j = await resp.json(); if (j.error && j.error.message) msg += ` — ${j.error.message}`; } catch {}
          throw new Error(msg);
        }
        return resp.json();
      }

      function disconnectGoogle(){
        clearSavedToken(); markGranted(false);
        setStatus('Non connecté.');
        updateGoogleButtons();
      }

      async function silentReconnect(){
        if (loadSavedToken()){
          const me = await whoAmI();
          if (me && me.email){
            setStatus('Connecté : ' + me.email);
            updateGoogleButtons();
            return;
          }
        }
  // Do NOT call ensureToken(false) here: that can trigger a popup in some browsers
  // instead, rely only on an already saved/valid token. If no saved token, remain disconnected.
        setStatus('Non connecté.');
        updateGoogleButtons();
      }

      function updateGoogleButtons(){
        const connected = !!(loadSavedToken() || accessToken);

        // Affiche/masque Connexion/Déconnexion
        if (btnConnect) btnConnect.style.display = connected ? 'none' : '';
        if (btnLogout)  btnLogout.style.display  = connected ? '' : 'none';

        // Les actions d’orga visibles seulement si connecté
        const showOrgActions = connected ? '' : 'none';
        if (orgCreateBtn)         orgCreateBtn.style.display        = showOrgActions;
        if (orgRefreshBtn)        orgRefreshBtn.style.display       = showOrgActions;
        if (orgImportBtn)         orgImportBtn.style.display        = showOrgActions;
        if (orgImportPrimaryBtn)  orgImportPrimaryBtn.style.display = showOrgActions;

        // Désactive intelligemment les imports selon la sélection
        const selCount = (typeof selectedOrgs !== 'undefined' && selectedOrgs) ? selectedOrgs.size : 0;
        if (orgImportBtn)         orgImportBtn.disabled        = !connected || selCount === 0;
        if (orgImportPrimaryBtn)  orgImportPrimaryBtn.disabled = !connected || selCount !== 1;

        // Bouton "Inviter les membres" = grisé si pas connecté ou champ vide
        if (typeof window.updateInviteBtnState === 'function') window.updateInviteBtnState();
      }

      // ======= ORGANISATIONS (détection, création, invitations) =======
      function parseOrgFromSummary(summary){
        // "MultiappOrg · Nom · General"
        // "MultiappOrg · Nom · Member · email@..."
        const s = String(summary||'');
        if (s.indexOf(ORG_PREFIX)!==0) return null;
        const parts = s.slice(ORG_PREFIX.length).split('·').map(p=>p.trim());
        if (!parts.length) return null;
        const name = parts[0];
        if (parts.length>=2 && /^general$/i.test(parts[1])) return { name, type:'general' };
        if (parts.length>=3 && /^member$/i.test(parts[1]))  return { name, type:'member', email: parts.slice(2).join(' · ') };
        return { name, type:'unknown' };
      }

      async function scanOrganizations(){
        const list = await gfetch('/users/me/calendarList', { query:{ maxResults:'250' }});
        const items = Array.isArray(list.items) ? list.items : [];
        const groups = new Map(); // name -> {name, generalId, members:[], owner:bool}

        for (const c of items){
          const meta = parseOrgFromSummary(c.summary);
          if (!meta) continue;
          if (!groups.has(meta.name)) groups.set(meta.name, { name: meta.name, generalId: null, members: [], owner: false });
          const g = groups.get(meta.name);
          const role = String(c.accessRole||'').toLowerCase();
          if (role === 'owner') g.owner = true;

          if (meta.type === 'general') g.generalId = c.id;
          else if (meta.type === 'member' && meta.email) g.members.push({ email: meta.email, calId: c.id });
        }

        orgsOwned  = Array.from(groups.values()).filter(o => o.owner);
        orgsShared = Array.from(groups.values()).filter(o => !o.owner);

        renderOrgLists();
      }

      function renderOrgLists(){
        function renderList(root, data, section){
          root.innerHTML = '';
          if (!data.length){
            root.innerHTML = '<div class="muted">Aucune</div>';
            return;
          }
          data.forEach(o=>{
            const id = 'orgchk-'+section+'-'+o.name.replace(/\s+/g,'_');
            const wrap = document.createElement('div');
            wrap.className = 'row';
            wrap.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 0;';
            const left = document.createElement('div');
            left.style.cssText='display:flex; align-items:center; gap:8px;';
            const cb = document.createElement('input');
            cb.type='checkbox'; cb.id=id; cb.checked = selectedOrgs.has(o.name);
            cb.addEventListener('change', ()=>{
              if (cb.checked) selectedOrgs.add(o.name); else selectedOrgs.delete(o.name);
              saveSelectedOrgs(); buildFilters(); renderGrid(); renderDayPanel();
            });
            const lbl = document.createElement('label');
            lbl.setAttribute('for', id);
            lbl.innerHTML = `<b>${esc(o.name)}</b> &nbsp;<span class="muted">${o.members.length} membre(s)</span>`;
            left.appendChild(cb); left.appendChild(lbl);
            wrap.appendChild(left);

            if (o.owner){
              const right = document.createElement('div');
              const btn = document.createElement('button');
              btn.className='btn ghost';
              btn.textContent = 'Inviter des membres';
              btn.title = 'Ajoute des membres à cette organisation';
              btn.addEventListener('click', ()=>{
                orgNameInp.value = o.name;
                orgMembersInp.focus();
              });
              right.appendChild(btn);
              wrap.appendChild(right);
            }

            root.appendChild(wrap);
          });
        }

        renderList(orgOwnedList, orgsOwned, 'owned');
        renderList(orgSharedList, orgsShared, 'shared');
        updateGoogleButtons();
        buildFilters();
      }

      // Crée une org (Général + (option) perso par membre) et partage
      async function createOrganization(){
        const name = orgNameInp.value.trim();
        if (!name){ alert('Indique un nom d’organisation.'); return; }
        const members = splitEmails(orgMembersInp.value);
        const createPersonals = !!orgCreatePersonals.checked;
        const sendInv = !!orgSendInvites.checked;

        setStatus('Création de l’organisation…');

        // 1) Général
        const general = await gfetch('/calendars', { method:'POST', body:{ summary: ORG_PREFIX + name + ' · General' }});
        const generalId = general.id;
        await gfetch('/users/me/calendarList', { method:'POST', body:{ id: generalId } }).catch(()=>{});

        // 2) ACL du Général (tous membres = writer)
        for (const m of members){
          await gfetch(`/calendars/${encodeURIComponent(generalId)}/acl`, {
            method:'POST', query:{ sendNotifications: sendInv?'true':'false' },
            body:{ role:'writer', scope:{ type:'user', value:m } }
          }).catch(()=>{});
        }

        // 3) Perso (optionnel)
        if (createPersonals){
          for (const m of members){
            const cal = await gfetch('/calendars', { method:'POST', body:{ summary: ORG_PREFIX + name + ' · Member · ' + m }});
            await gfetch('/users/me/calendarList', { method:'POST', body:{ id: cal.id } }).catch(()=>{});
            await gfetch(`/calendars/${encodeURIComponent(cal.id)}/acl`, {
              method:'POST', query:{ sendNotifications: sendInv?'true':'false' },
              body:{ role:'writer', scope:{ type:'user', value:m } }
            }).catch(()=>{});
          }
        }

        setStatus('Organisation créée ✅');
        alert('Organisation créée. Les membres reçoivent un e-mail (à accepter).');
        orgMembersInp.value = '';
        updateInviteBtnState();
        await scanOrganizations();
      }

      // Inviter des e-mails à une org existante (ou la créer si absente)
      async function inviteMembersToOrg(){
        const name = orgNameInp.value.trim();
        const emails = splitEmails(orgMembersInp.value);
        if (!name){ alert('Indique le nom de l’organisation.'); return; }
        if (!emails.length){ alert('Ajoute au moins un e-mail.'); return; }
        const createPersonals = !!orgCreatePersonals.checked;
        const sendInv = !!orgSendInvites.checked;

        setStatus('Invitation en cours…');

        // Scanner pour trouver l’org existante (propriétaire)
        const list = await gfetch('/users/me/calendarList', { query:{ maxResults:'250' }});
        const items = Array.isArray(list.items)?list.items:[];
        let general = items.find(c => c.summary === (ORG_PREFIX+name+' · General'));
        let generalId = general?.id;

        // Si pas d’org, on la crée automatiquement (Général)
        if (!generalId){
          const created = await gfetch('/calendars', { method:'POST', body:{ summary: ORG_PREFIX + name + ' · General' }});
          generalId = created.id;
          await gfetch('/users/me/calendarList', { method:'POST', body:{ id: generalId } }).catch(()=>{});
        }

        // Donne accès writer au Général (+ e-mail d’invitation si coché)
        for (const m of emails){
          await gfetch(`/calendars/${encodeURIComponent(generalId)}/acl`, {
            method:'POST', query:{ sendNotifications: sendInv?'true':'false' },
            body:{ role:'writer', scope:{ type:'user', value:m } }
          }).catch(()=>{});
        }

        // Perso optionnel : créer le calendrier “Member · email” + writer pour le membre
        if (createPersonals){
          // Re-scan rapide pour éviter doublons
          const again = await gfetch('/users/me/calendarList', { query:{ maxResults:'250' }});
          const all   = Array.isArray(again.items)?again.items:[];
          for (const m of emails){
            const want = ORG_PREFIX + name + ' · Member · ' + m;
            let cal = all.find(c => c.summary === want);
            if (!cal){
              cal = await gfetch('/calendars', { method:'POST', body:{ summary: want }});
              await gfetch('/users/me/calendarList', { method:'POST', body:{ id: cal.id } }).catch(()=>{});
            }
            await gfetch(`/calendars/${encodeURIComponent(cal.id)}/acl`, {
              method:'POST', query:{ sendNotifications: sendInv?'true':'false' },
              body:{ role:'writer', scope:{ type:'user', value:m } }
            }).catch(()=>{});
          }
        }

        alert('Invitations envoyées.');
        orgMembersInp.value = '';
        updateInviteBtnState();
        setStatus('Invitations envoyées ✅');
        await scanOrganizations();
      }

      // ======= IMPORT (mois visible) =======
      function monthRangeISO(){
        const start = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1, 0,0,0,0);
        const end   = new Date(currentMonth.getFullYear(), currentMonth.getMonth()+1, 0, 23,59,59,999);
        return { timeMin: start.toISOString(), timeMax: end.toISOString() };
      }
      function toYmdFromGoogle(ev){
        if (ev && ev.start && ev.start.date) return ev.start.date;
        const iso = ev && ev.start ? (ev.start.dateTime || ev.start.date) : null;
        if (!iso) return null;
        const d = new Date(iso); if (isNaN(d)) return null;
        return ymd(d);
      }
      function dedupeMerge(base, incoming){
        const byGid = new Map(), bySig = new Map();
        for (const e of base){
          if (e.gid) byGid.set(e.gid, 1);
          else bySig.set(e.cal+'|'+e.date+'|'+e.title, 1);
        }
        const out = base.slice();
        for (const e of incoming){
          if (e.gid && byGid.has(e.gid)) continue;
          const sig = e.cal+'|'+e.date+'|'+e.title;
          if (!e.gid && bySig.has(sig)) continue;
          out.push(e);
        }
        return out;
      }

      function orgCalKey(orgName, label){ return orgName+'::'+label; } // ex: “Famille Martin::General” ou “Projet::member:email”
      function colorFor(text){
        let h=0; for (let i=0;i<text.length;i++) h=(h*31 + text.charCodeAt(i))>>>0;
        const hue = h % 360; return `hsl(${hue}deg 70% 45%)`;
      }

      function activeCalendarsFromSelection(){
        // Construit la liste des "calendriers logiques" (General + member…) pour les organisations cochées
        const map = [];
        const addOrg = (o)=>{
          if (!o) return;
          // Général
          map.push({ key: orgCalKey(o.name,'General'), label: o.name+' — Général', color: '#4CAF50', gId: o.generalId });
          // Membres
          (o.members||[]).forEach(m=>{
            map.push({ key: orgCalKey(o.name,'member:'+m.email), label: o.name+' — '+m.email, color: colorFor(o.name+'|'+m.email), gId: m.calId });
          });
        };
        orgsOwned.filter(o=>selectedOrgs.has(o.name)).forEach(addOrg);
        orgsShared.filter(o=>selectedOrgs.has(o.name)).forEach(addOrg);
        return map;
      }

      async function importSelectedOrgsMonth(){
        const sel = Array.from(selectedOrgs);
        if (!sel.length){ alert('Coche au moins une organisation.'); return; }
        setStatus('Import du mois en cours…');

        const { timeMin, timeMax } = monthRangeISO();
        const incoming = [];
        const active = activeCalendarsFromSelection();

        for (const cal of active){
          if (!cal.gId) continue; // pas de calendrier Google (ex: org partagée incomplète)
      const data = await gfetch(`/calendars/${encodeURIComponent(cal.gId)}/events`, {
        query:{ maxResults:'2500', singleEvents:'true', orderBy:'startTime', timeMin, timeMax }
      });
      const items = Array.isArray(data.items)?data.items:[];
      for (const ev of items){
        if (ev.status==='cancelled') continue;
        const date = toYmdFromGoogle(ev); if (!date) continue;
        const title = (ev.summary||'(Sans titre)').trim();
        incoming.push({ id: uid(), cal: cal.key, date, title, gid: ev.id });
      }
        }

        events = dedupeMerge(events, incoming);
        saveEvents();
        buildFilters();
        renderGrid();
        renderDayPanel();
        setStatus('Import terminé.');
        alert('Affichage mis à jour pour le mois visible.');
      }

      async function importPrimaryToSelectedOrg(){
        const sel = Array.from(selectedOrgs);
        if (sel.length!==1){ alert('Sélectionne exactement 1 organisation (case cochée).'); return; }
        const orgName = sel[0];
        const org = orgsOwned.find(o=>o.name===orgName) || orgsShared.find(o=>o.name===orgName);
        if (!org || !org.generalId){ alert('Organisation invalide ou sans calendrier Général.'); return; }

        setStatus('Import de votre calendrier principal → Général…');
        const { timeMin, timeMax } = monthRangeISO();
        const data = await gfetch('/calendars/primary/events', {
          query:{ maxResults:'2500', singleEvents:'true', orderBy:'startTime', timeMin, timeMax }
        });
        const items = Array.isArray(data.items)?data.items:[];
        const incoming = [];
        const calKey = orgCalKey(orgName,'General');

        for (const ev of items){
          if (ev.status==='cancelled') continue;
          const date = toYmdFromGoogle(ev); if (!date) continue;
          const title=(ev.summary||'(Sans titre)').trim();
          incoming.push({ id: uid(), cal: calKey, date, title, gid: 'primary:'+ev.id });
        }

        events = dedupeMerge(events, incoming);
        saveEvents(); buildFilters(); renderGrid(); renderDayPanel();
        setStatus('Import (primary → Général) terminé.');
        alert('Import terminé (mois visible).');
      }

      // ======= RENDU / UI AGENDA =======
      const MONTHS_FR   = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];

      function renderMonthHeader(){
        const label = MONTHS_FR[currentMonth.getMonth()]+' '+currentMonth.getFullYear();
        monthLbl.textContent = label.charAt(0).toUpperCase()+label.slice(1);
      }
      function startOfWeekIndex(d){ return (d.getDay()+6)%7; } // Lundi=0

      function renderGrid(){
        renderMonthHeader();
        grid.innerHTML = '';
        const first = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
        const daysInMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth()+1, 0).getDate();
        const leading = startOfWeekIndex(first);
        for (let i=0;i<leading;i++){
          const cell=document.createElement('div'); cell.className='ag-day muted';
          // Let CSS handle the background so theme switches update appearance live.
          cell.style.cssText='min-height:96px; border-radius:12px; opacity:.5;';
          grid.appendChild(cell);
        }
        for (let day=1; day<=daysInMonth; day++){
          const d = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day);
          const id = ymd(d);
          const cell = document.createElement('div'); cell.className='ag-day'; cell.dataset.date=id;
          // Keep layout consistent; background is provided by CSS to respect theme changes.
          cell.style.cssText='min-height:120px; border-radius:14px; padding:8px; border:1px solid rgba(0,0,0,.06); display:flex; flex-direction:column; gap:6px;';
          if (id === selectedDay) cell.classList.add('is-selected');
          const head=document.createElement('div'); head.style.cssText='display:flex; align-items:center; justify-content:space-between; gap:8px;';
          head.innerHTML='<div style="font-weight:600">'+day+'</div>'+(id===todayYMD()?'<span class="badge">Aujourd’hui</span>':'');
          const listWrap=document.createElement('div'); listWrap.style.cssText='display:flex; flex-direction:column; gap:4px;';
          const dayEvents = events.filter(e => e.date === id && visible.has(e.cal));
          dayEvents.slice(0,3).forEach(ev=>{
            const pill=document.createElement('div'); pill.className='ag-pill';
            const col = colorFor(ev.cal);
            pill.title=ev.title;
            pill.innerHTML='<span style="width:10px; height:10px; border-radius:50%; background:'+col+'"></span><span style="flex:1; overflow:hidden; text-overflow:ellipsis;">'+esc(ev.title)+'</span>';
            pill.dataset.id=ev.id; listWrap.appendChild(pill);
          });
          if (dayEvents.length>3){
            const more=document.createElement('div'); more.className='muted'; more.style.cssText='font-size:12px;'; more.textContent='+'+(dayEvents.length-3)+' autres…';
            listWrap.appendChild(more);
          }
          cell.appendChild(head); cell.appendChild(listWrap); grid.appendChild(cell);
        }
      }

      function buildFilters(){
        // Construit les chips à partir des org cochées
        if (!filtersWrap) return;
        const active = activeCalendarsFromSelection();
        if (!active.length){ filtersWrap.innerHTML = '<div class="muted">Aucune organisation sélectionnée.</div>'; return; }

        // Initialiser visible si vide
        if (!visible || !(visible instanceof Set) || visible.size===0){
          visible = new Set(active.map(a=>a.key));
          saveVisible();
        }

        filtersWrap.innerHTML = '';
        active.forEach(c=>{
          const label=document.createElement('label'); label.className='ag-chip';
          const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=visible.has(c.key);
          const dot=document.createElement('span'); dot.className='dot'; dot.style.background=c.color || colorFor(c.key);
          const txt=document.createElement('span'); txt.textContent=c.label;
          cb.addEventListener('change', ()=>{
            if (cb.checked) visible.add(c.key); else visible.delete(c.key);
            saveVisible(); renderGrid(); renderDayPanel();
          });
          label.appendChild(cb); label.appendChild(dot); label.appendChild(txt);
          filtersWrap.appendChild(label);
        });

        // Dropdown ajout rapide
        if (quickCal){
          quickCal.innerHTML='';
          active.forEach(c=>{ const o=document.createElement('option'); o.value=c.key; o.textContent=c.label; quickCal.appendChild(o); });
        }
      }

      function renderDayPanel(){
        if (!selectedDay){ dayTitle.textContent='Sélectionne un jour…'; dayList.innerHTML=''; dayEmpty.style.display='block'; quickForm.style.display='none'; return; }
        const d = parseYMD(selectedDay);
        dayTitle.textContent = d ? d.toLocaleDateString('fr-FR',{weekday:'long',day:'2-digit',month:'long',year:'numeric'}) : selectedDay;
        const items = events.filter(e=> e.date===selectedDay && visible.has(e.cal)).sort((a,b)=>a.cal.localeCompare(b.cal));
        dayList.innerHTML='';
        if (items.length===0){
          dayEmpty.style.display='block';
        } else {
          dayEmpty.style.display='none';
          const frag=document.createDocumentFragment();
          for (const ev of items){
            const row=document.createElement('div'); row.className='card';
            row.style.cssText='display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 10px;';
            row.innerHTML='<div style="display:flex; align-items:center; gap:8px; min-width:0;">'
            +'<span style="width:10px; height:10px; border-radius:50%; background:'+colorFor(ev.cal)+'"></span>'
            +'<div style="font-weight:600;">'+esc(ev.cal.split('::')[0])+'</div>'
            +'<div style="opacity:.8; overflow:hidden; text-overflow:ellipsis;">— '+esc(ev.title)+'</div></div>'
            +'<div><button class="btn" data-act="edit" data-id="'+ev.id+'">✏️</button>'
            +'<button class="btn danger" data-act="del" data-id="'+ev.id+'">🗑️</button></div>';
            frag.appendChild(row);
          }
          dayList.appendChild(frag);
        }
        quickForm.style.display='flex';
      }

      // ======= DONNÉES LOCALES (ajout/édition) =======
      function addEvent(calKey, dateYmd, title, gid){
        const obj = { id: uid(), cal: calKey, date: dateYmd, title: String(title||'').trim() };
        if (gid) obj.gid = gid;
        events.push(obj);
        saveEvents();
        renderGrid();
        renderDayPanel();
      }

      function deleteEvent(id){
        const i = events.findIndex(e => e.id === id);
        if (i !== -1){
          events.splice(i, 1);
          saveEvents();
          renderGrid();
          renderDayPanel();
        }
      }

      function editEvent(id, title){
        const e = events.find(x => x.id === id);
        if (!e) return;
        e.title = String(title || '').trim();
        saveEvents();
        renderGrid();
        renderDayPanel();
      }

      // ======= NAVIGATION / HANDLERS =======
      function goMonth(delta){ currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth()+delta, 1); renderGrid(); renderDayPanel(); }

      function init(cont){
        try {
          // ==== Récup des éléments ====
          container  = cont;
          grid       = container.querySelector('#ag-grid');
          monthLbl   = container.querySelector('#ag-month');
        btnPrev    = container.querySelector('#ag-prev');
        btnNext    = container.querySelector('#ag-next');
        btnToday   = container.querySelector('#ag-today');
        whoSel     = container.querySelector('#ag-who'); // pas utilisé ici mais conservé si présent
        filtersWrap= container.querySelector('#ag-cal-filters');
        quickForm  = container.querySelector('#ag-quick-form');
        quickCal   = container.querySelector('#ag-quick-cal');
        quickTitle = container.querySelector('#ag-quick-title');
        quickAdd   = container.querySelector('#ag-quick-add');
        dayTitle   = container.querySelector('#ag-day-title');
        dayList    = container.querySelector('#ag-day-list');
        dayEmpty   = container.querySelector('#ag-day-empty');

        // Google / Orgs UI
        statusEl   = container.querySelector('#gcal-status');
        btnConnect = container.querySelector('#gcal-connect');
        btnLogout  = container.querySelector('#gcal-logout');
        orgNameInp = container.querySelector('#org-name');
        orgMembersInp = container.querySelector('#org-members');
        orgCreatePersonals = container.querySelector('#org-create-personals');
        orgSendInvites     = container.querySelector('#org-send-invites');
        orgCreateBtn = container.querySelector('#org-create-btn');
        orgRefreshBtn= container.querySelector('#org-refresh');
        orgOwnedList = container.querySelector('#org-owned-list');
        orgSharedList= container.querySelector('#org-shared-list');
        orgImportBtn = container.querySelector('#org-import');
        orgImportPrimaryBtn = container.querySelector('#org-import-primary');
        const orgInviteBtn = container.querySelector('#org-invite');

  // ==== État local & rendu initial ====
  try { console.log('[AGENDA] init start', { container: !!container && container.id ? container.id : (container?container.tagName:container), grid: !!grid, monthLbl: !!monthLbl, btnPrev: !!btnPrev, btnNext: !!btnNext, btnToday: !!btnToday }); } catch(e){}
  loadAll();
  // ensure selectedDay is initialized before first render
  selectedDay = todayYMD();
  // build filters (initialise `visible`) before rendering the grid
  try{ if (typeof buildFilters === 'function') buildFilters(); }catch{}
  renderGrid();
  renderDayPanel();
          try { console.log('[AGENDA] post-render', { monthLabel: monthLbl && monthLbl.textContent, eventsCount: Array.isArray(events)?events.length:0, visibleCount: (visible && visible.size)||0, selectedDay }); } catch(e){}

        // ==== Correctif "refresh normal" ====
        const hadSaved = !!loadSavedToken(); // existe un jeton valide ?
        if (hadSaved) {
          whoAmI().then(me=>{
            if (me && me.email) setStatus('Connecté : ' + me.email);
            updateGoogleButtons();
            scanOrganizations();
          });
        } else {
          // tentative silencieuse (sans popup)
          silentReconnect().then(()=>{
            updateGoogleButtons();
            if (loadSavedToken()) scanOrganizations();
          });
        }

        // ==== Handlers ====
        if (grid) {
          grid.addEventListener('click', function (e) {
            const cell = e.target.closest('.ag-day[data-date]');
            if (cell) {
              selectedDay = cell.dataset.date;
              renderGrid();
              renderDayPanel();
              return;
            }
            const pill = e.target.closest('.ag-pill');
            if (pill) {
              const ev = events.find(x => x.id === pill.dataset.id);
              if (!ev) return;
              const next = prompt('Modifier le titre :', ev.title);
              if (next && next.trim()) editEvent(ev.id, next);
            }
          });
        }

        if (quickAdd) {
          quickAdd.addEventListener('click', function () {
            if (!selectedDay) return;
            const calKey = quickCal ? quickCal.value : null;
            const title = quickTitle ? quickTitle.value : '';
            if (!calKey || !title.trim()) return;
            addEvent(calKey, selectedDay, title);
            if (quickTitle) quickTitle.value = '';
          });
        }

        if (dayList) {
          dayList.addEventListener('click', function (e) {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            const id = btn.dataset.id;
            const act = btn.dataset.act;
            const ev = events.find(x => x.id === id);
            if (!ev) return;

            if (act === 'del') {
              if (confirm('Supprimer ?')) deleteEvent(id);
            } else if (act === 'edit') {
              const next = prompt('Modifier le titre :', ev.title);
              if (next && next.trim()) editEvent(id, next);
            }
          });
        }

        if (btnPrev)  btnPrev.addEventListener('click', function () { goMonth(-1); });
        if (btnNext)  btnNext.addEventListener('click', function () { goMonth(1); });
        if (btnToday) btnToday.addEventListener('click', function () {
          currentMonth = new Date(); currentMonth.setDate(1);
          selectedDay = todayYMD();
          renderGrid(); renderDayPanel();
        });

        if (btnConnect) {
          btnConnect.addEventListener('click', async function () {
            try {
              setStatus('Connexion...');
              await ensureToken(true);
              const me = await whoAmI();
              if (me && me.email) {
                setStatus('Connecté : ' + me.email);
              } else {
                setStatus('Connecté à Google.');
              }
              updateGoogleButtons();
              await scanOrganizations();
            } catch (e) {
              setStatus('Échec de connexion Google.');
              alert(e && e.message ? e.message : e);
            }
          });
        }

        if (btnLogout) {
          btnLogout.addEventListener('click', function () {
            disconnectGoogle();
            if (orgOwnedList)  orgOwnedList.innerHTML  = '';
            if (orgSharedList) orgSharedList.innerHTML = '';
          });
        }

        if (orgCreateBtn) {
          orgCreateBtn.addEventListener('click', async function () {
            try {
              await ensureToken(true);
              await createOrganization();
            } catch (e) {
              alert(e && e.message ? e.message : e);
            }
          });
        }

        if (orgRefreshBtn) {
          orgRefreshBtn.addEventListener('click', async function () {
            try {
              await ensureToken(true);
              await scanOrganizations();
            } catch (e) {
              alert(e && e.message ? e.message : e);
            }
          });
        }

        // === Inviter les membres (bouton à côté du champ) ===
        window.updateInviteBtnState = function () {
          const txt = (orgMembersInp && orgMembersInp.value || '').trim();
          const connected = !!(loadSavedToken() || accessToken);
          const orgInviteBtn = container.querySelector('#org-invite');
          if (orgInviteBtn) orgInviteBtn.disabled = (txt.length === 0) || !connected;
        };
          if (orgMembersInp) {
            orgMembersInp.addEventListener('input', window.updateInviteBtnState);
            window.updateInviteBtnState();
          }
          {
            const orgInviteBtn = container.querySelector('#org-invite');
            if (orgInviteBtn) {
              orgInviteBtn.addEventListener('click', async function () {
                try {
                  await ensureToken(true);
                  await inviteMembersToOrg();
                } catch (e) {
                  alert(e && e.message ? e.message : e);
                }
              });
            }
          }

          if (orgImportBtn) {
            orgImportBtn.addEventListener('click', async function () {
              try {
                await ensureToken(true);
                await importSelectedOrgsMonth();
              } catch (e) {
                alert(e && e.message ? e.message : e);
              }
            });
          }

          if (orgImportPrimaryBtn) {
            orgImportPrimaryBtn.addEventListener('click', async function () {
              try {
                await ensureToken(true);
                await importPrimaryToSelectedOrg();
              } catch (e) {
                alert(e && e.message ? e.message : e);
              }
            });
          }
          } catch (err) {
            // Log the error clearly so users/developers can see why the Agenda tab failed
            try { console.error('Agenda init error:', err); } catch(e){}
            // Attempt minimal graceful degradation: expose basic UI elements so user can still interact
            try { if (container) { container.querySelectorAll('button').forEach(b=>b.disabled=false); } } catch(e){}
          }
      }; // <-- FIN de function init(cont)
    return { init, destroy(){ /* no-op */ } };
})()); // <-- FIN DU MODULE AGENDA
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

    // --- Période des statistiques (mémoire + sélecteurs synchronisés)
    // (auto-suffisant : inclut son propre normaliseur et sécurise STATS_PERIOD)
    (() => {
  const statsSel = document.getElementById('stats-period');
  const editStatsSel = document.getElementById('edit-stats-period');
  const STATS_KEY = 'stats:period';

      // Normalise vers 'day' | 'month' | 'year'
      function normalizePeriodLocal(val) {
        const s = String(val || '')
        .toLowerCase()
        .normalize('NFD').replace(/\p{Diacritic}/gu,'') // enlève accents
        .replace(/\s+/g,'').replace(/[-_]/g,'');       // suppr espaces/traits/underscores
        if (['day','today','jour','aujourdhui','auj','cejour'].includes(s)) return 'day';
        if (['year','annee','anneeencours','currentyear','an'].includes(s)) return 'year';
        return 'month'; // défaut
      }

      // Expose une globale utilisée par d'autres morceaux éventuels
      if (typeof window.STATS_PERIOD === 'undefined') {
        window.STATS_PERIOD = 'month';
      }

      function applyStatsPeriod(val, opts = {}) {
        const persist = opts.persist !== false;
        const v = normalizePeriodLocal(val || 'month');

        if (statsSel) statsSel.value = v;
        if (editStatsSel) editStatsSel.value = v;

        window.STATS_PERIOD = v;

        if (persist) {
          try { localStorage.setItem(STATS_KEY, v); } catch {}
        }

        try { if (typeof window.renderStats === 'function') window.renderStats(); } catch {}
      }
    
      // Écoutes utilisateur
      statsSel?.addEventListener('change', () => applyStatsPeriod(statsSel.value));
      editStatsSel?.addEventListener('change', () => applyStatsPeriod(editStatsSel.value));

      // Initialisation (restaure si présent)
       (function initStatsPeriod(){
    let saved = null;
    try { saved = localStorage.getItem(STATS_KEY); } catch {}
    applyStatsPeriod(saved || statsSel?.value || 'month', { persist: false });
  })();
})(); // <-- on ferme juste cette IIFE utilitaire

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

// Defaults are hoisted earlier to avoid TDZ; this spot only assigns via readDefaultCalendarColors()

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
function applySelection(){
  if (!state.icon || !state.targetInput || !state.targetPreview) return;

  const cls = state.icon;

  // 1) Valeur + pastille
  state.targetInput.value = cls;
  state.targetPreview.innerHTML = `<i class="${cls}" aria-hidden="true"></i>`;

  // 2) Libellé "Choisir" -> nom d'icône (même comportement que le double-clic)
  try {
    const picker = state.targetPreview.closest('.category-picker-v2') || state.targetPreview.closest('.category-picker');
    const lbl = picker?.querySelector('.cat-current-label');
    if (lbl) {
      const MAP = {
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
      let nice = MAP[cls] || '';
      if (!nice) {
        const m = String(cls).match(/fa-[a-z0-9-]+$/i);
        if (m) {
          const s = m[0].replace(/^fa-/,'').replace(/-/g,' ');
          nice = s.charAt(0).toUpperCase() + s.slice(1);
        }
      }
      lbl.textContent = nice || 'Catégorie';
    }
  } catch {}

  // 3) Récents
  const r = loadRecents();
  const i = r.indexOf(cls);
  if (i !== -1) r.splice(i,1);
  r.unshift(cls);
  saveRecents(r);

  // 4) Ferme la sheet
  closeSheet();
}

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

  function openModal(){
    if (modal) modal.style.display = 'block';
  }
  function closeModal(){
    if (modal) modal.style.display = 'none';
  }

  // (compat large) pas d'optional chaining ici
  if (modal) {
    modal.addEventListener('click', function(e){
      if (e.target === modal) closeModal();
    });
  }

  document.addEventListener('keydown', function(e){
    if (e && e.key === 'Escape' && modal && modal.style.display === 'block') {
      closeModal();
    }
  });

  if (btnOpen)  btnOpen.addEventListener('click', openModal);
  if (btnCancel) btnCancel.addEventListener('click', closeModal);

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

  // Titre simple (dessin immédiat, pas de saut de page ici)
  function drawSectionTitle(pdf, title){
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(14);
    pdf.text(String(title || ''), LAYOUT.MARGIN, pdf.__cursorY);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(11);
    pdf.__cursorY += 8;
  }

  // (optionnel) si appelé ailleurs : garde-plat qui appelle drawSectionTitle
  function addSectionTitle(pdf, title){ drawSectionTitle(pdf, title); }

  // Convertit un sélecteur en image et l'insère dans jsPDF (robuste, sans toucher 'canvas' hors scope)
  // Convertit un sélecteur en image et l'insère dans jsPDF (net et compact)
  // Convertit un sélecteur en image et l'insère dans jsPDF (net et compact)
  async function captureSelectorToPdf(doc, selector, y, opts = {}) {
    const node = document.querySelector(selector);
    if (!node) return y;

    // --- Cas spécial: graphique Plotly → image nette directe, avec légende agrandie ---
    if (opts.plotlyDivId) {
      const div = document.getElementById(opts.plotlyDivId);
      if (div && window.Plotly?.toImage) {
        // Légende plus grande pendant l'export (puis on restaure)
        let oldLegendSize;
        try {
          oldLegendSize = div.layout?.legend?.font?.size;
          const newSize = Number(opts.legendFontSize || 16);
          await Plotly.relayout(div, {
            'legend.font.size': newSize,
            'legend.itemsizing': 'constant',
            'legend.itemwidth': 40
          });
        } catch (_) {}

        // Export image nette du graphe
        const W = 1000, H = 640;
        const S = Number(window.PLOTLY_EXPORT_SCALE || 1.6);
        const dataUrl = await Plotly.toImage(div, { format:'png', width:W, height:H, scale:S });

        // Restauration de la légende
        try { await Plotly.relayout(div, { 'legend.font.size': (oldLegendSize ?? null) }); } catch (_) {}

        // Place l'image : on force l'ajustement dans la hauteur dispo
        return placeImage(doc, dataUrl, y, {
          margin: Number(opts.pageMargin ?? 24),
                          wPx: W * S,
                          hPx: H * S,
                          maxHeight: Number(opts.maxHeight || 0)  // ← si fourni : pas de page en plus, on réduit pour tenir
        });
      }
    }

    // --- Clone hors-écran (visible pour html2canvas) ---
    const bg = '#ffffff'; // fond simple (évite color(srgb))
const rect = node.getBoundingClientRect();
const sandboxWidth = Math.max(720, Math.floor(rect.width || node.offsetWidth || 1200));

const sandbox = document.createElement('div');
sandbox.style.cssText = [
  'position:fixed','left:-99999px','top:0','z-index:-1',
  `background:${bg}`,'padding:0','margin:0',`width:${sandboxWidth}px`
].join(';');

const clone = node.cloneNode(true);

// Neutralise color-mix() → fixe --od-bg (évite erreur html2canvas "unsupported color function 'color'")
try {
  const dark = document.documentElement.classList.contains('dark-mode');
  clone.querySelectorAll('.od-gauge').forEach(el => {
    el.style.setProperty('--od-bg', dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.08)');
  });
} catch {}

// Calendrier : si le libellé de mois est vide dans le CLONE, on met celui de la page
if (selector === '#calendar-section') {
  try {
    const dst = clone.querySelector('#current-month, .current-month, [data-current-month]');
    const srcTxt = document.querySelector('#current-month, .current-month, [data-current-month]')?.textContent?.trim();
    if (dst && srcTxt && !dst.textContent.trim()) dst.textContent = srcTxt;
  } catch {}
}

// Rendre le clone "visible"
(function makeVisible(el){
  if (!(el instanceof Element)) return;
  el.removeAttribute('hidden'); el.setAttribute('aria-hidden','false');
  const s = el.style;
  if (s) {
    if (s.display === 'none') s.display = '';
    if (s.visibility === 'hidden') s.visibility = '';
    if (s.opacity === '0') s.opacity = '';
    if (s.transform && s.transform !== 'none') s.transform = 'none';
  }
  el.querySelectorAll('[hidden]').forEach(n => n.removeAttribute('hidden'));
  el.querySelectorAll('[aria-hidden="true"]').forEach(n => n.setAttribute('aria-hidden','false'));
  el.querySelectorAll('[style]').forEach(n => {
    const st = n.style;
    if (st.display === 'none') st.display = '';
    if (st.visibility === 'hidden') st.visibility = '';
    if (st.opacity === '0') st.opacity = '';
  });
})(clone);

sandbox.appendChild(clone);
document.body.appendChild(sandbox);

// Rasterisation (DPI contrôlé → poids maîtrisé)
const EXPORT_DPI   = Number(window.PDF_EXPORT_DPI || 132);
const SCALE        = Math.max(1, EXPORT_DPI / 96);
const JPEG_QUALITY = Number(window.JPEG_QUALITY  || 0.82);

const canvas = await html2canvas(clone, {
  backgroundColor: bg,
  scale: SCALE,
  useCORS: true,
  logging: false,
  windowWidth: sandboxWidth,
  windowHeight: clone.scrollHeight || document.documentElement.scrollHeight
});

document.body.removeChild(sandbox);

const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
return placeImage(doc, dataUrl, y, {
  margin: Number(opts.pageMargin ?? 24),
                  wPx: canvas.width,
                  hPx: canvas.height,
                  maxHeight: Number(opts.maxHeight || 0)
});

// --- Placement (sans page vide, ajuste pour tenir si maxHeight fourni) ---
function placeImage(doc, url, y0, { margin = 24, wPx, hPx, maxHeight = 0 } = {}) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const maxW  = pageW - margin*2;

  wPx = Math.max(1, Number(wPx) || 1200);
  hPx = Math.max(1, Number(hPx) || Math.round(wPx * 0.6));
  const ratio = hPx / wPx;

  let drawW = maxW;
  let drawH = drawW * ratio;

  // Si on a une contrainte de hauteur (cas du graphe en page dédiée), on respecte cette limite
  if (maxHeight > 0 && drawH > maxHeight) {
    drawH = maxHeight;
    drawW = drawH / ratio;
  } else {
    // Sinon, si ça dépasse la page courante → on saute une page proprement
    if (y0 + drawH > pageH - margin) {
      doc.addPage();
      y0 = margin;
      // sécurité: si trop haut même en page neuve → on réduit
      const avail = pageH - margin*2;
      if (drawH > avail) {
        drawH = avail;
        drawW = drawH / ratio;
      }
    }
  }

  doc.addImage(url, 'JPEG', margin, y0, drawW, drawH);
  return y0 + drawH + 10;
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

  // Handshake canvas pour Firefox/LibreWolf (RFP) : à appeler dès le clic
  function __requestCanvasPermissionSync() {
    try {
      const c = document.createElement('canvas');
      c.width = 4; c.height = 4;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 4, 4);
      // lecture synchrone = "user gesture" encore active
      void c.toDataURL('image/png');
    } catch(_) {}
  }

  // === PDF EXPORT SETTINGS (tu peux ajuster) ===
  window.PDF_EXPORT_DPI        = window.PDF_EXPORT_DPI ?? 192;   // ↓ DPI = ↓ poids ; ↑ DPI = ↑ netteté
  window.JPEG_QUALITY          = window.JPEG_QUALITY   ?? 0.9;  // 0.75–0.9 conseillé
  window.PLOTLY_EXPORT_SCALE   = window.PLOTLY_EXPORT_SCALE ?? 1.6;

  function ensureSpace(doc, y, need, margin=24){
    const pageH = doc.internal.pageSize.getHeight();
    if (y + need > pageH - margin) { doc.addPage(); return margin; }
    return y;
  }
  function drawPdfTitle(doc, text, y, margin=24){
    y = ensureSpace(doc, y, 18, margin);
    doc.setFont('helvetica','bold'); doc.setFontSize(14);
    doc.text(String(text||''), margin, y);
    doc.setFont('helvetica','normal'); doc.setFontSize(11);
    return y + 10;
  }
  function drawPdfNote(doc, text, y, margin=24){
    y = ensureSpace(doc, y, 14, margin);
    doc.setFont('helvetica','normal'); doc.setFontSize(11);
    doc.text(String(text||''), margin, y);
    return y + 8;
  }
  function getCalendarMonthLabel(){
    // 1) window.currentMonth (si dispo)
    try{ if (window.currentMonth instanceof Date && !isNaN(window.currentMonth)) {
      return window.currentMonth.toLocaleDateString('fr-FR',{month:'long',year:'numeric'}).replace(/^\w/,c=>c.toUpperCase());
    }}catch{}
    // 2) Texte déjà affiché dans la page
    try{
      const t = document.querySelector('#current-month, .current-month, [data-current-month]')?.textContent?.trim();
      if (t) return t;
    }catch{}
    // 3) data-year/data-month sur la section calendrier
    try{
      const root = document.querySelector('#calendar-section');
      const y = Number(root?.getAttribute('data-year'));
      const m = Number(root?.getAttribute('data-month'));
      if (Number.isFinite(y) && Number.isFinite(m)) {
        const d = new Date(y, (m>0?m-1:m), 1);
        return d.toLocaleDateString('fr-FR',{month:'long',year:'numeric'}).replace(/^\w/,c=>c.toUpperCase());
      }
    }catch{}
    // 4) Fallback: mois courant
    const d = new Date();
    return d.toLocaleDateString('fr-FR',{month:'long',year:'numeric'}).replace(/^\w/,c=>c.toUpperCase());
  }

  async function runExport() {
    document.body.classList.add('is-exporting');
    try {
      const PDFCtor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
      if (typeof PDFCtor !== 'function') throw new Error('jsPDF non chargé');

      const doc = new PDFCtor({ unit: 'pt', format: 'a4' });
      const M = 24;  // marge
      let y = M;

      // 1) CALENDRIER — titre + mois (texte) + capture
      y = drawPdfTitle(doc, 'Calendrier', y, M);
      y = drawPdfNote(doc, getCalendarMonthLabel(), y, M);
      y = await captureSelectorToPdf(doc, '#calendar-section', y);

      // 2) RÉCAPITULATIF — titre + capture
      y = drawPdfTitle(doc, 'Récapitulatif du mois', y, M);
      y = await captureSelectorToPdf(doc, '#month-summary', y);

      // 3) STATISTIQUES — NOUVELLE PAGE dédiée (titre + graphe qui tient en entier)
      doc.addPage();
      y = M;
      y = drawPdfTitle(doc, 'Statistiques', y, M);

      // hauteur dispo pour l'image sur cette page (après le titre)
      const pageH = doc.internal.pageSize.getHeight();
      const maxH  = pageH - M - y;

      y = await captureSelectorToPdf(doc, '#stats-section', y, {
        plotlyDivId: 'pie-chart',
        maxHeight: maxH,     // ← on demande explicitement une image à cette hauteur max
        pageMargin: M,
        legendFontSize: 16   // ← légende plus grande pendant l’export
      });

      const name = (typeof makePdfName === 'function')
      ? makePdfName()
      : `finances-${new Date().toISOString().slice(0,10)}.pdf`;

      doc.save(name);
    } catch (err) {
      console.error('Erreur export PDF:', err);
      alert('Erreur export PDF: ' + (err?.message || err));
    } finally {
      document.body.classList.remove('is-exporting');
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

    // Ferme visuellement
    sheet.classList.remove('is-open');
    sheet.setAttribute('aria-hidden', 'true');

    // 🔒 Coupe toute interaction résiduelle
    try { sheet.style.display = 'none'; } catch {}
    try { sheet.style.pointerEvents = 'none'; } catch {}

    // S’il y a une modale finance ouverte derrière, on la “réveille”
    try {
      const modal = document.getElementById('modal-edit-transaction');
      if (modal) modal.style.pointerEvents = 'auto';
    } catch {}
  }

  // Expose la fermeture en global pour tous les appels existants
  try { window.__closeIconSheet = closeIconSheet; } catch {}

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

/* ==== HOTFIX 2025-08-12 — IconPickerV2: état global manquant ==== */
(function(){
  const init = { icon:null, category:'Essentiels', targetInput:null, targetPreview:null };
  if (!window.__ICON_PICKER__) window.__ICON_PICKER__ = { state: { ...init } };
  if (!window.__ICON_PICKER__.state) window.__ICON_PICKER__.state = { ...init };
  // Alias attendu par le code existant (références directes à "state.*")
  if (typeof window.state === 'undefined') window.state = window.__ICON_PICKER__.state;
})();


// === IconPickerV2 — ouverture (compat window.openIconPicker)
window.__openIconSheet = function(inputId, previewId){
  // cibles
  try {
    state.targetInput   = document.getElementById(inputId);
    state.targetPreview = document.getElementById(previewId);
  } catch { state.targetInput = null; state.targetPreview = null; }
  state.icon = state.targetInput?.value || null;

  // éléments du sheet (locaux)
  const SHEET = document.getElementById('icon-sheet');
  const PANEL = SHEET?.querySelector('.sheet__panel');
  const GRID  = document.getElementById('ip-grid');
  const SEARCH = document.getElementById('ip-search');
  const BTN_VALIDATE = document.getElementById('ip-validate');

  // catégories + récents + reset recherche
  if (typeof loadRecents === 'function') {
    ICONS["Récents"] = loadRecents();
  }
  if (!ICONS[state.category]) state.category = 'Essentiels';
  if (SEARCH) SEARCH.value = '';

  // (re)peuple les onglets + la grille
  if (typeof renderChips === 'function') renderChips();
  if (typeof renderGrid  === 'function') renderGrid();

  // Si la grille est vide, fallback sur "toutes icônes"
  if (GRID && !GRID.children.length) {
    state.category = '';
    if (typeof renderChips === 'function') renderChips();
    if (typeof renderGrid  === 'function') renderGrid();
  }

  // Ouvre visuellement
  if (SHEET) {
    SHEET.style.display = 'block';
    SHEET.classList.add('is-open');
    SHEET.setAttribute('aria-hidden','false');
  }
  if (PANEL) PANEL.style.transform = 'translateY(0)';

  // (Ré)initialise le bouton Valider
  if (BTN_VALIDATE) {
    BTN_VALIDATE.disabled = !state.icon;
    if (!state.icon) BTN_VALIDATE.setAttribute('aria-disabled','true');
    else BTN_VALIDATE.removeAttribute('aria-disabled');
  }

  // Focus recherche
  setTimeout(() => { try { SEARCH?.focus(); } catch {} }, 0);
};

/* ==== HOTFIX 2025-08-12 — IconPickerV2: catalogue + rendu (fallbacks) ==== */
(function(){
  // Catalogue minimal si absent
  if (!window.ICONS) window.ICONS = {
    'Essentiels': [
      'fa-solid fa-bus',
      'fa-solid fa-cart-shopping',
      'fa-solid fa-basket-shopping',
      'fa-solid fa-gas-pump',
      'fa-solid fa-briefcase',
      'fa-solid fa-car',
      'fa-solid fa-house',
      'fa-solid fa-utensils',
      'fa-solid fa-bolt',
      'fa-solid fa-shield-heart'
    ]
  };

  // Récents (fallback)
  if (typeof window.loadRecents !== 'function') {
    const KEY = 'iconPickerRecents';
    window.loadRecents = () => {
      try { const s = localStorage.getItem(KEY); const a = s?JSON.parse(s):[]; return Array.isArray(a)?a.slice(0,12):[]; } catch { return []; }
    };
    window.saveRecents = (arr) => { try { localStorage.setItem(KEY, JSON.stringify((arr||[]).slice(0,12))); } catch {} };
  }

  // Onglets catégories (fallback)
  if (typeof window.renderChips !== 'function') {
    window.renderChips = function(){
      const wrap = document.getElementById('ip-cats');
      if (!wrap) return;
      const cats = Object.keys(window.ICONS);
      wrap.innerHTML = cats.map(c => `<button type="button" class="ip-chip${state.category===c?' is-active':''}" data-cat="${c}">${c}</button>`).join('');
      wrap.querySelectorAll('.ip-chip').forEach(btn=>{
        btn.onclick = () => { state.category = btn.dataset.cat; renderChips(); renderGrid(); };
      });
    };
  }

  // Grille d’icônes (fallback)
  if (typeof window.renderGrid !== 'function') {
    window.renderGrid = function(){
      const grid = document.getElementById('ip-grid');
      if (!grid) return;
      const search = (document.getElementById('ip-search')?.value || '').trim().toLowerCase();
      const list = (state.category && window.ICONS[state.category]) ? window.ICONS[state.category] : Object.values(window.ICONS).flat();
      const filtered = !search ? list : list.filter(c => c.toLowerCase().includes(search));
      grid.innerHTML = filtered.map(cls => `
        <button type="button" class="ip-icon" data-icon="${cls}" title="${cls}">
          <i class="${cls}" aria-hidden="true"></i>
        </button>
      `).join('') || '<div class="ip-empty">Aucune icône</div>';

      const btnValidate = document.getElementById('ip-validate');
      grid.querySelectorAll('.ip-icon').forEach(btn=>{
        btn.onclick = () => {
          state.icon = btn.dataset.icon;
          if (btnValidate) { btnValidate.disabled = false; btnValidate.removeAttribute('aria-disabled'); }
        };
        btn.ondblclick = () => { state.icon = btn.dataset.icon; if (typeof applySelection === 'function') applySelection(); };
      });
    };
  }

  // Fermeture (fallback, n’écrase pas l’existant)
  if (typeof window.closeSheet !== 'function') {
    window.closeSheet = function(){
      const sheet = document.getElementById('icon-sheet');
      if (!sheet) return;
      sheet.classList.remove('is-open');
      sheet.setAttribute('aria-hidden','true');
      sheet.style.display = '';
      const panel = sheet.querySelector('.sheet__panel');
      if (panel) panel.style.transform = '';
    };
  }
})();

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

/* ============================================
   Thème : toggle soleil/lune dans le menu Profil
   - Stocke le choix dans localStorage('theme')
   - Ajoute / retire la classe 'dark-mode' sur <html>
   - Met à jour l'état ARIA du bouton (aria-pressed)
   ============================================ */
(function () {
  function applyTheme(mode) {
    const html = document.documentElement;
    const isDark = mode === 'dark';
    html.classList.toggle('dark-mode', isDark);
    try {
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
    } catch (e) {}
    const btn = document.getElementById('themeToggle');
    if (btn) btn.setAttribute('aria-pressed', String(isDark));
  }

  document.addEventListener('DOMContentLoaded', function () {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;

    // État initial : on lit le stockage (complément du bootstrap en <head>)
    let saved = null;
    try { saved = localStorage.getItem('theme'); } catch (e) {}
    if (!saved) {
      saved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    const isDarkNow = document.documentElement.classList.contains('dark-mode') || saved === 'dark';
    btn.setAttribute('aria-pressed', String(isDarkNow));

    // Click => bascule
    btn.addEventListener('click', function () {
      const next = (localStorage.getItem('theme') === 'dark' ||
                    document.documentElement.classList.contains('dark-mode'))
                  ? 'light' : 'dark';
      applyTheme(next);
    });
  });
})();

/* ==========================================================
   Couleur du bandeau (Topbar)
   - Pastilles + color picker
   - Persistance localStorage('topbarColor')
   - Applique --topbar-bg et une bordure éclaircie (--topbar-border)
   ========================================================== */
(function setupTopbarColorPicker() {
  const STORAGE_KEY = 'topbarColor';
  const root = document.documentElement;

  // Utils couleurs
  const hexToRgb = (hex) => {
    const m = String(hex).trim().replace('#','').toLowerCase();
    const v = (m.length === 3) ? m.split('').map(c => c+c).join('') : m;
    const n = parseInt(v, 16);
    return [ (n>>16)&255, (n>>8)&255, n&255 ];
  };
  const rgbToHex = ([r,g,b]) => '#' + [r,g,b].map(x => x.toString(16).padStart(2,'0')).join('');
  const mixWithWhite = (hex, ratio=0.55) => {
    const [r,g,b] = hexToRgb(hex);
    const R = Math.round(r + (255 - r) * ratio);
    const G = Math.round(g + (255 - g) * ratio);
    const B = Math.round(b + (255 - b) * ratio);
    return rgbToHex([R,G,B]);
  };
  const isValidHex = (v) => /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(String(v).trim());

  function markActive(hex) {
    const list = document.getElementById('topbar-color-swatches');
    if (!list) return;
    list.querySelectorAll('.swatch-btn').forEach(b => {
      const ok = b.dataset.color?.toLowerCase() === hex?.toLowerCase();
      b.classList.toggle('is-active', !!ok);
    });
  }

  function applyTopbar(hex) {
    if (!isValidHex(hex)) return;
    root.style.setProperty('--topbar-bg', hex);
    root.style.setProperty('--topbar-border', mixWithWhite(hex, 0.55));
    try { localStorage.setItem(STORAGE_KEY, hex); } catch (_e) {}
    markActive(hex);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const list = document.getElementById('topbar-color-swatches');
    const input = document.getElementById('topbar-color-input');
    if (!list || !input) return;

    // État initial
    const saved = (() => { try { return localStorage.getItem(STORAGE_KEY); } catch(_e) { return null; } })();
    if (saved && isValidHex(saved)) {
      applyTopbar(saved);
      try { input.value = saved; } catch {}
    } else {
      // Prend la valeur CSS courante si définie, sinon fallback fonctionne
      const cssVar = getComputedStyle(root).getPropertyValue('--topbar-bg').trim();
      if (isValidHex(cssVar)) { try { input.value = cssVar; } catch {} markActive(cssVar); }
    }

    // Clic sur les pastilles
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('button.swatch-btn[data-color]');
      if (!btn) return;
      const hex = btn.dataset.color;
      applyTopbar(hex);
      try { input.value = hex; } catch {}
    });

    // Couleur personnalisée
    input.addEventListener('input', () => {
      const hex = input.value;
      if (isValidHex(hex)) applyTopbar(hex);
    });
  });
})();

/* ==========================================================
   Découvert : saisie (profil) + jauge AU NIVEAU "Calendrier"
   - Ajout: possibilité d'activer/désactiver la jauge (localStorage 'overdraft.enabled')
   - Couleurs:
       * VERT  : solde >= 0 €
       * ORANGE: découvert utilisé, mais < 90 %
       * ROUGE : proche de la limite (>= 90 %) ou dépassement
   ========================================================== */
(function overdraftFeature(){
  const LS_LIMIT   = 'overdraft.limit';
  const LS_ALERT   = 'overdraft.alerts';
  const LS_ENABLED = 'overdraft.enabled';

  // --------- Utils ---------
  const nf = (v) => {
    try { return new Intl.NumberFormat('fr-FR', { style:'currency', currency:'EUR' }).format(v); }
    catch { return (Math.round(v*100)/100).toString().replace('.',',') + ' €'; }
  };
  const parseMoney = (s) => {
    if (typeof s === 'number') return s;
    if (s == null) return 0;
    const n = String(s).trim().replace(/\s/g,'').replace(',', '.');
    const v = Number(n);
    return Number.isFinite(v) ? v : 0;
  };

  function getSavedLimit(){ try { return parseMoney(localStorage.getItem(LS_LIMIT)); } catch { return 0; } }
  function getSavedAlerts(){ try { return localStorage.getItem(LS_ALERT) === '1'; } catch { return false; } }
  function getSavedEnabled(){
    try {
      const v = localStorage.getItem(LS_ENABLED);
      return v == null ? true : v === '1'; // par défaut: activé
    } catch { return true; }
  }
  function setSavedLimit(v){ try { localStorage.setItem(LS_LIMIT, String(v)); } catch {} }
  function setSavedAlerts(b){ try { localStorage.setItem(LS_ALERT, b ? '1' : '0'); } catch {} }
  function setSavedEnabled(b){ try { localStorage.setItem(LS_ENABLED, b ? '1' : '0'); } catch {} }

  // Solde courant (fallback si pas d’API interne)
  function getCurrentBalance(){
    try {
      if (typeof window.getCurrentBalance === 'function') return Number(window.getCurrentBalance()) || 0;
      if (typeof window.currentBalance === 'number') return window.currentBalance || 0;
      const tx = (Array.isArray(window.transactions) ? window.transactions : []);
      let sum = 0;
      for (const t of tx) {
        const v = parseMoney(t?.amount ?? t?.montant ?? t?.value ?? 0);
        sum += Number.isFinite(v) ? v : 0;
      }
      return sum;
    } catch { return 0; }
  }

  // Crée/insère la jauge SOUS LE TITRE "Calendrier"
  function ensureGaugeAtCalendar(){
    const sec = document.getElementById('calendar-section');
    if (!sec) return null;

    let g = sec.querySelector('#overdraft-gauge');
    if (g) return g;

    const h2 = sec.querySelector('h2');
    g = document.createElement('div');
    g.id = 'overdraft-gauge';
    g.className = 'od-gauge';
    g.innerHTML = `
      <div class="od-gauge-bar" aria-hidden="true">
        <div class="od-gauge-fill" style="width:0%"></div>
      </div>
      <div class="od-gauge-meta">
        <span id="od-balance-label">Solde : —</span>
        <span id="od-remaining-label">Reste avant limite : —</span>
        <span id="od-limit-label">Découvert : —</span>
      </div>
      <div class="od-alert" id="od-alert">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <span id="od-alert-text">Dépassement du découvert autorisé</span>
      </div>
    `;
    if (h2 && h2.parentNode) h2.insertAdjacentElement('afterend', g);
    else sec.prepend(g);
    return g;
  }
  function showGauge(show){
    const g = ensureGaugeAtCalendar();
    if (!g) return;
    g.style.display = show ? '' : 'none';
  }

  // Met à jour la jauge (respecte l'activation)
  let lastAlertState = 'ok'; // 'ok' | 'warn' | 'danger' | 'over'
  function updateGauge(){
    const enabled = getSavedEnabled();

    // S'il est désactivé: masquer et sortir
    if (!enabled) {
      showGauge(false);
      return;
    } else {
      showGauge(true);
    }

    const limit   = Math.max(0, getSavedLimit());
    const balance = Number(getCurrentBalance()) || 0;

    const g = ensureGaugeAtCalendar();
    if (!g) return;

    const fill    = g.querySelector('.od-gauge-fill');
    const balLbl  = g.querySelector('#od-balance-label');
    const remLbl  = g.querySelector('#od-remaining-label');
    const limLbl  = g.querySelector('#od-limit-label');
    const alertEl = g.querySelector('#od-alert');

    let widthPct, usedPct = 0;
    if (balance >= 0 || limit === 0) {
      widthPct = 100; usedPct = 0;
    } else {
      usedPct  = Math.min(1, Math.abs(balance) / limit);
      widthPct = Math.max(0, Math.min(100, (1 - usedPct) * 100));
    }

    const RED_TH = 0.90;
    let color = '#2ecc71', state = 'ok';
    if (balance >= 0) {
      color = '#2ecc71'; state = 'ok';
    } else if (limit > 0 && usedPct < RED_TH) {
      color = '#ff9800'; state = 'warn';
    } else if (limit > 0 && usedPct >= RED_TH && usedPct <= 1) {
      color = '#ef5350'; state = 'danger';
    } else if (limit > 0 && usedPct > 1) {
      color = '#c62828'; state = 'over';
    }

    fill.style.width = widthPct.toFixed(1) + '%';
    fill.style.backgroundColor = color;

    const remaining = (balance >= 0) ? limit : Math.max(0, limit + balance);
    balLbl.textContent = `Solde : ${nf(balance)}`;
    remLbl.textContent = `Reste avant limite : ${limit > 0 ? nf(remaining) : '—'}`;
    limLbl.textContent = `Découvert : ${nf(limit)}`;

    const alertsOn = getSavedAlerts();
    if (alertsOn && (state === 'danger' || state === 'over')) {
      alertEl.style.display = 'block';
      alertEl.querySelector('#od-alert-text').textContent =
        (state === 'over') ? 'Dépassement du découvert autorisé' : 'Attention : proche de la limite';
      if (lastAlertState !== state && 'vibrate' in navigator) {
        try { navigator.vibrate(state === 'over' ? [140, 80, 140] : 120); } catch {}
      }
    } else {
      alertEl.style.display = 'none';
    }
    lastAlertState = state;
  }

  document.addEventListener('DOMContentLoaded', () => {
    ensureGaugeAtCalendar();

    // Switch "Afficher la jauge"
    const enabledEl = document.getElementById('od-enabled');
    if (enabledEl) {
      enabledEl.checked = getSavedEnabled();
      enabledEl.addEventListener('change', () => {
        setSavedEnabled(enabledEl.checked);
        updateGauge(); // affiche/masque immédiatement
      });
    }

    // Limite & alertes
    const limitEl = document.getElementById('od-limit');
    const alertEl = document.getElementById('od-alerts');

    if (limitEl) {
      const saved = getSavedLimit();
      if (saved >= 0) limitEl.value = String(saved).replace('.', ',');
      const onLimitChange = () => {
        const v = parseMoney(limitEl.value);
        setSavedLimit(Math.max(0, v));
        updateGauge();
      };
      limitEl.addEventListener('input', onLimitChange);
      limitEl.addEventListener('change', onLimitChange);
      limitEl.addEventListener('blur', onLimitChange);
    }
    if (alertEl) {
      alertEl.checked = getSavedAlerts();
      alertEl.addEventListener('change', () => { setSavedAlerts(alertEl.checked); updateGauge(); });
    }

    // MAJ au chargement + évènements
    updateGauge();
    window.addEventListener('transactions-updated', updateGauge);
    window.updateOverdraftGauge = updateGauge;
    setInterval(() => { if (!document.hidden) updateGauge(); }, 5000);
  });
})();

/* ==========================================================
   Dossier local : cacher "Choisir le dossier…" si non supporté
   - Détecte l'API File System Access (showDirectoryPicker)
   - Cache le bouton si le statut indique "Non supporté..." ou si l'API manque
   - Se met à jour si le texte/classe du statut change plus tard
   ========================================================== */
(function hidePickFolderWhenUnsupported(){
  const statusEl = document.getElementById('folder-status');
  const pickBtn  = document.getElementById('pick-folder-btn');
  const clearBtn = document.getElementById('clear-folder-btn');

  if (!statusEl || !pickBtn) return;

  function isUnsupportedNow(){
    const byApi = !('showDirectoryPicker' in window);
    const text  = (statusEl.textContent || '').trim().toLowerCase();
    const byMsg = text.includes('non supporté');
    const byCls = statusEl.classList.contains('unsupported');
    return byApi || byMsg || byCls;
  }

  function applyUI(){
    const unsupported = isUnsupportedNow();

    // Optionnel : force le libellé si non supporté
    if (unsupported && !statusEl.textContent.toLowerCase().includes('non supporté')) {
      statusEl.textContent = 'Non supporté par ce navigateur';
      statusEl.classList.add('unsupported');
    }
    // Cache/affiche les boutons
    pickBtn.style.display  = unsupported ? 'none' : '';   // <-- ce que tu voulais
    if (clearBtn) clearBtn.style.display = unsupported ? 'none' : clearBtn.style.display;
  }

  // Init + observe les changements du statut
  document.addEventListener('DOMContentLoaded', applyUI);
  applyUI();

  const mo = new MutationObserver(applyUI);
  mo.observe(statusEl, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
})();

/* ==========================================================
   Normalisation des dates de transactions (robuste)
   Objectif : tout ramener en 'YYYY-MM-DD' (local), pour que
   le filtre "transactions du jour" du calendrier retrouve bien
   les lignes, même si l'utilisateur a saisi 22/08/2025 ou 22-08-2025
   ========================================================== */
(function normalizeTransactionDates() {
  // Parse "souple" : supporte jj/mm/aaaa, jj-mm-aaaa, aaaa-mm-jj, ISO
  function parseLooseDate(input) {
    if (!input) return null;

    // Déjà un Date ?
    if (input instanceof Date && !isNaN(input)) return input;

    const s = String(input).trim();

    // ISO direct ?
    // NB: Date.parse gère '2025-08-22' ou '2025-08-22T10:00:00Z'
    const isoTry = new Date(s);
    if (!isNaN(isoTry)) return isoTry;

    // jj/mm/aaaa
    let m = s.match(/^(\d{1,2})[\/](\d{1,2})[\/](\d{4})$/);
    if (m) {
      const d = Number(m[1]), mo = Number(m[2]) - 1, y = Number(m[3]);
      const dt = new Date(y, mo, d, 12, 0, 0); // midi local pour éviter décalages
      return isNaN(dt) ? null : dt;
    }

    // jj-mm-aaaa
    m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (m) {
      const d = Number(m[1]), mo = Number(m[2]) - 1, y = Number(m[3]);
      const dt = new Date(y, mo, d, 12, 0, 0);
      return isNaN(dt) ? null : dt;
    }

    // aaaa/mm/jj
    m = s.match(/^(\d{4})[\/](\d{1,2})[\/](\d{1,2})$/);
    if (m) {
      const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
      const dt = new Date(y, mo, d, 12, 0, 0);
      return isNaN(dt) ? null : dt;
    }

    return null;
  }

  function toLocalISODate(dateObj) {
    if (!(dateObj instanceof Date) || isNaN(dateObj)) return null;
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // Renvoie le champ date existant (quel que soit son nom)
  function pickDateField(tx) {
    return tx?.date ?? tx?.dateStr ?? tx?.day ?? tx?.jour ?? tx?.when ?? null;
  }

  // Applique la normalisation sur place. Renvoie true si un changement a eu lieu
  function normalizeInPlace(tx) {
    const raw = pickDateField(tx);
    const parsed = parseLooseDate(raw);
    if (!parsed) return false;
    const norm = toLocalISODate(parsed);
    if (!norm) return false;

    // On réécrit les champs courants si présents
    let changed = false;
    if (tx.date !== undefined && tx.date !== norm) { tx.date = norm; changed = true; }
    if (tx.dateStr !== undefined && tx.dateStr !== norm) { tx.dateStr = norm; changed = true; }
    // Si aucun des deux n’existait, on crée "date"
    if (tx.date === undefined && tx.dateStr === undefined) {
      tx.date = norm; changed = true;
    }
    return changed;
  }

  function normalizeAllTransactions() {
    try {
      const arr = Array.isArray(window.transactions) ? window.transactions : null;
      if (!arr) return false;
      let changed = false;
      for (const t of arr) {
        try { if (normalizeInPlace(t)) changed = true; } catch {}
      }
      return changed;
    } catch { return false; }
  }

  // Expose au besoin
  window.normalizeTxDatesNow = function() {
    const changed = normalizeAllTransactions();
    if (changed) {
      // Si ton app écoute cet event, elle re-rend le calendrier
      window.dispatchEvent(new Event('transactions-updated'));
    }
  };

  // Au chargement : normaliser une fois, puis MAJ l’UI si modifié
  document.addEventListener('DOMContentLoaded', () => {
    const changed = normalizeAllTransactions();
    if (changed) {
      // Laisse le thread libre puis notifie
      setTimeout(() => window.dispatchEvent(new Event('transactions-updated')), 0);
    }
  });

  // À chaque mise à jour externe des transactions, on tente de (re)normaliser
  // (sans reboucler : on ne redéclenche pas l’event ici)
  window.addEventListener('transactions-updated', () => {
    normalizeAllTransactions();
  });
})();

/* ==========================================================
   Watchdog post-refresh : normalise les dates dès que
   les transactions sont (re)chargées, puis notifie l'UI.
   - Appelle window.normalizeTxDatesNow() plusieurs fois
     pendant quelques secondes pour couvrir le chargement async.
   ========================================================== */
(function ensureDatesNormalizedAfterRefresh(){
  const TICK_MS = 700;     // fréquence de vérif
  const MAX_MS  = 15000;   // arrêt après 15 s
  let elapsed = 0;

  function tick(){
    // Si notre normaliseur existe, on le lance (idempotent)
    if (typeof window.normalizeTxDatesNow === 'function') {
      window.normalizeTxDatesNow();
    }
    elapsed += TICK_MS;
    if (elapsed >= MAX_MS) clearInterval(timer);
  }

  // Démarre après DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { tick(); });
  } else {
    tick();
  }

  // Boucle douce pendant MAX_MS
  const timer = setInterval(tick, TICK_MS);

  // Si ton app émet un évènement de fin de chargement, on s’y branche aussi
  ['transactions-loaded','data-loaded','storage-loaded'].forEach(ev => {
    window.addEventListener(ev, () => {
      if (typeof window.normalizeTxDatesNow === 'function') window.normalizeTxDatesNow();
    });
  });
})();

/* ==========================================================
   Stockage transactions — V2.1 (compat calendrier)
   - Persiste un TABLEAU complet dans localStorage.transactions_v2
   - Compat calendrier : `date` => "dd-mm-yyyy"
   - Ajoute `dateISO` => "yyyy-mm-dd" pour les calculs
   - Miroir legacy 'transactions' (tableau complet) avec `date` "dd-mm-yyyy"
   - Normalisation robuste des dates et montants
   ========================================================== */
(function txStoreV2_1(){
  'use strict';

  const V2_KEY    = 'transactions_v2';
  const LEGACY_KEY = 'transactions'; // certains modules la lisent encore

  // ---------- Helpers ----------
  function parseAmount(x){
    // Prend en charge "−500,00 €", " - 500.00", "(500)", etc.
    if (typeof x === 'number') return (Math.abs(x) < 1e-9) ? 0 : x;
    if (x == null) return 0;

    let s = String(x).trim();

    // Parenthèses => négatif
    let negParen = false;
    if (s.startsWith('(') && s.endsWith(')')) { negParen = true; s = s.slice(1, -1); }

    // Remplacer les minus “exotiques” par un vrai '-'
    s = s.replace(/[\u2212\u2012\u2013\u2014]/g, '-'); // −, ‒, –, —

    // Nettoyage espaces/monnaies/symboles
    s = s.replace(/\s+/g, '');
    s = s.replace(/[€$£₤]/g, '');

    // Si virgule décimale sans point -> on la convertit
    if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');

    // Supprimer tous les séparateurs de milliers possibles
    s = s.replace(/[,’'` \u00A0]/g, ''); // , ’ ' ` espace fine insécable &nbsp;

    // Ne garder que chiffres, point et tiret
    s = s.replace(/[^0-9.\-]/g, '');

    // Ne conserver qu'un seul '-' en tête si présent
    if (s.includes('-')) {
      const negative = s.trim().startsWith('-');
      s = s.replace(/-/g, '');
      if (negative) s = '-' + s;
    }

    let v = parseFloat(s);
    if (!Number.isFinite(v)) v = 0;
    if (negParen) v = -Math.abs(v);

    // Évite le -0
    if (Object.is(v, -0)) v = 0;
    if (Math.abs(v) < 1e-9) v = 0;

    return v;
  }

  function parseLooseDate(input){
    if (!input) return null;
    if (input instanceof Date && !isNaN(input)) return input;
    const s = String(input).trim();

    // dd-mm-yyyy
    let m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (m){ const d=new Date(+m[3], +m[2]-1, +m[1], 12, 0, 0); return isNaN(d)?null:d; }
    // dd/mm/yyyy
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m){ const d=new Date(+m[3], +m[2]-1, +m[1], 12, 0, 0); return isNaN(d)?null:d; }
    // yyyy/mm/dd
    m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (m){ const d=new Date(+m[1], +m[2]-1, +m[3], 12, 0, 0); return isNaN(d)?null:d; }

    const d = new Date(s);
    return isNaN(d) ? null : d;
  }

  function toISO(d){
    if (!(d instanceof Date) || isNaN(d)) return '';
    const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${dd}`;
  }

  function toFR(d){
    if (!(d instanceof Date) || isNaN(d)) return '';
    const dd=String(d.getDate()).padStart(2,'0'), m=String(d.getMonth()+1).padStart(2,'0'), y=d.getFullYear();
    return `${dd}-${m}-${y}`; // <-- format attendu par le calendrier
  }

  function normalizeTx(t){
    if (!t || typeof t !== 'object') return null;

    // ----- Date -----
    const rawDate = t.date ?? t.dateISO ?? t.day ?? t.jour ?? t.when ?? '';
    const d = parseLooseDate(rawDate);
    const dateISO = toISO(d) || '';
    const dateFR  = toFR(d)  || ''; // format attendu par le calendrier

    // ----- Description (fallbacks sûrs) -----
    const description =
      (t.description ?? t.label ?? t.libelle ?? t.titre ?? t.title ?? t.nom ?? t.name ?? t.memo ?? t.notes ?? '')
        .toString().trim() || '(Sans libellé)';

    // ----- Montant & type -----
    let amount = parseAmount(t.amount ?? t.montant ?? t.value ?? t.prix ?? t.total);
    let type = (t.type === 'income' || t.type === 'expense') ? t.type : (amount < 0 ? 'expense' : 'income');

    // Cohérence signe/type
    if (type === 'expense' && amount > 0) amount = -Math.abs(amount);
    if (type === 'income'  && amount < 0) amount =  Math.abs(amount);
    if (Math.abs(amount) < 1e-9) amount = 0; // évite -0

    const category = (t.category ?? t.categorie ?? t.cat ?? '').toString();

    return {
      id: t.id || (crypto?.randomUUID?.() ?? (Date.now()+'-'+Math.random())),
      description,
      category,
      type,
      amount,
      date: dateISO || dateFR || '',
      dateStr: dateFR || dateISO || ''
    };
  }

  // ---------- Lecture / écriture ----------
  function readV2(){
    try{
      const raw = localStorage.getItem(V2_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.map(normalizeTx).filter(Boolean) : [];
    }catch{ return []; }
  }

  function readLegacy(){
    try{
      const raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(normalizeTx).filter(Boolean);
      if (parsed && typeof parsed === 'object') return [normalizeTx(parsed)].filter(Boolean); // cas "dernière transaction seule"
      return [];
    }catch{ return []; }
  }

  function saveAll(list){
    try{
      const clean = (Array.isArray(list) ? list.map(normalizeTx).filter(Boolean) : []);
      // Persistance principale (V2)
      localStorage.setItem(V2_KEY, JSON.stringify(clean));
      // Miroir "legacy" (toujours un TABLEAU, pas un objet)
      localStorage.setItem(LEGACY_KEY, JSON.stringify(clean));
      // Laisse le reste de l'app gérer le rendu
    }catch{}
  }

  // ---------- Hydrate au chargement ----------
  function hydrateOnLoad(){
    let list = readV2();
    if (!list.length){
      // Migration depuis l’ancienne clé si besoin
      const legacy = readLegacy();
      if (legacy.length){
        list = legacy;
        saveAll(list);
      }
    }
    // Publie côté app (garde la même référence)
    if (!Array.isArray(window.transactions)) window.transactions = [];
    window.transactions.length = 0;
    list.forEach(t => window.transactions.push(t));

    // Notifie l’UI existante (calendrier/historique/…)
    window.dispatchEvent(new Event('transactions-updated'));
  }

  // ---------- Autosave ----------
  let lastSnapshot = '';
  function snapshot(list){
    try{ return JSON.stringify(list.map(t => ({id:t.id, date:t.date, amount:t.amount, type:t.type}))); }
    catch{ return ''; }
  }

  function tryAutosave(){
    const arr = Array.isArray(window.transactions) ? window.transactions.map(normalizeTx).filter(Boolean) : [];
    const snap = snapshot(arr);
    if (snap !== lastSnapshot){
      lastSnapshot = snap;
      saveAll(arr);
    }
  }

  window.addEventListener('transactions-updated', tryAutosave);
  setInterval(tryAutosave, 1000);
  window.addEventListener('beforeunload', tryAutosave);

  // ---------- Go (déféré pour éviter le FOUC) ----------
  (function initOnce(){
    let done = false;
    const run = async () => {
      if (done) return; done = true;
      try { await (document.fonts?.ready ?? Promise.resolve()); } catch {}
      requestAnimationFrame(() => { try { hydrateOnLoad(); } catch(e){ console.error(e); } });
    };
    if (document.readyState === 'complete') {
      run();
    } else {
      window.addEventListener('load', run, { once: true });
    }
  })();

})(); // fin IIFE txStoreV2_1

// --- Historique : rendu (tri décroissant par date)
function renderHistory(list){
  const container =
    document.getElementById('history-list') ||
    document.getElementById('history') ||
    document.querySelector('.history-list');
  if (!container) return;

  const TXS = Array.isArray(list) ? list : getUnifiedTransactions();

  // Parse date robuste (ISO ou formats FR)
  const toTime = (t) => {
    const iso = (t.date || t.dateISO || '').toString();
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return new Date(iso + 'T12:00:00').getTime();
    const raw = iso || t.day || t.dateStr || '';
    const d = (typeof parseLooseDate === 'function') ? parseLooseDate(raw) : new Date(raw);
    return isNaN(d) ? 0 : d.getTime();
  };

  const rows = [...TXS].sort((a,b) => toTime(b) - toTime(a)).map(t => {
    const amt = Number(t.amount) || 0;
    const dd  = (t.date || t.dateStr || '').replace(/-/g,'/'); // affichage simple
    return `
      <div class="hist-row" data-id="${t.id || ''}">
        <span class="h-date">${dd}</span>
        <span class="h-cat">${renderCategoryIconInline(t.category)}</span>
        <span class="h-desc">${(t.description || '').toString()}</span>
        <span class="h-amt ${amt < 0 ? 'neg' : 'pos'}">${formatAmount(amt)}</span>
      </div>
    `;
  });

  container.innerHTML = rows.join('') || '<div class="empty">Aucune transaction.</div>';
}

// --- Lance l'édition pour une transaction donnée (essaie plusieurs noms connus)
function tryOpenEdit(txId){
  if (!txId) return;
  const fns = [
    window.openEditModal,
    window.openEditTransaction,
    window.editTransaction,
    window.showEditModal
  ].filter(fn => typeof fn === 'function');

  if (fns.length) { try { fns[0](txId); } catch(e){ console.error(e); } return; }

  // Fallback : évènement global (au cas où ton app l'écoute)
  try {
    window.dispatchEvent(new CustomEvent('edit-transaction', { detail: { id: txId }}));
  } catch {}
  // Dernier recours : alerte dév
  console.warn('[calendar] Aucune fonction d’ouverture de modale trouvée pour txId=', txId);
}

/* === Modal choix transaction (édition) === */
function openEditChoiceForDate(dateIso){
  const all = getUnifiedTransactions();
  const list = all.filter(t => occursOnDate(t, dateIso));
  if (!list.length) return;
  if (list.length === 1) { tryOpenEdit(list[0].id); return; }
  openEditChoiceModal(list);
}

function openEditChoiceModal(list){
  const modal = document.getElementById('modal-pick-transaction');
  const body  = document.getElementById('mp-list');
  const btnOk = document.getElementById('mp-confirm');
  const btnCancel = document.getElementById('mp-cancel');
  const btnClose  = document.getElementById('mp-close');
  if (!modal || !body) return;

  // Liste (radios)
  const esc = (s)=>String(s||'').replace(/[&<>]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
  body.innerHTML = list.map((t, i) => {
    const id = esc(t.id || ('id'+i));
    const desc = esc(t.description || '');
    const amt  = Number(t.amount)||0;
    return `
      <label class="mp-item" style="display:flex;align-items:center;gap:.6rem;cursor:pointer;">
        <input type="radio" name="mp-choice" value="${id}" ${i===0?'checked':''}" style="margin-right:.4rem;">
        <span class="mp-icon">${renderCategoryIconInline(t.category)}</span>
        <span class="mp-desc" style="flex:1 1 auto;min-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${desc}</span>
        <span class="mp-amt ${amt<0?'neg':'pos'}" style="font-variant-numeric:tabular-nums;">${formatAmount(amt)}</span>
      </label>
    `;
  }).join('');

  let currentId = list[0]?.id || null;
  const update = () => {
    const r = body.querySelector('input[name="mp-choice"]:checked');
    currentId = r ? r.value : null;
    if (btnOk) { btnOk.disabled = !currentId; btnOk.toggleAttribute('aria-disabled', !currentId); }
  };
  body.querySelectorAll('input[name="mp-choice"]').forEach(r => {
    r.addEventListener('change', update);
    r.closest('.mp-item')?.addEventListener('dblclick', () => { hidePickModal(); tryOpenEdit(r.value); });
  });
  update();

  function showPickModal(){
    modal.style.display = 'grid';
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden','false');
    document.body.classList.add('modal-open'); // bloque le scroll
  }
  function hidePickModal(){
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden','true');
    modal.style.display = 'none';
    document.body.classList.remove('modal-open');
  }

  // actions
  btnOk.onclick = () => { if (!currentId) return; hidePickModal(); tryOpenEdit(currentId); };
  btnCancel.onclick = btnClose.onclick = hidePickModal;

  // clic sur le fond (en dehors de .modal-content) -> fermer
  modal.addEventListener('click', (e) => {
    if (e.target === modal) hidePickModal();
  }, { once:true });

  showPickModal();
}

/* ==== PATCH FOUC 2025-08-12 : rendus après CSS + polices ==== */
(function(){
  function onLoad(){
    Promise.resolve(document.fonts?.ready).catch(()=>{}).then(()=>{
      requestAnimationFrame(() => {
        try { window.renderStats?.(); } catch {}
        try { window.refreshUI?.(); } catch {}
      });
    });
  }
  if (document.readyState === 'complete') onLoad();
  else window.addEventListener('load', onLoad, { once:true });
})();
