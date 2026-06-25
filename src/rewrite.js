'use strict';

const cheerio = require('cheerio');

/**
 * Convert any URL found in a proxied page into a URL that points back at our
 * proxy, so navigation stays inside our same-origin iframe.
 *
 * @param {string} rawUrl   the URL as it appears in the page (may be relative)
 * @param {string} baseUrl  absolute URL of the page the URL was found in
 * @param {string} selfOrigin  absolute origin of THIS app (e.g. http://host:3000)
 * @returns {string}
 */
function proxifyUrl(rawUrl, baseUrl, selfOrigin) {
  if (rawUrl == null) return rawUrl;
  let u = String(rawUrl).trim();
  if (u === '') return rawUrl;

  // Leave non-navigational / pseudo URLs untouched.
  if (/^(data:|blob:|javascript:|mailto:|tel:|sms:|about:|#)/i.test(u)) return u;

  const proxyPrefix = selfOrigin + '/proxy?url=';

  // Already pointing at our proxy — don't double-wrap.
  if (u.indexOf(proxyPrefix) === 0) return u;
  if (u.indexOf('/proxy?url=') === 0) return selfOrigin + u;

  let abs;
  try {
    abs = new URL(u, baseUrl).href;
  } catch (e) {
    return rawUrl;
  }

  // If it already resolves to our own proxy endpoint, leave as-is.
  if (abs.indexOf(selfOrigin + '/proxy') === 0) return abs;

  return proxyPrefix + encodeURIComponent(abs);
}

/**
 * Rewrite a `srcset` attribute (comma separated "url descriptor" pairs).
 */
function proxifySrcset(value, baseUrl, selfOrigin) {
  return value
    .split(',')
    .map((part) => {
      const seg = part.trim();
      if (!seg) return '';
      const sp = seg.split(/\s+/);
      sp[0] = proxifyUrl(sp[0], baseUrl, selfOrigin);
      return sp.join(' ');
    })
    .filter(Boolean)
    .join(', ');
}

/**
 * This function is serialised (via toString) and injected as an inline script
 * into every proxied HTML page. It runs *inside* the proxied page and:
 *   - routes fetch / XHR / sendBeacon / WebSocket-less requests back through
 *     the proxy so same-origin API calls keep working without CORS errors;
 *   - keeps link clicks, window.open and form submits inside our iframe;
 *   - notifies the parent app on load.
 *
 * It must be completely self-contained (no references to module scope) because
 * only its own source text is shipped to the browser.
 */
function injectRuntime(SELF, BASE) {
  if (window.__cdfInjected) return;
  window.__cdfInjected = true;

  var PROXY = SELF + '/proxy?url=';

  function isSpecial(u) {
    if (u == null || u === '') return true;
    return /^(data:|blob:|javascript:|mailto:|tel:|sms:|about:|#)/i.test(String(u));
  }
  function toAbs(u) {
    try {
      return new URL(u, BASE).href;
    } catch (e) {
      return null;
    }
  }
  function proxify(u) {
    if (typeof u !== 'string') return u;
    if (isSpecial(u)) return u;
    if (u.indexOf(PROXY) === 0) return u;
    if (u.indexOf('/proxy?url=') === 0) return SELF + u;
    var abs = toAbs(u);
    if (!abs) return u;
    if (abs.indexOf(SELF + '/proxy') === 0) return abs;
    return PROXY + encodeURIComponent(abs);
  }

  // --- fetch ---
  if (window.fetch) {
    var _fetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') {
          input = proxify(input);
        } else if (input && input.url) {
          input = new Request(proxify(input.url), input);
        }
      } catch (e) {}
      return _fetch.call(this, input, init);
    };
  }

  // --- XMLHttpRequest ---
  if (window.XMLHttpRequest) {
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        arguments[1] = proxify(url);
      } catch (e) {}
      return _open.apply(this, arguments);
    };
  }

  // --- navigator.sendBeacon ---
  if (navigator.sendBeacon) {
    var _beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      try { url = proxify(url); } catch (e) {}
      return _beacon(url, data);
    };
  }

  // --- window.open (force back into our flow) ---
  var _wopen = window.open;
  window.open = function (url, name, features) {
    try { if (url) url = proxify(url); } catch (e) {}
    // Keep everything in the same iframe instead of spawning detached tabs.
    try {
      window.location.href = url;
      return window;
    } catch (e) {
      return _wopen.call(window, url, name, features);
    }
  };

  // --- anchor clicks ---
  // Handles both server-rewritten links and links added dynamically after load.
  // We navigate explicitly rather than relying on a synthesised click's default
  // action (which does not reliably fire for dispatched events), while still
  // respecting SPA routers that call preventDefault().
  document.addEventListener(
    'click',
    function (e) {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href');
      if (isSpecial(href)) return;
      var purl = proxify(href);
      if (!purl) return;
      e.preventDefault();
      window.location.href = purl;
    },
    false
  );

  // --- form submits (catches dynamically created forms) ---
  document.addEventListener(
    'submit',
    function (e) {
      if (e.defaultPrevented) return;
      var f = e.target;
      if (!f || f.tagName !== 'FORM') return;
      var action = f.getAttribute('action') || BASE;
      var abs = toAbs(action);
      if (!abs) return;
      if (abs.indexOf(SELF + '/proxy') === 0) return;
      f.setAttribute('action', proxify(action));
    },
    false
  );

  try {
    window.parent.postMessage({ __cdf: 'loaded', url: BASE }, '*');
  } catch (e) {}
}

/**
 * Rewrite an HTML document for proxying.
 */
function rewriteHtml(html, finalUrl, selfOrigin) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // Remove CSP / framing restrictions delivered via <meta>.
  $('meta[http-equiv]').each((i, el) => {
    const v = ($(el).attr('http-equiv') || '').toLowerCase();
    if (
      v === 'content-security-policy' ||
      v === 'content-security-policy-report-only' ||
      v === 'x-frame-options'
    ) {
      $(el).remove();
    }
  });

  // Drop any existing <base> — we install our own.
  $('base').remove();

  // Subresource Integrity would fail once we change how things load.
  $('[integrity]').removeAttr('integrity');

  const px = (u) => proxifyUrl(u, finalUrl, selfOrigin);

  // Keep navigations inside the iframe.
  $('a[href]').each((i, el) => {
    const $e = $(el);
    $e.attr('href', px($e.attr('href')));
    $e.removeAttr('target');
  });
  $('area[href]').each((i, el) => {
    const $e = $(el);
    $e.attr('href', px($e.attr('href')));
  });
  $('form[action]').each((i, el) => {
    const $e = $(el);
    $e.attr('action', px($e.attr('action')));
    $e.removeAttr('target');
  });
  // Some pages use formaction on buttons.
  $('[formaction]').each((i, el) => {
    const $e = $(el);
    $e.attr('formaction', px($e.attr('formaction')));
  });

  // Build the head injection: <base> first so relative subresources resolve to
  // the real target origin, then our runtime shim before any page script runs.
  const safeBase = finalUrl.replace(/"/g, '%22');
  const baseTag = `<base href="${safeBase}">`;
  const shim =
    '<script>(' +
    injectRuntime.toString() +
    ')(' +
    JSON.stringify(selfOrigin) +
    ',' +
    JSON.stringify(finalUrl) +
    ');</script>';

  if ($('head').length) {
    $('head').prepend(baseTag + shim);
  } else if ($('html').length) {
    $('html').prepend('<head>' + baseTag + shim + '</head>');
  } else {
    return baseTag + shim + $.html();
  }

  return $.html();
}

module.exports = { proxifyUrl, proxifySrcset, rewriteHtml };
