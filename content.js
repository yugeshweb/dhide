// content.js
// Blurs sensitive interactive fields only (not static labels)

(() => {
  if (window.__hideExtensionLoaded) return;
  window.__hideExtensionLoaded = true;

  const BLUR_CLASS = "__hide_blurred";
  const STYLE_ID = "__hide_blur_style";

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
    document.getElementById(STYLE_ID)?.remove();
  }

  function shouldBlur(el) {
    const tag = el.tagName.toLowerCase();

    // Real form controls
    if (tag === "input" || tag === "textarea" || tag === "select") {
      return true;
    }

    // Stripe-style fake inputs
    if (
      el.getAttribute("role") === "textbox" ||
      el.contentEditable === "true"
    ) {
      return true;
    }

    return false;
  }

  function blurFields(root = document) {
    const all = root.querySelectorAll("*");

    all.forEach(el => {
      if (shouldBlur(el)) {
        el.classList.add(BLUR_CLASS);
      }
    });
  }

  function unblurFields() {
    document
      .querySelectorAll(`.${BLUR_CLASS}`)
      .forEach(el => el.classList.remove(BLUR_CLASS));
  }

  function blurIframes() {
    document.querySelectorAll("iframe").forEach(frame => {
      frame.classList.add(BLUR_CLASS);
    });
  }

  function unblurIframes() {
    document.querySelectorAll("iframe").forEach(frame => {
      frame.classList.remove(BLUR_CLASS);
    });
  }

  function startWatching() {
    observer = new MutationObserver(() => {
      blurFields();
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
    blurFields();
    blurIframes();
    startWatching();
    active = true;
  }

  function disable() {
    stopWatching();
    unblurFields();
    unblurIframes();
    removeStyles();
    active = false;
  }

  function getCount() {
    return document.querySelectorAll(
      "input, textarea, select, iframe, [role='textbox'], [contenteditable='true']"
    ).length;
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

  window.addEventListener(
    "pagehide",
    () => {
      if (active) disable();
      window.__hideExtensionLoaded = false;
    },
    { once: true }
  );
})();