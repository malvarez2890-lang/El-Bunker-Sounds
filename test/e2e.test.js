// Prueba de punta a punta en un navegador de verdad (Chromium con tamaño de celular).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { loadConfig } from '../server/config.js';
import { buildApp } from '../server/app.js';
import { testMusicDir } from './helpers.js';
import { startFakeOnkyo } from './fake-onkyo.js';

function loadPlaywright() {
  const candidates = [import.meta.url, path.join(execSync('npm root -g').toString().trim(), 'x.js')];
  for (const base of candidates) { try { return createRequire(base)('playwright'); } catch { /* siguiente */ } }
  return null;
}
const pw = loadPlaywright();
const SHOTS = path.resolve('test-output');
fs.mkdirSync(SHOTS, { recursive: true });

let server, base, dataDir, browser, fakeOnkyo;
const errors = [];

before(async () => {
  if (!pw) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebs-e2e-'));
  fakeOnkyo = await startFakeOnkyo({ playMs: 60000 });
  const config = loadConfig({
    MUSIC_DIR: testMusicDir('8'), DATA_DIR: dataDir, BASE_URL: 'http://127.0.0.1:3917', PORT: '3917', HOST: '127.0.0.1',
    ADMIN_EMAILS: 'admin@test.cl', MAIL_MODE: 'file', SCAN_INTERVAL_MIN: '0',
    ONKYO_IP: '127.0.0.1', ONKYO_LAN_IP: '127.0.0.1', ONKYO_LAN_PORT: '39199', ONKYO_LAN_HOST: '127.0.0.1',
    ONKYO_EISCP_PORT: String(fakeOnkyo.eiscpPort), ONKYO_UPNP_PORT: String(fakeOnkyo.upnpPort),
    ONKYO_POLL_MS: '300', ONKYO_BOOT_WAIT_MS: '100', ONKYO_INPUT_WAIT_MS: '50',
  });
  server = await buildApp(config, { logger: false });
  await server.ctx.library.scan();
  await server.ctx.transcoder.whenIdle();
  await server.app.listen({ port: 3917, host: '127.0.0.1' });
  await server.ctx.onkyo.listen();
  base = 'http://127.0.0.1:3917';
  browser = await pw.chromium.launch();
});
after(async () => { await browser?.close(); await server?.app.close(); fakeOnkyo?.close(); });

const codeFor = (email) => {
  const dir = path.join(dataDir, 'outbox');
  for (const f of fs.readdirSync(dir).sort().reverse()) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (m.to === email) { const c = /es (\d{6})\./.exec(m.text); if (c) return c[1]; }
  }
};

