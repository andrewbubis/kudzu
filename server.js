// Minimal Express static server.
// Serves everything in /public on PORT (Railway injects this).
//
// "Pretty URLs": /about resolves to /about.html, /work/lowndes-collection
// resolves to /work/lowndes-collection.html, etc.

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

// 1. /<slug> → /<slug>.html if the file exists
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  // already has an extension, or root → let static handle it
  if (req.path === '/' || path.extname(req.path)) return next();
  const candidate = path.join(PUBLIC, req.path + '.html');
  if (fs.existsSync(candidate)) {
    return res.sendFile(candidate);
  }
  next();
});

// 2. Static files
app.use(express.static(PUBLIC, {
  extensions: ['html'],
  index: 'index.html',
}));

// 3. Fallback 404
app.use((req, res) => {
  const four04 = path.join(PUBLIC, '404.html');
  if (fs.existsSync(four04)) return res.status(404).sendFile(four04);
  res.status(404).send('Not found.');
});

app.listen(PORT, () => {
  console.log(`kudzo · listening on http://localhost:${PORT}`);
});
