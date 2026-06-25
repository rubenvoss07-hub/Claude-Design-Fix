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