async function newPage(name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'es-CL', serviceWorkers: 'block', ...opts });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|403)/.test(m.text())) errors.push(`[${name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/api/')) errors.push(`[${name}] ${r.status()} ${r.url()}`); });
  await page.addInitScript(() => {
    window.__audios = [];
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { if (!window.__audios.includes(this)) window.__audios.push(this); return orig.call(this); };
    // Anota qué botones de la pantalla de bloqueo registra la app (iOS muestra anterior/siguiente solo si NO hay botones de ±10 s).
    window.__msh = {};
    if (window.MediaSession) { const setH = MediaSession.prototype.setActionHandler; MediaSession.prototype.setActionHandler = function (n, f) { window.__msh[n] = f; return setH.call(this, n, f); }; }
    // Permite simular el teléfono bloqueado: el aviso "terminó la canción" no llega (iOS congela la app justo ahí).
    const addL = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, cb, opts) {
      if (type === 'ended' && this instanceof HTMLMediaElement) { const orig2 = cb; cb = function (e) { if (window.__suppressEnded) return; return orig2.call(this, e); }; }
      return addL.call(this, type, cb, opts);
    };
    // El reproductor que suena ahora (hay dos que se turnan).
    window.__a = () => { const l = window.__audios.filter((a) => a.src.startsWith('blob:')); return l.find((a) => !a.paused) || l.sort((x, y) => y.currentTime - x.currentTime)[0] || window.__audios[0]; };
  });
  return { page, ctx };
}
/** Espera a que terminen las animaciones de cambio de pantalla. */
const noSplash = (page) => page.locator('#splash').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
const settled = async (page) => {
  await page.waitForTimeout(380); // deja arrancar y terminar la transición de pantalla
  await page.waitForFunction(() => !document.getAnimations().some((a) => a.playState === 'running' && (a.effect?.target?.closest?.('.page') && !a.effect.target.closest('.eq, .loading, .skel'))), null, { timeout: 5000 });
};
const P = (page) => page.locator('.page:not(.off)');
const shot = async (page, name) => {
  await settled(page).catch(() => {});
  await page.waitForTimeout(250);
  const text = await page.locator('body').innerText();
  assert.ok(!/\bnull\b|\bundefined\b|\[object|NaN/.test(text), `texto raro en pantalla ${name}: ${text.match(/.{0,20}(null|undefined|\[object|NaN).{0,20}/)?.[0]}`);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

async function login(page, email) {
  await page.goto(base);
  await page.getByRole('button', { name: 'Comenzar' }).click();
  await page.getByLabel('Tu correo').fill(email);
  await page.getByRole('button', { name: 'Enviarme un código' }).click();
  await page.getByLabel('Código de 6 dígitos').waitFor();
  await page.getByLabel('Código de 6 dígitos').fill(codeFor(email));
}

let admin, friend;
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('tiempo agotado'); await new Promise((r) => setTimeout(r, 50)); } };

test('pantalla de bienvenida y acceso', { skip: !pw }, async () => {
  admin = await newPage('admin');
  const { page } = admin;
  await page.goto(base);
  await page.getByRole('img', { name: 'El Búnker Sound' }).waitFor();
  await shot(page, '01-bienvenida');
  await page.getByRole('button', { name: 'Comenzar' }).click();
  await page.waitForTimeout(250);
  await shot(page, '02-entrar');
  await page.getByLabel('Tu correo').fill('mal');
  await page.getByRole('button', { name: 'Enviarme un código' }).click();
  assert.match(await page.locator('.err').innerText(), /correo válido/);
  await page.getByLabel('Tu correo').fill('admin@test.cl');
  await page.getByRole('button', { name: 'Enviarme un código' }).click();
  await page.getByLabel('Código de 6 dígitos').waitFor();
  await page.getByLabel('Código de 6 dígitos').fill('000000');
  await page.locator('.err', { hasText: 'no sirve' }).waitFor();
  await shot(page, '03-codigo-error');
  await page.getByLabel('Código de 6 dígitos').fill(codeFor('admin@test.cl'));
  await page.getByRole('heading', { name: 'Tu música. Tu refugio.' }).waitFor();
  assert.equal(await page.evaluate(() => document.fonts.ready.then(() => document.fonts.check('700 24px Sora') && document.fonts.check('400 15px Inter'))), true, 'las fuentes Sora e Inter deben cargar');
});

test('inicio, explorar, biblioteca y buscar', { skip: !pw }, async () => {
  const { page } = admin;
  await P(page).locator('.hero').waitFor();
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await shot(page, '04-inicio');
  await page.getByRole('link', { name: 'Explorar' }).click();
  await page.getByRole('heading', { name: 'Explorar' }).waitFor();
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await shot(page, '05-explorar');
  await page.getByRole('link', { name: 'Biblioteca' }).click();
  await page.getByRole('heading', { name: 'Mi biblioteca' }).waitFor();
  await shot(page, '06-biblioteca');
  await page.getByRole('link', { name: 'Buscar' }).click();
  await P(page).getByLabel('Buscar', { exact: true }).fill('MAÑANA');
  await P(page).locator('.row', { hasText: 'Mañana' }).waitFor();
  await P(page).getByLabel('Buscar', { exact: true }).fill('zzzz');
  await P(page).getByText('No encontramos nada').waitFor();
  await P(page).getByLabel('Buscar', { exact: true }).fill('piu veloce');
  await P(page).locator('.card', { hasText: 'PIÙ VELOCE' }).first().waitFor();
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await shot(page, '07-buscar');
});

test('álbum: reproducir, mini reproductor, pantalla bloqueada (Media Session)', { skip: !pw }, async () => {
  const { page } = admin;
  await page.goto(`${base}/#/lista/album`);
  await settled(page);
  await P(page).locator('.card', { hasText: 'Musica per te' }).click();
  await page.getByRole('heading', { name: 'Musica per te' }).waitFor();
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await shot(page, '08-album');
  await page.getByRole('button', { name: 'Reproducir', exact: true }).first().click();
  await page.locator('.mini').waitFor();
  // el audio avanza de verdad
  await page.waitForFunction(() => window.__a() && window.__a().currentTime > 1.2, null, { timeout: 15000 });
  const meta = await page.evaluate(() => ({ t: navigator.mediaSession.metadata.title, a: navigator.mediaSession.metadata.artist, al: navigator.mediaSession.metadata.album, art: navigator.mediaSession.metadata.artwork.length, state: navigator.mediaSession.playbackState }));
  assert.deepEqual({ t: meta.t, a: meta.a, al: meta.al, state: meta.state }, { t: 'Che Livello!', a: 'PIÙ VELOCE', al: 'Musica per te', state: 'playing' });
  assert.equal(meta.art, 3);
  await shot(page, '09-mini');
  // los botones del celular (siguiente / pausa) llegan a la app
  await page.getByRole('button', { name: 'Siguiente' }).first().click();
  await page.waitForFunction(() => navigator.mediaSession.metadata.title === 'Neon');
  await page.getByRole('button', { name: 'Pausar' }).first().click();
  await page.waitForFunction(() => window.__a().paused && navigator.mediaSession.playbackState === 'paused');
  await page.getByRole('button', { name: 'Reproducir' }).first().click();
  await page.waitForFunction(() => !window.__a().paused);
});

