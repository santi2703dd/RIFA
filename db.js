'use strict';
const { Pool, types } = require('pg');

// CockroachDB devuelve INT/COUNT como INT8 y pg los entrega como texto: los pasamos a número.
types.setTypeParser(20, (v) => parseInt(v, 10));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
});
pool.on('error', (err) => console.error('Error inesperado en el pool de BD:', err.message));

// Números de cada puesto. Solo se escriben si el puesto todavía no tiene números,
// así que lo que edite el organizador desde la página nunca se pisa al reiniciar.
const NUMEROS_INICIALES = {
  1: '07,42,89',
  2: '13,56,91',
  3: '02,38,74',
  4: '19,63,85',
  5: '24,51,97',
  6: '05,46,80',
  7: '16,59,93',
  8: '00,35,72',
  9: '21,48,86',
  10: '11,54,99',
  11: '04,33,68',
  12: '17,61,90',
  13: '09,44,78',
  14: '26,57,95',
  15: '14,39,82',
  16: '06,50,87',
  17: '23,65,98',
  18: '01,41,76',
  19: '18,53,92',
  20: '10,36,70',
  21: '27,60,84',
  22: '08,47,96',
  23: '15,55,81',
  24: '03,43,73',
  25: '20,62,88',
  26: '12,49,94',
  27: '25,58,79',
  28: '22,45,83',
  29: '28,64,77',
  30: '30,52,71',
  31: '29,66,75',
  32: '31,40,67',
  33: '32,34,37,69',
};
const PRECIO = 30000; // puestos 1 a 32
const PRECIO_ESPECIAL = 40000; // puesto 33

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rifa_puestos (
      puesto           INT PRIMARY KEY CHECK (puesto BETWEEN 1 AND 33),
      numeros          TEXT NOT NULL DEFAULT '',
      precio           INT NOT NULL CHECK (precio >= 0),
      comprado_por     TEXT,
      telefono         TEXT,
      forma_pago       TEXT CHECK (forma_pago IN ('efectivo', 'transferencia')),
      estado           TEXT NOT NULL DEFAULT 'libre'
                       CHECK (estado IN ('libre', 'debe', 'verificar', 'pagado')),
      comprobante      BYTEA,
      comprobante_tipo TEXT,
      actualizado      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK ((estado = 'libre' AND comprado_por IS NULL)
          OR (estado <> 'libre' AND comprado_por IS NOT NULL))
    )`);

  const values = [];
  const params = [];
  for (let n = 1; n <= 33; n++) {
    params.push(n, NUMEROS_INICIALES[n] || '', n === 33 ? PRECIO_ESPECIAL : PRECIO);
    values.push(`($${params.length - 2}, $${params.length - 1}, $${params.length})`);
  }
  await pool.query(
    `INSERT INTO rifa_puestos (puesto, numeros, precio) VALUES ${values.join(', ')}
     ON CONFLICT (puesto) DO NOTHING`,
    params
  );
  for (const [n, numeros] of Object.entries(NUMEROS_INICIALES)) {
    await pool.query(`UPDATE rifa_puestos SET numeros = $2 WHERE puesto = $1 AND numeros = ''`, [Number(n), numeros]);
  }
}

module.exports = { pool, init };
