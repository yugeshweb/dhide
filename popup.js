

(async () => {
  const btn        = document.getElementById('toggleBtn');
  const statusText = document.getElementById('statusText');
  const fieldCount = document.getElementById('fieldCount');
  const infoBar    = document.getElementById('infoBar');
  const pulseRing  = document.querySelector('.pulse-ring');

  const EYE_OPEN  = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
  const EYE_SLASH = `<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>`;

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function getTabState(tabId) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'GET_STATE', tabId }, resp => {
        resolve(resp ?? { active: false, fieldCount: 0 });
      });
    });
  }

  /**
   * Inject content.js into the main frame AND all accessible sub-frames.
   * Cross-origin iframes (e.g. Stripe) will fail silently — that's expected;
   * the parent-frame script handles blurring those iframes at the DOM level.
   */
  async function ensureContentScript(tab) {
    try {
      // Ping main frame first.
      const pong = await chrome.tabs.sendMessage(tab.id, { type: 'PING' }, { frameId: 0 })
        .catch(() => null);

      if (!pong?.pong) {
        // Inject into main frame + all accessible sub-frames.
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content.js']
        });
      }
      return true;
    } catch {
      return false; // Restricted page (chrome://, etc.)
    }
  }

  /**
   * Send TOGGLE to main frame. The main frame script also handles iframe blurring.
   * Additionally send to any accessible sub-frames (best-effort).
   */
  async function sendToggle(tab) {
    // Always toggle the main frame — it handles iframe detection too.
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE' }, { frameId: 0 })
      .catch(() => null);

    // Also toggle accessible sub-frames (same-origin iframes).
    chrome.webNavigation?.getAllFrames({ tabId: tab.id })
      .then(frames => {
        if (!frames) return;
        frames
          .filter(f => f.frameId !== 0)
          .forEach(f => {
            chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE' }, { frameId: f.frameId })
              .catch(() => {}); // Cross-origin frames will fail silently — expected.
          });
      })
      .catch(() => {});

    return result;
  }

  function applyUiState(isActive, count) {
    const icon = btn.querySelector('.btn-icon');

    if (isActive) {
      btn.classList.add('active');
      pulseRing.classList.add('animating');
      statusText.textContent = 'Masking active';
      statusText.classList.add('active');
      icon.innerHTML = EYE_OPEN;
    } else {
      btn.classList.remove('active');
      pulseRing.classList.remove('animating');
      statusText.textContent = 'Click to mask sensitive fields';
      statusText.classList.remove('active');
      icon.innerHTML = EYE_SLASH;
    }

    if (count !== undefined) {
      infoBar.classList.toggle('has-fields', count > 0);
      fieldCount.textContent = count === 0
        ? 'No sensitive fields found'
        : `${count} sensitive field${count !== 1 ? 's' : ''} detected`;
    }
  }

  // ── Init: restore state from background ───────────────────────
  const tab   = await getActiveTab();
  const state = await getTabState(tab.id);
  applyUiState(state?.active ?? false, state?.fieldCount);

  // ── Button click ───────────────────────────────────────────────
  btn.addEventListener('click', async () => {
    const tab = await getActiveTab();
    const ok  = await ensureContentScript(tab);

    if (!ok) {
      statusText.textContent = 'Cannot run on this page';
      return;
    }

    const result = await sendToggle(tab);

    if (!result) {
      statusText.textContent = 'Communication error — reload page & retry';
      return;
    }

    // Persist state.
    chrome.runtime.sendMessage({
      type:       'SET_STATE',
      tabId:      tab.id,
      active:     result.active,
      fieldCount: result.fieldCount
    });

    applyUiState(result.active, result.fieldCount);

    // Re-fetch count after 600ms to account for lazy-loaded fields
    // (e.g. Stripe elements that mount asynchronously).
    if (result.active) {
      setTimeout(async () => {
        const updated = await chrome.tabs.sendMessage(tab.id, { type: 'GET_COUNT' }, { frameId: 0 })
          .catch(() => null);
        if (updated?.fieldCount !== undefined) {
          infoBar.classList.toggle('has-fields', updated.fieldCount > 0);
          fieldCount.textContent = updated.fieldCount === 0
            ? 'No sensitive fields found'
            : `${updated.fieldCount} sensitive field${updated.fieldCount !== 1 ? 's' : ''} detected`;

          chrome.runtime.sendMessage({
            type:       'SET_STATE',
            tabId:      tab.id,
            active:     result.active,
            fieldCount: updated.fieldCount
          });
        }
      }, 600);
    }
  });
})();
