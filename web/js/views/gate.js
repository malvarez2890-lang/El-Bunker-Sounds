// Pantallas antes de entrar: bienvenida, acceso (Google o correo con código), pendiente y bloqueado.
import { h, icon, clear } from '../dom.js';
import { get, post, ApiError } from '../api.js';

const logo = () => h('img', { class: 'logo', src: '/img/logo.webp', alt: 'El Búnker Sound', width: 900, height: 675 });

export async function renderGate(app, { onDone }) {
  let cfg = { google: false };
  try { cfg = await get('/api/auth/config'); } catch { /* sin config: solo correo */ }
  let step = location.hash.startsWith('#/entrar') ? 'login' : 'welcome';
  let email = '';
  let message = location.hash.includes('error=google') ? 'No pudimos entrar con Google. Prueba con tu correo.' : '';
  if (message) history.replaceState(null, '', '/');

  const draw = () => {
    clear(app);
    const wrap = h('div', { class: 'gate' });
    app.append(wrap);
    if (step === 'welcome') {
      wrap.append(logo(), h('div', { class: 'tagline' }, 'Tu refugio musical.'),
        h('div', { class: 'stack' }, h('button', { class: 'btn btn-primary btn-block', onclick: () => { step = 'login'; draw(); } }, 'Entrar'),
          h('div', { class: 'hint' }, 'Si ya tienes cuenta, entra con el mismo correo de siempre: no se crea otra. Música de casa, solo para amigos invitados.')));
    } else if (step === 'login') {
      const err = h('div', { class: 'err', role: 'alert' }, message);
      const input = h('input', { class: 'field', type: 'email', placeholder: 'tu@correo.com', autocomplete: 'email', inputMode: 'email', autocapitalize: 'off', 'aria-label': 'Tu correo', value: email });
      const send = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, icon('mail'), 'Enviarme un código');
      const form = h('form', { class: 'stack', noValidate: true, onsubmit: async (e) => {
        e.preventDefault();
        email = input.value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = 'Escribe un correo válido.'; return; }
        send.disabled = true; err.textContent = '';
        try { await post('/api/auth/email/start', { email }); step = 'code'; message = ''; draw(); }
        catch (ex) { send.disabled = false; err.textContent = ex.status === 429 ? 'Demasiados intentos. Espera unos minutos.' : 'No pudimos enviar el código. Intenta de nuevo en un momento.'; }
      } },
      input, err, send);
      wrap.append(h('img', { class: 'logo', src: '/img/logo.webp', alt: '', style: { width: '52%', 'margin-bottom': '14px' } }),
        h('div', { class: 'stack' },
          h('h1', null, 'Entrar'),
          h('div', { class: 'muted', style: { 'margin-bottom': '6px' } }, 'Escribe el mismo correo con el que ya entras en tu celular y te enviamos un código. Si ya tienes cuenta, no se crea otra. Solo si es tu primera vez, el administrador tiene que aprobar tu acceso.'),
          cfg.google ? h('a', { class: 'btn google-btn btn-block', href: '/api/auth/google/start' }, 'Entrar con Google') : null,
          cfg.google ? h('div', { class: 'divider' }, 'o con tu correo') : null,
          form,
          h('div', { class: 'divider' }, 'o'),
          h('button', { class: 'btn btn-secondary btn-block', onclick: () => { step = 'link'; draw(); } }, icon('user'), 'Ya tengo cuenta: entrar con un código del celular')));
      message = '';
    } else if (step === 'link') {
      const err = h('div', { class: 'err', role: 'alert' });
      const input = h('input', { class: 'field code-input', autocomplete: 'off', autocapitalize: 'characters', spellcheck: false, maxLength: 9, placeholder: 'XXXX-XXXX', 'aria-label': 'Código del celular', style: { 'letter-spacing': '.2em', 'text-transform': 'uppercase' } });
      const go = async () => {
        const code = input.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        if (code.length !== 8) return;
        input.disabled = true; err.textContent = '';
        try { await post('/api/auth/link/redeem', { code }); onDone(); }
        catch (ex) { input.disabled = false; input.focus(); err.textContent = ex.status === 429 ? 'Demasiados intentos. Espera unos minutos.' : 'Ese código no sirve o ya venció. Pide uno nuevo en tu celular.'; }
      };
      input.addEventListener('input', () => { const c = input.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8); input.value = c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c; if (c.length === 8) go(); });
      wrap.append(h('div', { class: 'stack' },
        h('div', { class: 'pending-ico' }, icon('user')),
        h('h1', { style: { 'text-align': 'center' } }, 'Entrar con tu cuenta'),
        h('div', { class: 'muted', style: { 'text-align': 'center' } }, 'En tu celular abre El Búnker Sound, toca tu letra (arriba a la derecha) y elige «Conectar otro dispositivo». Escribe aquí el código que aparece.'),
        input, err,
        h('button', { class: 'btn btn-ghost btn-block', onclick: () => { step = 'login'; draw(); } }, 'Volver')));
      setTimeout(() => input.focus(), 80);
    } else {
      const err = h('div', { class: 'err', role: 'alert' });
      const input = h('input', { class: 'field code-input', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 6, placeholder: '······', 'aria-label': 'Código de 6 dígitos' });
      const verify = async () => {
        const code = input.value.replace(/\D/g, '');
        if (code.length !== 6) return;
        input.disabled = true; err.textContent = '';
        try { await post('/api/auth/email/verify', { email, code }); onDone(); }
        catch (ex) {
          input.disabled = false; input.value = ''; input.focus();
          err.textContent = ex.status === 429 ? 'Demasiados intentos. Espera unos minutos.' : 'Ese código no sirve o venció. Revisa el correo o pide uno nuevo.';
        }
      };
      input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); if (input.value.length === 6) verify(); });
      const resend = h('button', { class: 'btn btn-ghost btn-block', disabled: true }, 'Reenviar código');
      let left = 30;
      const timer = setInterval(() => {
        if (!resend.isConnected) { clearInterval(timer); return; }
        left--; resend.textContent = left > 0 ? `Reenviar código (${left})` : 'Reenviar código'; resend.disabled = left > 0;
        if (left <= 0) clearInterval(timer);
      }, 1000);
      resend.addEventListener('click', async () => {
        resend.disabled = true;
        try { await post('/api/auth/email/start', { email }); err.textContent = ''; resend.textContent = 'Código enviado'; } catch { err.textContent = 'No pudimos reenviar el código.'; }
      });
      wrap.append(h('div', { class: 'stack' },
        h('div', { class: 'pending-ico' }, icon('mail')),
        h('h1', { style: { 'text-align': 'center' } }, 'Revisa tu correo'),
        h('div', { class: 'muted', style: { 'text-align': 'center' } }, `Te enviamos un código de 6 dígitos a ${email}. Si no aparece, mira en spam.`),
        input, err, resend,
        h('button', { class: 'btn btn-ghost btn-block', onclick: () => { step = 'login'; draw(); } }, 'Usar otro correo')));
      setTimeout(() => input.focus(), 80);
    }
  };
  draw();
}