test('reproductor expandido: progreso, favorito, cola, aleatorio, repetir', { skip: !pw }, async () => {
  const { page } = admin;
  await page.locator('.mini .main').click();
  await page.locator('.player').waitFor();
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.waitForTimeout(450); // termina la animación de subida
  await shot(page, '10-reproductor');
  // buscar en la canción
  await page.locator('.range').evaluate((el) => { el.value = 500; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => window.__a().currentTime > 3);
  // favorito
  await page.getByRole('button', { name: 'Agregar a favoritos' }).click();
  await page.getByRole('button', { name: 'Quitar de favoritos' }).waitFor();
  // aleatorio y repetir
  const pl = page.locator('.player');
  await pl.getByRole('button', { name: 'Aleatorio' }).click();
  assert.equal(await pl.getByRole('button', { name: 'Aleatorio' }).getAttribute('aria-pressed'), 'true');
  await pl.getByRole('button', { name: /Repetir/ }).click();
  await pl.getByRole('button', { name: 'Repetir toda la cola' }).waitFor();
  await pl.getByRole('button', { name: 'Aleatorio' }).click();
  // cola
  await pl.getByRole('button', { name: 'En cola' }).click();
  await page.locator('.sheet .row.current').waitFor();
  await page.waitForTimeout(450);
  await shot(page, '11-cola');
  await page.locator('.sheet .row .main').nth(3).click();
  await page.locator('.sheet-backdrop').click({ position: { x: 10, y: 10 } });
  await page.getByRole('button', { name: 'Cerrar reproductor' }).click();
  await page.locator('.player').waitFor({ state: 'detached' });
});

test('canciones: menú, favoritos, playlist', { skip: !pw }, async () => {
  const { page } = admin;
  await page.goto(`${base}/#/lista/album`);
  await P(page).locator('.card', { hasText: 'Lasciati Andare' }).click();
  await page.getByRole('heading', { name: 'Lasciati Andare' }).waitFor();
  await page.getByRole('button', { name: 'Más opciones de Il Matto' }).click();
  await page.waitForFunction(() => document.querySelector('.sheet .menu-head'));
  await page.waitForTimeout(450);
  await shot(page, '12-menu-cancion');
  await page.getByRole('button', { name: 'Agregar a una playlist' }).click();
  await page.getByRole('button', { name: 'Nueva playlist' }).click();
  await page.getByLabel('Nombre de la playlist').fill('Para el auto');
  await page.getByRole('button', { name: 'Crear' }).click();
  await page.getByText('Agregada a “Para el auto”').waitFor();
  await page.getByRole('button', { name: 'Más opciones de Nessuna Risposta' }).click();
  await page.getByRole('button', { name: 'Agregar a una playlist' }).click();
  await page.locator('.sheet .menu-item', { hasText: 'Para el auto' }).click();
  await page.goto(`${base}/#/playlists`);
  await page.locator('.pl-row .t', { hasText: 'Para el auto' }).waitFor();
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await shot(page, '13-playlists');
  await page.locator('.pl-row .t', { hasText: 'Para el auto' }).click();
  await page.getByRole('heading', { name: 'Para el auto' }).waitFor();
  await P(page).locator('.row', { hasText: 'Nessuna Risposta' }).waitFor();
  await shot(page, '14-playlist');
  await page.goto(`${base}/#/favoritos`);
  await P(page).locator('.row', { hasText: 'Che Livello!' }).waitFor();
  await page.goto(`${base}/#/recientes`);
  await P(page).locator('.row').first().waitFor();
  await page.goto(`${base}/#/artista/1`);
  await P(page).locator('.detail-head').waitFor();
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await shot(page, '15-artista');
});

/** Simula un dedo: delay bajo = empujón rápido; delay alto = arrastre lento. */
async function touch(page, points, { end = true, delay = 16 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const [first, ...rest] = points;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: first[0], y: first[1] }] });
  for (const [x, y] of rest) { await page.waitForTimeout(delay); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); }
  if (end) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await page.waitForTimeout(520); } // deja terminar la animación
  return cdp;
}
const line = (x0, y0, x1, y1, n = 10) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);

test('pantalla de carga: aparece al instante con el logo y luego se va', { skip: !pw }, async () => {
  const f = await newPage('splash');
  await f.page.goto(base, { waitUntil: 'commit' });
  await f.page.locator('#splash').waitFor({ state: 'visible', timeout: 3000 });
  assert.equal(await f.page.locator('#splash img').getAttribute('src'), '/img/logo.webp');
  await f.page.waitForTimeout(700);
  await f.page.screenshot({ path: path.join(SHOTS, '00-pantalla-de-carga.png') });
  await f.page.locator('#splash').waitFor({ state: 'detached', timeout: 6000 });
  await f.page.getByRole('button', { name: 'Comenzar' }).waitFor();
  await f.ctx.close();
});

test('se comporta como app: sin zoom, sin scroll de la página, sin selección', { skip: !pw }, async () => {
  const { page } = admin;
  await page.goto(base);
  await noSplash(page);
  await settled(page).catch(() => {});
  const r = await page.evaluate(() => {
    window.scrollBy(0, 400); document.documentElement.scrollTop = 300;
    return {
      viewport: document.querySelector('meta[name=viewport]').content,
      scrollY: window.scrollY, docScroll: document.scrollingElement.scrollTop,
      select: getComputedStyle(document.body).userSelect, callout: getComputedStyle(document.body).webkitTouchCallout,
      overflow: getComputedStyle(document.body).overflow, bodyPos: getComputedStyle(document.body).position,
      visiblePages: document.querySelectorAll('.page:not(.off)').length,
      standalone: document.querySelector('meta[name=apple-mobile-web-app-capable]').content,
      tabbarInFlow: getComputedStyle(document.querySelector('.tabbar')).position,
    };
  });
  assert.match(r.viewport, /user-scalable=no/);
  assert.match(r.viewport, /maximum-scale=1/);
  assert.equal(r.scrollY, 0);
  assert.equal(r.docScroll, 0);
  assert.equal(r.select, 'none');
  assert.equal(r.overflow, 'hidden');
  assert.equal(r.bodyPos, 'fixed');
  assert.equal(r.visiblePages, 1);
  assert.equal(r.standalone, 'yes');
});

