// background.js
// Service worker (Manifest V3)
//
// Keeps track of which tabs have the feature enabled.
// State is stored in memory only (resets when extension reloads).

const tabs = new Map(); 
// key: tabId
// value: { active: boolean, fieldCount: number }

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, tabId, active, fieldCount } = message;

  if (type === "GET_STATE") {
    // If we don't have anything stored for this tab,
    // return default values.
    const state = tabs.get(tabId);
    sendResponse(state || { active: false, fieldCount: 0 });
    return true;
  }

  if (type === "SET_STATE") {
    tabs.set(tabId, {
      active,
      fieldCount
    });

    sendResponse({ ok: true });
    return true;
  }
});

// Remove stored data when the tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabs.has(tabId)) {
    tabs.delete(tabId);
  }
});

// Clear state when a new page loads in the tab
chrome.webNavigation.onCommitted.addListener((details) => {
  // Only reset on top-level navigation
  if (details.frameId === 0) {
    tabs.delete(details.tabId);
  }
});