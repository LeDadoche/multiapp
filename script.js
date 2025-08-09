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

        const dayTx = transactions.filter(t => t.date === dStr);

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
    const dayTx = transactions.filter(t => t.date === selectedDate);

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
  const [set, name] = String(cat || '').split('::');
  if (set === 'fa') return `<i class="${name}" aria-hidden="true"></i>`;
  if (set === 'mi') return `<span class="material-icons" aria-hidden="true">${name}</span>`;
  if (set === 'bs') return `<i class="bi ${name}" aria-hidden="true"></i>`;
  return `<i class="fa-regular fa-circle-question" aria-hidden="true"></i>`;
}

// ====== LISTE / HISTORIQUE ======
function renderTransactionList() {
  const list = document.getElementById('transactions-list');
  if (!list) return;
  list.innerHTML = '';
  const sorted = [...transactions].sort((a,b) => new Date(b.date) - new Date(a.date));
  for (const tx of sorted) {
    const li = document.createElement('li');
    li.innerHTML = `
    <span>${renderCategoryIconInline(tx.category)} ${tx.description} — <strong>${tx.type === 'income' ? '+' : '-'}${Number(tx.amount).toFixed(2)}€</strong></span>
    <span>${new Date(tx.date).toLocaleDateString('fr-FR')}</span>
    <button class="remove-btn" title="Supprimer" aria-label="Supprimer">&#x2716;</button>
    `;
    li.querySelector('.remove-btn').addEventListener('click', () => {
      const idx = transactions.findIndex(t => t === tx);
      if (idx !== -1) {
        transactions.splice(idx, 1);
        saveTransactionsLocal();
        if (isDropboxConnected()) saveTransactionsDropbox();
        updateViews();
      }
    });
    li.addEventListener('dblclick', () => openEditModal(tx));
    list.appendChild(li);
  }
}

// ====== STATS ======
let pieChart;
function renderStats() {
  const canvas = document.getElementById('pie-chart');
  const info = document.getElementById('stats-info');
  if (!canvas || !info) return;

  const expense = transactions.filter(t => t.type === 'expense');
  const byCat = {};
  for (const tx of expense) {
    const key = tx.category || DEFAULT_CATEGORY;
    byCat[key] = (byCat[key] || 0) + Number(tx.amount || 0);
  }
  const labels = Object.keys(byCat);
  const values = labels.map(k => byCat[k]);

  if (pieChart) {
    pieChart.destroy();
    pieChart = null;
  }
  pieChart = new Chart(canvas.getContext('2d'), {
    type: 'pie',
    data: { labels, datasets: [{ data: values }] },
    options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
  });

  const total = values.reduce((a,b)=>a+b,0);
  info.textContent = `Total dépenses : ${total.toFixed(2)} €`;
}

// ====== Récapitulatif du mois (liste + tri + regroupement) ======
function renderMonthSummary() {
  const list = document.getElementById('month-tx-list');
  if (!list) return;

  const sortIcon = document.getElementById('month-sort-icon');
  const groupCheckbox = document.getElementById('group-by-category');

  const mKey = monthKey(currentMonth);
  const filtered = transactions.filter(t => monthKey(parseDate(t.date)) === mKey);

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
  if (!description || !dateISO || Number.isNaN(amount)) {
    alert('Merci de remplir correctement le formulaire.');
    return;
  }
  const recurrence = document.getElementById('recurrence').value;
  const applyPrev = document.getElementById('apply-previous').checked;

  const baseTx = { id: crypto.randomUUID(), type, category, description, amount, date: dateISO, recurrence: recurrence || 'none' };
  // Ajout de la transaction de base
  transactions.push(baseTx);

  // ===== Récurrence vers les mois précédents =====
  if (applyPrev && recurrence === 'monthly') {
    const start = parseDate(dateISO);
    for (let i = 1; i <= 11; i++) { // 11 mois précédents
      const prev = addMonths(start, -i);
      const lastOfMonth = new Date(prev.getFullYear(), prev.getMonth() + 1, 0);
      const day = Math.min(start.getDate(), lastOfMonth.getDate());
      const iso = formatDate(new Date(prev.getFullYear(), prev.getMonth(), day));
      transactions.push({ ...baseTx, id: crypto.randomUUID(), date: iso });
    }
  } else if (applyPrev && recurrence === 'yearly') {
    const d = parseDate(dateISO);
    const prevYear = new Date(d.getFullYear() - 1, d.getMonth(), d.getDate());
    const lastOfMonth = new Date(prevYear.getFullYear(), prevYear.getMonth() + 1, 0);
    const day = Math.min(d.getDate(), lastOfMonth.getDate());
    const iso = formatDate(new Date(prevYear.getFullYear(), prevYear.getMonth(), day));
    transactions.push({ ...baseTx, id: crypto.randomUUID(), date: iso });
  }

  saveTransactionsLocal();
  if (isDropboxConnected()) saveTransactionsDropbox();
  updateViews();
  ev.target.reset();
  document.getElementById('apply-previous-row').style.display = 'none';
}

function openEditModal(tx) {
  const modal = document.getElementById('modal-edit-transaction');
  if (!modal) return;
  document.getElementById('edit-id').value = tx.id;
  document.getElementById('edit-description').value = tx.description;
  document.getElementById('edit-amount').value = tx.amount;
  writeDateInput('edit-date', tx.date);
  document.getElementById('edit-type').value = tx.type;
  document.getElementById('edit-recurrence').value = tx.recurrence || 'none';
  modal.style.display = 'block';
}

