const s = document.createElement('script');
s.src = chrome.runtime.getURL('page.js');
s.onload = () => {
  window.postMessage({ source: 'gv-xq-ext', type: 'ENGINE_BASE', base: chrome.runtime.getURL('engine/') }, '*');
  s.remove();
};
(document.head || document.documentElement).appendChild(s);
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.source !== 'gv-xq-bot') return;
  if (e.data.type === 'REQUEST_BASE') {
    window.postMessage({ source: 'gv-xq-ext', type: 'ENGINE_BASE', base: chrome.runtime.getURL('engine/') }, '*');
  }
});
