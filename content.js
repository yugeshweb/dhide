// content.js
// Blurs all form fields + iframes on the page.
// State lives only while this content script is active.

(() => {
  if (window.__hideExtensionLoaded) return;
  window.__hideExtensionLoaded = true;

  const BLUR_CLASS = "__hide_blurred";
  const STYLE_ID = "__hide_blur_style";

  const savedValues = new Map();     // input -> real value
  const cleanupFns = new Map();      // input -> remove listener
  const blurredIframes = new Set();

  let observer = null;
  let active = false;

  function addStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${BLUR_CLASS} {
        filter: blur(8px) !important;
        transition: filter 0.2s ease !important;
      }
    `;

    document.head.appendChild(style);
  }

  function removeStyles() {
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
  }

  function mask(el) {
    if (savedValues.has(el)) return;

    savedValues.set(el, el.value);

    if (el.value) {
      el.value = "*".repeat(el.value.length);
    }

    const handler = () => {
      const current = el.value;
      savedValues.set(el, current);
      el.value = "*".repeat(current.length);
    };

    el.addEventListener("input", handler, true);
    cleanupFns.set(el, () => {
      el.removeEventListener("input", handler, true);
    });
  }

  function unmask(el) {
    if (!savedValues.has(el)) return;

    el.value = savedValues.get(el) || "";
    savedValues.delete(el);

    const cleanup = cleanupFns.get(el);
    if (cleanup) cleanup();
    cleanupFns.delete(el);
  }

  function scan(root = document) {
    const fields = root.querySelectorAll("input, textarea, select");
    fields.forEach(mask);
  }

  function blurIframes() {
    document.querySelectorAll("iframe").forEach(frame => {
      if (!blurredIframes.has(frame)) {
        frame.classList.add(BLUR_CLASS);
        blurredIframes.add(frame);
      }
    });
  }

  function unblurIframes() {
    blurredIframes.forEach(frame => {
      frame.classList.remove(BLUR_CLASS);
    });
    blurredIframes.clear();
  }

  function startWatching() {
    observer = new MutationObserver(() => {
      scan();
      blurIframes();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function stopWatching() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function enable() {
    addStyles();
    scan();
    blurIframes();
    startWatching();
    active = true;
  }

  function disable() {
    stopWatching();
    Array.from(savedValues.keys()).forEach(unmask);
    unblurIframes();
    removeStyles();
    active = false;
  }

  function getCount() {
    return savedValues.size + blurredIframes.size;
  }

  chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
    if (msg.type === "PING") {
      sendResponse({ pong: true });
      return true;
    }

    if (msg.type === "TOGGLE") {
      active ? disable() : enable();
      sendResponse({ active, fieldCount: getCount() });
      return true;
    }

    if (msg.type === "GET_COUNT") {
      sendResponse({ fieldCount: getCount() });
      return true;
    }
  });

  // Clean up when navigating away
  window.addEventListener("pagehide", () => {
    if (active) disable();
    window.__hideExtensionLoaded = false;
  }, { once: true });

})();