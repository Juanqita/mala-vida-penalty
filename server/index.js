import { createServer } from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, 'data');
const dbPath = join(dataDir, 'shots.json');
mkdirSync(dataDir, { recursive: true });

const PORT = Number(process.env.PORT) || 3001;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'dev-admin-change-me';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const GAME_BASE_URL = (process.env.GAME_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '57';
const CAMPAIGN_ID = process.env.CAMPAIGN_ID || 'mundial-2026';
const CAMPAIGN_START = process.env.CAMPAIGN_START || '2026-06-01';
const CAMPAIGN_END = process.env.CAMPAIGN_END || '2026-07-31';
const OTP_TTL_MS = Number(process.env.OTP_TTL_MINUTES || 15) * 60 * 1000;
const INVITE_TTL_MS = Number(process.env.INVITE_TTL_HOURS || 48) * 60 * 60 * 1000;
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 4) * 60 * 60 * 1000;

function loadDb() {
  if (!existsSync(dbPath)) {
    return defaultDb();
  }
  try {
    const db = JSON.parse(readFileSync(dbPath, 'utf8'));
    return {
      campaign: db.campaign || defaultDb().campaign,
      shots: db.shots || [],
      invites: db.invites || [],
      otp_requests: db.otp_requests || [],
      sessions: db.sessions || []
    };
  } catch {
    return defaultDb();
  }
}

function defaultDb() {
  return {
    campaign: { id: CAMPAIGN_ID, start: CAMPAIGN_START, end: CAMPAIGN_END },
    shots: [],
    invites: [],
    otp_requests: [],
    sessions: []
  };
}

function saveDb(db) {
  writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
}

function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('hex');
}

function randomOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizePhone(raw, countryCode = DEFAULT_COUNTRY_CODE) {
  if (raw == null) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  const cc = String(countryCode || DEFAULT_COUNTRY_CODE).replace(/\D/g, '');
  if (cc && !digits.startsWith(cc) && digits.length <= 10) {
    digits = cc + digits;
  }
  if (digits.length < 11 || digits.length > 15) return null;
  return digits;
}

function formatPhoneDisplay(phone) {
  const cc = String(DEFAULT_COUNTRY_CODE).replace(/\D/g, '');
  if (phone.startsWith(cc)) {
    return `+${cc} ${phone.slice(cc.length)}`;
  }
  return `+${phone}`;
}

function isCampaignActive() {
  const now = new Date();
  const start = new Date(`${CAMPAIGN_START}T00:00:00`);
  const end = new Date(`${CAMPAIGN_END}T23:59:59`);
  return now >= start && now <= end;
}

function campaignError() {
  return {
    error: 'campaign_inactive',
    message: `La promo está activa del ${CAMPAIGN_START} al ${CAMPAIGN_END}.`
  };
}

function findShot(phone) {
  const db = loadDb();
  return db.shots.find((s) => s.phone === phone && s.campaign_id === CAMPAIGN_ID) || null;
}

function findInvite(token) {
  const db = loadDb();
  return db.invites.find((i) => i.token === token && i.campaign_id === CAMPAIGN_ID) || null;
}

function findSession(token) {
  const db = loadDb();
  return db.sessions.find((s) => s.token === token) || null;
}

function findActiveOtp(phone) {
  const db = loadDb();
  const now = Date.now();
  return db.otp_requests.find(
    (o) =>
      o.phone === phone &&
      o.campaign_id === CAMPAIGN_ID &&
      !o.verified_at &&
      new Date(o.expires_at).getTime() > now
  ) || null;
}

function rowToResult(row) {
  if (!row) return null;
  return {
    prizeId: row.prize_id,
    prizeName: row.prize_name,
    isLoss: !!row.is_loss,
    lossType: row.loss_type || null,
    code: row.code || null
  };
}

function purgeExpired(db) {
  const now = Date.now();
  db.sessions = db.sessions.filter((s) => new Date(s.expires_at).getTime() > now);
  db.otp_requests = db.otp_requests.filter(
    (o) => o.verified_at || new Date(o.expires_at).getTime() > now - 3600000
  );
  db.invites = db.invites.filter(
    (i) => i.used_at || new Date(i.expires_at).getTime() > now - 86400000
  );
}

function createSession(db, phone) {
  purgeExpired(db);
  const token = randomToken(32);
  const session = {
    token,
    phone,
    campaign_id: CAMPAIGN_ID,
    verified_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  };
  db.sessions.push(session);
  saveDb(db);
  return session;
}

function secureEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function corsHeaders() {
  if (CORS_ORIGIN === '*') {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key'
    };
  }
  return {
    'Access-Control-Allow-Origin': CORS_ORIGIN.split(',')[0].trim(),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key'
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...corsHeaders()
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 32768) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function getAdminKey(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return req.headers['x-admin-key'] || '';
}

function requireAdmin(req, res) {
  if (!secureEqual(getAdminKey(req), ADMIN_SECRET)) {
    sendJson(res, 401, { error: 'unauthorized', message: 'Clave de admin incorrecta.' });
    return false;
  }
  return true;
}

function parseUrl(req) {
  return new URL(req.url, `http://localhost:${PORT}`);
}

function buildInviteLink(token) {
  return `${GAME_BASE_URL}/?t=${token}`;
}

function buildWhatsAppInviteMessage(phone, link) {
  return [
    '⚽ *Mala Vida — Penalti del Mundial 2026*',
    '',
    `Hola, aquí va tu acceso personal al penalti (${formatPhoneDisplay(phone)}):`,
    link,
    '',
    '• Un solo intento durante todo el mes del Mundial.',
    '• Ábrelo desde el celular.',
    '• Si el link expira, escríbenos de nuevo.',
    '',
    '¡Suerte! 🥅'
  ].join('\n');
}

function buildWhatsAppOtpMessage(code) {
  return [
    '⚽ *Mala Vida — Código penalti*',
    '',
    `Tu código para jugar es: *${code}*`,
    '',
    'Ingrésalo en la pantalla del juego. Válido 15 minutos.',
    'Un solo intento por WhatsApp durante el Mundial.'
  ].join('\n');
}

function buildWhatsAppFirstReply(gameUrl) {
  return [
    '⚽ ¡Hola! Gracias por escribir a *Mala Vida Fast Food*.',
    '',
    'Tenemos un *penalti del Mundial 2026* con premio 🎁',
    '',
    'Para jugar:',
    '1️⃣ Confírmame tu número de WhatsApp (con código de país, ej. +57 300…)',
    '2️⃣ Te envío *tu link personal* en seguida',
    '',
    'Reglas rápidas:',
    '• 1 penalti por número durante todo el mes del Mundial',
    '• Premio se reclama por este mismo chat',
    '',
    `(Alternativa: entra a ${gameUrl} y pide código de verificación)`
  ].join('\n');
}