export function renderPending(app, me, { onRefresh, onLogout }) {
  clear(app).append(h('div', { class: 'gate' }, h('div', { class: 'stack' },
    h('div', { class: 'pending-ico' }, icon('clock')),
    h('h1', { style: { 'text-align': 'center' } }, 'Tu acceso está pendiente'),
    h('div', { class: 'muted', style: { 'text-align': 'center' } }, `Hola, ${me.name}. Ya avisamos al administrador. Cuando apruebe tu acceso podrás escuchar la música.`),
    h('div', { class: 'muted small', style: { 'text-align': 'center' } }, `¿Ya tenías cuenta? Entraste con ${me.email || 'otro correo'}, que no es el de siempre. Cierra sesión y entra con el correo con el que ya usas la app.`),
    h('button', { class: 'btn btn-primary btn-block', onclick: onRefresh }, icon('refresh'), 'Revisar de nuevo'),
    h('button', { class: 'btn btn-ghost btn-block', onclick: onLogout }, 'Entrar con otro correo'))));
}

export function renderBlocked(app, { onLogout }) {
  clear(app).append(h('div', { class: 'gate' }, h('div', { class: 'stack' },
    h('div', { class: 'pending-ico' }, icon('close')),
    h('h1', { style: { 'text-align': 'center' } }, 'Acceso no disponible'),
    h('div', { class: 'muted', style: { 'text-align': 'center' } }, 'Esta cuenta no tiene permiso para entrar. Si crees que es un error, habla con el administrador.'),
    h('button', { class: 'btn btn-ghost btn-block', onclick: onLogout }, 'Cerrar sesión'))));
}

/** El servidor de la casa no responde (apagado, reiniciándose o sin internet): la app igual abre y lo explica, y reintenta sola. */
export function renderOffline(app, { retry }) {
  document.body.classList.add('offline-page'); // en esta pantalla no hace falta el aviso de arriba (diría lo mismo)
  const status = h('div', { class: 'hint', 'aria-live': 'polite' });
  const why = h('div', { class: 'muted', style: { 'text-align': 'center' } });
  let left = 6, stopped = false;
  const paint = () => {
    why.textContent = navigator.onLine === false
      ? 'Tu aparato no tiene internet. Revisa el Wi-Fi o los datos y vuelve a intentar.'
      : 'No conseguimos conectar con el servidor de El Búnker. Puede estar apagado o reiniciándose. No es culpa de tu aparato: en unos minutos debería volver.';
  };
  paint();
  const now = () => { if (stopped) return; stopped = true; retry(); };
  const timer = setInterval(() => {
    if (!status.isConnected) { clearInterval(timer); stopped = true; return; }
    left--; paint();
    if (left <= 0) { status.textContent = 'Reintentando…'; clearInterval(timer); setTimeout(() => { if (status.isConnected) now(); }, 300); return; }
    status.textContent = `Reintentando en ${left} s…`;
  }, 1000);
  status.textContent = `Reintentando en ${left} s…`;
  window.addEventListener('online', now, { once: true });
  clear(app).append(h('div', { class: 'gate' }, h('div', { class: 'stack' },
    logo(), h('div', { class: 'pending-ico' }, icon('wave')),
    h('h1', { style: { 'text-align': 'center' } }, 'Sin conexión con el servidor'), why, status,
    h('button', { class: 'btn btn-primary btn-block', onclick: () => { clearInterval(timer); now(); } }, icon('refresh'), 'Reintentar ahora'))));
}
