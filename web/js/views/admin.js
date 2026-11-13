import { h, icon, plural, fill, add } from '../dom.js';
import { get, post, del, errorText } from '../api.js';
import { backBar, toast, confirmDialog, emptyState } from '../ui.js';

const ago = (ts) => {
  if (!ts) return 'nunca';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 90) return 'recién';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} d`;
};

export async function admin(ctx) {
  const usersBox = h('div');
  const libBox = h('div');
  const root = h('div', null, backBar(), h('h1', { class: 'h1' }, 'Administración'),
    h('div', { class: 'eyebrow', style: { 'margin-bottom': '8px' } }, 'Personas'), usersBox,
    h('div', { class: 'eyebrow', style: { margin: '28px 0 8px' } }, 'Biblioteca'), libBox,
    h('div', { class: 'eyebrow', style: { margin: '28px 0 8px' } }, 'Herramientas'),
    h('a', { class: 'libcard', href: '#/diagnostico' }, h('div', { class: 'ico', style: { '--c': '#2c4a3f' } }, icon('wave')),
      h('div', { class: 'main' }, h('div', { class: 't' }, 'Diagnóstico del audio'), h('div', { class: 'muted small' }, 'Estado del reproductor y últimos eventos')), h('span', { class: 'chev' }, icon('right'))));

  async function act(user, body, okText) {
    try { await post(`/api/admin/users/${user.id}`, body); toast(okText); await loadUsers(); ctx.updateBadge?.(); } catch (e) { toast(errorText(e)); }
  }
  const userRow = (u) => {
    const me = u.id === ctx.me.id;
    const btns = [];
    if (!me) {
      if (u.status === 'pending') {
        btns.push(h('button', { class: 'btn btn-primary btn-sm', onclick: () => act(u, { status: 'active' }, `${u.name} ya puede entrar`) }, icon('check'), 'Aprobar'));
        btns.push(h('button', { class: 'btn btn-danger btn-sm', onclick: () => act(u, { status: 'blocked' }, 'Solicitud rechazada') }, 'Rechazar'));
      } else if (u.status === 'active') {
        btns.push(h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => {
          if (await confirmDialog({ title: `¿Bloquear a ${u.name}?`, text: 'Se le cierra la sesión y no podrá entrar hasta que lo reactives.', confirm: 'Bloquear', danger: true })) act(u, { status: 'blocked' }, `${u.name} fue bloqueado`);
        } }, 'Bloquear'));
      } else {
        btns.push(h('button', { class: 'btn btn-secondary btn-sm', onclick: () => act(u, { status: 'active' }, `${u.name} fue reactivado`) }, 'Reactivar'));
        btns.push(h('button', { class: 'btn btn-danger btn-sm', onclick: async () => {
          if (await confirmDialog({ title: `¿Eliminar a ${u.name}?`, text: 'Se borran también sus favoritos y playlists.', confirm: 'Eliminar', danger: true })) {
            try { await del(`/api/admin/users/${u.id}`); toast('Persona eliminada'); loadUsers(); } catch (e) { toast(errorText(e)); }
          }
        } }, 'Eliminar'));
      }
    }
    return h('div', { class: 'user' }, h('div', { class: 'ava' }, u.name.slice(0, 1)),
      h('div', { class: 'main' }, h('div', { class: 't' }, u.name, u.isAdmin ? h('span', { class: 'tag' }, 'ADMIN') : null, me ? h('span', { class: 'tag' }, 'TÚ') : null),
        h('div', { class: 's' }, u.email), h('div', { class: 's' }, u.status === 'pending' ? `Pidió entrar ${ago(u.createdAt)}` : `Última vez: ${ago(u.lastSeen)}`)),
      h('div', { class: 'btns' }, ...btns));
  };

  async function loadUsers() {
    const { users } = await get('/api/admin/users');
    const by = (s) => users.filter((u) => u.status === s);
    fill(usersBox,
      h('div', { class: 'stat' }, h('div', { class: by('pending').length ? 'hot' : '' }, h('b', null, String(by('pending').length)), h('span', null, 'Pendientes')),
        h('div', null, h('b', null, String(by('active').length)), h('span', null, 'Con acceso')), h('div', null, h('b', null, String(by('blocked').length)), h('span', null, 'Bloqueados'))));
    if (by('pending').length) add(usersBox,h('div', { class: 'muted small', style: { margin: '10px 0 0' } }, 'Esperan tu aprobación'), ...by('pending').map(userRow));
    else add(usersBox,h('div', { class: 'muted small', style: { margin: '10px 0' } }, 'No hay solicitudes pendientes.'));
    if (by('active').length) add(usersBox,h('div', { class: 'muted small', style: { margin: '14px 0 0' } }, 'Con acceso'), ...by('active').map(userRow));
    if (by('blocked').length) add(usersBox,h('div', { class: 'muted small', style: { margin: '14px 0 0' } }, 'Bloqueados'), ...by('blocked').map(userRow));
  }

  let timer = null;
  async function loadLib() {
    const s = await get('/api/admin/library');
    const total = s.ok + s.pending + s.error;
    const busy = s.scanning || s.pending > 0;
    fill(libBox,
      h('div', { class: 'stat' }, h('div', null, h('b', null, String(s.ok)), h('span', null, 'Listas')), h('div', { class: s.pending ? 'hot' : '' }, h('b', null, String(s.pending)), h('span', null, 'Convirtiendo')), h('div', null, h('b', null, String(s.error)), h('span', null, 'Con error'))),
      total ? h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': String(s.ok), 'aria-valuemax': String(total) }, h('i', { style: { '--p': String(s.ok / total) } })) : null,
      h('div', { class: 'muted small' }, s.lastScan ? (s.lastScan.error ? `Último escaneo con error: ${s.lastScan.error}` : `Última búsqueda: ${s.lastScan.tracks} canciones de ${plural(s.lastScan.artists, 'artista', 'artistas')} (${ago(Math.floor(s.lastScan.at / 1000))})`) : 'Aún no se ha buscado música.'),
      h('div', { style: { display: 'flex', gap: '10px', 'margin-top': '12px', 'flex-wrap': 'wrap' } },
        h('button', { class: 'btn btn-primary btn-sm', disabled: s.scanning, onclick: async () => { try { await post('/api/admin/scan'); toast('Buscando música nueva…'); setTimeout(loadLib, 800); } catch (e) { toast(errorText(e)); } } }, icon('refresh'), s.scanning ? 'Buscando…' : 'Buscar música nueva'),
        s.error ? h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => { await post('/api/admin/retry'); toast('Reintentando…'); loadLib(); } }, 'Reintentar errores') : null),
      s.errors.length ? h('div', { class: 'muted small', style: { 'margin-top': '10px' } }, ...s.errors.map((e) => h('div', null, `• ${e.title}: ${e.error}`))) : null);
    clearTimeout(timer);
    if (busy && root.isConnected) timer = setTimeout(() => root.isConnected && loadLib().catch(() => {}), 3000);
  }

  await Promise.all([loadUsers(), loadLib()]);
  return root;
}
