#!/usr/bin/env node
/**
 * CLI para agregar un nuevo evento al proyecto lippu-subdoms.
 * Automatiza: events.json + CNAME en GoDaddy + dominio en Vercel + git push (redeploy).
 *
 * Uso:
 *   node scripts/add-event.js \
 *     --slug "tfs69experience" \
 *     --title "TFS 69 Experience" \
 *     --description "El evento más esperado del año" \
 *     --image "https://url-imagen.com/tfs69.jpg" \
 *     --url "https://lippu.app/eventwa/..."
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// ─── Load .env ────────────────────────────────────────────────────────────────
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !process.env[key]) process.env[key] = val;
  });
}

// ─── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const slug        = get('--slug');
const title       = get('--title');
const description = get('--description') || '';
const image       = get('--image') || '';
const url         = get('--url');

if (!slug || !title || !url) {
  console.error(`
  ERROR: Faltan argumentos requeridos.

  Uso:
    node scripts/add-event.js \\
      --slug "nombre-evento" \\
      --title "Nombre del Evento" \\
      --description "Descripción breve" \\
      --image "https://url-imagen.com/img.jpg" \\
      --url "https://lippu.app/eventwa/..."
  `);
  process.exit(1);
}

if (!/^[a-z0-9-]+$/.test(slug)) {
  console.error('  ERROR: --slug solo puede contener letras minúsculas, números y guiones.');
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const OK   = '  ✓';
const ERR  = '  ✗';
const SKIP = '  ○';
const INFO = '  →';

function apiRequest(method, hostname, apiPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname,
        path: apiPath,
        method,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'lippu-subdoms-cli/1.0', ...headers,
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
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

// ─── Step 1: events.json ──────────────────────────────────────────────────────
async function step1_updateEventsJson() {
  console.log('\n1. Actualizando events.json...');
  const eventsPath = path.join(__dirname, '..', 'events.json');
  const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));

  if (events.find(e => e.slug === slug)) {
    console.log(`${ERR} El slug "${slug}" ya existe en events.json`);
    process.exit(1);
  }

  events.push({ slug, subdomain: slug, title, description, image, imageWidth: 1200, imageHeight: 630, url });
  fs.writeFileSync(eventsPath, JSON.stringify(events, null, 2) + '\n', 'utf8');
  console.log(`${OK} events.json actualizado (${events.length} eventos)`);
}

// ─── Step 2: GoDaddy DNS ──────────────────────────────────────────────────────
async function step2_godaddyCname() {
  console.log('\n2. Creando CNAME en GoDaddy...');
  const { GODADDY_API_KEY, GODADDY_API_SECRET } = process.env;

  if (!GODADDY_API_KEY || !GODADDY_API_SECRET) {
    console.log(`${SKIP} GODADDY_API_KEY/GODADDY_API_SECRET no configurados — agregar CNAME manualmente.`);
    console.log(`     Tipo: CNAME  Nombre: ${slug}  Valor: cname.vercel-dns.com  TTL: 600`);
    return;
  }

  try {
    const r = await apiRequest(
      'PATCH', 'api.godaddy.com', '/v1/domains/lippu.app/records',
      [{ type: 'CNAME', name: slug, data: 'cname.vercel-dns.com', ttl: 600 }],
      { Authorization: `sso-key ${GODADDY_API_KEY}:${GODADDY_API_SECRET}` }
    );
    if (r.status < 300) {
      console.log(`${OK} CNAME creado: ${slug}.lippu.app → cname.vercel-dns.com (TTL 600)`);
    } else {
      console.log(`${ERR} GoDaddy error ${r.status}: ${JSON.stringify(r.body)}`);
    }
  } catch (err) {
    console.log(`${ERR} GoDaddy request falló: ${err.message}`);
  }
}

// ─── Step 3: Vercel domain ────────────────────────────────────────────────────
async function step3_vercelDomain() {
  console.log('\n3. Añadiendo dominio en Vercel...');
  const { VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID } = process.env;

  if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) {
    console.log(`${SKIP} VERCEL_TOKEN/VERCEL_PROJECT_ID no configurados — agregar dominio manualmente en Vercel dashboard.`);
    return;
  }

  const domain = `${slug}.lippu.app`;
  const qs = VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : '';

  try {
    const r = await apiRequest(
      'POST', 'api.vercel.com', `/v10/projects/${VERCEL_PROJECT_ID}/domains${qs}`,
      { name: domain },
      { Authorization: `Bearer ${VERCEL_TOKEN}` }
    );
    if (r.status < 300) {
      console.log(`${OK} Dominio añadido en Vercel: ${domain}`);
    } else if (r.status === 409) {
      console.log(`${SKIP} ${domain} ya estaba en Vercel.`);
    } else {
      console.log(`${ERR} Vercel error ${r.status}: ${JSON.stringify(r.body)}`);
    }
  } catch (err) {
    console.log(`${ERR} Vercel request falló: ${err.message}`);
  }
}

// ─── Step 4: Git push → auto-redeploy ────────────────────────────────────────
async function step4_deploy() {
  console.log('\n4. Haciendo git push (triggerea redeploy en Vercel)...');
  const root = path.join(__dirname, '..');
  try {
    execSync(`git -C "${root}" add events.json`, { stdio: 'pipe' });
    execSync(`git -C "${root}" commit -m "feat: add event ${slug}"`, { stdio: 'pipe' });
    execSync(`git -C "${root}" push`, { stdio: 'inherit' });
    console.log(`${OK} Push realizado — Vercel redeploy en curso (~1 min)`);
  } catch (err) {
    console.log(`${ERR} Git push falló. Haz push manualmente:`);
    console.log(`     git add events.json && git commit -m "feat: add event ${slug}" && git push`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n  Agregando evento: "${title}"`);
  console.log(`  Subdominio:       ${slug}.lippu.app`);
  console.log(`  Destino:          ${url}`);

  await step1_updateEventsJson();
  await step2_godaddyCname();
  await step3_vercelDomain();
  await step4_deploy();

  console.log(`
  ─────────────────────────────────────────────────
  Listo. Tiempos estimados de propagación:

  ${OK} events.json actualizado
  ${INFO} CNAME GoDaddy:    1–5 min
  ${INFO} SSL Vercel:       1–2 min
  ${INFO} Redeploy Vercel:  1–2 min
  ${INFO} Cache WhatsApp:   hasta 24h

  URL: https://${slug}.lippu.app

  Para forzar re-scrape de WhatsApp/Facebook:
  https://developers.facebook.com/tools/debug/?q=https://${slug}.lippu.app
  ─────────────────────────────────────────────────
  `);
}

main().catch(err => { console.error('\n  ERROR:', err.message); process.exit(1); });
