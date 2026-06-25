'use strict';

const { proxifyUrl, rewriteHtml } = require('./rewrite');

// Response headers that must never be forwarded as-is.
const STRIP_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'content-encoding', // body is already decoded by fetch()
  'content-length', // length changes after rewriting
  'transfer-encoding',
  'strict-transport-security',
  'permissions-policy',
  'feature-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'report-to',
  'reporting-endpoints',
  'nel',
  'connection',
  'keep-alive',
]);

// Request headers we deliberately do not forward upstream.
const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'cookie', // forwarded explicitly below
  'accept-encoding', // let fetch negotiate + auto-decode
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  'upgrade-insecure-requests',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);

function getSelfOrigin(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0]
    .trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return proto + '://' + host;
}

function decodeBuffer(buf, contentType) {
  let charset = 'utf-8';
  const m = /charset=([^;]+)/i.exec(contentType || '');
  if (m) charset = m[1].trim().toLowerCase().replace(/['"]/g, '');
  try {
    return new TextDecoder(charset).decode(buf);
  } catch (e) {
    return new TextDecoder('utf-8').decode(buf);
  }
}

// Make upstream Set-Cookie values storable under our own origin.
function rewriteSetCookie(cookieStr, isHttps) {
  let out = cookieStr
    .replace(/;\s*Domain=[^;]*/gi, '')
    .replace(/;\s*SameSite=[^;]*/gi, '');
  if (!isHttps) {
    out = out.replace(/;\s*Secure/gi, '');
  }
  // Loosen SameSite so the cookie rides along inside our iframe.
  out += '; SameSite=Lax';
  return out;
}

async function handleProxy(req, res) {
  const target = req.query.url;
  if (!target) {
    res.status(400).send('Missing "url" query parameter.');
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (e) {
    res.status(400).send('Invalid target URL.');
    return;
  }
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    res.status(400).send('Only http(s) URLs are supported.');
    return;
  }

  const selfOrigin = getSelfOrigin(req);
  const isHttps = selfOrigin.startsWith('https:');

  // Build upstream request headers.
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (SKIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    if (value != null) headers[key] = value;
  }
  // Forward cookies stored for our origin to the target.
  if (req.headers.cookie) headers['cookie'] = req.headers.cookie;
  // Present a believable referer to the target (helps with hotlink checks).
  headers['referer'] = targetUrl.href;

  // Body for non-GET/HEAD requests (express.raw gives us a Buffer).
  let body;
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      body = req.body;
    }
    // Browsers only send Origin on non-GET requests; mirror that so CSRF
    // checks on the target see a same-origin submission.
    headers['origin'] = targetUrl.origin;
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl.href, {
      method,
      headers,
      body,
      redirect: 'follow',
    });
  } catch (err) {
    res
      .status(502)
      .send(
        'Could not reach the target site.\n\n' +
          String(err && err.message ? err.message : err)
      );
    return;
  }

  const finalUrl = upstream.url || targetUrl.href;
  const contentType = upstream.headers.get('content-type') || '';

  // Copy through safe response headers.
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (STRIP_RESPONSE_HEADERS.has(k)) return;
    if (k === 'set-cookie') return; // handled below
    if (k === 'location') {
      res.setHeader('location', proxifyUrl(value, finalUrl, selfOrigin));
      return;
    }
    try {
      res.setHeader(key, value);
    } catch (e) {
      /* ignore invalid header names */
    }
  });

  // Rewrite Set-Cookie headers for our origin.
  const setCookies =
    typeof upstream.headers.getSetCookie === 'function'
      ? upstream.headers.getSetCookie()
      : [];
  if (setCookies && setCookies.length) {
    res.setHeader(
      'set-cookie',
      setCookies.map((c) => rewriteSetCookie(c, isHttps))
    );
  }

  // Never let the browser cache proxied responses in a way that confuses
  // origin handling.
  res.removeHeader('content-security-policy');
  res.removeHeader('x-frame-options');

  res.status(upstream.status);

  const buf = Buffer.from(await upstream.arrayBuffer());

  if (/text\/html/i.test(contentType)) {
    const html = decodeBuffer(buf, contentType);
    const rewritten = rewriteHtml(html, finalUrl, selfOrigin);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(rewritten);
  } else {
    if (contentType) res.setHeader('content-type', contentType);
    res.send(buf);
  }
}

module.exports = { handleProxy, getSelfOrigin };
