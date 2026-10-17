'use strict';
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { pool, init } = require('./db');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const ADMIN_CLAVE = process.env.ADMIN_CLAVE || '';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const MAX_COMPROBANTE = 3 * 1024 * 1024; // 3 MB ya decodificado

if (!ADMIN_CLAVE) console.warn('AVISO: falta ADMIN_CLAVE; el modo organizador está desactivado.');
if (!process.env.SESSION_SECRET) console.warn('AVISO: falta SESSION_SECRET; la sesión del organizador se cierra al reiniciar.');

const CONFIG = {
  titulo: 'Gran Rifa Extraordinaria',
  premio: 200000,
  precio: 30000,
  precioEspecial: 40000,
  loteria: 'Lotería de Boyacá',
  fecha: process.env.FECHA_SORTEO || 'Sábado 24 de octubre',
  lugarHora: process.env.LUGAR_HORA || '',
  contacto: process.env.CONTACTO || '',
  datosPago: process.env.DATOS_PAGO || 'Nequi o Daviplata: 320 271 7905\nLlave: @3202717905',
};

const ESTADOS = ['libre', 'debe', 'verificar', 'pagado'];
const FORMAS = ['efectivo', 'transferencia'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

// ---------- utilidades ----------
function makeLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) {
      const keep = arr.filter((t) => now - t < windowMs);
      if (keep.length) hits.set(k, keep);
      else hits.delete(k);
    }
  }, 10 * 60 * 1000).unref();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      hits.set(key, arr);
      return false;
    }
    arr.push(now);
    hits.set(key, arr);
    return true;
  };
}
const loginLimit = makeLimiter(10, 15 * 60 * 1000);
const claimLimit = makeLimiter(6, 60 * 60 * 1000);

function same(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}
function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
function makeToken() {
  const exp = String(Date.now() + 12 * 3600 * 1000);
  return `${exp}.${sign(exp)}`;
}
function isAdmin(req) {
  if (!ADMIN_CLAVE) return false;
  const t = getCookie(req, 'rifa_admin');
  if (!t) return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig) return false;
  const expected = Buffer.from(sign(exp));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return false;
  return Number(exp) > Date.now();
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return next(new HttpError(401, 'Entra como organizador para hacer esto.'));
  next();
}

function parsePuesto(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 33) throw new HttpError(404, 'Ese puesto no existe.');
  return n;
}
function cleanName(v) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 60) throw new HttpError(400, 'Escribe el nombre completo (entre 2 y 60 letras).');
  return s;
}
function cleanPhone(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (!/^[0-9+()\s-]{6,20}$/.test(s)) throw new HttpError(400, 'El teléfono solo puede tener números, espacios, + y guiones.');
  return s;
}
function normNumeros(v) {
  const toks = String(v || '').split(/[^0-9]+/).filter(Boolean);
  const out = [];
  for (const t of toks) {
    if (t.length > 2) throw new HttpError(400, 'Los números deben ir de 00 a 99.');
    const n = t.padStart(2, '0');
    if (out.includes(n)) throw new HttpError(400, `El número ${n} está repetido en este puesto.`);
    out.push(n);
  }
  if (out.length > 10) throw new HttpError(400, 'Un puesto no puede tener más de 10 números.');
  return out.join(',');
}
function detectTipo(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.length > 4 && buf.slice(0, 5).toString() === '%PDF-') return 'application/pdf';
  return null;
}
function parseComprobante(c) {
  if (!c) return null;
  if (typeof c.datos !== 'string' || !c.datos) throw new HttpError(400, 'El comprobante no llegó completo. Intenta de nuevo.');
  const buf = Buffer.from(c.datos, 'base64');
  if (!buf.length) throw new HttpError(400, 'El comprobante está vacío.');
  if (buf.length > MAX_COMPROBANTE) throw new HttpError(413, 'El comprobante no puede pasar de 3 MB.');
  const tipo = detectTipo(buf);
  if (!tipo) throw new HttpError(400, 'Adjunta una imagen (JPG, PNG o WEBP) o un PDF.');
  return { buf, tipo };
}

const COLS = `puesto, numeros, precio, comprado_por, telefono, forma_pago, estado,
              comprobante_tipo, (comprobante IS NOT NULL) AS tiene_comprobante`;

