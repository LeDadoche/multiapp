export const $$ = (s, ctx=document) => Array.from(ctx.querySelectorAll(s));
export const onAll = (sel, evt, fn) => $$(sel).forEach(el => el.addEventListener(evt, fn));
export const q = (s, ctx=document) => ctx.querySelector(s);
export const qe = (s, ctx=document) => ctx.querySelectorAll(s);
export default { $$, onAll, q, qe };
