import { createServer } from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import pg from 'pg';

const { Pool } = pg;

// ── Config ─────────────────────────────────────────────────────────────────
const PORT           = Number(process.env.PORT) || 3001;
const ADMIN_SECRET   = process.env.ADMIN_SECRET  || 'dev-admin-change-me';
const CORS_ORIGIN    = process.env.CORS_ORIGIN   || '*';
const GAME_BASE_URL  = (process.env.GAME_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const DEFAULT_CC     = process.env.DEFAULT_COUNTRY_CODE || '57';
const CAMPAIGN_ID    = process.env.CAMPAIGN_ID   || 'mundial-2026';
const CAMPAIGN_START = process.env.CAMPAIGN_START || '2026-06-01';
const CAMPAIGN_END   = process.env.CAMPAIGN_END   || '2026-07-31';
const OTP_TTL_MS     = Number(process.env.OTP_TTL_MINUTES  || 15) * 60_000;
const INVITE_TTL_MS  = Number(process.env.INVITE_TTL_HOURS || 48) * 3_600_000;
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 4) * 3_600_000;
const DATABASE_URL   = process.env.DATABASE_URL;

// ── DB ─────────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL + '?family=4',
  ssl: { rejectUnauthorized: false }
});

async function dbInit() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shots (
      id          SERIAL PRIMARY KEY,
      phone       TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      prize_id    TEXT,
      prize_name  TEXT,
      is_loss     BOOLEAN DEFAULT FALSE,
      loss_type   TEXT,
      code        TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(phone, campaign_id)
    );
    CREATE TABLE IF NOT EXISTS invites (
      id          SERIAL PRIMARY KEY,
      token       TEXT NOT NULL UNIQUE,
      phone       TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL,
      opened_at   TIMESTAMPTZ,
      used_at     TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS otp_requests (
      id          SERIAL PRIMARY KEY,
      phone       TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      code        TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL,
      verified_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id          SERIAL PRIMARY KEY,
      token       TEXT NOT NULL UNIQUE,
      phone       TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS claims (
      id          SERIAL PRIMARY KEY,
      code        TEXT NOT NULL UNIQUE,
      phone       TEXT NOT NULL,
      prize_name  TEXT,
      claimed_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ Tablas listas');
}

// ── Utilidades ─────────────────────────────────────────────────────────────
function randomToken(bytes = 24) { return randomBytes(bytes).toString('hex'); }
function randomOtp()             { return String(Math.floor(100000 + Math.random() * 900000)); }

function normalizePhone(raw, cc = DEFAULT_CC) {
  if (raw == null) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  const c = String(cc || DEFAULT_CC).replace(/\D/g, '');
  if (c && !d.startsWith(c) && d.length <= 10) d = c + d;
  if (d.length < 11 || d.length > 15) return null;
  return d;
}

function formatPhoneDisplay(phone) {
  const cc = String(DEFAULT_CC).replace(/\D/g, '');
  return phone.startsWith(cc) ? `+${cc} ${phone.slice(cc.length)}` : `+${phone}`;
}

function isCampaignActive() {
  const now = new Date();
  return now >= new Date(`${CAMPAIGN_START}T00:00:00`) &&
         now <= new Date(`${CAMPAIGN_END}T23:59:59`);
}

function rowToResult(row) {
  if (!row) return null;
  return {
    phone:     row.phone,
    prizeName: row.prize_name,
    prizeId:   row.prize_id,
    code:      row.code || null,
    isLoss:    !!row.is_loss,
    lossType:  row.loss_type || null
  };
}

function secureEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function corsHeaders(reqOrigin) {
  const allowed = CORS_ORIGIN === '*'
    ? '*'
    : CORS_ORIGIN.split(',').map(o => o.trim()).find(o => o === reqOrigin)
      || CORS_ORIGIN.split(',')[0].trim();
  return {
    'Access-Control-Allow-Origin':      allowed,
    'Access-Control-Allow-Methods':     'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':     'Content-Type, Authorization, X-Admin-Key',
    'Access-Control-Allow-Credentials': 'true'
  };
}

function sendJson(res, status, body, origin = '') {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':   'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...corsHeaders(origin)
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 32768) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); }
      catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

function requireAdmin(req, res, origin) {
  const key = req.headers['x-admin-key'] || (req.headers.authorization || '').replace('Bearer ', '');
  if (!secureEqual(key, ADMIN_SECRET)) {
    sendJson(res, 401, { error: 'unauthorized' }, origin);
    return false;
  }
  return true;
}

