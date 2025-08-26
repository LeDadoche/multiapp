import './modules/patches.js';
import './utils/theme.js';
import utils from './utils/format.js';
import * as dom from './utils/dom.js';
import storageLocal from './storage/local.js';
import tx from './transactions.js';

// Expose utilitaires globaux attendus par le reste de l'app
window.formatAmount = utils.formatAmount;
window.$$ = dom.$$;
window.onAll = dom.onAll;

// Bootstrap
tx.bootstrapTransactionsOnce();

// Render UI initiales si nécessaire (file contains functions elsewhere)
console.log('Module entry loaded');

export default {};
