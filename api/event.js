const events = require('../events.json');

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildHtml(event) {
  const title = escapeHtml(event.title);
  const description = escapeHtml(event.description || '');
  const image = escapeHtml(event.image || '');
  const url = escapeHtml(event.url);
  const canonical = `https://${escapeHtml(event.subdomain || event.slug)}.lippu.app/`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${canonical}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:image" content="${image}">
  ${event.imageWidth ? `<meta property="og:image:width" content="${event.imageWidth}">` : ''}
  ${event.imageHeight ? `<meta property="og:image:height" content="${event.imageHeight}">` : ''}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="${image}">
  <meta http-equiv="refresh" content="0; url=${url}">
  <link rel="canonical" href="${url}">
</head>
<body>
  <script>window.location.replace("${url}");</script>
  <noscript><a href="${url}">Ir al evento →</a></noscript>
</body>
</html>`;
}

module.exports = function handler(req, res) {
  // Slug can come from path (/tfs69experience) or from subdomain host header
  let slug = req.query.slug || '';

  if (!slug) {
    // Extract subdomain: "tfs69experience.lippu.app" → "tfs69experience"
    const host = req.headers.host || '';
    const parts = host.split('.');
    // Only for custom domains (3+ parts), not for vercel.app or localhost
    if (parts.length >= 3 && !host.includes('vercel.app') && !host.includes('localhost')) {
      slug = parts[0];
    }
  }

  if (!slug || slug === 'favicon.ico') {
    return res.status(404).end('Not found');
  }

  const event = events.find(e => e.slug === slug);

  if (!event) {
    return res.status(404).send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Evento no encontrado</title></head>
<body><p>Este evento no existe. <a href="https://lippu.app">Volver a lippu.app</a></p></body>
</html>`);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  res.status(200).send(buildHtml(event));
};