function buildInviteLink(token) { return `${GAME_BASE_URL}/?t=${token}`; }

function buildWhatsAppInviteMessage(phone, link) {
  return [
    '⚽ *Mala Vida — Penalti del Mundial 2026*', '',
    `Hola, aquí va tu acceso personal (${formatPhoneDisplay(phone)}):`,
    link, '',
    '• Un solo intento durante todo el mes del Mundial.',
    '• Ábrelo desde el celular.',
    '• Si el link expira, escríbenos de nuevo.', '',
    '¡Suerte! 🥅'
  ].join('\n');
}

// ── Servidor ───────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const origin = req.headers.origin || '';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin)); res.end(); return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {

    // GET /api/health
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const { rows } = await pool.query('SELECT COUNT(*) FROM shots WHERE campaign_id=$1', [CAMPAIGN_ID]);
      sendJson(res, 200, { ok: true, campaign: { id: CAMPAIGN_ID, start: CAMPAIGN_START, end: CAMPAIGN_END, active: isCampaignActive() }, shots: Number(rows[0].count) }, origin);
      return;
    }

    // GET /api/campaign
    if (req.method === 'GET' && url.pathname === '/api/campaign') {
      sendJson(res, 200, { id: CAMPAIGN_ID, start: CAMPAIGN_START, end: CAMPAIGN_END, active: isCampaignActive(), gameBaseUrl: GAME_BASE_URL }, origin);
      return;
    }

    // GET /api/admin/shots
    if (req.method === 'GET' && url.pathname === '/api/admin/shots') {
      if (!requireAdmin(req, res, origin)) return;
      const { rows } = await pool.query(
        'SELECT * FROM shots WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 100', [CAMPAIGN_ID]);
      sendJson(res, 200, {
        shots: rows.map(s => ({
          phone: s.phone, phoneDisplay: formatPhoneDisplay(s.phone),
          prizeName: s.prize_name, code: s.code,
          isLoss: !!s.is_loss, createdAt: s.created_at
        })),
        total: rows.length
      }, origin);
      return;
    }

    // GET /api/admin/otp-pending
    if (req.method === 'GET' && url.pathname === '/api/admin/otp-pending') {
      if (!requireAdmin(req, res, origin)) return;
      const { rows } = await pool.query(
        `SELECT * FROM otp_requests WHERE campaign_id=$1 AND verified_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC`,
        [CAMPAIGN_ID]);
      sendJson(res, 200, { pending: rows.map(o => ({
        phone: o.phone, phoneDisplay: formatPhoneDisplay(o.phone),
        code: o.code, createdAt: o.created_at, expiresAt: o.expires_at
      }))}, origin);
      return;
    }

    // GET /api/admin/lookup-phone
    if (req.method === 'GET' && url.pathname === '/api/admin/lookup-phone') {
      if (!requireAdmin(req, res, origin)) return;
      const phone = normalizePhone(url.searchParams.get('phone'));
      if (!phone) { sendJson(res, 400, { error: 'invalid_phone' }, origin); return; }
      const { rows } = await pool.query(
        'SELECT * FROM shots WHERE phone=$1 AND campaign_id=$2', [phone, CAMPAIGN_ID]);
      if (!rows.length) {
        sendJson(res, 200, { found: false, phone, phoneDisplay: formatPhoneDisplay(phone) }, origin);
        return;
      }
      const row = rows[0];
      const { rows: claims } = await pool.query('SELECT * FROM claims WHERE phone=$1', [phone]);
      const claimed = claims[0] || null;
      sendJson(res, 200, {
        found: true, phone, phoneDisplay: formatPhoneDisplay(phone),
        isLoss: !!row.is_loss, prizeName: row.prize_name,
        code: row.code, playedAt: row.created_at,
        claimed: !!claimed, claimedAt: claimed ? claimed.claimed_at : null
      }, origin);
      return;
    }

    // GET /api/admin/lookup-code
    if (req.method === 'GET' && url.pathname === '/api/admin/lookup-code') {
      if (!requireAdmin(req, res, origin)) return;
      const code = (url.searchParams.get('code') || '').trim().toUpperCase();
      if (!code) { sendJson(res, 400, { error: 'invalid_code' }, origin); return; }
      const { rows } = await pool.query(
        'SELECT * FROM shots WHERE UPPER(code)=$1', [code]);
      if (!rows.length) {
        sendJson(res, 200, { found: false, code }, origin); return;
      }
      const row = rows[0];
      const { rows: claims } = await pool.query('SELECT * FROM claims WHERE UPPER(code)=$1', [code]);
      const claimed = claims[0] || null;
      sendJson(res, 200, {
        found: true, code,
        phone: row.phone, phoneDisplay: formatPhoneDisplay(row.phone),
        prizeName: row.prize_name, playedAt: row.created_at,
        claimed: !!claimed, claimedAt: claimed ? claimed.claimed_at : null
      }, origin);
      return;
    }

    // Solo POST de aquí en adelante para rutas no-admin-GET
    if (req.method !== 'POST') {
      sendJson(res, 404, { error: 'not_found' }, origin); return;
    }

    const body = await readBody(req);

    // POST /api/admin/reset
    if (url.pathname === '/api/admin/reset') {
      if (!requireAdmin(req, res, origin)) return;
      const { rowCount } = await pool.query('DELETE FROM shots WHERE campaign_id=$1', [CAMPAIGN_ID]);
      await pool.query('DELETE FROM invites WHERE campaign_id=$1', [CAMPAIGN_ID]);
      await pool.query('DELETE FROM otp_requests WHERE campaign_id=$1', [CAMPAIGN_ID]);
      await pool.query('DELETE FROM sessions WHERE campaign_id=$1', [CAMPAIGN_ID]);
      await pool.query('DELETE FROM claims');
      console.log(`[RESET] ${rowCount} tiros borrados`);
      sendJson(res, 200, { ok: true, message: `Datos reiniciados. ${rowCount} tiros borrados.` }, origin);
      return;
    }

    // POST /api/admin/claim
    if (url.pathname === '/api/admin/claim') {
      if (!requireAdmin(req, res, origin)) return;
      const code = (body.code || '').trim().toUpperCase();
      if (!code) { sendJson(res, 400, { error: 'invalid_code' }, origin); return; }
      const { rows } = await pool.query('SELECT * FROM shots WHERE UPPER(code)=$1', [code]);
      if (!rows.length) { sendJson(res, 404, { error: 'not_found', message: 'Código no encontrado.' }, origin); return; }
      try {
        await pool.query(
          'INSERT INTO claims(code, phone, prize_name) VALUES($1,$2,$3)',
          [code, rows[0].phone, rows[0].prize_name]);
        sendJson(res, 200, { ok: true, message: 'Premio marcado como reclamado.', code, prizeName: rows[0].prize_name }, origin);
      } catch (e) {
        if (e.code === '23505') {
          const { rows: c } = await pool.query('SELECT * FROM claims WHERE UPPER(code)=$1', [code]);
          sendJson(res, 409, { error: 'already_claimed', message: 'Ya fue reclamado.', claimedAt: c[0]?.claimed_at }, origin);
        } else throw e;
      }
      return;
    }

    // POST /api/admin/invite/create
    if (url.pathname === '/api/admin/invite/create') {
      if (!requireAdmin(req, res, origin)) return;
      if (!isCampaignActive()) { sendJson(res, 403, { error: 'campaign_inactive' }, origin); return; }
      const phone = normalizePhone(body.phone, body.countryCode);
      if (!phone) { sendJson(res, 400, { error: 'invalid_phone' }, origin); return; }
      const { rows: existing } = await pool.query(
        'SELECT * FROM shots WHERE phone=$1 AND campaign_id=$2', [phone, CAMPAIGN_ID]);
      if (existing.length) { sendJson(res, 409, { error: 'already_played', message: 'Este número ya jugó.' }, origin); return; }
      const token     = randomToken(18);
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      await pool.query(
        'INSERT INTO invites(token,phone,campaign_id,expires_at) VALUES($1,$2,$3,$4)',
        [token, phone, CAMPAIGN_ID, expiresAt]);
      const link = buildInviteLink(token);
      sendJson(res, 201, {
        ok: true, phone, phoneDisplay: formatPhoneDisplay(phone),
        token, link, expiresAt,
        whatsappMessage: buildWhatsAppInviteMessage(phone, link)
      }, origin);
      return;
    }

    // POST /api/check
    if (url.pathname === '/api/check') {
      if (!isCampaignActive()) { sendJson(res, 403, { error: 'campaign_inactive' }, origin); return; }
      let phone = normalizePhone(body.phone, body.countryCode);
      if (!phone && body.sessionToken) {
        const { rows } = await pool.query(
          'SELECT * FROM sessions WHERE token=$1 AND expires_at > NOW()', [body.sessionToken]);
        if (rows.length) phone = rows[0].phone;
      }
      if (!phone) { sendJson(res, 400, { error: 'invalid_phone' }, origin); return; }
      const { rows } = await pool.query(
        'SELECT * FROM shots WHERE phone=$1 AND campaign_id=$2', [phone, CAMPAIGN_ID]);
      sendJson(res, 200, {
        allowed: !rows.length, phone, campaignId: CAMPAIGN_ID,
        result: rows.length ? rowToResult(rows[0]) : null
      }, origin);
      return;
    }

    // POST /api/session/validate
    if (url.pathname === '/api/session/validate') {
      const { rows } = await pool.query(
        'SELECT * FROM sessions WHERE token=$1 AND expires_at > NOW()', [body.sessionToken]);
      if (!rows.length) { sendJson(res, 401, { error: 'invalid_session' }, origin); return; }
      const session = rows[0];
      const { rows: shots } = await pool.query(
        'SELECT * FROM shots WHERE phone=$1 AND campaign_id=$2', [session.phone, CAMPAIGN_ID]);
      sendJson(res, 200, {
        ok: true, phone: session.phone, sessionToken: session.token,
        expiresAt: session.expires_at, alreadyPlayed: !!shots.length,
        result: shots.length ? rowToResult(shots[0]) : null
      }, origin);
      return;
    }

    // POST /api/invite/redeem
    if (url.pathname === '/api/invite/redeem') {
      if (!isCampaignActive()) { sendJson(res, 403, { error: 'campaign_inactive' }, origin); return; }
      const token = String(body.token || url.searchParams.get('t') || '').trim();
      if (!token) { sendJson(res, 400, { error: 'invalid_token' }, origin); return; }
      const { rows } = await pool.query('SELECT * FROM invites WHERE token=$1', [token]);
      if (!rows.length) { sendJson(res, 404, { error: 'invalid_token', message: 'Link no encontrado.' }, origin); return; }
      const inv = rows[0];
      if (new Date(inv.expires_at) <= new Date()) { sendJson(res, 410, { error: 'expired_token', message: 'Este link expiró. Escríbenos por WhatsApp.' }, origin); return; }
      if (inv.used_at) { sendJson(res, 409, { error: 'used_token', message: 'Este link ya fue usado.' }, origin); return; }
      const { rows: existing } = await pool.query(
        'SELECT * FROM shots WHERE phone=$1 AND campaign_id=$2', [inv.phone, CAMPAIGN_ID]);
      if (existing.length) { sendJson(res, 409, { error: 'already_played', phone: inv.phone, result: rowToResult(existing[0]) }, origin); return; }
      await pool.query('UPDATE invites SET used_at=NOW(), opened_at=COALESCE(opened_at,NOW()) WHERE token=$1', [token]);
      const sessionToken = randomToken(32);
      await pool.query(
        'INSERT INTO sessions(token,phone,campaign_id,expires_at) VALUES($1,$2,$3,$4)',
        [sessionToken, inv.phone, CAMPAIGN_ID, new Date(Date.now() + SESSION_TTL_MS)]);
      sendJson(res, 200, { ok: true, phone: inv.phone, sessionToken, expiresAt: new Date(Date.now() + SESSION_TTL_MS) }, origin);
      return;
    }

    // POST /api/otp/request
    if (url.pathname === '/api/otp/request') {
      if (!isCampaignActive()) { sendJson(res, 403, { error: 'campaign_inactive' }, origin); return; }
      const phone = normalizePhone(body.phone, body.countryCode);
      if (!phone) { sendJson(res, 400, { error: 'invalid_phone' }, origin); return; }
      const { rows: existing } = await pool.query(
        'SELECT * FROM shots WHERE phone=$1 AND campaign_id=$2', [phone, CAMPAIGN_ID]);
      if (existing.length) { sendJson(res, 409, { error: 'already_played', result: rowToResult(existing[0]) }, origin); return; }
      const { rows: active } = await pool.query(
        `SELECT * FROM otp_requests WHERE phone=$1 AND campaign_id=$2 AND verified_at IS NULL AND expires_at > NOW()`,
        [phone, CAMPAIGN_ID]);
      if (active.length) { sendJson(res, 200, { ok: true, message: 'Ya hay un código activo.', expiresAt: active[0].expires_at }, origin); return; }
      const code      = randomOtp();
      const expiresAt = new Date(Date.now() + OTP_TTL_MS);
      await pool.query(
        'INSERT INTO otp_requests(phone,campaign_id,code,expires_at) VALUES($1,$2,$3,$4)',
        [phone, CAMPAIGN_ID, code, expiresAt]);
      sendJson(res, 200, { ok: true, message: 'Te enviaremos el código por WhatsApp.', expiresAt }, origin);
      return;
    }

    // POST /api/otp/verify
    if (url.pathname === '/api/otp/verify') {
      if (!isCampaignActive()) { sendJson(res, 403, { error: 'campaign_inactive' }, origin); return; }
      const phone = normalizePhone(body.phone, body.countryCode);
      const code  = String(body.code || '').replace(/\D/g, '');
      if (!phone || code.length !== 6) { sendJson(res, 400, { error: 'invalid_input' }, origin); return; }
      const { rows } = await pool.query(
        `SELECT * FROM otp_requests WHERE phone=$1 AND campaign_id=$2 AND verified_at IS NULL AND expires_at > NOW()`,
        [phone, CAMPAIGN_ID]);
      if (!rows.length || !secureEqual(rows[0].code, code)) { sendJson(res, 401, { error: 'invalid_code', message: 'Código incorrecto o expirado.' }, origin); return; }
      await pool.query('UPDATE otp_requests SET verified_at=NOW() WHERE id=$1', [rows[0].id]);
      const sessionToken = randomToken(32);
      await pool.query(
        'INSERT INTO sessions(token,phone,campaign_id,expires_at) VALUES($1,$2,$3,$4)',
        [sessionToken, phone, CAMPAIGN_ID, new Date(Date.now() + SESSION_TTL_MS)]);
      sendJson(res, 200, { ok: true, phone, sessionToken, expiresAt: new Date(Date.now() + SESSION_TTL_MS) }, origin);
      return;
    }

    // POST /api/register
    if (url.pathname === '/api/register') {
      if (!isCampaignActive()) { sendJson(res, 403, { error: 'campaign_inactive' }, origin); return; }
      const { rows: sessions } = await pool.query(
        'SELECT * FROM sessions WHERE token=$1 AND expires_at > NOW()', [body.sessionToken]);
      if (!sessions.length) { sendJson(res, 401, { error: 'invalid_session' }, origin); return; }
      const phone  = sessions[0].phone;
      const result = body.result;
      if (!result || typeof result !== 'object') { sendJson(res, 400, { error: 'invalid_result' }, origin); return; }
      try {
        await pool.query(
          `INSERT INTO shots(phone,campaign_id,prize_id,prize_name,is_loss,loss_type,code)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [phone, CAMPAIGN_ID,
           String(result.prizeId   || '').slice(0,64),
           String(result.prizeName || '').slice(0,128),
           result.isLoss ? true : false,
           result.lossType ? String(result.lossType).slice(0,32) : null,
           result.code ? String(result.code).slice(0,64) : null]);
        console.log(`[SHOT] ${phone} → ${result.prizeName} (${result.isLoss ? 'loss' : 'win'})`);
        const { rows } = await pool.query(
          'SELECT * FROM shots WHERE phone=$1 AND campaign_id=$2', [phone, CAMPAIGN_ID]);
        sendJson(res, 201, { ok: true, phone, campaignId: CAMPAIGN_ID, result: rowToResult(rows[0]) }, origin);
      } catch (e) {
        if (e.code === '23505') {
          const { rows } = await pool.query(
            'SELECT * FROM shots WHERE phone=$1 AND campaign_id=$2', [phone, CAMPAIGN_ID]);
          sendJson(res, 409, { error: 'already_played', result: rowToResult(rows[0]) }, origin);
        } else throw e;
      }
      return;
    }

    sendJson(res, 404, { error: 'not_found' }, origin);

  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'server_error', message: 'Error interno.' }, origin);
  }
});

// ── Arranque ───────────────────────────────────────────────────────────────
dbInit()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`✅ API corriendo en :${PORT}`);
      console.log(`   Campaña : ${CAMPAIGN_ID} (${CAMPAIGN_START} → ${CAMPAIGN_END})`);
      console.log(`   Game URL: ${GAME_BASE_URL}`);
      console.log(`   CORS    : ${CORS_ORIGIN}`);
    });
  })
  .catch(err => { console.error('Error conectando a la DB:', err); process.exit(1); });
