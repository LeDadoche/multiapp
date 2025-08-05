// --- Configuration Dropbox ---
const DROPBOX_APP_KEY = "sx9tl18fkusxm05";
const DROPBOX_FILE = "/transactions.json";

let dbx, accessToken = null;
let transactions = [];
let currentMonth = new Date();

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

// Jours fériés France (calcul dynamique)
const FRENCH_HOLIDAYS = (year) => ({
  [`${year}-01-01`]: "Jour de l'An",
  [`${year}-05-01`]: "Fête du Travail",
  [`${year}-05-08`]: "Victoire 1945",
  [`${year}-07-14`]: "Fête Nationale",
  [`${year}-08-15`]: "Assomption",
  [`${year}-11-01`]: "Toussaint",
  [`${year}-11-11`]: "Armistice 1918",
  [`${year}-12-25`]: "Noël",
  ...(() => {
    function calcEaster(year) {
      const f = Math.floor, G = year % 19, C = f(year / 100), H = (C - f(C / 4) - f((8*C+13)/25) + 19*G + 15) % 30,
            I = H - f(H/28)*(1 - f(29/(H+1))*f((21-G)/11)),
            J = (year + f(year/4) + I + 2 - C + f(C/4)) % 7,
            L = I - J, month = 3 + f((L+40)/44), day = L + 28 - 31*f(month/4);
      return new Date(year, month-1, day);
    }
    let y = year;
    let easter = calcEaster(y);
    let pad = n => n.toString().padStart(2, "0");
    let d = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}`;
    let holidays = {};
    let lundiPaques = new Date(easter); lundiPaques.setDate(easter.getDate() + 1);
    holidays[d(lundiPaques)] = "Lundi de Pâques";
    let ascension = new Date(easter); ascension.setDate(easter.getDate() + 39);
    holidays[d(ascension)] = "Ascension";
    let pentecote = new Date(easter); pentecote.setDate(easter.getDate() + 50);
    holidays[d(pentecote)] = "Lundi de Pentecôte";
    return holidays;
  })()
});

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
  if (!status) return;
  if (isDropboxConnected()) {
    status.textContent = "Connecté à Dropbox";
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

// --- Picker Catégorie
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
      document.getElementById('selected-category').dataset.placeholder = "";
    });
    picker.appendChild(span);
  });
}

// --- Storage local
function saveTransactionsLocal() {
  localStorage.setItem('transactions', JSON.stringify(transactions));
}
function loadTransactionsLocal() {
  const saved = localStorage.getItem('transactions');
  if (saved) {
    try { transactions = JSON.parse(saved); } catch(e) {}
  }
}

// Ajout transaction
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
  document.getElementById('selected-category').innerHTML = `<i class="fa-regular fa-circle-question"></i>`;
  document.getElementById('selected-category').dataset.placeholder = "1";
}

// Transactions pour un jour (récurrences incluses)
function transactionsForDay(dateString) {
  const selectedDate = new Date(dateString);
  const day = selectedDate.getDate();
  const list = [];
  for (const tx of transactions) {
    const txDate = new Date(tx.date);
    if (tx.recurrence === 'monthly') {
      // Si la date du mois courant >= date de départ de la transaction récurrente
      if (
        txDate.getDate() === day &&
        (selectedDate.getFullYear() > txDate.getFullYear() ||
         (selectedDate.getFullYear() === txDate.getFullYear() && selectedDate.getMonth() >= txDate.getMonth()))
      ) {
        list.push({ ...tx, date: formatDate(selectedDate) });
      }
    } else if (formatDate(txDate) === dateString) {
      list.push(tx);
    }
  }
  return list;
}

// --- CALENDRIER
function renderCalendar() {
  const calendar = document.getElementById('calendar');
  calendar.innerHTML = '';
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const today = new Date();
  const todayStr = formatDate(today);

  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0);
  const daysInMonth = monthEnd.getDate();

  const dayNames = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
  const headerRow = document.createElement('tr');
  for (const name of dayNames) {
    const th = document.createElement('th');
    th.textContent = name;
    headerRow.appendChild(th);
  }
  calendar.appendChild(headerRow);

  const firstDayIndex = (monthStart.getDay() + 6) % 7;
  let dateCounter = 1;
  const holidays = FRENCH_HOLIDAYS(year);

  let weeks = Math.ceil((daysInMonth + firstDayIndex) / 7);
  for (let row = 0; row < weeks; row++) {
    const tr = document.createElement('tr');
    for (let col = 0; col < 7; col++) {
      const td = document.createElement('td');
      if (row === 0 && col < firstDayIndex) {
        td.innerHTML = '&nbsp;';
      } else if (dateCounter > daysInMonth) {
        td.innerHTML = '&nbsp;';
      } else {
        const dateObj = new Date(year, month, dateCounter);
        const dateString = formatDate(dateObj);

        const divDayNumber = document.createElement('div');
        divDayNumber.className = 'day-number';
        divDayNumber.textContent = dateCounter;
        td.appendChild(divDayNumber);

        const txDay = transactionsForDay(dateString);
        txDay.forEach(tx => {
          const dot = document.createElement('span');
          dot.className = 'event-dot';
          if (tx.category && tx.category.type === 'fa') {
            dot.innerHTML = `<i class="fa-solid ${tx.category.icon}"></i>`;
          } else if (tx.category && tx.category.type === 'mi') {
            dot.innerHTML = `<span class="material-icons">${tx.category.icon}</span>`;
          } else {
            dot.style.backgroundColor = tx.type === 'income' ? '#4caf50' : '#e53935';
          }
          td.appendChild(dot);
        });

        td.dataset.date = dateString;
        td.addEventListener('click', () => {
          displayDayDetails(dateString);
          const allCells = calendar.querySelectorAll('td');
          allCells.forEach(c => c.classList.remove('selected'));
          td.classList.add('selected');
        });

        // *** Ajoute le double-clic pour ajouter une transaction rapide ***
        td.addEventListener('dblclick', () => {
          openAddTransactionModal(dateString);
        });

        const dayOfWeek = (dateObj.getDay() + 6) % 7;
        if (dayOfWeek >= 5) td.classList.add('calendar-weekend');
        if (holidays[dateString]) {
          td.classList.add('calendar-holiday');
          td.title = holidays[dateString];
        }
        if (dateString === formatDate(today) && year === today.getFullYear() && month === today.getMonth()) {
          td.classList.add('calendar-today');
        }
        dateCounter++;
      }
      tr.appendChild(td);
    }
    calendar.appendChild(tr);
  }
  const monthNames = [
    'Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'
  ];
  document.getElementById('current-month').textContent = `${monthNames[month]} ${year}`;
}

function displayDayDetails(dateString) {
  const container = document.getElementById('day-details');
  const txDay = transactionsForDay(dateString);
  if (txDay.length === 0) {
    container.innerHTML = '<p>Aucune transaction pour ce jour.</p>';
    return;
  }
  let html = `<h3>Détails du ${dateString}</h3>`;
  html += '<ul>';
  txDay.forEach(tx => {
    const amountStr = `${tx.amount.toFixed(2)} €`;
    let icon = '';
    if (tx.category && tx.category.type === 'fa')
      icon = `<i class="fa-solid ${tx.category.icon}" style="margin-right:6px"></i>`;
    else if (tx.category && tx.category.type === 'mi')
      icon = `<span class="material-icons" style="font-size:1em;margin-right:6px">${tx.category.icon}</span>`;
    html += `<li>${icon}<strong>${tx.type === 'income' ? 'Revenu' : 'Dépense'} :</strong> ${tx.description} – <em>${amountStr}</em></li>`;
  });
  html += '</ul>';
  container.innerHTML = html;
}

// Nouvelle logique pour afficher les transactions mensuelles “à partir de la date de départ”
function transactionsForDay(dateString) {
  const selectedDate = new Date(dateString);
  const day = selectedDate.getDate();
  const list = [];
  for (const tx of transactions) {
    const txDate = new Date(tx.date);
    if (tx.recurrence === 'monthly') {
      // La transaction doit apparaître UNIQUEMENT si date courante >= date de départ
      if (
        txDate.getDate() === day &&
        (selectedDate.getFullYear() > txDate.getFullYear() ||
         (selectedDate.getFullYear() === txDate.getFullYear() && selectedDate.getMonth() >= txDate.getMonth()))
      ) {
        list.push({ ...tx, date: formatDate(selectedDate) });
      }
    } else if (formatDate(txDate) === dateString) {
      list.push(tx);
    }
  }
  return list;
}

// Liste des transactions
function renderTransactionList() {
  const list = document.getElementById('transactions-list');
  list.innerHTML = '';
  const sorted = [...transactions].sort((a,b) => new Date(a.date) - new Date(b.date));
  sorted.forEach(tx => {
    const li = document.createElement('li');
    let icon = '';
    if (tx.category && tx.category.type === 'fa')
      icon = `<i class="fa-solid ${tx.category.icon}" style="margin-right:8px"></i>`;
    else if (tx.category && tx.category.type === 'mi')
      icon = `<span class="material-icons" style="font-size:1em;margin-right:8px">${tx.category.icon}</span>`;
    const text = `${tx.date} – ${icon}${tx.description} – ${tx.type === 'income' ? '+' : '-'}${tx.amount.toFixed(2)} €`;
    li.innerHTML = text;
    const btnEdit = document.createElement('button');
    btnEdit.className = 'edit-btn';
    btnEdit.title = 'Modifier';
    btnEdit.textContent = '✎';
    btnEdit.addEventListener('click', () => {
      openEditTransactionModal(tx);
    });
    li.appendChild(btnEdit); // Place-le avant/sur la droite du bouton supprimer
    const btn = document.createElement('button');
    btn.className = 'remove-btn';
    btn.textContent = '×';
    btn.addEventListener('click', () => {
      if (confirm('Supprimer cette transaction ?')) {
        transactions = transactions.filter(item => item.id !== tx.id);
        saveTransactionsLocal();
        if (isDropboxConnected()) saveTransactionsDropbox();
        updateViews();
      }
    });
    li.appendChild(btn);
    list.appendChild(li);
  });
}
// Statistiques
function renderStats() {
  const chartContainer = document.getElementById('chart-container');
  chartContainer.innerHTML = '';
  const categoryTotals = {};
  let totalIncome = 0;
  let totalExpense = 0;
  for (const tx of transactions) {
    if (tx.recurrence === 'monthly') {
      totalExpense += tx.type === 'expense' ? tx.amount : 0;
      totalIncome += tx.type === 'income' ? tx.amount : 0;
      categoryTotals[tx.description] = (categoryTotals[tx.description] || 0) + tx.amount;
    } else {
      if (tx.type === 'income') totalIncome += tx.amount;
      else totalExpense += tx.amount;
      categoryTotals[tx.description] = (categoryTotals[tx.description] || 0) + tx.amount;
    }
  }
  const expenseCategories = Object.keys(categoryTotals).filter(desc =>
    transactions.some(tx => tx.description === desc && tx.type === 'expense')
  );
  expenseCategories.sort((a,b) => categoryTotals[b] - categoryTotals[a]);
  const maxVal = Math.max(...expenseCategories.map(desc => categoryTotals[desc]), 0);
  const colors = ['#e57373','#f06292','#ba68c8','#9575cd','#7986cb','#64b5f6','#4db6ac','#81c784','#dce775','#fff176','#ffd54f','#ffb74d','#ff8a65','#a1887f'];
  expenseCategories.forEach((desc, idx) => {
    const barRow = document.createElement('div');
    barRow.className = 'bar';
    const label = document.createElement('span');
    label.className = 'bar-label';
    label.textContent = desc;
    const value = document.createElement('div');
    value.className = 'bar-value';
    const percent = maxVal ? (categoryTotals[desc] / maxVal) * 100 : 0;
    value.style.width = `${percent}%`;
    value.style.backgroundColor = colors[idx % colors.length];
    value.title = `${categoryTotals[desc].toFixed(2)} €`;
    barRow.appendChild(label);
    barRow.appendChild(value);
    chartContainer.appendChild(barRow);
  });
  const statsInfo = document.getElementById('stats-info');
  statsInfo.innerHTML = `<strong>Total revenus :</strong> ${totalIncome.toFixed(2)} €<br>` +
    `<strong>Total dépenses :</strong> ${totalExpense.toFixed(2)} €<br>` +
    `<strong>Solde :</strong> ${(totalIncome - totalExpense).toFixed(2)} €`;
}
function calculateSavings() {
  const salaryVal = parseFloat(document.getElementById('salary').value);
  const savingsDesired = parseFloat(document.getElementById('savings').value);
  if (isNaN(salaryVal)) {
    alert('Veuillez saisir votre salaire.');
    return;
  }
  const month = currentMonth;
  let monthlyExpense = 0;
  transactions.forEach(tx => {
    if (tx.type === 'expense') {
      if (tx.recurrence === 'monthly') {
        monthlyExpense += tx.amount;
      } else {
        const d = new Date(tx.date);
        if (d.getFullYear() === month.getFullYear() && d.getMonth() === month.getMonth()) {
          monthlyExpense += tx.amount;
        }
      }
    }
  });
  const leftover = salaryVal - monthlyExpense - (isNaN(savingsDesired) ? 0 : savingsDesired);
  const result = document.getElementById('saving-result');
  if (!isNaN(savingsDesired)) {
    result.textContent = `Après avoir mis ${savingsDesired.toFixed(2)} € de côté et payé vos dépenses du mois, il vous restera ${leftover.toFixed(2)} €.`;
  } else {
    result.textContent = `Il vous restera ${leftover.toFixed(2)} € après vos dépenses.`;
  }
}
function renderPieChart() {
  const ctx = document.getElementById('pie-chart').getContext('2d');
  new Chart(ctx, {
    type: 'pie',
    data: {
      labels: expenseCategories, // Array des noms de catégories
      datasets: [{
        data: expenseCategories.map(desc => categoryTotals[desc]),
        backgroundColor: colors.slice(0, expenseCategories.length),
      }]
    }
  });
}

function exportToJSON() {
  const dataStr = JSON.stringify(transactions, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'transactions.json';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
function updateViews() {
  renderCalendar();
  renderTransactionList();
  renderStats();
}

// --- INIT ---
document.addEventListener('DOMContentLoaded', () => {
  parseDropboxTokenFromUrl();
  restoreDropboxSession();
  if (isDropboxConnected()) {
    dbx = new Dropbox.Dropbox({ accessToken: accessToken });
    loadTransactionsDropbox();
  } else {
    loadTransactionsLocal();
    updateViews();
  }
  updateDropboxStatus();

  document.getElementById('dropbox-login').addEventListener('click', loginDropbox);

  renderCategoryPicker();
  const picker = document.getElementById('category-dropdown');
  const selectedCat = document.getElementById('selected-category');
  selectedCat.innerHTML = `<i class="fa-regular fa-circle-question"></i>`;
  selectedCat.dataset.placeholder = "1";
  selectedCat.addEventListener('click', () => {
    picker.style.display = picker.style.display === 'grid' ? 'none' : 'grid';
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.category-picker')) picker.style.display = 'none';
  });
  document.getElementById('dropbox-logout').addEventListener('click', logoutDropbox);
  document.getElementById('recurrence').addEventListener('change', e => {
    const val = e.target.value;
    const row = document.getElementById('installments-row');
    if (row) row.style.display = val === 'installments' ? 'flex' : 'none';
  });
  document.getElementById('transaction-form').addEventListener('submit', addTransaction);
  document.getElementById('prev-month').addEventListener('click', () => {
    currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
    renderCalendar();
  });
  document.getElementById('next-month').addEventListener('click', () => {
    currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
    renderCalendar();
  });
  document.getElementById('go-today').addEventListener('click', () => {
  currentMonth = new Date();
  updateViews();
  });
  document.getElementById('calculate-saving').addEventListener('click', calculateSavings);
  document.getElementById('export-json').addEventListener('click', exportToJSON);

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(tab => tab.style.display = 'none');
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).style.display = 'block';
    });
  });

  // --- MODE SOMBRE ---
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
  updateLegendColors(true); // ← IMPORTANT : force le changement de palette
  renderCalendar();
});

function updateLegendColors(force = false) {
  const isDark = document.body.classList.contains('dark-mode');
  const defs = isDark ? DEFAULT_COLORS_DARK : DEFAULT_COLORS_LIGHT;

  document.querySelectorAll('.legend-color').forEach(span => {
    const v = span.dataset.var;
    let current = getComputedStyle(document.documentElement).getPropertyValue(v).trim();

    // Si force (changement de thème), ou la couleur correspond à celle du thème précédent
    if (force || current === (isDark ? DEFAULT_COLORS_LIGHT[v] : DEFAULT_COLORS_DARK[v])) {
      document.documentElement.style.setProperty(v, defs[v]);
      span.style.background = defs[v];
    } else {
      // Sinon, laisse la couleur personnalisée
      span.style.background = current;
    }
  });
}

const DEFAULT_COLORS_LIGHT = {
  '--color-weekend': '#d1ecfb',
  '--color-holiday': '#fffbe6',
  '--color-today': '#fda7a7',
  '--color-primary': '#65b8f7',
};
const DEFAULT_COLORS_DARK = {
  '--color-weekend': '#23373a',    // doux bleu-vert
  '--color-holiday': '#40361a',    // marron chaud doux
  '--color-today': '#6c464e',      // prune douce
  '--color-primary': '#27524b',    // ton vert demandé
};
document.querySelectorAll('.legend-reset').forEach(resetBtn => {
  resetBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    const v = resetBtn.dataset.var;
    const isDark = document.body.classList.contains('dark-mode');
    const defColor = isDark ? DEFAULT_COLORS_DARK[v] : DEFAULT_COLORS_LIGHT[v];
    document.documentElement.style.setProperty(v, defColor);
    document.querySelectorAll(`.legend-color[data-var="${v}"]`).forEach(
      el => el.style.background = defColor
    );
    renderCalendar();
  });
});

  // --- Couleurs légende calendrier
  document.querySelectorAll('.legend-color').forEach(span => {
    span.addEventListener('click', function(e) {
      e.stopPropagation();
      let color = getComputedStyle(document.documentElement).getPropertyValue(span.dataset.var).trim();
      const input = document.createElement('input');
      input.type = 'color';
      input.value = rgbToHex(color);
      input.style.display = 'block';
      input.addEventListener('input', () => {
        document.documentElement.style.setProperty(span.dataset.var, input.value);
        span.style.background = input.value;
        renderCalendar();
      });
      input.click();
      setTimeout(() => input.remove(), 300);
    });
  });
});

// Petit utilitaire pour convertir rgb en hex
function rgbToHex(rgb) {
  if (!rgb.startsWith('rgb')) return rgb;
  let nums = rgb.match(/\d+/g);
  if (!nums) return rgb;
  return "#" + nums.map(x => Number(x).toString(16).padStart(2, "0")).join('');
}
function openEditTransactionModal(tx) {
  // Affiche la modale et pré-remplit le formulaire
  document.getElementById('modal-edit-transaction').style.display = 'flex';
  document.getElementById('edit-id').value = tx.id;
  document.getElementById('edit-description').value = tx.description;
  document.getElementById('edit-amount').value = tx.amount;
  document.getElementById('edit-date').value = tx.date;
  document.getElementById('edit-type').value = tx.type;
}

document.getElementById('edit-cancel-btn').onclick = function() {
  document.getElementById('modal-edit-transaction').style.display = 'none';
};

document.getElementById('edit-transaction-form').onsubmit = function(e) {
  e.preventDefault();
  const id = document.getElementById('edit-id').value;
  const description = document.getElementById('edit-description').value;
  const amount = parseFloat(document.getElementById('edit-amount').value);
  const date = document.getElementById('edit-date').value;
  const type = document.getElementById('edit-type').value;
  // Tu peux compléter ici avec catégorie/recurrence si tu veux
  const idx = transactions.findIndex(tx => tx.id == id);
  if (idx !== -1) {
    transactions[idx].description = description;
    transactions[idx].amount = amount;
    transactions[idx].date = date;
    transactions[idx].type = type;
    saveTransactionsLocal();
    if (isDropboxConnected()) saveTransactionsDropbox();
    updateViews();
    document.getElementById('modal-edit-transaction').style.display = 'none';
  }
};
document.getElementById('modal-edit-transaction').addEventListener('click', function(e){
  if(e.target === this) this.style.display = 'none';
});
function openAddTransactionModal(dateString) {
  document.getElementById('modal-add-transaction').style.display = 'flex';
  document.getElementById('add-date').value = dateString;
  document.getElementById('add-description').value = '';
  document.getElementById('add-amount').value = '';
  document.getElementById('add-type').value = 'expense';
}

document.getElementById('add-cancel-btn').onclick = function() {
  document.getElementById('modal-add-transaction').style.display = 'none';
};

document.getElementById('add-transaction-form').onsubmit = function(e) {
  e.preventDefault();
  const description = document.getElementById('add-description').value;
  const amount = parseFloat(document.getElementById('add-amount').value);
  const date = document.getElementById('add-date').value;
  const type = document.getElementById('add-type').value;
  const tx = {
    id: Date.now(),
    type,
    category: null, // tu peux ajouter un picker ici
    description,
    amount,
    date,
    recurrence: 'none',
  };
  transactions.push(tx);
  saveTransactionsLocal();
  if (isDropboxConnected()) saveTransactionsDropbox();
  updateViews();
  document.getElementById('modal-add-transaction').style.display = 'none';
};

document.getElementById('modal-add-transaction').addEventListener('click', function(e){
  if(e.target === this) this.style.display = 'none';
});
function openEditTransactionModal(tx) {
  document.getElementById('modal-edit-transaction').style.display = 'flex';
  document.getElementById('edit-id').value = tx.id;
  document.getElementById('edit-description').value = tx.description;
  document.getElementById('edit-amount').value = tx.amount;
  document.getElementById('edit-date').value = tx.date;
  document.getElementById('edit-type').value = tx.type;
}

document.getElementById('edit-cancel-btn').onclick = function() {
  document.getElementById('modal-edit-transaction').style.display = 'none';
};

document.getElementById('edit-transaction-form').onsubmit = function(e) {
  e.preventDefault();
  const id = document.getElementById('edit-id').value;
  const description = document.getElementById('edit-description').value;
  const amount = parseFloat(document.getElementById('edit-amount').value);
  const date = document.getElementById('edit-date').value;
  const type = document.getElementById('edit-type').value;
  const idx = transactions.findIndex(tx => tx.id == id);
  if (idx !== -1) {
    transactions[idx].description = description;
    transactions[idx].amount = amount;
    transactions[idx].date = date;
    transactions[idx].type = type;
    saveTransactionsLocal();
    if (isDropboxConnected()) saveTransactionsDropbox();
    updateViews();
    document.getElementById('modal-edit-transaction').style.display = 'none';
  }
};

document.getElementById('modal-edit-transaction').addEventListener('click', function(e){
  if(e.target === this) this.style.display = 'none';
});