function mapRow(r, admin) {
  const o = {
    puesto: r.puesto,
    numeros: r.numeros ? r.numeros.split(',') : [],
    precio: r.precio,
    comprado_por: r.comprado_por || null,
    estado: r.estado,
    forma_pago: r.forma_pago || null,
    tiene_comprobante: !!r.tiene_comprobante,
  };
  if (admin) {
    o.telefono = r.telefono || null;
    o.comprobante_tipo = r.comprobante_tipo || null;
  }
  return o;
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  next();
});
app.use(express.json({ limit: '4.5mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

app.get('/healthz', (req, res) => res.send('ok'));

app.get('/api/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ...CONFIG, admin: isAdmin(req), adminHabilitado: !!ADMIN_CLAVE });
});

app.get('/api/puestos', wrap(async (req, res) => {
  const admin = isAdmin(req);
  const filtro = admin ? '' : "WHERE estado = 'libre' AND numeros <> ''";
  const { rows } = await pool.query(`SELECT ${COLS} FROM rifa_puestos ${filtro} ORDER BY puesto`);
  res.set('Cache-Control', 'no-store');
  res.json(rows.map((r) => mapRow(r, admin)));
}));

// Cualquier persona con el enlace aparta un puesto libre
app.post('/api/puestos/:n/apartar', wrap(async (req, res) => {
  const n = parsePuesto(req.params.n);
  if (!claimLimit(req.ip)) throw new HttpError(429, 'Demasiados intentos seguidos. Escríbele al organizador o intenta más tarde.');
  const b = req.body || {};
  const nombre = cleanName(b.nombre);
  const telefono = cleanPhone(b.telefono);
  if (!FORMAS.includes(b.forma_pago)) throw new HttpError(400, 'Elige cómo vas a pagar: efectivo o transferencia.');
  const comp = b.forma_pago === 'transferencia' ? parseComprobante(b.comprobante) : null;
  const estado = comp ? 'verificar' : 'debe';

  const r = await pool.query(
    `UPDATE rifa_puestos
        SET comprado_por = $2, telefono = $3, forma_pago = $4, estado = $5,
            comprobante = $6, comprobante_tipo = $7, actualizado = CURRENT_TIMESTAMP
      WHERE puesto = $1 AND estado = 'libre' AND numeros <> ''
      RETURNING puesto`,
    [n, nombre, telefono, b.forma_pago, estado, comp ? comp.buf : null, comp ? comp.tipo : null]
  );
  if (!r.rows.length) {
    const { rows } = await pool.query('SELECT estado, numeros FROM rifa_puestos WHERE puesto = $1', [n]);
    if (rows[0] && rows[0].estado === 'libre') throw new HttpError(409, 'Este puesto todavía no tiene números asignados.');
    throw new HttpError(409, 'Ese puesto ya fue tomado. Elige otro.');
  }
  res.status(201).json({ ok: true, estado });
}));

// ---------- organizador ----------
app.post('/api/admin/login', wrap(async (req, res) => {
  if (!ADMIN_CLAVE) throw new HttpError(503, 'El modo organizador no está configurado.');
  if (!loginLimit(req.ip)) throw new HttpError(429, 'Demasiados intentos. Espera unos minutos.');
  if (!same((req.body || {}).clave || '', ADMIN_CLAVE)) throw new HttpError(401, 'Clave incorrecta.');
  res.cookie('rifa_admin', makeToken(), {
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_PROD,
    maxAge: 12 * 3600 * 1000,
    path: '/',
  });
  res.json({ ok: true });
}));

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('rifa_admin', { path: '/' });
  res.json({ ok: true });
});