test('gestos: arrastrar para cambiar de pestaña y para volver', { skip: !pw }, async () => {
  const { page } = admin;
  await noSplash(page);
  await page.goto(`${base}/#/biblioteca`);
  await P(page).getByRole('heading', { name: 'Mi biblioteca' }).waitFor();
  await settled(page);
  // arrastre corto: se cancela y vuelve a su sitio
  await touch(page, line(200, 400, 250, 402, 4), { delay: 90 });
  assert.equal(await page.evaluate(() => location.hash), '#/biblioteca');
  // a mitad de arrastre se ven las dos pantallas
  const cdp = await touch(page, line(330, 400, 150, 402, 10), { end: false, delay: 40 });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.page:not(.off)').count(), 2, 'durante el arrastre se ven la pantalla actual y la siguiente');
  await shot(page, '19-arrastre-a-medias');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(() => location.hash === '#/buscar');
  await page.waitForTimeout(450);
  await settled(page);
  assert.equal(await page.locator('.page:not(.off)').count(), 1);
  assert.equal(await page.locator('.tab[aria-current=page]').innerText(), 'Buscar');
  // hacia el otro lado
  await touch(page, line(60, 400, 340, 402, 10));
  await page.waitForFunction(() => location.hash === '#/biblioteca');
  await settled(page);
  assert.equal(await page.locator('.tab[aria-current=page]').innerText(), 'Biblioteca');
  // en la última pestaña no hay más a la derecha (rebota y se queda)
  await page.goto(`${base}/#/buscar`); await settled(page);
  await touch(page, line(340, 400, 60, 402, 8)); await settled(page);
  assert.equal(await page.evaluate(() => location.hash), '#/buscar');

  // entrar a un álbum y volver arrastrando desde la izquierda
  await page.goto(`${base}/#/lista/album`); await settled(page);
  await P(page).locator('.card', { hasText: 'Lasciati Andare' }).click(); await settled(page);
  await P(page).getByRole('heading', { name: 'Lasciati Andare' }).waitFor();
  const before = await page.evaluate(() => document.querySelectorAll('.page').length);
  await touch(page, line(20, 300, 330, 304, 10));
  await page.waitForFunction(() => location.hash === '#/lista/album');
  await settled(page);
  await P(page).getByRole('heading', { name: 'Álbumes' }).waitFor();
  assert.ok(await page.evaluate(() => document.querySelectorAll('.page').length) < before, 'la pantalla de abajo se descarta al volver');
  // el botón atrás hace lo mismo (con animación)
  await P(page).locator('.card', { hasText: 'Neon, Fumo' }).click(); await settled(page);
  await page.getByRole('button', { name: 'Volver' }).click();
  await P(page).getByRole('heading', { name: 'Álbumes' }).waitFor();
  assert.equal(await page.locator('.page:not(.off)').count() >= 1, true);
  // tocar la pestaña activa con una pantalla encima vuelve a la raíz
  await P(page).locator('.card').first().click(); await settled(page);
  await page.getByRole('link', { name: 'Explorar' }).click(); await settled(page);
  await P(page).getByRole('heading', { name: 'Explorar' }).waitFor();
});

test('el scroll de una lista no mueve el resto de la app', { skip: !pw }, async () => {
  const { page } = admin;
  await page.goto(`${base}/#/lista/album`); await settled(page);
  await P(page).locator('.card', { hasText: 'Musica per te' }).click(); await settled(page);
  await touch(page, line(200, 650, 200, 250, 10));
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => ({
    pageScroll: document.querySelector('.page:not(.off)').scrollTop, win: window.scrollY,
    tabbarY: Math.round(document.querySelector('.tabbar').getBoundingClientRect().bottom), vh: innerHeight, topbarY: Math.round(document.querySelector('.topbar').getBoundingClientRect().top),
  }));
  assert.ok(r.pageScroll > 100, 'la lista sí se desplaza');
  assert.equal(r.win, 0);
  assert.equal(r.tabbarY, r.vh, 'la barra de abajo queda fija');
  assert.equal(r.topbarY, 0, 'la barra de arriba queda fija');
});

