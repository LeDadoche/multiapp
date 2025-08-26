// domUtils.js

export const q = (s, el = document) => el.querySelector(s);
export const qs = (s, el = document) => [...el.querySelectorAll(s)];
export const qe = (s, el = document) => el.querySelector(`[data-js="${s}"]`);
