'use strict';

const path = require('path');
const express = require('express');
const { handleProxy } = require('./src/proxy');

const app = express();
const PORT = process.env.PORT || 3000;

// Behind a single reverse proxy at most; lets req.protocol honour
// X-Forwarded-Proto so generated proxy URLs use the right scheme.
app.set('trust proxy', true);
app.disable('x-powered-by');

// Optional password protection. Set BASIC_AUTH_USER and BASIC_AUTH_PASS to
// require a login — strongly recommended for any public/cloud deployment so it
// is not left as an open proxy. Disabled by default for frictionless local use.
const AUTH_USER = process.env.BASIC_AUTH_USER;
const AUTH_PASS = process.env.BASIC_AUTH_PASS;
if (AUTH_USER && AUTH_PASS) {
  app.use((req, res, next) => {
    if (req.path === '/healthz') return next(); // let platform health checks through
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString();
      const idx = decoded.indexOf(':');
      const user = decoded.slice(0, idx);
      const pass = decoded.slice(idx + 1);
      if (user === AUTH_USER && pass === AUTH_PASS) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Cursor Control"');
    res.status(401).send('Authentication required');
  });
  console.log('  [auth] Basic authentication is ENABLED.');
}

// Capture the raw request body for every /proxy request so POST/PUT form and
// API submissions can be forwarded upstream unchanged.
app.use(
  '/proxy',
  express.raw({ type: () => true, limit: '50mb' })
);

// The proxy endpoint accepts any HTTP method.
app.all('/proxy', handleProxy);

// Serve the controller UI (sidebar + cursor + iframe shell).
app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    index: 'index.html',
  })
);

// Lightweight health check.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Anything else falls back to the app shell.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('');
  console.log('  Cursor Control Proxy is running.');
  console.log('  Open:  http://localhost:' + PORT);
  console.log('');
});