test('reproducción: pasa sola a la siguiente, la barra salta de verdad y retoma donde ibas', { skip: !pw }, async () => {
  const { page } = admin;
  await noSplash(page);
  await page.evaluate(() => { window.__suppressEnded = true; }); // simula el teléfono bloqueado: nunca llega el aviso de "terminó"
  await page.goto(`${base}/#/lista/album`); await settled(page);
  await P(page).locator('.card', { hasText: 'Neon, Fumo' }).click(); await settled(page);
  await P(page).getByRole('button', { name: 'Reproducir', exact: true }).first().click();
  await page.waitForFunction(() => navigator.mediaSession.metadata?.title === 'Luci Accese');
  await page.waitForFunction(() => window.__a().currentTime > 1 && !window.__a().paused);

  // 1) la barra de reproducción salta de verdad (al 80% de una canción de 8 s)
  await page.locator('.mini .main').click();
  const pl = page.locator('.player');
  await pl.waitFor();
  await pl.locator('.range').evaluate((el) => { el.value = 800; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => window.__a().currentTime > 6 && window.__a().currentTime < 7.9);
  // 2) al terminar, empieza sola la siguiente (sin tocar nada)
  await page.waitForFunction(() => navigator.mediaSession.metadata?.title === 'Velocità', null, { timeout: 8000 });
  await page.waitForFunction(() => !window.__a().paused && window.__a().currentTime < 3);
  assert.equal(await pl.locator('h2').innerText(), 'Velocità');
  // 3) y la que sigue después de esa también
  await pl.locator('.range').evaluate((el) => { el.value = 900; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => navigator.mediaSession.metadata?.title === 'Corpi Elettrici', null, { timeout: 8000 });
  await page.getByRole('button', { name: 'Cerrar reproductor' }).click();
  await page.locator('.player').waitFor({ state: 'detached' });
  // la pantalla de diagnóstico confirma que la siguiente arrancó ANTES de que terminara la anterior (sin depender del aviso de "terminó")
  await page.goto(`${base}/#/diagnostico`); await settled(page);
  assert.match(await P(page).locator('.diag').innerText(), /traspaso .* a id=/);
  await page.goto(`${base}/#/lista/album`); await settled(page);

  await page.evaluate(() => { window.__suppressEnded = false; });
  // 4) retomar: se guarda la posición al salir y, al volver y apretar play, sigue desde ahí (no desde cero)
  await page.waitForFunction(() => window.__a().currentTime > 3);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ebs_player_v1')));
  assert.ok(saved.pos >= 3, `se guardó la posición (${saved.pos})`);
  await page.reload();
  await noSplash(page);
  await page.locator('.mini').waitFor();
  assert.equal(await page.locator('.mini .t').innerText(), 'Corpi Elettrici');
  const shownBefore = await page.evaluate(() => getComputedStyle(document.querySelector('.mini')).getPropertyValue('--p'));
  assert.ok(Number(shownBefore) > 0.3, 'la barra muestra el avance guardado');
  await page.locator('#mini-toggle').click();
  await page.waitForFunction((pos) => window.__a() && !window.__a().paused && window.__a().currentTime >= pos - 0.6, saved.pos, { timeout: 8000 });
});

test('diagnóstico del audio: está dentro de Administración y muestra el estado y los eventos', { skip: !pw }, async () => {
  const { page } = admin;
  await page.goto(`${base}/#/admin`); await settled(page);
  await P(page).getByRole('heading', { name: 'Administración' }).waitFor();
  await P(page).getByText('Herramientas').waitFor();
  await P(page).locator('.libcard', { hasText: 'Diagnóstico del audio' }).click(); await settled(page);
  await P(page).getByRole('heading', { name: 'Diagnóstico del audio' }).waitFor();
  // ya no está en el menú del perfil
  await page.getByRole('button', { name: 'Tu perfil' }).click();
  await page.waitForFunction(() => document.querySelector('.sheet .menu-head'));
  assert.equal(await page.getByText('Diagnóstico del audio').count() > 0 && await page.locator('.sheet').getByText('Diagnóstico').count(), 0);
  await page.keyboard.press('Escape');
  const txt = await P(page).locator('.diag').innerText();
  assert.match(txt, /memoria \(blob\)/);
  assert.match(txt, /Últimos eventos/);
  assert.match(txt, /descarga lista/);
});

test('pantalla de bloqueo: botones anterior/siguiente como Spotify (no ±10 s) y funcionan', { skip: !pw }, async () => {
  const { page } = admin;
  await noSplash(page);
  await page.goto(`${base}/#/lista/album`); await settled(page);
  await P(page).locator('.card', { hasText: 'Musica per te' }).click(); await settled(page);
  await P(page).getByRole('button', { name: 'Reproducir', exact: true }).first().click();
  await page.waitForFunction(() => navigator.mediaSession.metadata?.title === 'Che Livello!');
  const h = await page.evaluate(() => Object.fromEntries(Object.entries(window.__msh).map(([k, v]) => [k, typeof v])));
  assert.equal(h.nexttrack, 'function');
  assert.equal(h.previoustrack, 'function');
  assert.equal(h.seekbackward, 'object', 'sin botón de retroceder 10 s (null)');
  assert.equal(h.seekforward, 'object', 'sin botón de avanzar 10 s (null)');
  await page.evaluate(() => window.__msh.nexttrack());
  await page.waitForFunction(() => navigator.mediaSession.metadata?.title === 'Neon');
  await page.evaluate(() => window.__msh.previoustrack());
  await page.waitForFunction(() => navigator.mediaSession.metadata?.title === 'Che Livello!' || window.__a().currentTime < 3);
});

test('gestos: mini reproductor, tarjeta del reproductor y hojas se manejan deslizando', { skip: !pw }, async () => {
  const { page } = admin;
  await noSplash(page);
  const title = () => page.evaluate(() => navigator.mediaSession.metadata?.title);
  await page.waitForFunction(() => navigator.mediaSession.metadata?.title);
  // mini: deslizar a la izquierda = siguiente; a la derecha = anterior
  const m = await page.locator('.mini').boundingBox();
  const y = m.y + m.height / 2;
  const t0 = await title();
  await touch(page, line(m.x + m.width - 60, y, m.x + 40, y, 8), { delay: 20 });
  await page.waitForFunction((a) => navigator.mediaSession.metadata?.title !== a, t0);
  const t1 = await title();
  await touch(page, line(m.x + 40, y, m.x + m.width - 60, y, 8), { delay: 20 });
  await page.waitForFunction((a) => navigator.mediaSession.metadata?.title !== a, t1);
  // mini: deslizar hacia arriba abre el reproductor
  await touch(page, line(m.x + 200, y, m.x + 200, y - 120, 8), { delay: 20 });
  await page.locator('.player').waitFor();
  await settled(page).catch(() => {});
  // reproductor: deslizar la carátula a un lado cambia de canción
  const t2 = await title();
  const art = await page.locator('.player .art .cover').boundingBox();
  await touch(page, line(art.x + art.width - 20, art.y + art.height / 2, art.x + 20, art.y + art.height / 2, 8), { delay: 20 });
  await page.waitForFunction((a) => navigator.mediaSession.metadata?.title !== a, t2);
  await page.waitForTimeout(350);
  // reproductor: deslizar hacia abajo la tarjeta, la cierra (sin tocar el botón de la flecha)
  const mid = await touch(page, line(200, 160, 200, 520, 8), { end: false, delay: 20 });
  await page.waitForTimeout(80);
  const moved = await page.evaluate(() => new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.player')).transform).m42);
  assert.ok(moved > 100, `la tarjeta sigue al dedo (bajó ${Math.round(moved)} px)`);
  await shot(page, '20-arrastrando-tarjeta');
  await mid.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.locator('.player').waitFor({ state: 'detached', timeout: 3000 });
  // un arrastre corto la deja donde estaba
  await page.locator('.mini .main').click();
  await page.locator('.player').waitFor();
  await touch(page, line(200, 160, 200, 200, 4), { delay: 60 });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.player').count(), 1);
  await page.getByRole('button', { name: 'Cerrar reproductor' }).click();
  await page.locator('.player').waitFor({ state: 'detached' });

  // hojas inferiores: se cierran deslizando hacia abajo
  await page.goto(`${base}/#/lista/album`); await settled(page);
  await P(page).locator('.card', { hasText: 'Lasciati Andare' }).click(); await settled(page);
  await page.getByRole('button', { name: 'Más opciones de Il Matto' }).click();
  await page.locator('.sheet').waitFor();
  await page.waitForTimeout(450);
  const sh = await page.locator('.sheet').boundingBox();
  await touch(page, line(sh.x + sh.width / 2, sh.y + 14, sh.x + sh.width / 2, sh.y + 260, 8), { delay: 20 });
  await page.locator('.sheet').waitFor({ state: 'detached', timeout: 3000 });
});

test('teléfono de lado (horizontal): la app se reordena (columna de navegación, más columnas, reproductor en dos) y funciona igual', { skip: !pw }, async () => {
  const { page, ctx } = await newPage('horizontal', { viewport: { width: 844, height: 390 }, screen: { width: 844, height: 390 } });
  const fits = async (loc, what) => {
    const b = await loc.boundingBox();
    assert.ok(b && b.x >= -1 && b.y >= -1 && b.x + b.width <= 845 && b.y + b.height <= 391, `${what} cabe en pantalla (${JSON.stringify(b)})`);
    return b;
  };
  // entrada
  await page.goto(base);
  await page.locator('#splash').waitFor({ state: 'detached', timeout: 8000 });
  await fits(page.getByRole('button', { name: 'Comenzar' }), 'botón Comenzar');
  await page.screenshot({ path: path.join(SHOTS, '21-horizontal-entrada.png') });
  await login(page, 'admin@test.cl');
  await P(page).getByRole('heading', { name: 'Tu música. Tu refugio.' }).waitFor();
  await settled(page).catch(() => {});

  // la barra de abajo pasa a ser una columna a la izquierda
  const rail = await page.locator('.tabbar').boundingBox();
  assert.ok(rail.x <= 1 && rail.width < 140 && rail.height > 250, `columna de navegación a la izquierda (${JSON.stringify(rail)})`);
  const stage = await page.locator('#stage').boundingBox();
  assert.ok(stage.x >= rail.width - 1 && stage.width > 600, `el contenido usa el resto del ancho (${Math.round(stage.width)} px)`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'sin desplazamiento lateral');
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.screenshot({ path: path.join(SHOTS, '22-horizontal-inicio.png') });

  // se navega igual
  await page.getByRole('link', { name: 'Explorar' }).click(); await settled(page);
  await P(page).getByRole('heading', { name: 'Explorar' }).waitFor();
  await page.goto(`${base}/#/lista/album`); await settled(page);
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.page:not(.off) .grid')).gridTemplateColumns.split(' ').length);
  assert.equal(cols, 4, 'la grilla de álbumes usa 4 columnas');

  // álbum: carátula a la izquierda, datos a la derecha
  await P(page).locator('.card', { hasText: 'Musica per te' }).click(); await settled(page);
  const cover = await P(page).locator('.detail-head .cover').boundingBox();
  const title = await P(page).locator('.detail-head h1').boundingBox();
  assert.ok(cover.x + cover.width <= title.x + 1, 'la carátula queda a la izquierda del título');
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.screenshot({ path: path.join(SHOTS, '23-horizontal-album.png') });

  // reproducir: el mini reproductor va al lado de la columna, no encima
  await P(page).getByRole('button', { name: 'Reproducir', exact: true }).first().click();
  await page.locator('.mini').waitFor();
  await page.waitForFunction(() => navigator.mediaSession.metadata?.title === 'Che Livello!');
  const mini = await fits(page.locator('.mini'), 'mini reproductor');
  assert.ok(mini.x >= rail.width, 'el mini reproductor no tapa la columna de navegación');

  // reproductor expandido en dos columnas
  await page.locator('.mini .main').click();
  await page.locator('.player').waitFor();
  await page.waitForTimeout(450);
  const art = await fits(page.locator('.player .art .cover'), 'carátula del reproductor');
  const info = await page.locator('.player .info').boundingBox();
  assert.ok(art.x + art.width <= info.x + 1, 'carátula a la izquierda, datos a la derecha');
  await fits(page.locator('.player .controls .play'), 'botón de play');
  await fits(page.locator('.player .range'), 'barra de reproducción');
  await fits(page.getByRole('button', { name: 'Cerrar reproductor' }), 'botón para cerrar');
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.screenshot({ path: path.join(SHOTS, '24-horizontal-reproductor.png') });
  // sigue funcionando: la barra salta y el cierre por gesto
  await page.locator('.player .range').evaluate((el) => { el.value = 600; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => window.__a().currentTime > 3);
  await page.getByRole('button', { name: 'Cerrar reproductor' }).click();
  await page.locator('.player').waitFor({ state: 'detached' });

  // hojas inferiores caben
  await page.getByRole('button', { name: 'Más opciones de Neon' }).first().click();
  await page.locator('.sheet').waitFor();
  await page.waitForTimeout(450);
  await fits(page.locator('.sheet'), 'menú de la canción');
  await page.screenshot({ path: path.join(SHOTS, '25-horizontal-menu.png') });
  await ctx.close();
});

test('vertical y horizontal no se mezclan: al volver a vertical todo vuelve a su lugar', { skip: !pw }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'es-CL', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await login(page, 'admin@test.cl');
  await P(page).getByRole('heading', { name: 'Tu música. Tu refugio.' }).waitFor();
  await page.locator('#splash').waitFor({ state: 'detached', timeout: 8000 });
  const where = () => page.evaluate(() => { const r = document.querySelector('.tabbar').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vh: innerHeight, vw: innerWidth }; });
  let t = await where();
  assert.ok(t.y > t.vh - 120 && t.w >= t.vw - 2, 'vertical: barra de abajo');
  await page.setViewportSize({ width: 844, height: 390 }); await page.waitForTimeout(400);
  t = await where();
  assert.ok(t.x <= 1 && t.w < 140, 'horizontal: columna a la izquierda');
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400);
  t = await where();
  assert.ok(t.y > t.vh - 120 && t.w >= t.vw - 2, 'de vuelta a vertical: barra de abajo');
  await ctx.close();
});

test('aviso para instalar: iPhone con pasos, Android con botón "Instalar" (o pasos del menú)', { skip: !pw }, async () => {
  const UAS = {
    android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  };
  for (const [name, ua] of Object.entries(UAS)) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'es-CL', serviceWorkers: 'block', userAgent: ua });
    const page = await ctx.newPage();
    await login(page, 'admin@test.cl');
    await page.locator('#splash').waitFor({ state: 'detached', timeout: 8000 });
    const banner = P(page).locator('.install-banner');
    await banner.waitFor();
    if (name === 'iphone') {
      assert.match(await banner.innerText(), /Compartir.*Agregar a pantalla de inicio/s);
    } else {
      assert.match(await banner.innerText(), /menú ⋮.*Instalar app/s, 'sin aviso del navegador: se explican los pasos');
      assert.equal(await banner.getByRole('button', { name: 'Instalar' }).count(), 0);
      // Chrome avisa que se puede instalar: aparece el botón y al tocarlo se abre la ventana de instalación
      await page.evaluate(() => {
        const ev = new Event('beforeinstallprompt', { cancelable: true });
        window.__prompted = 0;
        ev.prompt = () => { window.__prompted++; return Promise.resolve(); };
        ev.userChoice = Promise.resolve({ outcome: 'dismissed' });
        window.dispatchEvent(ev);
      });
      await banner.getByRole('button', { name: 'Instalar', exact: true }).click();
      await page.waitForFunction(() => window.__prompted === 1);
      await page.screenshot({ path: path.join(SHOTS, '22-aviso-instalar-android.png') });
    }
    // se puede ocultar y no vuelve
    await banner.getByRole('button', { name: 'Ocultar aviso' }).click();
    await banner.waitFor({ state: 'detached' });
    await ctx.close();
  }
});

