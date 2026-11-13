import { h, icon, fill } from '../dom.js';
import { backBar, toast } from '../ui.js';
import { debugInfo } from '../player.js';

export async function diagnostico() {
  const box = h('pre', { class: 'diag' });
  const draw = () => {
    const d = debugInfo();
    const text = [
      `App instalada (pantalla completa): ${navigator.standalone || matchMedia('(display-mode: standalone)').matches ? 'sí' : 'no'}`,
      `Service worker activo: ${navigator.serviceWorker?.controller ? 'sí' : 'no'}`,
      `Navegador: ${navigator.userAgent}`,
      '',
      `Audio: ${JSON.stringify(d.audio, null, 1)}`,
      `Siguiente lista en el 2º reproductor: ${JSON.stringify(d.spare)}`,
      `Cola: ${d.queue}  cargada: ${d.loadedId}`,
      `Descargas en memoria: ${d.cache.join(', ') || 'ninguna'}`,
      `Estado: ${JSON.stringify(d.state)}`,
      '',
      'Últimos eventos (lo más nuevo arriba):',
      ...d.logs,
    ].join('\n');
    box.textContent = text;
    return text;
  };
  draw();
  return h('div', null, backBar(), h('h1', { class: 'h1' }, 'Diagnóstico del audio'),
    h('div', { class: 'muted small', style: { 'margin-bottom': '12px' } }, 'Si algo falla con la música, toma una captura de esta pantalla y mándasela a quien te ayuda.'),
    h('div', { style: { display: 'flex', gap: '10px', 'margin-bottom': '12px' } },
      h('button', { class: 'btn btn-secondary btn-sm', onclick: draw }, icon('refresh'), 'Actualizar'),
      h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => { try { await navigator.clipboard.writeText(draw()); toast('Copiado'); } catch { toast('No se pudo copiar'); } } }, 'Copiar')),
    box);
}
