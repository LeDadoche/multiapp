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

// ====== Catégories / couleurs / icônes ======
const CATEGORY_COLORS = {
  "logement": "#90caf9",
  "alimentation": "#ffcc80",
  "transport": "#a5d6a7",
  "loisirs": "#ce93d8",
  "santé": "#f48fb1",
  "abonnements": "#80cbc4",
  "animaux": "#e6ee9c",
  "cadeaux": "#ffe082",
  "autre": "#b0bec5"
};
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
  // On repasse en local uniquement
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

// ====== LISTE / HISTORIQUE ======
function renderTransactionList() {
  const list = document.getElementById('transactions-list');
  if (!list) return;
  list.innerHTML = '';

  // Affiche UNIQUEMENT les "bases" (pas d’expansion)
  const sorted = [...transactions].sort((a,b) => new Date(b.date) - new Date(a.date));

  const badge = (tx) => {
    if (!tx.recurrence || tx.recurrence === 'none') return '';
    if (tx.recurrence === 'monthly') return '<span class="tx-badge" title="Mensuelle">Mensuelle</span>';
    if (tx.recurrence === 'yearly')  return '<span class="tx-badge" title="Annuelle">Annuelle</span>';
    if (tx.recurrence === 'installments') return `<span class="tx-badge" title="Échéances">Échéances${tx.installments?` ×${tx.installments}`:''}</span>`;
    return '';
  };

  for (const tx of sorted) {
    const li = document.createElement('li');
    li.innerHTML = `
    <span style="display:flex; align-items:center; gap:.4em;">
    ${renderCategoryIconInline(tx.category)}
    <span>${tx.description}</span>
    ${badge(tx)}
    </span>
    <span>${new Date(tx.date).toLocaleDateString('fr-FR')}</span>
    <span style="display:flex; gap:.4em;">
    <button class="edit-btn"  title="Modifier"  aria-label="Modifier">✏️</button>
    <button class="remove-btn" title="Supprimer" aria-label="Supprimer">🗑️</button>
    </span>
    `;

    li.querySelector('.edit-btn').addEventListener('click', () => openEditModal(tx));
    li.querySelector('.remove-btn').addEventListener('click', () => {
      if (confirm(`Supprimer "${tx.description}" (série entière) ?`)) {
        transactions = transactions.filter(t => t.id !== tx.id);
        saveTransactionsLocal();
        if (isDropboxConnected()) saveTransactionsDropbox();
        updateViews();
      }
    });

    // Double‑clic = éditer
    li.addEventListener('dblclick', () => openEditModal(tx));

    list.appendChild(li);
  }
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


// ====== Récapitulatif du mois (liste + tri + regroupement) ======
function renderMonthSummary() {
  const list = document.getElementById('month-tx-list');
  if (!list) return;

  const sortIcon = document.getElementById('month-sort-icon');
  const groupCheckbox = document.getElementById('group-by-category');

  const y = currentMonth.getFullYear();
  const m0 = currentMonth.getMonth();
  const startIso = formatDate(new Date(y, m0, 1));
  const endIso   = formatDate(new Date(y, m0 + 1, 0));
  const filtered = expandTransactionsBetween(startIso, endIso);

  const sorted = [...filtered].sort((a, b) => {
    if (monthSortMode === 'date-asc') return new Date(a.date) - new Date(b.date);
    if (monthSortMode === 'date-desc') return new Date(b.date) - new Date(a.date);
    if (monthSortMode === 'amount-asc') return Number(a.amount) - Number(b.amount);
    if (monthSortMode === 'amount-desc') return Number(b.amount) - Number(a.amount);
    return 0;
  });

  if (sortIcon) {
    sortIcon.className = {
      'date-asc':  'fa-solid fa-calendar-day',
      'date-desc': 'fa-solid fa-calendar-days',
      'amount-asc':'fa-solid fa-arrow-down-1-9',
      'amount-desc':'fa-solid fa-arrow-down-9-1'
    }[monthSortMode] || 'fa-solid fa-calendar-day';
  }

  list.innerHTML = '';

  if (groupCheckbox && groupCheckbox.checked) {
    const groups = {};
    for (const tx of sorted) {
      const k = tx.category || DEFAULT_CATEGORY;
      (groups[k] = groups[k] || []).push(tx);
    }
    Object.keys(groups).forEach(cat => {
      const header = document.createElement('li');
      header.style.fontWeight = '700';
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.innerHTML = `${renderCategoryIconInline(cat)}&nbsp;${cat} — ${groups[cat].reduce((s,t)=>s+Number(t.amount),0).toFixed(2)}€`;
      const toggleBtn = document.createElement('button');
      toggleBtn.textContent = '▾';
      toggleBtn.style.marginLeft = 'auto';
      toggleBtn.style.border = 'none';
      toggleBtn.style.background = 'transparent';
      toggleBtn.style.cursor = 'pointer';
      header.appendChild(toggleBtn);
      list.appendChild(header);

      const ul = document.createElement('ul');
      ul.style.listStyle = 'none';
      ul.style.paddingLeft = '1em';
      groups[cat].forEach(tx => {
        const li = document.createElement('li');
        li.innerHTML = `${new Date(tx.date).toLocaleDateString('fr-FR')} — ${tx.description} — <strong>${tx.type === 'income' ? '+' : '-'}${Number(tx.amount).toFixed(2)}€</strong>`;
        ul.appendChild(li);
      });
      list.appendChild(ul);

      let open = true;
      toggleBtn.addEventListener('click', () => {
        open = !open;
        ul.style.display = open ? '' : 'none';
        toggleBtn.textContent = open ? '▾' : '▸';
      });
    });
  } else {
    for (const tx of sorted) {
      const li = document.createElement('li');
      li.innerHTML = `
      <span>${renderCategoryIconInline(tx.category)} ${tx.description}</span>
      <span>${new Date(tx.date).toLocaleDateString('fr-FR')} — <strong>${tx.type === 'income' ? '+' : '-'}${Number(tx.amount).toFixed(2)}€</strong></span>
      `;
      list.appendChild(li);
    }
  }
}

// ====== Formulaires ======
function addTransaction(ev) {
  ev.preventDefault();
  const type = document.getElementById('type').value;
  const category = document.getElementById('category').value || DEFAULT_CATEGORY;
  const description = document.getElementById('description').value.trim();
  const amount = Number(document.getElementById('amount').value);
  const dateISO = readDateInput('date');
  const recurrence = document.getElementById('recurrence').value;
  const untilISO = readDateInput('recurrence-end'); // ⬅️ nouveau
  const installmentsEl = document.getElementById('installments');
  const installments = installmentsEl ? Number(installmentsEl.value || 0) : 0;

  // “appliquer aux mois antérieurs” (virtuel, pas de duplication)
  const applyPrev = document.getElementById('apply-previous')?.checked || false;

  if (!description || !dateISO || Number.isNaN(amount)) {
    alert('Merci de remplir correctement le formulaire.');
    return;
  }

  const tx = {
    id: crypto.randomUUID(),
    type, category, description, amount,
    date: dateISO,
    recurrence: recurrence || 'none',
    applyPrev: applyPrev || false
  };

  if (untilISO) tx.until = untilISO;
  if (tx.recurrence === 'installments' && installments >= 2) {
    tx.installments = installments;
  }

  transactions.push(tx);
  saveTransactionsLocal();
  if (isDropboxConnected()) saveTransactionsDropbox();
  updateViews();

  ev.target.reset();
  document.getElementById('apply-previous-row').style.display = 'none';
  document.getElementById('recurrence-end-row').style.display = 'none';
  document.getElementById('installments-row').style.display = 'none';
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

    if (isDropboxConnected() && hasDropboxSDK) {
      try {
        dbx = new Dropbox.Dropbox({ accessToken });
        loadTransactionsDropbox();
      } catch (e) {
        console.warn('Dropbox init failed, fallback local:', e);
        loadTransactionsLocal();
        updateViews();
      }
    } else {
      if (isDropboxConnected() && !hasDropboxSDK) {
        console.warn('Dropbox token present but SDK missing. Falling back to local.');
        // Optionnel: on "déconnecte" proprement pour éviter de retomber dedans au prochain chargement
        accessToken = null;
        localStorage.removeItem('dropbox_token');
        updateDropboxStatus?.();
      }
      loadTransactionsLocal();
      updateViews();
    }

    updateDropboxStatus();
    updateGoogleStatus();
    updateMSStatus();
    __attachDatePickers();

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

    // Écouteurs pour les services cloud
    // 2) Boutons Cloud (tous en ?.)
    document.getElementById('dropbox-login') ?.addEventListener('click', loginDropbox);
    document.getElementById('dropbox-logout')?.addEventListener('click', logoutDropbox);
    document.getElementById('google-login')  ?.addEventListener('click', loginGoogle);
    document.getElementById('google-logout') ?.addEventListener('click', logoutGoogle);
    document.getElementById('ms-login')      ?.addEventListener('click', loginMS);
    document.getElementById('ms-logout')     ?.addEventListener('click', logoutMS);

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