test('amigo nuevo: queda pendiente y el admin lo aprueba desde la app', { skip: !pw }, async () => {
  friend = await newPage('amigo');
  await login(friend.page, 'amigo@test.cl');
  await friend.page.getByRole('heading', { name: 'Tu acceso está pendiente' }).waitFor();
  await shot(friend.page, '16-pendiente');
  // sin sesión aprobada no se puede pedir nada
  const r = await friend.page.evaluate(() => fetch('/api/albums').then((x) => x.status));
  assert.equal(r, 403);

  const { page } = admin;
  await page.goto(`${base}/#/admin`);
  await page.getByRole('heading', { name: 'Administración' }).waitFor();
  await P(page).locator('.user', { hasText: 'amigo@test.cl' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.stat'));
  await shot(page, '17-admin');
  await P(page).locator('.user', { hasText: 'amigo@test.cl' }).getByRole('button', { name: 'Aprobar' }).click();
  await page.getByText('ya puede entrar').waitFor();

  await friend.page.getByRole('button', { name: 'Revisar de nuevo' }).click();
  await friend.page.getByRole('heading', { name: 'Tu música. Tu refugio.' }).waitFor();
  await friend.page.getByRole('button', { name: 'Tu perfil' }).click();
  assert.equal(await friend.page.getByText('Administración').count(), 0, 'un amigo no debe ver Administración');
  await friend.page.keyboard.press('Escape');
  const adminDenied = await friend.page.evaluate(() => fetch('/api/admin/users').then((x) => x.status));
  assert.equal(adminDenied, 403);

  // bloquear: se le cierra la sesión
  await P(page).locator('.user', { hasText: 'amigo@test.cl' }).getByRole('button', { name: 'Bloquear' }).click();
  await page.getByRole('button', { name: 'Bloquear', exact: true }).last().click();
  await page.getByText('fue bloqueado').waitFor();
  await friend.page.goto(base);
  await friend.page.getByRole('heading', { name: 'Entrar' }).or(friend.page.getByRole('button', { name: 'Comenzar' })).waitFor();
});

test('Onkyo: el administrador lo ve, envía la cola, controla y el amigo no tiene botón', { skip: !pw }, async () => {
  const { page } = admin;
  await page.goto(`${base}/#/`); await settled(page);
  await page.locator('.mini .main').click();
  await page.locator('.player').waitFor();
  await page.waitForTimeout(450);
  await page.locator('.player').getByRole('button', { name: 'Onkyo' }).click();
  await page.locator('.sheet h3', { hasText: 'Onkyo TX-8130' }).waitFor();
  await page.locator('.onk-status', { hasText: 'Apagado' }).waitFor();
  await page.waitForTimeout(450);
  await shot(page, '60-onkyo-apagado');
  await page.getByRole('button', { name: 'Enviar lo que suena al Onkyo' }).click();
  await page.locator('.onk-now .t').waitFor();
  await page.locator('.onk-status', { hasText: 'Sonando' }).waitFor();
  assert.equal(fakeOnkyo.dev.power, true);
  assert.equal(fakeOnkyo.dev.input, '2B');
  assert.equal(fakeOnkyo.av.fetched.length >= 1 && fakeOnkyo.av.fetched[0].status, 206);
  assert.equal(await page.evaluate(() => !window.__a() || window.__a().paused), true, 'el teléfono se calla');
  await page.waitForTimeout(450);
  await shot(page, '61-onkyo-sonando');
  // volumen (con tope), pausa y siguiente
  await page.locator('.onk-vol .range').evaluate((el) => { el.value = 30; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector('.onk-vol-n')?.textContent === '30');
  await until(() => fakeOnkyo.dev.volume === 30);
  const first = await page.locator('.onk-now .t').innerText();
  await page.locator('.sheet').getByRole('button', { name: 'Pausar' }).click();
  await page.locator('.onk-status', { hasText: 'En pausa' }).waitFor();
  await page.locator('.sheet').getByRole('button', { name: 'Siguiente' }).click();
  await page.waitForFunction((t) => document.querySelector('.onk-now .t')?.textContent !== t, first);
  await page.getByRole('button', { name: 'Apagar el Onkyo' }).click();
  await page.locator('.onk-status', { hasText: 'Apagado' }).waitFor();
  assert.equal(fakeOnkyo.dev.power, false);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
});

test('perfil y cierre de sesión', { skip: !pw }, async () => {
  const { page } = admin;
  await page.goto(base);
  await page.getByRole('button', { name: 'Tu perfil' }).click();
  await page.waitForFunction(() => document.querySelector('.sheet .menu-head'));
  await page.waitForTimeout(450);
  await shot(page, '18-perfil');
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await page.getByRole('button', { name: 'Comenzar' }).waitFor();
});

test('sin errores en la consola ni respuestas fallidas inesperadas', { skip: !pw }, () => {
  assert.deepEqual(errors, []);
});
