(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const fmt = (n) => '$' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const ETIQUETA = { libre: 'Libre', debe: 'Debe', verificar: 'Por verificar', pagado: 'Pagado' };
  const state = { config: null, puestos: [], admin: false, filtro: 'todos', q: '' };

  // Crea elementos sin usar innerHTML: todo lo que escribe la gente se inserta como texto.
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(kid));
    }
    return el;
  }

  async function api(url, { method = 'GET', body } = {}) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* sin cuerpo */ }
    if (!res.ok) throw new Error((data && data.error) || 'No se pudo completar la acción.');
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 4500);
  }

  // ---------- diálogo ----------
  const dlg = $('#dlg');
  function abrir(...nodes) {
    dlg.replaceChildren(h('div', { class: 'dlg-in' }, ...nodes));
    if (!dlg.open) dlg.showModal();
  }
  const cerrar = () => { if (dlg.open) dlg.close(); };
  dlg.addEventListener('click', (e) => { if (e.target === dlg) cerrar(); });

  // ---------- comprobante: se reduce la foto antes de enviarla ----------
  function toBase64(blob) {
    return new Promise((ok, no) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(',')[1]);
      r.onerror = () => no(new Error('No se pudo leer el archivo.'));
      r.readAsDataURL(blob);
    });
  }
  async function archivoAComprobante(file) {
    if (!file) return null;
    if (file.type === 'application/pdf') {
      if (file.size > 2.5 * 1024 * 1024) throw new Error('El PDF no puede pasar de 2,5 MB.');
      return { nombre: file.name, datos: await toBase64(file) };
    }
    if (!file.type.startsWith('image/')) throw new Error('Adjunta una imagen (captura o foto) o un PDF.');
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, no) => {
        const i = new Image();
        i.onload = () => ok(i);
        i.onerror = () => no(new Error('No se pudo leer la imagen. Prueba con otra captura.'));
        i.src = url;
      });
      const escala = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * escala));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * escala));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.82));
      if (!blob || blob.size > 2.8 * 1024 * 1024) throw new Error('La imagen es muy pesada. Prueba con una captura de pantalla.');
      return { nombre: file.name, datos: await toBase64(blob) };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ---------- piezas visuales ----------
  function bolas(nums) {
    if (!nums.length) return h('span', { class: 'balls' }, h('span', { class: 'balls-vacio', text: 'Números por asignar' }));
    return h('span', { class: 'balls' }, nums.map((n) =>
      h('span', { class: 'ball c' + (Number(n[0]) % 6) }, h('b', { text: n }))));
  }
  const badge = (estado) => h('span', { class: 'badge b-' + estado, text: ETIQUETA[estado] });

  function pintarCabecera() {
    const c = state.config;
    $('#premio').textContent = fmt(c.premio);
    $('#fecha').textContent = c.fecha;
    $('#loteria').textContent = c.loteria;
    $('#precio').textContent = fmt(c.precio) + ' cada uno';
    $('#precio-esp').textContent = fmt(c.precioEspecial);
    const lugar = $('#lugar');
    lugar.hidden = !c.lugarHora;
    lugar.textContent = c.lugarHora ? 'Lugar y hora: ' + c.lugarHora : '';
    const contacto = $('#contacto');
    contacto.hidden = !c.contacto;
    contacto.textContent = c.contacto ? 'Contacto: ' + c.contacto : '';
    $('#btn-organizador').hidden = state.admin || !c.adminHabilitado;
    $('#adminbar').hidden = !state.admin;
    $('.filtros').hidden = !state.admin;
    document.querySelectorAll('[data-admin-only]').forEach((el) => { el.hidden = !state.admin; });
    document.querySelectorAll('.filtros button').forEach((button) => {
      button.setAttribute('aria-pressed', String(state.admin && button.dataset.filtro === state.filtro));
    });
    $('.buscar .sr').textContent = state.admin
      ? 'Buscar por nombre, puesto o número'
      : 'Buscar por puesto o número';
    $('#buscar').placeholder = state.admin
      ? 'Busca por nombre, puesto o número'
      : 'Busca el puesto o número';
  }

  function pintarResumen() {
    const p = state.puestos;
    const cuenta = (e) => p.filter((x) => x.estado === e).length;
    $('#n-libres').textContent = cuenta('libre');
    $('#n-debe').textContent = cuenta('debe') + cuenta('verificar');
    $('#n-pagados').textContent = cuenta('pagado');
    if (state.admin) {
      const suma = (f) => p.filter(f).reduce((s, x) => s + x.precio, 0);
      $('#a-recaudado').textContent = fmt(suma((x) => x.estado === 'pagado'));
      $('#a-cobrar').textContent = fmt(suma((x) => x.estado === 'debe' || x.estado === 'verificar'));
    }
  }

  function coincide(p) {
    if (state.filtro !== 'todos' && p.estado !== state.filtro) return false;
    const q = state.q.trim().toLowerCase();
    if (!q) return true;
    if (state.admin && (p.comprado_por || '').toLowerCase().includes(q)) return true;
    if (String(p.puesto) === q) return true;
    if (/^\d{1,2}$/.test(q) && p.numeros.includes(q.padStart(2, '0'))) return true;
    return false;
  }

  function pintarGrid() {
    const lista = state.puestos.filter(coincide);
    $('#grid').replaceChildren(...lista.map((p) => {
      const sinNumeros = !p.numeros.length;
      const bloqueado = !state.admin && p.estado === 'libre' && sinNumeros;
      const quien = p.estado === 'libre' ? 'Disponible' : p.comprado_por;
      const btn = h('button', {
        type: 'button',
        class: 'ticket estado-' + p.estado,
        disabled: bloqueado,
        'aria-label': `Puesto ${p.puesto}, ${ETIQUETA[p.estado].toLowerCase()}`,
        onclick: () => abrirPuesto(p),
      },
      h('span', { class: 'stub' }, h('span', { class: 'stub-n', text: p.puesto }), h('span', { class: 'stub-l', text: 'puesto' })),
      h('span', { class: 'cuerpo' },
        bolas(p.numeros),
        h('span', { class: 'fila' },
          h('span', { class: 'who' + (p.estado === 'libre' ? ' libre' : ''), text: quien }),
          badge(p.estado))));
      return h('li', {}, btn);
    }));
    $('#vacio').hidden = lista.length > 0;
  }

  function pintar() {
    pintarCabecera();
    pintarResumen();
    pintarGrid();
  }

  async function cargar() {
    try {
      const [config, puestos] = await Promise.all([api('/api/config'), api('/api/puestos')]);
      state.config = config;
      state.puestos = puestos;
      state.admin = !!config.admin;
      state.filtro = state.admin ? 'todos' : 'libre';
      $('#error-carga').hidden = true;
      pintar();
    } catch (e) {
      $('#error-carga').hidden = false;
    }
  }

  // ---------- apartar un puesto (público) ----------
  function abrirPuesto(p) {
    if (state.admin) return abrirAdmin(p);
    if (p.estado === 'libre') return abrirApartar(p);
    abrirInfo(p);
  }

  function abrirInfo(p) {
    abrir(
      h('h2', { text: `Puesto ${p.puesto}` }),
      bolas(p.numeros),
      h('p', {}, h('strong', { text: p.comprado_por || '' }), ' ya tiene este puesto.'),
      h('p', {}, badge(p.estado)),
      p.estado === 'verificar' ? h('p', { class: 'nota', text: 'El comprobante llegó. El organizador lo está revisando.' }) : null,
      h('div', { class: 'acciones' }, h('button', { type: 'button', class: 'btn', onclick: cerrar, text: 'Cerrar' }))
    );
  }

  function abrirApartar(p) {
    const c = state.config;
    const nombre = h('input', { id: 'f-nombre', type: 'text', required: true, maxlength: 60, autocomplete: 'name' });
    const tel = h('input', { id: 'f-tel', type: 'tel', maxlength: 20, autocomplete: 'tel', placeholder: 'Para avisarte si ganas' });
    const radio = (valor, texto) => h('label', { class: 'opcion' }, h('input', { type: 'radio', name: 'pago', value: valor, required: true }), h('span', { text: texto }));
    const file = h('input', { id: 'f-file', type: 'file', accept: 'image/*,application/pdf' });
    const vista = h('div', {});
    const cajaEfectivo = h('p', { class: 'nota', hidden: true, text: 'Pagas en efectivo al organizador. El puesto queda como "Debe" hasta que él confirme tu pago.' });
    const cajaTransf = h('div', { class: 'caja', hidden: true },
      c.datosPago ? h('p', { class: 'datos-pago', text: c.datosPago }) : h('p', { class: 'nota', text: 'El organizador te dará los datos para transferir.' }),
      h('label', { class: 'campo' }, h('span', { text: 'Comprobante de pago' }), file,
        h('small', { text: 'Captura o foto de la transferencia. Si aún no la tienes, apártalo y envíala después al organizador.' })),
      vista);
    const error = h('p', { class: 'error', role: 'alert' });
    const enviar = h('button', { type: 'submit', class: 'btn', text: `Apartar puesto ${p.puesto} por ${fmt(p.precio)}` });

    file.addEventListener('change', () => {
      vista.replaceChildren();
      const f = file.files[0];
      if (f && f.type.startsWith('image/')) {
        const img = h('img', { class: 'preview', alt: 'Vista previa del comprobante' });
        img.src = URL.createObjectURL(f);
        img.onload = () => URL.revokeObjectURL(img.src);
        vista.append(img);
      } else if (f) {
        vista.append(h('p', { class: 'nota', text: f.name }));
      }
    });

    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      enviar.disabled = true;
      try {
        const forma = form.elements.pago.value;
        const comprobante = forma === 'transferencia' ? await archivoAComprobante(file.files[0]) : null;
        await api(`/api/puestos/${p.puesto}/apartar`, {
          method: 'POST',
          body: { nombre: nombre.value, telefono: tel.value, forma_pago: forma, comprobante },
        });
        cerrar();
        toast(forma === 'transferencia' && comprobante
          ? 'Listo. El organizador revisará tu comprobante.'
          : `Puesto ${p.puesto} apartado. Págaselo al organizador para confirmarlo.`);
        cargar();
      } catch (err) {
        error.textContent = err.message;
        enviar.disabled = false;
        if (/ya fue tomado/.test(err.message)) cargar();
      }
    } },
    h('div', { class: 'dlg-in-form' },
      h('label', { class: 'campo' }, h('span', { text: 'Nombre completo' }), nombre),
      h('label', { class: 'campo' }, h('span', { text: 'Teléfono (opcional)' }), tel),
      h('fieldset', {}, h('legend', { text: 'Forma de pago' }),
        h('div', { class: 'opciones' }, radio('efectivo', 'Efectivo'), radio('transferencia', 'Transferencia'))),
      cajaEfectivo, cajaTransf, error,
      h('div', { class: 'acciones' },
        h('button', { type: 'button', class: 'btn btn-sec', onclick: cerrar, text: 'Cancelar' }), enviar)));

    form.addEventListener('change', (e) => {
      if (e.target.name !== 'pago') return;
      cajaEfectivo.hidden = e.target.value !== 'efectivo';
      cajaTransf.hidden = e.target.value !== 'transferencia';
    });

    abrir(h('h2', { text: `Apartar el puesto ${p.puesto}` }), bolas(p.numeros), form);
    nombre.focus();
  }

  // ---------- modo organizador ----------
  function abrirLogin() {
    const clave = h('input', { id: 'f-clave', type: 'password', required: true, autocomplete: 'current-password' });
    const error = h('p', { class: 'error', role: 'alert' });
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      try {
        await api('/api/admin/login', { method: 'POST', body: { clave: clave.value } });
        cerrar();
        await cargar();
        toast('Entraste como organizador. Toca un puesto para editarlo.');
      } catch (err) {
        error.textContent = err.message;
      }
    } },
    h('div', { class: 'dlg-in-form' },
      h('label', { class: 'campo' }, h('span', { text: 'Clave del organizador' }), clave), error,
      h('div', { class: 'acciones' },
        h('button', { type: 'button', class: 'btn btn-sec', onclick: cerrar, text: 'Cancelar' }),
        h('button', { type: 'submit', class: 'btn', text: 'Entrar' }))));
    abrir(h('h2', { text: 'Entrar como organizador' }), form);
    clave.focus();
  }

  function abrirAdmin(p) {
    const numeros = h('input', { id: 'f-num', type: 'text', value: p.numeros.join(' '), placeholder: 'Ej: 08 09 07', inputmode: 'numeric', autocomplete: 'off' });
    const nombre = h('input', { id: 'f-nombre', type: 'text', value: p.comprado_por || '', maxlength: 60, placeholder: 'Quién compró la boleta' });
    const tel = h('input', { id: 'f-tel', type: 'tel', value: p.telefono || '', maxlength: 20 });
    const opt = (v, t, sel) => h('option', { value: v, selected: sel, text: t });
    const forma = h('select', { id: 'f-forma' },
      opt('', 'Sin definir', !p.forma_pago), opt('efectivo', 'Efectivo', p.forma_pago === 'efectivo'), opt('transferencia', 'Transferencia', p.forma_pago === 'transferencia'));
    const estado = h('select', { id: 'f-estado' },
      ['libre', 'debe', 'verificar', 'pagado'].map((e) => opt(e, ETIQUETA[e], p.estado === e)));
    const file = h('input', { id: 'f-file', type: 'file', accept: 'image/*,application/pdf' });
    const quitar = h('input', { id: 'f-quitar', type: 'checkbox' });
    const error = h('p', { class: 'error', role: 'alert' });
    const guardar = h('button', { type: 'submit', class: 'btn', text: 'Guardar cambios' });

    let comprobanteActual = null;
    if (p.tiene_comprobante) {
      const src = `/api/admin/puestos/${p.puesto}/comprobante?v=${Date.now()}`;
      comprobanteActual = h('div', { class: 'caja' },
        p.comprobante_tipo === 'application/pdf'
          ? h('a', { class: 'btn btn-sec', href: src, target: '_blank', rel: 'noopener', text: 'Abrir comprobante (PDF)' })
          : h('a', { href: src, target: '_blank', rel: 'noopener' }, h('img', { class: 'comp-img', src, alt: `Comprobante del puesto ${p.puesto}` })),
        h('label', { class: 'check' }, quitar, h('span', { text: 'Quitar este comprobante' })));
    }

    async function enviar(estadoForzado) {
      error.textContent = '';
      guardar.disabled = true;
      try {
        const comprobante = await archivoAComprobante(file.files[0]);
        await api(`/api/admin/puestos/${p.puesto}`, {
          method: 'PUT',
          body: {
            numeros: numeros.value,
            comprado_por: nombre.value,
            telefono: tel.value,
            forma_pago: forma.value,
            estado: estadoForzado || estado.value,
            comprobante,
            quitar_comprobante: quitar.checked,
          },
        });
        cerrar();
        toast(`Puesto ${p.puesto} guardado.`);
        cargar();
      } catch (err) {
        error.textContent = err.message;
        guardar.disabled = false;
      }
    }

    const form = h('form', { onsubmit: (e) => { e.preventDefault(); enviar(); } },
      h('div', { class: 'dlg-in-form' },
        h('label', { class: 'campo' }, h('span', { text: 'Números del puesto' }), numeros, h('small', { text: 'De 00 a 99, separados por espacio.' })),
        h('label', { class: 'campo' }, h('span', { text: 'Comprado por' }), nombre),
        h('label', { class: 'campo' }, h('span', { text: 'Teléfono' }), tel),
        h('label', { class: 'campo' }, h('span', { text: 'Forma de pago' }), forma),
        h('label', { class: 'campo' }, h('span', { text: 'Estado' }), estado),
        comprobanteActual,
        h('label', { class: 'campo' }, h('span', { text: p.tiene_comprobante ? 'Reemplazar comprobante' : 'Adjuntar comprobante' }), file),
        error,
        h('div', { class: 'acciones' },
          h('button', { type: 'button', class: 'btn btn-peligro', onclick: () => {
            if (confirm(`¿Liberar el puesto ${p.puesto}? Se borran el comprador y el comprobante.`)) enviar('libre');
          }, text: 'Liberar puesto' }),
          h('button', { type: 'button', class: 'btn btn-sec', onclick: cerrar, text: 'Cerrar' }),
          h('button', { type: 'button', class: 'btn btn-sec', onclick: () => enviar('pagado'), text: 'Marcar pagado' }),
          guardar)));

    abrir(h('h2', { text: `Puesto ${p.puesto}, ${fmt(p.precio)}` }), form);
  }

  // ---------- eventos de la página ----------
  $('#buscar').addEventListener('input', (e) => { state.q = e.target.value; pintarGrid(); });
  document.querySelectorAll('.filtros button').forEach((b) => b.addEventListener('click', () => {
    state.filtro = b.dataset.filtro;
    document.querySelectorAll('.filtros button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    pintarGrid();
  }));
  $('#btn-organizador').addEventListener('click', abrirLogin);
  $('#btn-salir').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    await cargar();
    toast('Saliste del modo organizador.');
  });

  cargar();
})();
