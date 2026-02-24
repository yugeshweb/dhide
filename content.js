
(() => {
  // ── Guard: prevent double-injection ─────────────────────────────
  if (window.__hideExtensionLoaded) return;
  window.__hideExtensionLoaded = true;

  // ────────────────────────────────────────────────────────────────
  // Patterns & constants
  // ────────────────────────────────────────────────────────────────

  /**
   * Broad regex covering all common sensitive field naming conventions.
   * Deliberately verbose — false positives on real payment pages are fine.
   */
  const SENSITIVE_RE = /card|credit|debit|cc[\-_ ]?(num|number|no|cvc|cvv|csc|exp)|cvv|cvc|cvn|csc|expir|expiry|exp[\-_ ]?(date|month|year|mm|yy)|security[\-_ ]?code|secure[\-_ ]?code|ssn|social[\-_ ]?sec|account[\-_ ]?(num|number|no)|bank|routing|iban|swift|bic|sort[\-_ ]?code|passwd|password|pin[\b\-_ ]|card[\-_ ]?holder/i;

  /** Autocomplete tokens defined by WHATWG as payment-related. */
  const AUTOCOMPLETE_SENSITIVE = new Set([
    'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
    'cc-name', 'cc-type', 'cc-given-name', 'cc-family-name', 'cc-additional-name', 'Card number', 'Security code (CVC)'
  ]);

  /** Matches 13–19 consecutive digits possibly separated by spaces/dashes. */
  const CARD_NUMBER_RE = /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{1,7}\b/;

  /** Iframe src patterns that indicate payment widgets (Stripe, Braintree, etc.). */
  const PAYMENT_IFRAME_RE = /stripe|braintree|adyen|checkout|paypal|square|klarna|worldpay|cybersource|recurly|chargebee|paddle/i;

  const BLUR_CLASS    = '__hide_blurred';
  const BLUR_STYLE_ID = '__hide_blur_style';

  // ────────────────────────────────────────────────────────────────
  // State
  // ────────────────────────────────────────────────────────────────

  /** @type {Map<HTMLInputElement, string>} real values keyed by input element */
  const realValues     = new Map();
  /** @type {Map<HTMLInputElement, Function[]>} cleanup fns keyed by input */
  const inputListeners = new Map();
  /** @type {Set<HTMLIFrameElement>} iframes we blurred (for unblur on toggle) */
  const blurredFrames  = new Set();
  /** @type {MutationObserver|null} */
  let observer = null;
  let isActive = false;

  // ────────────────────────────────────────────────────────────────
  // Styles
  // ────────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById(BLUR_STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = BLUR_STYLE_ID;
    s.textContent = `
      .${BLUR_CLASS} {
        filter: blur(8px) !important;
        transition: filter 0.3s ease !important;
        pointer-events: none !important;
        user-select: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  function removeStyles() {
    document.getElementById(BLUR_STYLE_ID)?.remove();
  }

  // ────────────────────────────────────────────────────────────────
  // Detection helpers
  // ────────────────────────────────────────────────────────────────

  /**
   * Resolve all text signals for an input element into one haystack string.
   * Includes: name, id, placeholder, aria-*, data-*, autocomplete, AND the
   * text of any associated <label> element.
   */
  function getInputSignals(el) {
    const parts = [
      el.name || '',
      el.id || '',
      el.getAttribute('placeholder') || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('aria-describedby') || '',
      el.getAttribute('data-field') || '',
      el.getAttribute('data-testid') || '',
      el.getAttribute('data-cy') || '',
      el.title || '',
    ];

    // Resolve aria-labelledby → element text
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      labelledBy.split(/\s+/).forEach(id => {
        const ref = document.getElementById(id);
        if (ref) parts.push(ref.textContent || '');
      });
    }

    // Resolve <label for="id"> or wrapping <label>
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) parts.push(label.textContent || '');
    }
    // Ancestor label (implicit association)
    const ancestorLabel = el.closest('label');
    if (ancestorLabel) parts.push(ancestorLabel.textContent || '');

    // Also check the nearest preceding sibling/parent text — catches
    // frameworks that render label text as a sibling span/div.
    const parent = el.parentElement;
    if (parent) {
      // Grab text of all non-input siblings preceding this input
      for (const child of parent.children) {
        if (child === el) break;
        const tag = child.tagName;
        if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
          parts.push(child.textContent || '');
        }
      }
      // One level up (e.g. a wrapper div with a label above the input wrapper)
      const grandParent = parent.parentElement;
      if (grandParent) {
        for (const child of grandParent.children) {
          if (child === parent) break;
          const tag = child.tagName;
          if (tag === 'LABEL' || tag === 'SPAN' || tag === 'DIV' || tag === 'P') {
            parts.push(child.textContent || '');
          }
        }
      }
    }

    return parts.join(' ');
  }

  /**
   * Returns true if the input is considered sensitive.
   * @param {HTMLInputElement} el
   */
  function isSensitiveInput(el) {
    if (!(el instanceof HTMLInputElement)) return false;

    const type = (el.type || 'text').toLowerCase();
    const ac   = (el.getAttribute('autocomplete') || '').toLowerCase().trim();

    // 1. Password type — always sensitive
    if (type === 'password') return true;

    // 2. Autocomplete attribute — authoritative when present
    if (AUTOCOMPLETE_SENSITIVE.has(ac)) return true;

    // 3. Collect all signals and test against broad regex
    const signals = getInputSignals(el);
    if (SENSITIVE_RE.test(signals)) return true;

    // 4. inputmode="numeric" with a sensitive-looking context
    //    (Stripe uses plain <input> with no meaningful attrs, just inputmode)
    if (el.getAttribute('inputmode') === 'numeric' && SENSITIVE_RE.test(signals)) return true;

    // 5. Maxlength heuristics as final fallback:
    //    CVV fields are often maxlength=3 or 4 with numeric inputmode
    //    Card fields often maxlength=16-19
    //    Only trigger if there's at least one faint signal nearby
    const maxLen = parseInt(el.getAttribute('maxlength') || '0', 10);
    if ((maxLen === 3 || maxLen === 4) &&
        el.getAttribute('inputmode') === 'numeric' &&
        SENSITIVE_RE.test(signals)) return true;

    return false;
  }

  /**
   * Returns true if an iframe is likely a payment widget.
   * @param {HTMLIFrameElement} frame
   */
  function isSensitiveIframe(frame) {
    const src   = frame.src   || '';
    const name  = frame.name  || '';
    const title = frame.title || '';
    const combined = `${src} ${name} ${title}`;
    return PAYMENT_IFRAME_RE.test(combined);
  }

  /** Returns true if text looks like a raw card number or SSN. */
  function looksLikeSensitiveText(text) {
    if (CARD_NUMBER_RE.test(text)) return true;
    if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) return true; // SSN
    return false;
  }

  // ────────────────────────────────────────────────────────────────
  // Input masking
  // ────────────────────────────────────────────────────────────────

  function maskInput(input) {
    if (realValues.has(input)) return;

    realValues.set(input, input.value);
    if (input.value) input.value = '*'.repeat(input.value.length);

    const onKeydown = (e) => {
      if (e.key.length > 1 && e.key !== 'Backspace' && e.key !== 'Delete') return;
      e.preventDefault();

      const real   = realValues.get(input) ?? '';
      let cursor   = input.selectionStart ?? real.length;
      let selEnd   = input.selectionEnd   ?? cursor;

      if (e.key === 'Backspace') {
        if (cursor !== selEnd) {
          realValues.set(input, real.slice(0, cursor) + real.slice(selEnd));
        } else if (cursor > 0) {
          realValues.set(input, real.slice(0, cursor - 1) + real.slice(cursor));
          cursor--;
        }
      } else if (e.key === 'Delete') {
        if (cursor !== selEnd) {
          realValues.set(input, real.slice(0, cursor) + real.slice(selEnd));
        } else {
          realValues.set(input, real.slice(0, cursor) + real.slice(cursor + 1));
        }
      } else {
        realValues.set(input, real.slice(0, cursor) + e.key + real.slice(selEnd));
        cursor++;
      }

      input.value = '*'.repeat((realValues.get(input) ?? '').length);
      const c = cursor;
      requestAnimationFrame(() => input.setSelectionRange(c, c));
    };

    // Catch paste / autofill
    const onInput = () => {
      const displayed = input.value;
      const expected  = '*'.repeat((realValues.get(input) ?? '').length);
      if (displayed !== expected) {
        realValues.set(input, displayed);
        input.value = '*'.repeat(displayed.length);
      }
    };

    input.addEventListener('keydown', onKeydown, true);
    input.addEventListener('input',   onInput,   true);

    inputListeners.set(input, [
      () => input.removeEventListener('keydown', onKeydown, true),
      () => input.removeEventListener('input',   onInput,   true),
    ]);
  }

  function unmaskInput(input) {
    if (!realValues.has(input)) return;
    input.value = realValues.get(input) ?? '';
    realValues.delete(input);
    (inputListeners.get(input) ?? []).forEach(fn => fn());
    inputListeners.delete(input);
  }

  // ────────────────────────────────────────────────────────────────
  // Iframe blurring
  // ────────────────────────────────────────────────────────────────

  function blurPaymentIframes() {
    document.querySelectorAll('iframe').forEach(frame => {
      if (isSensitiveIframe(frame) && !blurredFrames.has(frame)) {
        frame.classList.add(BLUR_CLASS);
        blurredFrames.add(frame);
      }
    });
  }

  function unblurPaymentIframes() {
    blurredFrames.forEach(frame => frame.classList.remove(BLUR_CLASS));
    blurredFrames.clear();
  }

  // ────────────────────────────────────────────────────────────────
  // Sensitive text blurring (non-input text nodes)
  // ────────────────────────────────────────────────────────────────

  function blurSensitiveTextNodes() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          const tag = p.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' ||
              tag === 'INPUT'  || tag === 'TEXTAREA') {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let node;
    while ((node = walker.nextNode())) {
      if (looksLikeSensitiveText(node.textContent || '')) {
        node.parentElement?.classList.add(BLUR_CLASS);
      }
    }
  }

  function unblurAll() {
    document.querySelectorAll(`.${BLUR_CLASS}`)
      .forEach(el => el.classList.remove(BLUR_CLASS));
  }

  // ────────────────────────────────────────────────────────────────
  // Scan all inputs (called on activate + from observer)
  // ────────────────────────────────────────────────────────────────

  function scanInputs(root = document) {
    root.querySelectorAll('input').forEach(input => {
      if (isSensitiveInput(input)) maskInput(input);
    });
  }

  // ────────────────────────────────────────────────────────────────
  // MutationObserver
  // ────────────────────────────────────────────────────────────────

  function startObserver() {
    observer = new MutationObserver(mutations => {
      let hasNewNodes = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length) { hasNewNodes = true; break; }
      }
      if (!hasNewNodes) return;

      // Re-scan everything — cheaper than diff-tracking for typical page sizes
      scanInputs();
      blurPaymentIframes();
      blurSensitiveTextNodes();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
  }

  // ────────────────────────────────────────────────────────────────
  // Activate / deactivate
  // ────────────────────────────────────────────────────────────────

  function activate() {
    injectStyles();
    scanInputs();
    blurPaymentIframes();
    blurSensitiveTextNodes();
    startObserver();
    isActive = true;
  }

  function deactivate() {
    stopObserver();
    [...realValues.keys()].forEach(unmaskInput);
    unblurPaymentIframes();
    unblurAll();
    removeStyles();
    isActive = false;
  }

  /** Total count of things we've masked/blurred — reported back to popup. */
  function fieldCount() {
    return realValues.size +
           document.querySelectorAll(`.${BLUR_CLASS}`).length +
           blurredFrames.size;
  }

  // ────────────────────────────────────────────────────────────────
  // Message listener
  // ────────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ pong: true });
      return true;
    }
    if (msg.type === 'TOGGLE') {
      isActive ? deactivate() : activate();
      sendResponse({ active: isActive, fieldCount: fieldCount() });
      return true;
    }
    if (msg.type === 'GET_COUNT') {
      sendResponse({ fieldCount: fieldCount() });
      return true;
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Cleanup on navigation
  // ────────────────────────────────────────────────────────────────
  window.addEventListener('pagehide', () => {
    if (isActive) deactivate();
    window.__hideExtensionLoaded = false;
  }, { once: true });

})();
