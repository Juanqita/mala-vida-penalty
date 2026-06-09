import { createServer } from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';

// ── Config ─────────────────────────────────────────────────────────────────
const PORT            = Number(process.env.PORT) || 3001;
const ADMIN_SECRET    = process.env.ADMIN_SECRET || 'dev-admin-change-me';
const CORS_ORIGIN     = process.env.CORS_ORIGIN  || '*';
const GAME_BASE_URL   = (process.env.GAME_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const DEFAULT_CC      = process.env.DEFAULT_COUNTRY_CODE || '57';
const CAMPAIGN_ID     = process.env.CAMPAIGN_ID    || 'mundial-2026';
const CAMPAIGN_START  = process.env.CAMPAIGN_START || '2026-06-01';
const CAMPAIGN_END    = process.env.CAMPAIGN_END   || '2026-07-31';
const OTP_TTL_MS      = Number(process.env.OTP_TTL_MINUTES || 15) * 60_000;
const INVITE_TTL_MS   = Number(process.env.INVITE_TTL_HOURS || 48) * 3_600_000;
const SESSION_TTL_MS  = Number(process.env.SESSION_TTL_HOURS || 4) * 3_600_000;

// ── Base de datos en memoria ────────────────────────────────────────────────
// Persiste mientras el servidor está corriendo.
// Se reinicia SOLO cuando Render reinicia el proceso (sleep en plan free).
let DB = freshDb();

function freshDb() {
  return {
    campaign: { id: CAMPAIGN_ID, start: CAMPAIGN_START, end: CAMPAIGN_END },
    shots: [],
    invites: [],
    otp_requests: [],
    sessions: [],
    claims: []
  };
}

// ── Utilidades ─────────────────────────────────────────────────────────────
function randomToken(bytes = 24) { return randomBytes(bytes).toString('hex'); }
function randomOtp()              { return String(Math.floor(100000 + Math.random() * 900000)); }

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

function campaignError() {
  return { error: 'campaign_inactive', message: `La promo está activa del ${CAMPAIGN_START} al ${CAMPAIGN_END}.` };
}

function findShot(phone) {
  return DB.shots.find(s => s.phone === phone && s.campaign_id === CAMPAIGN_ID) || null;
}

function findInvite(token) {
  return DB.invites.find(i => i.token === token && i.campaign_id === CAMPAIGN_ID) || null;
}

function findSession(token) {
  return DB.sessions.find(s => s.token === token) || null;
}

function findActiveOtp(phone) {
  return DB.otp_requests.find(
    o => o.phone === phone && o.campaign_id === CAMPAIGN_ID &&
         !o.verified_at && new Date(o.expires_at).getTime() > Date.now()
  ) || null;
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

function purgeExpired() {
  const now = Date.now();
  DB.sessions     = DB.sessions.filter(s => new Date(s.expires_at).getTime() > now);
  DB.otp_requests = DB.otp_requests.filter(o => o.verified_at || new Date(o.expires_at).getTime() > now - 3_600_000);
  DB.invites      = DB.invites.filter(i => i.used_at || new Date(i.expires_at).getTime() > now - 86_400_000);
}

function createSession(phone) {
  purgeExpired();
  const token = randomToken(32);
  DB.sessions.push({
    token, phone,
    campaign_id: CAMPAIGN_ID,
    verified_at: new Date().toISOString(),
    expires_at:  new Date(Date.now() + SESSION_TTL_MS).toISOString()
  });
  return token;
}

function secureEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function corsHeaders(reqOrigin) {
  // Acepta el origin exacto si coincide con la lista, o * si está configurado así
  const allowed = CORS_ORIGIN === '*'
    ? '*'
    : CORS_ORIGIN.split(',').map(o => o.trim()).find(o => o === reqOrigin) || CORS_ORIGIN.split(',')[0].trim();
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
    'Access-Control-Allow-Credentials': 'true'
  };
}

function sendJson(res, status, body, reqOrigin = '') {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':   'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...corsHeaders(reqOrigin)
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
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

function getAdminKey(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return req.headers['x-admin-key'] || '';
}

function requireAdmin(req, res, origin) {
  if (!secureEqual(getAdminKey(req), ADMIN_SECRET)) {
    sendJson(res, 401, { error: 'unauthorized', message: 'Clave de admin incorrecta.' }, origin);
    return false;
  }
  return true;
}

function parseUrl(req) {
  return new URL(req.url, `http://localhost:${PORT}`);
}

function buildInviteLink(token)      { return `${GAME_BASE_URL}/?t=${token}`; }

function buildWhatsAppInviteMessage(phone, link) {
  return [
    '⚽ *Mala Vida — Penalti del Mundial 2026*', '',
    `Hola, aquí va tu acceso personal al penalti (${formatPhoneDisplay(phone)}):`,
    link, '',
    '• Un solo intento durante todo el mes del Mundial.',
    '• Ábrelo desde el celular.',
    '• Si el link expira, escríbenos de nuevo.', '',
    '¡Suerte! 🥅'
  ].join('\n');
}

function buildWhatsAppOtpMessage(code) {
  return [
    '⚽ *Mala Vida — Código penalti*', '',
    `Tu código para jugar es: *${code}*`, '',
    'Ingrésalo en la pantalla del juego. Válido 15 minutos.',
    'Un solo intento por WhatsApp durante el Mundial.'
  ].join('\n');
}

function buildWhatsAppFirstReply() {
  return [
    '⚽ ¡Hola! Gracias por escribir a *Mala Vida Fast Food*.', '',
    'Tenemos un *penalti del Mundial 2026* con premio 🎁', '',
    'Para jugar:',
    '1️⃣ Confírmame tu número de WhatsApp (con código de país, ej. +57 300…)',
    '2️⃣ Te envío *tu link personal* en seguida', '',
    'Reglas rápidas:',
    '• 1 penalti por número durante todo el mes del Mundial',
    '• Premio se reclama por este mismo chat'
  ].join('\n');
}

function buildWhatsAppPrizeReply(code, prizeName) {
  return [
    '🎉 *¡GOL! Premio del penalti*', '',
    `Premio: *${prizeName}*`,
    `Código: *${code}*`, '',
    'Envíanos captura de pantalla con este código para coordinar tu entrega.',
    'Cocina oculta · entrega según disponibilidad del día.', '',
    'Gracias por jugar con Mala Vida ⚽'
  ].join('\n');
}

// ── Servidor ───────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const origin = req.headers.origin || '';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  const url = parseUrl(req);

  try {
    // ── GET /api/health ────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        campaign: { id: CAMPAIGN_ID, start: CAMPAIGN_START, end: CAMPAIGN_END, active: isCampaignActive() },
        stats: { shots: DB.shots.length, invites: DB.invites.length }
      }, origin);
      return;
    }

    // ── GET /api/campaign ──────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/campaign') {
      sendJson(res, 200, {
        id: CAMPAIGN_ID, start: CAMPAIGN_START, end: CAMPAIGN_END,
        active: isCampaignActive(), gameBaseUrl: GAME_BASE_URL
      }, origin);
      return;
    }

    // ── GET /api/admin/templates ───────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/admin/templates') {
      if (!requireAdmin(req, res, origin)) return;
      sendJson(res, 200, {
        firstReply:    buildWhatsAppFirstReply(),
        inviteExample: buildWhatsAppInviteMessage('573001234567', buildInviteLink('ejemplo-token')),
        otpExample:    buildWhatsAppOtpMessage('123456'),
        prizeExample:  buildWhatsAppPrizeReply('MALA-MUN-ABC123', 'Papitas gratis')
      }, origin);
      return;
    }

    // ── GET /api/admin/otp-pending ─────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/admin/otp-pending') {
      if (!requireAdmin(req, res, origin)) return;
      purgeExpired();
      const pending = DB.otp_requests
        .filter(o => o.campaign_id === CAMPAIGN_ID && !o.verified_at && new Date(o.expires_at).getTime() > Date.now())
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .map(o => ({
          id: o.id, phone: o.phone, phoneDisplay: formatPhoneDisplay(o.phone),
          code: o.code, createdAt: o.created_at, expiresAt: o.expires_at,
          whatsappMessage: buildWhatsAppOtpMessage(o.code)
        }));
      sendJson(res, 200, { pending }, origin);
      return;
    }

    // ── GET /api/admin/shots ───────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/admin/shots') {
      if (!requireAdmin(req, res, origin)) return;
      const shots = DB.shots
        .filter(s => s.campaign_id === CAMPAIGN_ID)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .map(s => ({
          phone: s.phone, phoneDisplay: formatPhoneDisplay(s.phone),
          prizeName: s.prize_name, code: s.code,
          isLoss: !!s.is_loss, createdAt: s.created_at
        }));
      sendJson(res, 200, { shots, total: shots.length }, origin);
      return;
    }

    // ── POST /api/admin/reset ──────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/admin/reset') {
      if (!requireAdmin(req, res, origin)) return;
      const before = DB.shots.length;
      DB = freshDb();
      console.log(`[RESET] DB reiniciada. Borrados ${before} tiros.`);
      sendJson(res, 200, { ok: true, message: `Base de datos reiniciada. ${before} tiros borrados.` }, origin);
      return;
    }


    // ── GET /api/admin/lookup-phone ────────────────────────────────────
    // Verifica si un número ya jugó. Query param: ?phone=573001234567
    if (req.method === 'GET' && url.pathname === '/api/admin/lookup-phone') {
      if (!requireAdmin(req, res, origin)) return;
      const rawPhone = url.searchParams.get('phone') || '';
      const phone = normalizePhone(rawPhone);
      if (!phone) {
        sendJson(res, 400, { error: 'invalid_phone', message: 'Número inválido.' }, origin);
        return;
      }
      const row = findShot(phone);
      if (!row) {
        sendJson(res, 200, { found: false, phone, phoneDisplay: formatPhoneDisplay(phone), message: 'Este número NO ha jugado aún.' }, origin);
        return;
      }
      const claimed = DB.claims.find(c => c.phone === phone);
      sendJson(res, 200, {
        found: true, phone, phoneDisplay: formatPhoneDisplay(phone),
        isLoss: !!row.is_loss, prizeName: row.prize_name,
        code: row.code, playedAt: row.created_at,
        claimed: !!claimed, claimedAt: claimed ? claimed.claimed_at : null
      }, origin);
      return;
    }

    // ── GET /api/admin/lookup-code ─────────────────────────────────────
    // Verifica si un código de premio existe y si ya fue reclamado
    if (req.method === 'GET' && url.pathname === '/api/admin/lookup-code') {
      if (!requireAdmin(req, res, origin)) return;
      const code = (url.searchParams.get('code') || '').trim().toUpperCase();
      if (!code) {
        sendJson(res, 400, { error: 'invalid_code', message: 'Código requerido.' }, origin);
        return;
      }
      const row = DB.shots.find(s => s.code && s.code.toUpperCase() === code);
      if (!row) {
        sendJson(res, 200, { found: false, code, message: 'Código no encontrado.' }, origin);
        return;
      }
      const claimed = DB.claims.find(c => c.code === code);
      sendJson(res, 200, {
        found: true, code,
        phone: row.phone, phoneDisplay: formatPhoneDisplay(row.phone),
        prizeName: row.prize_name, playedAt: row.created_at,
        claimed: !!claimed, claimedAt: claimed ? claimed.claimed_at : null
      }, origin);
      return;
    }

    // ── POST /api/admin/claim ──────────────────────────────────────────
    // Marca un código de premio como reclamado
    if (req.method === 'POST' && url.pathname === '/api/admin/claim') {
      if (!requireAdmin(req, res, origin)) return;
      const body2 = await readBody(req);
      const code = (body2.code || '').trim().toUpperCase();
      if (!code) {
        sendJson(res, 400, { error: 'invalid_code', message: 'Código requerido.' }, origin);
        return;
      }
      const row = DB.shots.find(s => s.code && s.code.toUpperCase() === code);
      if (!row) {
        sendJson(res, 404, { error: 'not_found', message: 'Código no encontrado.' }, origin);
        return;
      }
      const already = DB.claims.find(c => c.code === code);
      if (already) {
        sendJson(res, 409, { error: 'already_claimed', message: 'Este premio ya fue reclamado.', claimedAt: already.claimed_at }, origin);
        return;
      }
      DB.claims.push({ code, phone: row.phone, prizeName: row.prize_name, claimed_at: new Date().toISOString() });
      console.log(`[CLAIM] ${code} reclamado por ${row.phone}`);
      sendJson(res, 200, { ok: true, message: 'Premio marcado como reclamado.', code, prizeName: row.prize_name }, origin);
      return;
    }

    // ── A partir de aquí solo POST ─────────────────────────────────────
    if (req.method !== 'POST') {
      sendJson(res, 404, { error: 'not_found' }, origin);
      return;
    }

    const body = await readBody(req);

    // ── POST /api/check ────────────────────────────────────────────────
    if (url.pathname === '/api/check') {
      if (!isCampaignActive()) { sendJson(res, 403, campaignError(), origin); return; }

      let phone = normalizePhone(body.phone, body.countryCode);
      if (!phone && body.sessionToken) {
        const session = findSession(body.sessionToken);
        if (session && new Date(session.expires_at).getTime() > Date.now()) phone = session.phone;
      }
      if (!phone) { sendJson(res, 400, { error: 'invalid_phone', message: 'Número o sesión inválidos.' }, origin); return; }

      const row = findShot(phone);
      if (row) { sendJson(res, 200, { allowed: false, phone, campaignId: CAMPAIGN_ID, result: rowToResult(row) }, origin); return; }
      sendJson(res, 200, { allowed: true, phone, campaignId: CAMPAIGN_ID }, origin);
      return;
    }

    // ── POST /api/session/validate ─────────────────────────────────────
    if (url.pathname === '/api/session/validate') {
      const session = findSession(body.sessionToken);
      if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
        sendJson(res, 401, { error: 'invalid_session', message: 'Sesión expirada. Verifica de nuevo.' }, origin);
        return;
      }
      const row = findShot(session.phone);
      sendJson(res, 200, { ok: true, phone: session.phone, sessionToken: session.token, expiresAt: session.expires_at, alreadyPlayed: !!row, result: rowToResult(row) }, origin);
      return;
    }

    // ── POST /api/invite/redeem ────────────────────────────────────────
    if (url.pathname === '/api/invite/redeem') {
      if (!isCampaignActive()) { sendJson(res, 403, campaignError(), origin); return; }

      const token = String(body.token || url.searchParams.get('t') || '').trim();
      if (!token) { sendJson(res, 400, { error: 'invalid_token', message: 'Link inválido.' }, origin); return; }

      const invite = findInvite(token);
      if (!invite) { sendJson(res, 404, { error: 'invalid_token', message: 'Link no encontrado o expirado.' }, origin); return; }
      if (new Date(invite.expires_at).getTime() <= Date.now()) { sendJson(res, 410, { error: 'expired_token', message: 'Este link expiró. Escríbenos por WhatsApp.' }, origin); return; }
      if (invite.used_at) { sendJson(res, 409, { error: 'used_token', message: 'Este link ya fue usado.' }, origin); return; }

      const existing = findShot(invite.phone);
      if (existing) { sendJson(res, 409, { error: 'already_played', message: 'Este WhatsApp ya jugó durante el Mundial.', phone: invite.phone, result: rowToResult(existing) }, origin); return; }

      invite.used_at    = new Date().toISOString();
      invite.opened_at  = invite.opened_at || new Date().toISOString();

      const sessionToken = createSession(invite.phone);
      sendJson(res, 200, { ok: true, phone: invite.phone, sessionToken, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() }, origin);
      return;
    }

    // ── POST /api/otp/request ──────────────────────────────────────────
    if (url.pathname === '/api/otp/request') {
      if (!isCampaignActive()) { sendJson(res, 403, campaignError(), origin); return; }

      const phone = normalizePhone(body.phone, body.countryCode);
      if (!phone) { sendJson(res, 400, { error: 'invalid_phone', message: 'Número de WhatsApp inválido.' }, origin); return; }

      const existing = findShot(phone);
      if (existing) { sendJson(res, 409, { error: 'already_played', message: 'Este WhatsApp ya jugó durante el Mundial.', result: rowToResult(existing) }, origin); return; }

      purgeExpired();
      const active = findActiveOtp(phone);
      if (active) { sendJson(res, 200, { ok: true, message: 'Ya hay un código activo. Revisa WhatsApp o espera a que expire.', expiresAt: active.expires_at }, origin); return; }

      const otp = {
        id: randomToken(8), phone, campaign_id: CAMPAIGN_ID,
        code: randomOtp(),
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
        verified_at: null
      };
      DB.otp_requests.push(otp);
      sendJson(res, 200, { ok: true, message: 'Te enviaremos el código por WhatsApp en los próximos minutos.', expiresAt: otp.expires_at }, origin);
      return;
    }

    // ── POST /api/otp/verify ───────────────────────────────────────────
    if (url.pathname === '/api/otp/verify') {
      if (!isCampaignActive()) { sendJson(res, 403, campaignError(), origin); return; }

      const phone = normalizePhone(body.phone, body.countryCode);
      const code  = String(body.code || '').replace(/\D/g, '');
      if (!phone || code.length !== 6) { sendJson(res, 400, { error: 'invalid_input', message: 'Número o código inválido.' }, origin); return; }

      const otp = findActiveOtp(phone);
      if (!otp || !secureEqual(otp.code, code)) { sendJson(res, 401, { error: 'invalid_code', message: 'Código incorrecto o expirado.' }, origin); return; }

      otp.verified_at = new Date().toISOString();
      const sessionToken = createSession(phone);
      sendJson(res, 200, { ok: true, phone, sessionToken, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() }, origin);
      return;
    }

    // ── POST /api/register ─────────────────────────────────────────────
    if (url.pathname === '/api/register') {
      if (!isCampaignActive()) { sendJson(res, 403, campaignError(), origin); return; }

      const session = findSession(body.sessionToken);
      if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
        sendJson(res, 401, { error: 'invalid_session', message: 'Sesión expirada.' }, origin);
        return;
      }

      const phone  = session.phone;
      const result = body.result;
      if (!result || typeof result !== 'object') { sendJson(res, 400, { error: 'invalid_result', message: 'Resultado de tiro requerido.' }, origin); return; }

      const existing = findShot(phone);
      if (existing) { sendJson(res, 409, { error: 'already_played', result: rowToResult(existing) }, origin); return; }

      const row = {
        phone, campaign_id: CAMPAIGN_ID,
        prize_id:   String(result.prizeId   || '').slice(0, 64),
        prize_name: String(result.prizeName || '').slice(0, 128),
        is_loss:    result.isLoss ? 1 : 0,
        loss_type:  result.lossType ? String(result.lossType).slice(0, 32) : null,
        code:       result.code ? String(result.code).slice(0, 64) : null,
        created_at: new Date().toISOString()
      };
      DB.shots.push(row);
      console.log(`[SHOT] ${phone} → ${row.prize_name} (${row.is_loss ? 'loss' : 'win'})`);
      sendJson(res, 201, { ok: true, phone, campaignId: CAMPAIGN_ID, result: rowToResult(row) }, origin);
      return;
    }

    // ── POST /api/admin/invite/create ──────────────────────────────────
    if (url.pathname === '/api/admin/invite/create') {
      if (!requireAdmin(req, res, origin)) return;
      if (!isCampaignActive()) { sendJson(res, 403, campaignError(), origin); return; }

      const phone = normalizePhone(body.phone, body.countryCode);
      if (!phone) { sendJson(res, 400, { error: 'invalid_phone', message: 'Número inválido.' }, origin); return; }

      const existing = findShot(phone);
      if (existing) { sendJson(res, 409, { error: 'already_played', message: 'Este número ya jugó.', result: rowToResult(existing) }, origin); return; }

      const token = randomToken(18);
      DB.invites.push({
        token, phone, campaign_id: CAMPAIGN_ID,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
        opened_at: null, used_at: null
      });

      const link = buildInviteLink(token);
      sendJson(res, 201, {
        ok: true, phone, phoneDisplay: formatPhoneDisplay(phone),
        token, link, expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
        whatsappMessage: buildWhatsAppInviteMessage(phone, link)
      }, origin);
      return;
    }

    sendJson(res, 404, { error: 'not_found' }, origin);

  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'server_error', message: 'Error interno del servidor.' }, origin);
  }
});

server.listen(PORT, () => {
  console.log(`✅ Penalty API corriendo en puerto ${PORT}`);
  console.log(`   Campaña: ${CAMPAIGN_ID} (${CAMPAIGN_START} → ${CAMPAIGN_END})`);
  console.log(`   Game URL: ${GAME_BASE_URL}`);
  console.log(`   CORS: ${CORS_ORIGIN}`);
});
