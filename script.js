// --- Configuration Dropbox ---
const DROPBOX_APP_KEY = "sx9tl18fkusxm05"; // Mets TA clé ici
# github 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
const DROPBOX_FILE = "/transactions.json";

let dbx, accessToken = null;
let transactions = [];
let currentMonth = new Date();

function isDropboxConnected() {
  return !!accessToken;
}

// Authentifie l'utilisateur Dropbox via OAuth2
function loginDropbox() {
  // Utilise bien la même URL que dans ta config Dropbox
  const redirectUri = window.location.origin + window.location.pathname;
  const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${DROPBOX_APP_KEY}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}`;
  window.location.href = authUrl;
}

// Cherche le token d'accès dans l'URL (après login)
function parseDropboxTokenFromUrl() {
  if (window.location.hash.startsWith("#access_token=")) {
    const params = new URLSearchParams(window.location.hash.substr(1));
    accessToken = params.get("access_token");
    window.localStorage.setItem("dropbox_token", accessToken);
    window.location.hash = "";
  }
}

// Recharge le token depuis localStorage si présent
function restoreDropboxSession() {
  const saved = window.localStorage.getItem("dropbox_token");
  if (saved) accessToken = saved;
}

// Affiche l'état de la connexion
function updateDropboxStatus() {
  const status = document.getElementById('dropbox-status');
  if (!status) return;
  if (isDropboxConnected()) {
    status.textContent = "Connecté à Dropbox";
    status.style.color = "#2e7d32";
    document.getElementById('dropbox-login').style.display = "none";
  } else {
    status.textContent = "Non connecté";
    status.style.color = "#d32f2f";
    document.getElementById('dropbox-login').style.display = "";
  }
}

// Récupère le fichier JSON depuis Dropbox
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

// Sauvegarde le fichier JSON vers Dropbox
async function saveTransactionsDropbox() {
  try {
    await dbx.filesUpload({
      path: DROPBOX_FILE,
      contents: JSON.stringify(transactions, null, 2),
                          mode: { ".tag": "overwrite" }
    });
  } catch (e) {
    alert("Erreur lors de la sauvegarde Dropbox : " + e);
  }
}

// --- Picker Catégorie (identique à avant) ---
const CATEGORY_ICONS = [
  { type: 'fa', icon: 'fa-utensils', label: 'Repas' },
{ type: 'fa', icon: 'fa-cart-shopping', label: 'Courses' },
{ type: 'fa', icon: 'fa-car', label: 'Transport' },
{ type: 'fa', icon: 'fa-house', label: 'Logement' },
{ type: 'fa', icon: 'fa-film', label: 'Loisirs' },
{ type: 'fa', icon: 'fa-medkit', label: 'Santé' },
{ type: 'fa', icon: 'fa-graduation-cap', label: 'Éducation' },
{ type: 'fa', icon: 'fa-gas-pump', label: 'Essence' },
{ type: 'fa', icon: 'fa-dog', label: 'Animaux' },
{ type: 'fa', icon: 'fa-gift', label: 'Cadeaux' },
{ type: 'fa', icon: 'fa-sack-dollar', label: 'Salaire' },
{ type: 'fa', icon: 'fa-phone', label: 'Téléphone' },
{ type: 'mi', icon: 'savings', label: 'Épargne' },
{ type: 'mi', icon: 'subscriptions', label: 'Abonnements' },
{ type: 'mi', icon: 'sports_esports', label: 'Jeux' },
{ type: 'mi', icon: 'flight', label: 'Voyage' },
{ type: 'mi', icon: 'pets', label: 'Animaux' },
{ type: 'mi', icon: 'restaurant', label: 'Restaurant' },
{ type: 'mi', icon: 'store', label: 'Magasin' },
{ type: 'mi', icon: 'health_and_safety', label: 'Santé' },
{ type: 'mi', icon: 'directions_car', label: 'Voiture' },
{ type: 'mi', icon: 'home', label: 'Maison' },
];

function renderCategoryPicker() {
  const picker = document.getElementById('category-dropdown');
  picker.innerHTML = '';
  picker.style.display = 'grid';
  CATEGORY_ICONS.forEach(cat => {
    const span = document.createElement('span');
    span.className = 'cat-icon';
    span.title = cat.label;
    if (cat.type === 'fa') {
      span.innerHTML = `<i class="fa-solid ${cat.icon}"></i>`;
    } else if (cat.type === 'mi') {
      span.innerHTML = `<span class="material-icons">${cat.icon}</span>`;
    }
    span.addEventListener('click', () => {
      document.getElementById('category').value = JSON.stringify(cat);
      document.getElementById('selected-category').innerHTML = span.innerHTML;
      picker.style.display = 'none';
    });
    picker.appendChild(span);
  });
}

// Sauvegarde localStorage pour backup et fonctionnement hors-ligne
function saveTransactionsLocal() {
  localStorage.setItem('transactions', JSON.stringify(transactions));
}
function loadTransactionsLocal() {
  const saved = localStorage.getItem('transactions');
  if (saved) {
    try { transactions = JSON.parse(saved); } catch(e) {}
  }
}

// Ajout d'une transaction (identique à avant)
function addTransaction(event) {
  event.preventDefault();
  const type = document.getElementById('type').value;
  const categoryRaw = document.getElementById('category').value;
  const category = categoryRaw ? JSON.parse(categoryRaw) : null;
  const description = document.getElementById('description').value.trim();
  const amountValue = parseFloat(document.getElementById('amount').value);
  const dateValue = document.getElementById('date').value;
  const recurrence = document.getElementById('recurrence').value;
  const installments = parseInt(document.getElementById('installments').value);
  if (!description || isNaN(amountValue) || !dateValue || !category) {
    alert('Veuillez remplir tous les champs obligatoires, y compris la catégorie.');
    return;
  }
  const baseDate = new Date(dateValue);
  const id = Date.now();
  if (recurrence === 'installments' && installments && installments > 1) {
    const perAmount = parseFloat((amountValue / installments).toFixed(2));
    for (let i = 0; i < installments; i++) {
      const instDate = addMonths(baseDate, i);
      const tx = {
        id: id + '_' + i,
        type,
        category,
        description: `${description} (${i + 1}/${installments})`,
        amount: perAmount,
        date: formatDate(instDate),
        recurrence: 'none',
      };
      transactions.push(tx);
    }
  } else {
    const tx = {
      id: id,
      type,
      category,
      description,
      amount: amountValue,
      date: dateValue,
      recurrence,
    };
    transactions.push(tx);
  }
  saveTransactionsLocal();
  if (isDropboxConnected()) saveTransactionsDropbox();
  updateViews();
  event.target.reset();
  document.getElementById('installments-row').style.display = 'none';
  document.getElementById('category').value = '';
  document.getElementById('selected-category').innerHTML = '';
}

// Les autres fonctions (affichage, calcul, onglets, mode sombre) restent identiques.

function addMonths(date, months) { /* ... */ }
function formatDate(date) { /* ... */ }
function transactionsForDay(dateString) { /* ... */ }
function renderCalendar() { /* ... */ }
function displayDayDetails(dateString) { /* ... */ }
function renderTransactionList() { /* ... */ }
function renderStats() { /* ... */ }
function calculateSavings() { /* ... */ }
function exportToJSON() { /* ... */ }
function updateViews() {
  renderCalendar();
  renderTransactionList();
  renderStats();
}

document.addEventListener('DOMContentLoaded', () => {
  parseDropboxTokenFromUrl();
  restoreDropboxSession();
  if (isDropboxConnected()) {
    dbx = new Dropbox.Dropbox({ accessToken: accessToken, fetch: fetch });
    loadTransactionsDropbox();
  } else {
    loadTransactionsLocal();
    updateViews();
  }
  updateDropboxStatus();

  document.getElementById('dropbox-login').addEventListener('click', loginDropbox);

  renderCategoryPicker();
  const picker = document.getElementById('category-dropdown');
  const preview = document.getElementById('selected-category');
  preview.addEventListener('click', () => {
    picker.style.display = picker.style.display === 'grid' ? 'none' : 'grid';
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.category-picker')) picker.style.display = 'none';
  });

    const recSel = document.getElementById('recurrence');
    if (recSel) {
      recSel.addEventListener('change', e => {
        const val = e.target.value;
        const row = document.getElementById('installments-row');
        if (row) row.style.display = val === 'installments' ? 'flex' : 'none';
      });
    }
    const txForm = document.getElementById('transaction-form');
    if (txForm) txForm.addEventListener('submit', addTransaction);
    const prevBtn = document.getElementById('prev-month');
  if (prevBtn) prevBtn.addEventListener('click', () => {
    currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
    renderCalendar();
  });
  const nextBtn = document.getElementById('next-month');
  if (nextBtn) nextBtn.addEventListener('click', () => {
    currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
    renderCalendar();
  });
  const calcBtn = document.getElementById('calculate-saving');
  if (calcBtn) calcBtn.addEventListener('click', calculateSavings);
  const expBtn = document.getElementById('export-json');
  if (expBtn) expBtn.addEventListener('click', exportToJSON);

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(tab => tab.style.display = 'none');
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).style.display = 'block';
    });
  });

  const darkModeSwitch = document.getElementById('dark-mode-switch');
  if (localStorage.getItem('darkMode') === 'true') {
    document.body.classList.add('dark-mode');
    darkModeSwitch.checked = true;
  }
  darkModeSwitch.addEventListener('change', function() {
    if (darkModeSwitch.checked) {
      document.body.classList.add('dark-mode');
      localStorage.setItem('darkMode', 'true');
    } else {
      document.body.classList.remove('dark-mode');
      localStorage.setItem('darkMode', 'false');
    }
  });
});
