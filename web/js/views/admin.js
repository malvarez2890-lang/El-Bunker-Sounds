import { h, icon, plural, fill, add } from '../dom.js';
import { get, post, del, errorText } from '../api.js';
import { backBar, toast, confirmDialog, emptyState, openSheet } from '../ui.js';

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
  const newsBox = h('div');
  const root = h('div', null, backBar(), h('h1', { class: 'h1' }, 'Administración'),
    h('div', { class: 'eyebrow', style: { 'margin-bottom': '8px' } }, 'Personas'), usersBox,
    h('div', { class: 'eyebrow', style: { margin: '28px 0 8px' } }, 'Novedades'), newsBox,
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
    const busy = s.scanning || s.pending > 0 || s.legacy > 0;
    fill(libBox,
      h('div', { class: 'stat' }, h('div', null, h('b', null, String(s.ok)), h('span', null, 'Listas')), h('div', { class: s.pending ? 'hot' : '' }, h('b', null, String(s.pending)), h('span', null, 'Convirtiendo')), h('div', null, h('b', null, String(s.error)), h('span', null, 'Con error'))),
      total ? h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': String(s.ok), 'aria-valuemax': String(total) }, h('i', { style: { '--p': String(s.ok / total) } })) : null,
      s.legacy ? h('div', { class: 'muted small', style: { 'margin-bottom': '6px' } }, `Pasando ${s.legacy} canciones a MP3 (siguen sonando mientras tanto).`) : null,
      h('div', { class: 'muted small' }, s.lastScan ? (s.lastScan.error ? `Último escaneo con error: ${s.lastScan.error}` : `Última búsqueda: ${s.lastScan.tracks} canciones de ${plural(s.lastScan.artists, 'artista', 'artistas')} (${ago(Math.floor(s.lastScan.at / 1000))})`) : 'Aún no se ha buscado música.'),
      h('div', { style: { display: 'flex', gap: '10px', 'margin-top': '12px', 'flex-wrap': 'wrap' } },
        h('button', { class: 'btn btn-primary btn-sm', disabled: s.scanning, onclick: async () => { try { await post('/api/admin/scan'); toast('Buscando música nueva…'); setTimeout(loadLib, 800); } catch (e) { toast(errorText(e)); } } }, icon('refresh'), s.scanning ? 'Buscando…' : 'Buscar música nueva'),
        s.error ? h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => { await post('/api/admin/retry'); toast('Reintentando…'); loadLib(); } }, 'Reintentar errores') : null),
      s.errors.length ? h('div', { class: 'muted small', style: { 'margin-top': '10px' } }, ...s.errors.map((e) => h('div', null, `• ${e.title}: ${e.error}`))) : null);
    clearTimeout(timer);
    if (busy && root.isConnected) timer = setTimeout(() => root.isConnected && loadLib().catch(() => {}), 3000);
  }

  // ---- novedades: tarjetas que ven todos arriba en Inicio ----
  async function openNewsForm(item) {
    let albums = [];
    try { albums = (await get('/api/albums')).albums; } catch { /* sin lista de álbumes */ }
    openSheet((box, o) => {
      const title = h('input', { class: 'field', value: item?.title || '', maxLength: 80, 'aria-label': 'Título', placeholder: 'Título (ej. Próximo lanzamiento)', autocomplete: 'off' });
      const body = h('textarea', { class: 'field area', maxLength: 500, 'aria-label': 'Texto', placeholder: 'Texto corto (opcional)' }, item?.body || '');
      const sel = h('select', { class: 'field', 'aria-label': 'Álbum que se abre al tocar' },
        h('option', { value: '' }, 'Sin álbum'), ...albums.map((a) => h('option', { value: String(a.id), selected: item?.album?.id === a.id }, `${a.artistName} · ${a.title}`)));
      const active = h('input', { type: 'checkbox', checked: item ? !!item.active : true });
      const save = async () => {
        if (!title.value.trim()) { toast('Escribe un título.'); return; }
        const payload = { title: title.value, body: body.value, albumId: sel.value ? Number(sel.value) : null, active: active.checked };
        try {
          await post(item ? `/api/admin/news/${item.id}` : '/api/admin/news', payload);
          o.close(); toast('Novedad guardada'); loadNews();
        } catch (e) { toast(errorText(e)); }
      };
      box.append(h('h3', null, item ? 'Editar novedad' : 'Nueva novedad'), title, h('div', { style: { height: '10px' } }), body,
        h('div', { style: { height: '10px' } }), sel, h('label', { class: 'check' }, active, 'Mostrar en Inicio'),
        h('div', { class: 'btns', style: { 'margin-top': '16px' } }, h('button', { class: 'btn btn-ghost', onclick: () => o.close() }, 'Cancelar'), h('button', { class: 'btn btn-primary', onclick: save }, 'Guardar')));
    });
  }
  async function loadNews() {
    const { news } = await get('/api/admin/news');
    fill(newsBox,
      ...(news.length ? news.map((n) => h('div', { class: 'row' },
        h('div', { class: 'main' }, h('div', { class: 't' }, n.title, h('span', { class: 'tag' }, n.active ? 'VISIBLE' : 'OCULTA')), h('div', { class: 's' }, n.album ? `Abre: ${n.album.title}` : (n.body || 'Sin texto'))),
        h('button', { class: 'icon-btn', 'aria-label': `Editar ${n.title}`, onclick: () => openNewsForm(n) }, icon('edit')),
        h('button', { class: 'icon-btn', 'aria-label': n.active ? `Ocultar ${n.title}` : `Mostrar ${n.title}`, onclick: async () => { try { await post(`/api/admin/news/${n.id}`, { active: !n.active }); loadNews(); } catch (e) { toast(errorText(e)); } } }, icon(n.active ? 'close' : 'check')),
        h('button', { class: 'icon-btn', 'aria-label': `Borrar ${n.title}`, onclick: async () => { if (await confirmDialog({ title: 'Borrar novedad', text: `“${n.title}” dejará de verse.`, confirm: 'Borrar', danger: true })) { try { await del(`/api/admin/news/${n.id}`); loadNews(); } catch (e) { toast(errorText(e)); } } } }, icon('trash'))))
        : [h('div', { class: 'muted small', style: { margin: '4px 0 10px' } }, 'Todavía no hay novedades. Aparecen arriba en Inicio para todos.')]),
      h('button', { class: 'btn btn-secondary btn-sm', style: { 'margin-top': '10px' }, onclick: () => openNewsForm(null) }, icon('plus'), 'Nueva novedad'));
  }

  await Promise.all([loadUsers(), loadLib(), loadNews()]);
  return root;
}
