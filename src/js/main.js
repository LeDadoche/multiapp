// main.js

import { q, qs, qe } from './core/domUtils.js';

console.log("Module principal chargé ✅");

// Exemple d'utilisation
const app = q("#app");
if (app) {
    app.innerHTML += "<p>App détectée via domUtils 👌</p>";
}
