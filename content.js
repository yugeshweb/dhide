// content.js
// Blurs only real interactive fields (no static text elements)

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

  function blurFields(root = document) {
    const elements = root.querySelectorAll(`
      input,
      textarea,
      select,
      [contenteditable="true"],
      [role="textbox"]
    `);

    elements.forEach(el => {
      el.classList.add(BLUR_CLASS);
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
    observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType !== 1) return;

          // If the node itself is interactive
          if (
            node.matches?.(`
              input,
              textarea,
              select,
              [contenteditable="true"],
              [role="textbox"]
            `)
          ) {
            node.classList.add(BLUR_CLASS);
          }

          // Also scan inside it
          blurFields(node);
        });
      }

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
    return document.querySelectorAll(`
      input,
      textarea,
      select,
      iframe,
      [contenteditable="true"],
      [role="textbox"]
    `).length;
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