const https = require('https');
const http = require('http');
const { URL } = require('url');

function fetchHtml(urlStr, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));

  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); } catch { return reject(new Error('Invalid URL')); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es,en;q=0.9',
      },
      timeout: 8000,
    };

    const req = lib.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
        res.resume();
        return fetchHtml(next, redirects + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; if (data.length > 500_000) req.destroy(); });
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function extractMeta(html) {
  function ogTag(name) {
    const m = html.match(new RegExp(`<meta[^>]+property=["']og:${name}["'][^>]+content=["']([^"']+)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${name}["']`, 'i'));
    return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim() : null;
  }
  function nameMeta(name) {
    const m = html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i'));
    return m ? m[1].replace(/&amp;/g, '&').trim() : null;
  }
  const titleTag = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1]?.trim();

  return {
    title: ogTag('title') || titleTag || null,
    description: ogTag('description') || nameMeta('description') || null,
    image: ogTag('image') || null,
    url: ogTag('url') || null,
  };
}

// Simple IP-based rate limit: max 15 req/min
const rl = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const entry = rl.get(ip) || { n: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.n = 0; entry.reset = now + 60_000; }
  entry.n++;
  rl.set(ip, entry);
  return entry.n <= 15;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'anon';
  if (!rateLimit(ip)) return res.status(429).json({ error: 'Rate limit exceeded' });

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' });

  let parsed;
  try {
    parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const html = await fetchHtml(url);
    const meta = extractMeta(html);
    res.setHeader('Cache-Control', 's-maxage=60');
    res.status(200).json(meta);
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch URL', detail: err.message });
  }
};
