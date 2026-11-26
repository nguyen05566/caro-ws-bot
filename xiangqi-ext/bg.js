chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'BESTMOVE_RESULT' || msg.type === 'ENGINE_ERROR' || msg.type === 'DEBUG') {
    chrome.tabs.query({}, tabs => tabs.forEach(t => chrome.tabs.sendMessage(t.id, msg).catch(() => {})));
  }
});
