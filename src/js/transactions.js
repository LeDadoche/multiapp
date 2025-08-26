import { loadTransactionsLocal, saveTransactionsLocal } from './storage/local.js';

export let transactions = [];

export function bootstrapTransactionsOnce() {
  try {
    const arr = loadTransactionsLocal();
    transactions = Array.isArray(arr) ? arr : [];
    window.transactions = transactions;
  } catch (_) { transactions = []; window.transactions = transactions; }
}

export function getAllTransactions() { return transactions; }
export function setAllTransactions(arr) { transactions = arr; window.transactions = transactions; saveTransactionsLocal(transactions); }
export function addTransaction(tx) { transactions.push(tx); saveTransactionsLocal(transactions); }
export default { bootstrapTransactionsOnce, getAllTransactions, setAllTransactions, addTransaction };