function closeEditModal() {
  const modal = document.getElementById('modal-edit-transaction');
  if (modal) modal.style.display = 'none';
}
document.getElementById('edit-cancel-btn')?.addEventListener('click', closeEditModal);

document.getElementById('edit-transaction-form')?.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const id = document.getElementById('edit-id').value;
  const description = document.getElementById('edit-description').value.trim();
  const amount = Number(document.getElementById('edit-amount').value);
  const dateISO = readDateInput('edit-date'); // NEW
  const type = document.getElementById('edit-type').value;
  const recurrence = document.getElementById('edit-recurrence').value;
  const tx = transactions.find(t => t.id === id);
  if (!tx) return;

  tx.description = description;
  tx.amount = amount;
  tx.date = dateISO;
  tx.type = type;
  tx.recurrence = recurrence;

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

  if (!description || Number.isNaN(amount) || !dateISO) {
    alert('Merci de compléter la description, le montant et la date.');
    return;
  }

  const tx = {
    id: crypto.randomUUID(),
                                                                  type,
                                                                  category,
                                                                  description,
                                                                  amount,
                                                                  date: dateISO,
                                                                  recurrence: 'none',
  };

  transactions.push(tx);
  saveTransactionsLocal();
  if (isDropboxConnected()) saveTransactionsDropbox();
  updateViews();
  document.getElementById('modal-add-transaction').style.display = 'none';
});

document.getElementById('modal-add-transaction').addEventListener('click', function(e){
  if (e.target.id === 'modal-add-transaction' || e.target.id === 'add-cancel-btn') {
    document.getElementById('modal-add-transaction').style.display = 'none';
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

// === Auth application (mot de passe local simple) ===
async function hashPassword(pwd) {
  const enc = new TextEncoder();
  const buffer = await crypto.subtle.digest('SHA-256', enc.encode(pwd));
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Affiche une fenêtre modale demandant la création ou l'entrée d'un mot de passe avant d'utiliser l'application
function setupAuthentication(callback) {
  const overlay = document.getElementById('auth-overlay');
  const titleEl = document.getElementById('auth-title');
  const confirmRow = document.getElementById('auth-confirm-row');
  const form = document.getElementById('auth-form');
  const pwdInput = document.getElementById('auth-password');
  const confirmInput = document.getElementById('auth-password-confirm');

  const storedHash = localStorage.getItem('appPasswordHash');

  if (sessionStorage.getItem('unlocked') === '1') {
    if (typeof callback === 'function') callback();
    return;
  }

  if (!storedHash) {
    titleEl.textContent = 'Créer un mot de passe';
    confirmRow.style.display = '';
  } else {
    titleEl.textContent = 'Saisir le mot de passe';
    confirmRow.style.display = 'none';
  }

  overlay.style.display = 'block';

  form.onsubmit = async (e) => {
    e.preventDefault();
    const pwd = pwdInput.value;
    if (!storedHash) {
      const confirm = confirmInput.value;
      if (!pwd || pwd !== confirm) {
        alert('Les mots de passe ne correspondent pas.');
        return;
      }
      const hash = await hashPassword(pwd);
      localStorage.setItem('appPasswordHash', hash);
      sessionStorage.setItem('unlocked', '1');
      overlay.style.display = 'none';
      if (typeof callback === 'function') callback();
    } else {
      if (!pwd) {
        alert('Merci de saisir votre mot de passe.');
        return;
      }
      const hash = await hashPassword(pwd);
      if (hash === storedHash) {
        sessionStorage.setItem('unlocked', '1');
        overlay.style.display = 'none';
        if (typeof callback === 'function') callback();
      } else {
        alert('Mot de passe incorrect.');
      }
    }
  };
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

    if (isDropboxConnected()) {
      dbx = new Dropbox.Dropbox({ accessToken: accessToken });
      loadTransactionsDropbox();
    } else {
      loadTransactionsLocal();
      updateViews();
    }

    updateDropboxStatus();
    updateGoogleStatus();
    updateMSStatus();
    __attachDatePickers();

    // Pickers catégories
    renderCategoryPicker();
    renderQuickAddPicker();

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
    document.getElementById('dropbox-login').addEventListener('click', loginDropbox);
    document.getElementById('dropbox-logout').addEventListener('click', logoutDropbox);
    document.getElementById('google-login').addEventListener('click', loginGoogle);
    document.getElementById('google-logout').addEventListener('click', logoutGoogle);
    document.getElementById('ms-login').addEventListener('click', loginMS);
    document.getElementById('ms-logout').addEventListener('click', logoutMS);

    // Onglets finances
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
    const recSel = document.getElementById('recurrence');
    const applyPrevRow = document.getElementById('apply-previous-row');
    if (recSel && applyPrevRow) {
      const syncApplyPrev = () => { applyPrevRow.style.display = (recSel.value === 'monthly') ? '' : 'none'; };
      recSel.addEventListener('change', syncApplyPrev);
      syncApplyPrev(); // état initial
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
    document.getElementById('transaction-form').addEventListener('submit', addTransaction);
    document.getElementById('prev-month').addEventListener('click', () => {
      currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
      renderCalendar();
      renderMonthSummary();
    });
    document.getElementById('next-month').addEventListener('click', () => {
      currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
      renderCalendar();
      renderMonthSummary();
    });
    document.getElementById('go-today').addEventListener('click', () => {
      currentMonth = new Date();
      updateViews();
    });

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
