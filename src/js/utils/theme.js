// theme.js — lightweight theme token generator and applier (offline, tiny)
// Exposes window.Theme with simple API and auto-applies dark variables when .dark-mode toggles
(function(){
  if (typeof window === 'undefined' || !document) return;
  const ID = 'theme-utils-dark-vars';

  // Minimal color helpers
  function hexToRgb(hex){
    if(!hex) return null;
    const s = String(hex).trim().replace('#','');
    const v = s.length===3 ? s.split('').map(c=>c+c).join('') : s;
    const n = parseInt(v,16);
    return [(n>>16)&255, (n>>8)&255, n&255];
  }
  function rgbToHex([r,g,b]){ return '#'+[r,g,b].map(x=>x.toString(16).padStart(2,'0')).join(''); }
  function rgbToHsl([r,g,b]){
    r/=255; g/=255; b/=255; const max=Math.max(r,g,b), min=Math.min(r,g,b); let h=0,s=0,l=(max+min)/2;
    if(max!==min){ const d=max-min; s = l>0.5? d/(2-max-min) : d/(max+min); switch(max){ case r: h = (g-b)/d + (g<b?6:0); break; case g: h = (b-r)/d + 2; break; default: h = (r-g)/d + 4; } h /= 6; }
    return [Math.round(h*360), Math.round(s*100), Math.round(l*100)];
  }
  function hslToRgb([h,s,l]){
    h/=360; s/=100; l/=100; let r,g,b;
    if(s===0){ r=g=b=l; } else {
      const hue2rgb=(p,q,t)=>{ if(t<0) t+=1; if(t>1) t-=1; if(t<1/6) return p+(q-p)*6*t; if(t<1/2) return q; if(t<2/3) return p+(q-p)*(2/3-t)*6; return p; };
      const q = l<0.5 ? l*(1+s) : l+s-l*s; const p = 2*l-q;
      r = hue2rgb(p,q,h+1/3); g = hue2rgb(p,q,h); b = hue2rgb(p,q,h-1/3);
    }
    return [Math.round(r*255),Math.round(g*255),Math.round(b*255)];
  }

  function clamp(x,a,b){ return Math.min(b, Math.max(a, x)); }

  // WCAG luminance & contrast
  function lum([r,g,b]){ const Rs = r/255, Gs = g/255, Bs = b/255; const f = v => v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); return 0.2126*f(Rs)+0.7152*f(Gs)+0.0722*f(Bs); }
  function contrast(rgbA, rgbB){ const L1 = lum(rgbA), L2 = lum(rgbB); const hi = Math.max(L1,L2), lo = Math.min(L1,L2); return (hi+0.05)/(lo+0.05); }

  // Read a CSS var from :root or fallbacks
  function readVar(name){ try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || null; } catch { return null; } }

  // Generate a dark variant from a light hex color (simple HSL transform)
  function darkenHex(hex, amountPercent){
    const rgb = hexToRgb(hex); if(!rgb) return hex;
    const hsl = rgbToHsl(rgb); const newL = clamp(Math.round(hsl[2] * (1 - (amountPercent/100))), 6, 40);
    const rgb2 = hslToRgb([hsl[0], hsl[1], newL]); return rgbToHex(rgb2);
  }

  // Ensure text color on background meets minimal contrast; returns adjusted text hex
  function ensureTextContrast(bgHex, textHex, minRatio=4.5){
    const bg = hexToRgb(bgHex) || [255,255,255]; let txt = hexToRgb(textHex) || [0,0,0];
    if(contrast(txt,bg) >= minRatio) return rgbToHex(txt);
    // try darken/lighten text by adjusting L in steps
    let hsl = rgbToHsl(txt);
    for(let i=0;i<12;i++){ hsl[2] = clamp(hsl[2] + (i%2===0 ? 6 : -8), 0, 100); const c = contrast(hslToRgb(hsl), bg); if(c>=minRatio) return rgbToHex(hslToRgb(hsl)); }
    // fallback: return white or black depending which is better
    const white = [255,255,255], black=[0,0,0]; return (contrast(white,bg) > contrast(black,bg)) ? rgbToHex(white) : rgbToHex(black);
  }

  // Main generator: reads light tokens and produces agenda-scoped dark tokens map
  function generateDarkTokens(overrides={}){
    const light = Object.assign({
      '--color-primary': readVar('--color-primary') || '#65b8f7',
      '--on-surface': readVar('--on-surface') || '#324a52',
      '--on-surface-strong': readVar('--on-surface-strong') || '#243037',
      '--color-surface': readVar('--color-surface') || '#ffffff',
      '--color-surface-2': readVar('--color-surface-2') || '#f6fbfd',
      '--color-background': readVar('--color-background') || '#f5f5f5'
    }, overrides);

    const dark = {};
    // Scope tokens to the agenda module only to avoid changing global site vars
    // Map to agenda-specific variables
    dark['--ag-surface'] = darkenHex(light['--color-surface'], 82);
    dark['--ag-surface-2'] = darkenHex(light['--color-surface-2'], 72);
    dark['--ag-primary'] = darkenHex(light['--color-primary'], 18);
    // text colors for agenda
    dark['--ag-on'] = ensureTextContrast(dark['--ag-surface'], light['--on-surface'], 4.5);
    dark['--ag-on-strong'] = ensureTextContrast(dark['--ag-surface'], light['--on-surface-strong'], 7);

    return dark;
  }

  // Apply tokens into a style tag scoped to .dark-mode #app-agenda on html OR body
  function applyDarkTokens(tokens){
    let s = document.getElementById(ID);
    if(!s){ s = document.createElement('style'); s.id = ID; document.head.appendChild(s); }
    // Support both html.dark-mode and body.dark-mode so theme toggles that flip either element work
    let css = 'html.dark-mode #app-agenda, body.dark-mode #app-agenda {\n';
    for(const k in tokens) css += `  ${k}: ${tokens[k]};\n`;
    css += '}\n';
    s.textContent = css;
  }

  // Public API
  const Theme = {
    generateDarkTokens,
    applyDarkTokens,
    refresh: function(overrides){ try{ const t = generateDarkTokens(overrides||{}); applyDarkTokens(t); return t; } catch(e){ return null; } }
  };

  // Auto apply: only after DOMContentLoaded to avoid interfering with early initialization
  function initAuto(){
    try { Theme.refresh(); } catch(e) {}
    // expose API
    window.Theme = Theme;
  // Optional: listen for explicit theme toggles by watching class changes on both html and body
  const obs = new MutationObserver((mutations)=>{ try { Theme.refresh(); } catch(e){} });
  try { obs.observe(document.documentElement, { attributes:true, attributeFilter:['class'] }); } catch(e){}
  try { if (document.body) obs.observe(document.body, { attributes:true, attributeFilter:['class'] }); } catch(e){}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuto, { once:true });
  } else {
    initAuto();
  }

})();

export default {};
