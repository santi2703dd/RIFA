# Gran Rifa Extraordinaria

Tablero público de 33 puestos. Cualquiera con el enlace puede ver los puestos disponibles y apartar uno
(nombre, efectivo o transferencia y comprobante). Los puestos ocupados y su información solo los ve el
organizador, quien con su clave confirma pagos, edita números, ve los comprobantes y descarga la tabla
para Excel.

## Variables de entorno (Render, sección Environment)

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Cadena de conexión de CockroachDB |
| `ADMIN_CLAVE` | Clave del organizador (obligatoria) |
| `SESSION_SECRET` | Frase larga y aleatoria |
| `NODE_ENV` | `production` |
| `DATOS_PAGO` | Texto con los datos para transferir (opcional) |
| `CONTACTO` | WhatsApp o teléfono del organizador (opcional) |
| `LUGAR_HORA` | Lugar y hora del sorteo (opcional) |
| `FECHA_SORTEO` | Por defecto: Sábado 24 de octubre |

## Render

Build Command `npm install`, Start Command `npm start`. La tabla `rifa_puestos` se crea sola al arrancar.

## Números de cada puesto

Se cargan desde `NUMEROS_INICIALES` en `db.js` (solo se escriben en puestos que aún no tienen números)
o los edita el organizador desde la página.