function buildWhatsAppPrizeReply(code, prizeName) {
  return [
    '🎉 *¡GOL! Premio del penalti*',
    '',
    `Premio: *${prizeName}*`,
    `Código: *${code}*`,
    '',
    'Envíanos captura de pantalla con este código para coordinar tu entrega.',
    'Cocina oculta · entrega según disponibilidad del día.',
    '',
    'Gracias por jugar con Mala Vida ⚽'
  ].join('\n');
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const url = parseUrl(req);

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        campaign: {
          id: CAMPAIGN_ID,
          start: CAMPAIGN_START,
          end: CAMPAIGN_END,
          active: isCampaignActive()
        }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/campaign') {
      sendJson(res, 200, {
        id: CAMPAIGN_ID,
        start: CAMPAIGN_START,
        end: CAMPAIGN_END,
        active: isCampaignActive(),
        gameBaseUrl: GAME_BASE_URL
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/templates') {
      if (!requireAdmin(req, res)) return;
      sendJson(res, 200, {
        firstReply: buildWhatsAppFirstReply(GAME_BASE_URL),
        inviteExample: buildWhatsAppInviteMessage('573001234567', buildInviteLink('ejemplo-token')),
        otpExample: buildWhatsAppOtpMessage('123456'),
        prizeExample: buildWhatsAppPrizeReply('MALA-PAP-ABC123', 'Papitas gratis')
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/otp-pending') {
      if (!requireAdmin(req, res)) return;
      const db = loadDb();
      purgeExpired(db);
      saveDb(db);
      const pending = db.otp_requests
        .filter((o) => o.campaign_id === CAMPAIGN_ID && !o.verified_at && new Date(o.expires_at).getTime() > Date.now())
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .map((o) => ({
          id: o.id,
          phone: o.phone,
          phoneDisplay: formatPhoneDisplay(o.phone),
          code: o.code,
          createdAt: o.created_at,
          expiresAt: o.expires_at,
          whatsappMessage: buildWhatsAppOtpMessage(o.code)
        }));
      sendJson(res, 200, { pending });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/shots') {
      if (!requireAdmin(req, res)) return;
      const db = loadDb();
      const shots = db.shots
        .filter((s) => s.campaign_id === CAMPAIGN_ID)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .map((s) => ({
          phone: s.phone,
          phoneDisplay: formatPhoneDisplay(s.phone),
          prizeName: s.prize_name,
          code: s.code,
          isLoss: !!s.is_loss,
          createdAt: s.created_at
        }));
      sendJson(res, 200, { shots, total: shots.length });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    const body = await readBody(req);

    if (url.pathname === '/api/check') {
      if (!isCampaignActive()) {
        sendJson(res, 403, campaignError());
        return;
      }

      let phone = normalizePhone(body.phone, body.countryCode);
      if (!phone && body.sessionToken) {
        const session = findSession(body.sessionToken);
        if (session && new Date(session.expires_at).getTime() > Date.now()) {
          phone = session.phone;
        }
      }
      if (!phone) {
        sendJson(res, 400, { error: 'invalid_phone', message: 'Número o sesión inválidos.' });
        return;
      }

      const row = findShot(phone);
      if (row) {
        sendJson(res, 200, {
          allowed: false,
          phone,
          campaignId: CAMPAIGN_ID,
          result: rowToResult(row)
        });
        return;
      }

      sendJson(res, 200, { allowed: true, phone, campaignId: CAMPAIGN_ID });
      return;
    }

    if (url.pathname === '/api/session/validate') {
      const session = findSession(body.sessionToken);
      if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
        sendJson(res, 401, { error: 'invalid_session', message: 'Sesión expirada. Verifica de nuevo.' });
        return;
      }
      const row = findShot(session.phone);
      sendJson(res, 200, {
        ok: true,
        phone: session.phone,
        sessionToken: session.token,
        expiresAt: session.expires_at,
        alreadyPlayed: !!row,
        result: rowToResult(row)
      });
      return;
    }

    if (url.pathname === '/api/invite/redeem') {
      if (!isCampaignActive()) {
        sendJson(res, 403, campaignError());
        return;
      }

      const token = String(body.token || url.searchParams.get('t') || '').trim();
      if (!token) {
        sendJson(res, 400, { error: 'invalid_token', message: 'Link inválido.' });
        return;
      }

      const db = loadDb();
      const invite = findInvite(token);
      if (!invite) {
        sendJson(res, 404, { error: 'invalid_token', message: 'Link no encontrado o expirado.' });
        return;
      }
      if (new Date(invite.expires_at).getTime() <= Date.now()) {
        sendJson(res, 410, { error: 'expired_token', message: 'Este link expiró. Escríbenos por WhatsApp.' });
        return;
      }
      if (invite.used_at) {
        sendJson(res, 409, { error: 'used_token', message: 'Este link ya fue usado.' });
        return;
      }

      const existing = findShot(invite.phone);
      if (existing) {
        sendJson(res, 409, {
          error: 'already_played',
          message: 'Este WhatsApp ya jugó durante el Mundial.',
          phone: invite.phone,
          result: rowToResult(existing)
        });
        return;
      }

      invite.used_at = new Date().toISOString();
      invite.opened_at = invite.opened_at || new Date().toISOString();
      saveDb(db);

      const session = createSession(db, invite.phone);
      sendJson(res, 200, {
        ok: true,
        phone: invite.phone,
        sessionToken: session.token,
        expiresAt: session.expires_at
      });
      return;
    }

    if (url.pathname === '/api/otp/request') {
      if (!isCampaignActive()) {
        sendJson(res, 403, campaignError());
        return;
      }

      const phone = normalizePhone(body.phone, body.countryCode);
      if (!phone) {
        sendJson(res, 400, { error: 'invalid_phone', message: 'Número de WhatsApp inválido.' });
        return;
      }

      const existing = findShot(phone);
      if (existing) {
        sendJson(res, 409, {
          error: 'already_played',
          message: 'Este WhatsApp ya jugó durante el Mundial.',
          result: rowToResult(existing)
        });
        return;
      }

      const db = loadDb();
      purgeExpired(db);

      const active = findActiveOtp(phone);
      if (active) {
        sendJson(res, 200, {
          ok: true,
          message: 'Ya hay un código activo. Revisa WhatsApp o espera a que expire.',
          expiresAt: active.expires_at
        });
        return;
      }

      const otp = {
        id: randomToken(8),
        phone,
        campaign_id: CAMPAIGN_ID,
        code: randomOtp(),
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
        verified_at: null
      };
      db.otp_requests.push(otp);
      saveDb(db);

      sendJson(res, 200, {
        ok: true,
        message: 'Te enviaremos el código por WhatsApp en los próximos minutos.',
        expiresAt: otp.expires_at
      });
      return;
    }

    if (url.pathname === '/api/otp/verify') {
      if (!isCampaignActive()) {
        sendJson(res, 403, campaignError());
        return;
      }

      const phone = normalizePhone(body.phone, body.countryCode);
      const code = String(body.code || '').replace(/\D/g, '');
      if (!phone || code.length !== 6) {
        sendJson(res, 400, { error: 'invalid_input', message: 'Número o código inválido.' });
        return;
      }

      const db = loadDb();
      const otp = findActiveOtp(phone);
      if (!otp || !secureEqual(otp.code, code)) {
        sendJson(res, 401, { error: 'invalid_code', message: 'Código incorrecto o expirado.' });
        return;
      }

      otp.verified_at = new Date().toISOString();
      saveDb(db);

      const session = createSession(db, phone);
      sendJson(res, 200, {
        ok: true,
        phone,
        sessionToken: session.token,
        expiresAt: session.expires_at
      });
      return;
    }

    if (url.pathname === '/api/register') {
      if (!isCampaignActive()) {
        sendJson(res, 403, campaignError());
        return;
      }

      const session = findSession(body.sessionToken);
      if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
        sendJson(res, 401, { error: 'invalid_session', message: 'Sesión expirada.' });
        return;
      }

      const phone = session.phone;
      const result = body.result;
      if (!result || typeof result !== 'object') {
        sendJson(res, 400, { error: 'invalid_result', message: 'Resultado de tiro requerido.' });
        return;
      }

      const existing = findShot(phone);
      if (existing) {
        sendJson(res, 409, {
          error: 'already_played',
          result: rowToResult(existing)
        });
        return;
      }

      const row = {
        phone,
        campaign_id: CAMPAIGN_ID,
        prize_id: String(result.prizeId || '').slice(0, 64),
        prize_name: String(result.prizeName || '').slice(0, 128),
        is_loss: result.isLoss ? 1 : 0,
        loss_type: result.lossType ? String(result.lossType).slice(0, 32) : null,
        code: result.code ? String(result.code).slice(0, 64) : null,
        created_at: new Date().toISOString()
      };

      const db = loadDb();
      db.shots.push(row);
      saveDb(db);

      sendJson(res, 201, { ok: true, phone, campaignId: CAMPAIGN_ID, result: rowToResult(row) });
      return;
    }

    if (url.pathname === '/api/admin/invite/create') {
      if (!requireAdmin(req, res)) return;
      if (!isCampaignActive()) {
        sendJson(res, 403, campaignError());
        return;
      }

      const phone = normalizePhone(body.phone, body.countryCode);
      if (!phone) {
        sendJson(res, 400, { error: 'invalid_phone', message: 'Número inválido.' });
        return;
      }

      const existing = findShot(phone);
      if (existing) {
        sendJson(res, 409, {
          error: 'already_played',
          message: 'Este número ya jugó.',
          result: rowToResult(existing)
        });
        return;
      }

      const db = loadDb();
      const token = randomToken(18);
      const invite = {
        token,
        phone,
        campaign_id: CAMPAIGN_ID,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
        opened_at: null,
        used_at: null
      };
      db.invites.push(invite);
      saveDb(db);

      const link = buildInviteLink(token);
      sendJson(res, 201, {
        ok: true,
        phone,
        phoneDisplay: formatPhoneDisplay(phone),
        token,
        link,
        expiresAt: invite.expires_at,
        whatsappMessage: buildWhatsAppInviteMessage(phone, link)
      });
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'server_error', message: 'Error interno del servidor.' });
  }
});

server.listen(PORT, () => {
  console.log(`Penalty API on http://localhost:${PORT}`);
  console.log(`Campaign ${CAMPAIGN_ID}: ${CAMPAIGN_START} → ${CAMPAIGN_END}`);
  console.log(`Game URL: ${GAME_BASE_URL}`);
});
