

/** @type {Map<number, { active: boolean, fieldCount: number }>} */
const tabState = new Map();

// ── Message handler ────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    sendResponse(tabState.get(msg.tabId) ?? { active: false, fieldCount: 0 });
    return true;
  }

  if (msg.type === 'SET_STATE') {
    tabState.set(msg.tabId, { active: msg.active, fieldCount: msg.fieldCount });
    sendResponse({ ok: true });
    return true;
  }
});

// ── Clean up state when tab is removed ────────────────────────────
chrome.tabs.onRemoved.addListener(tabId => {
  tabState.delete(tabId);
});

// ── Clean up state on navigation (new page = fresh state) ─────────
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId === 0) tabState.delete(tabId); // top-level frame only
});