app.put('/api/admin/puestos/:n', requireAdmin, wrap(async (req, res) => {
  const n = parsePuesto(req.params.n);
  const b = req.body || {};
  const numeros = normNumeros(b.numeros);
  if (!ESTADOS.includes(b.estado)) throw new HttpError(400, 'Estado no válido.');

  // Un número solo puede estar en un puesto
  if (numeros) {
    const { rows } = await pool.query(`SELECT puesto, numeros FROM rifa_puestos WHERE puesto <> $1 AND numeros <> ''`, [n]);
    for (const num of numeros.split(',')) {
      const dueno = rows.find((r) => r.numeros.split(',').includes(num));
      if (dueno) throw new HttpError(409, `El número ${num} ya está en el puesto ${dueno.puesto}.`);
    }
  }

  let sql;
  let params;
  if (b.estado === 'libre') {
    sql = `UPDATE rifa_puestos
              SET numeros = $2, comprado_por = NULL, telefono = NULL, forma_pago = NULL, estado = 'libre',
                  comprobante = NULL, comprobante_tipo = NULL, actualizado = CURRENT_TIMESTAMP
            WHERE puesto = $1 RETURNING puesto`;
    params = [n, numeros];
  } else {
    const nombre = cleanName(b.comprado_por);
    const telefono = cleanPhone(b.telefono);
    const forma = b.forma_pago || null;
    if (forma && !FORMAS.includes(forma)) throw new HttpError(400, 'Forma de pago no válida.');
    if ((b.estado === 'pagado' || b.estado === 'verificar') && !forma) {
      throw new HttpError(400, 'Elige la forma de pago (efectivo o transferencia).');
    }
    const sets = ['numeros = $2', 'comprado_por = $3', 'telefono = $4', 'forma_pago = $5', 'estado = $6', 'actualizado = CURRENT_TIMESTAMP'];
    params = [n, numeros, nombre, telefono, forma, b.estado];
    const comp = parseComprobante(b.comprobante);
    if (comp) {
      params.push(comp.buf, comp.tipo);
      sets.push(`comprobante = $${params.length - 1}`, `comprobante_tipo = $${params.length}`);
    } else if (b.quitar_comprobante) {
      sets.push('comprobante = NULL', 'comprobante_tipo = NULL');
    }
    sql = `UPDATE rifa_puestos SET ${sets.join(', ')} WHERE puesto = $1 RETURNING puesto`;
  }
  const r = await pool.query(sql, params);
  if (!r.rows.length) throw new HttpError(404, 'Ese puesto no existe.');
  const { rows } = await pool.query(`SELECT ${COLS} FROM rifa_puestos WHERE puesto = $1`, [n]);
  res.json(mapRow(rows[0], true));
}));

app.get('/api/admin/puestos/:n/comprobante', requireAdmin, wrap(async (req, res) => {
  const n = parsePuesto(req.params.n);
  const { rows } = await pool.query('SELECT comprobante, comprobante_tipo FROM rifa_puestos WHERE puesto = $1', [n]);
  if (!rows[0] || !rows[0].comprobante) throw new HttpError(404, 'Este puesto no tiene comprobante.');
  res.set({
    'Content-Type': rows[0].comprobante_tipo || 'application/octet-stream',
    'Content-Disposition': `inline; filename="comprobante-puesto-${n}"`,
    'Cache-Control': 'private, no-store',
  });
  res.send(Buffer.from(rows[0].comprobante));
}));

app.get('/api/admin/export.csv', requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT ${COLS} FROM rifa_puestos ORDER BY puesto`);
  const etiqueta = { libre: 'Libre', debe: 'Debe', verificar: 'Por verificar', pagado: 'Pagado' };
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita fórmulas al abrir en Excel
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [['Puesto', 'Números', 'Valor', 'Comprado por', 'Teléfono', 'Estado', 'Forma de pago', 'Soporte'].map(cell).join(';')];
  for (const r of rows) {
    lines.push([
      r.puesto, (r.numeros || '').replace(/,/g, ' '), r.precio, r.comprado_por, r.telefono,
      etiqueta[r.estado], r.forma_pago, r.tiene_comprobante ? 'Sí' : 'No',
    ].map(cell).join(';'));
  }
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="rifa.csv"' });
  res.send('\ufeff' + lines.join('\r\n'));
}));

app.use('/api', (req, res, next) => next(new HttpError(404, 'No encontrado.')));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'El archivo es muy pesado. Máximo 3 MB.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Solicitud no válida.' });
  console.error(err);
  res.status(500).json({ error: 'Ocurrió un error. Intenta de nuevo.' });
});

init()
  .then(() => app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`)))
  .catch((err) => {
    console.error('No se pudo iniciar la base de datos:', err.message);
    process.exit(1);
  });
