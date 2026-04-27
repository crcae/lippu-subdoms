const https = require('https');

// ─── Body parser ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 100_000) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function apiRequest(method, hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'lippu-subdoms/1.0',
          ...headers,
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let out = '';
        res.on('data', c => (out += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
          catch { resolve({ status: res.statusCode, body: out }); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── GitHub: get file + SHA ───────────────────────────────────────────────────
async function githubGetFile(repo, filePath, token) {
  const r = await apiRequest('GET', 'api.github.com', `/repos/${repo}/contents/${filePath}`, null, {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
  });
  if (r.status !== 200) throw new Error(`GitHub GET ${r.status}: ${JSON.stringify(r.body)}`);
  const content = Buffer.from(r.body.content, 'base64').toString('utf8');
  return { data: JSON.parse(content), sha: r.body.sha };
}

// ─── GitHub: update file ──────────────────────────────────────────────────────
async function githubPutFile(repo, filePath, content, sha, message, token) {
  const encoded = Buffer.from(JSON.stringify(content, null, 2) + '\n').toString('base64');
  const r = await apiRequest('PUT', 'api.github.com', `/repos/${repo}/contents/${filePath}`,
    { message, content: encoded, sha },
    { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
  );
  if (r.status >= 300) throw new Error(`GitHub PUT ${r.status}: ${JSON.stringify(r.body)}`);
  return r;
}

// ─── GoDaddy: add CNAME ───────────────────────────────────────────────────────
async function godaddyAddCname(slug, apiKey, apiSecret) {
  const record = [{ type: 'CNAME', name: slug, data: 'cname.vercel-dns.com', ttl: 600 }];
  const r = await apiRequest('PATCH', 'api.godaddy.com', '/v1/domains/lippu.app/records', record, {
    Authorization: `sso-key ${apiKey}:${apiSecret}`,
  });
  return r;
}

// ─── Vercel: add domain ───────────────────────────────────────────────────────
async function vercelAddDomain(domain, projectId, teamId, token) {
  const qs = teamId ? `?teamId=${teamId}` : '';
  const r = await apiRequest('POST', 'api.vercel.com', `/v10/projects/${projectId}/domains${qs}`,
    { name: domain },
    { Authorization: `Bearer ${token}` }
  );
  return r;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function checkAuth(req) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return true;
  return req.headers['x-admin-password'] === pw;
}

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { GITHUB_TOKEN, GITHUB_REPO, GODADDY_API_KEY, GODADDY_API_SECRET,
    VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID } = process.env;

  // GET — return current events (from deployed events.json)
  if (req.method === 'GET') {
    try {
      const events = require('../events.json');
      return res.status(200).json(events);
    } catch {
      return res.status(500).json({ error: 'Failed to read events.json' });
    }
  }

  // POST — add event
  if (req.method === 'POST') {
    const body = await readBody(req);
    const { slug, subdomain, title, description, image, imageWidth, imageHeight, url } = body;

    if (!slug || !title || !url) {
      return res.status(400).json({ error: 'slug, title y url son requeridos' });
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ error: 'slug solo puede contener letras minúsculas, números y guiones' });
    }

    const results = { github: 'skipped', godaddy: 'skipped', vercel: 'skipped' };

    // 1. GitHub: update events.json → triggers auto-redeploy
    if (GITHUB_TOKEN && GITHUB_REPO) {
      try {
        const { data: currentEvents, sha } = await githubGetFile(GITHUB_REPO, 'events.json', GITHUB_TOKEN);
        if (currentEvents.find(e => e.slug === slug)) {
          return res.status(409).json({ error: `El slug "${slug}" ya existe` });
        }
        currentEvents.push({
          slug,
          subdomain: subdomain || slug,
          title,
          description: description || '',
          image: image || '',
          imageWidth: imageWidth || 1200,
          imageHeight: imageHeight || 630,
          url,
        });
        await githubPutFile(GITHUB_REPO, 'events.json', currentEvents, sha, `feat: add event ${slug}`, GITHUB_TOKEN);
        results.github = 'ok';
      } catch (err) {
        results.github = `error: ${err.message}`;
      }
    }

    // 2. GoDaddy: create CNAME
    if (GODADDY_API_KEY && GODADDY_API_SECRET) {
      try {
        const r = await godaddyAddCname(slug, GODADDY_API_KEY, GODADDY_API_SECRET);
        results.godaddy = r.status < 300 ? 'ok' : `error ${r.status}`;
      } catch (err) {
        results.godaddy = `error: ${err.message}`;
      }
    }

    // 3. Vercel: add domain
    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      try {
        const r = await vercelAddDomain(`${slug}.lippu.app`, VERCEL_PROJECT_ID, VERCEL_TEAM_ID, VERCEL_TOKEN);
        results.vercel = (r.status < 300 || r.status === 409) ? 'ok' : `error ${r.status}`;
      } catch (err) {
        results.vercel = `error: ${err.message}`;
      }
    }

    return res.status(200).json({ success: true, results });
  }

  // DELETE — remove event
  if (req.method === 'DELETE') {
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ error: 'Falta ?slug=' });
    if (!GITHUB_TOKEN || !GITHUB_REPO) {
      return res.status(500).json({ error: 'GITHUB_TOKEN y GITHUB_REPO son requeridos para eliminar' });
    }

    try {
      const { data: currentEvents, sha } = await githubGetFile(GITHUB_REPO, 'events.json', GITHUB_TOKEN);
      const filtered = currentEvents.filter(e => e.slug !== slug);
      if (filtered.length === currentEvents.length) {
        return res.status(404).json({ error: `Evento "${slug}" no encontrado` });
      }
      await githubPutFile(GITHUB_REPO, 'events.json', filtered, sha, `chore: remove event ${slug}`, GITHUB_TOKEN);
      return res.status(200).json({ success: true, message: `Evento "${slug}" eliminado. Redeploy en ~1 min.` });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
