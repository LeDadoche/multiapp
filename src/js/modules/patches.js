// patches.js — tête de script : petits patchs et polyfills

/* ==== PATCH: mute logs ==== */
(function () {
  const MUTE = ['[IconPickerV2]', '[edit]'];
  function shouldMute(args){
    try {
      return args.some(a => {
        if (typeof a !== 'string') return false;
        const s = a.replace(/^%[a-z]/i,'').trim();
        return MUTE.some(p => s.includes(p));
      });
    } catch { return false; }
  }
  ['log','info','debug','warn'].forEach(k => {
    const orig = console[k].bind(console);
    console[k] = (...args) => { if (shouldMute(args)) return; return orig(...args); };
  });
})();

/* ==== HOTFIX: getUnifiedTransactions global & précoce ==== */
(function (g) {
  if (!g) return;
  if (typeof g.getUnifiedTransactions !== 'function') {
    g.getUnifiedTransactions = function () {
      try { if (Array.isArray(g.transactions) && g.transactions.length) return g.transactions; } catch (_) {}
      try {
        const keys = ['transactions','finance_transactions','finances:transactions','txs','data_transactions'];
        for (const k of keys) {
          const raw = g.localStorage ? g.localStorage.getItem(k) : null;
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed;
          if (parsed && typeof parsed === 'object') {
            if (Array.isArray(parsed.items)) return parsed.items;
            if (Array.isArray(parsed.data))  return parsed.data;
          }
        }
      } catch (_) {}
      return [];
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== PATCH: mute prefix logs (conservative) ==== */
(function () {
  const MUTE_PREFIXES = ['[IconPickerV2]', '[edit]'];
  const _log = console.log;
  console.log = function (...args) {
    try {
      const first = String(args[0] ?? '');
      if (MUTE_PREFIXES.some(p => first.startsWith(p))) return;
    } catch {}
    return _log.apply(console, args);
  };
})();

export default {};
