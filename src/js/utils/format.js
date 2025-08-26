export function formatAmount(input, { alwaysSign = false } = {}) {
  let n = Number(input);
  if (!Number.isFinite(n)) n = 0;
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: alwaysSign ? 'always' : 'auto'
  }).format(n);
}

export function addMonths(date, months) {
  const d = new Date(date);
  const newDate = new Date(d.getFullYear(), d.getMonth() + months, d.getDate());
  if (newDate.getDate() !== d.getDate()) newDate.setDate(0);
  return newDate;
}
export function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
export function parseDate(str) {
  const [y, m, d] = str.split('-').map(n => parseInt(n, 10));
  return new Date(y, m - 1, d);
}
export function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
export function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
}
export default { formatAmount, addMonths, formatDate, parseDate, sameDay, monthKey };
