import('file://' + new URL('../src/js/index.js', import.meta.url).pathname)
  .then(()=>{ console.log('ESM LOAD OK'); process.exit(0); })
  .catch(e=>{ console.error('ESM LOAD ERROR', e); process.exit(1); });
