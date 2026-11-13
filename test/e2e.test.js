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

function loadPlaywright() {
  const candidates = [import.meta.url, path.join(execSync('npm root -g').toString().trim(), 'x.js')];
  for (const base of candidates) { try { return createRequire(base)('playwright'); } catch { /* siguiente */ } }
  return null;
}
const pw = loadPlaywright();
const SHOTS = path.resolve('test-output');
fs.mkdirSync(SHOTS, { recursive: true });

let server, base, dataDir, browser;
const errors = [];

before(async () => {
  if (!pw) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebs-e2e-'));
  const config = loadConfig({
    MUSIC_DIR: testMusicDir('8'), DATA_DIR: dataDir, BASE_URL: 'http://127.0.0.1:3917', PORT: '3917', HOST: '127.0.0.1',
    ADMIN_EMAILS: 'admin@test.cl', MAIL_MODE: 'file', SCAN_INTERVAL_MIN: '0',
  });
  server = await buildApp(config, { logger: false });
  await server.ctx.library.scan();
  await server.ctx.transcoder.whenIdle();
  await server.app.listen({ port: 3917, host: '127.0.0.1' });
  base = 'http://127.0.0.1:3917';
  browser = await pw.chromium.launch();
});
after(async () => { await browser?.close(); await server?.app.close(); });

const codeFor = (email) => {
  const dir = path.join(dataDir, 'outbox');
  for (const f of fs.readdirSync(dir).sort().reverse()) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (m.to === email) { const c = /es (\d{6})\./.exec(m.text); if (c) return c[1]; }
  }
};

async function newPage(name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'es-CL', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|403)/.test(m.text())) errors.push(`[${name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/api/')) errors.push(`[${name}] ${r.status()} ${r.url()}`); });
  await page.addInitScript(() => {
    window.__audios = [];
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__audios.push(this); return orig.call(this); };
  });
  return { page, ctx };
}
/** Espera a que terminen las animaciones de cambio de pantalla. */
const noSplash = (page) => page.locator('#splash').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
const settled = async (page) => {
  await page.waitForTimeout(380); // deja arrancar y terminar la transición de pantalla
  await page.waitForFunction(() => !document.getAnimations().some((a) => a.playState === 'running' && a.effect?.target?.closest?.('.page')), null, { timeout: 5000 });
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
  await page.waitForFunction(() => window.__audios[0] && window.__audios[0].currentTime > 1.2, null, { timeout: 15000 });
  const meta = await page.evaluate(() => ({ t: navigator.mediaSession.metadata.title, a: navigator.mediaSession.metadata.artist, al: navigator.mediaSession.metadata.album, art: navigator.mediaSession.metadata.artwork.length, state: navigator.mediaSession.playbackState }));
  assert.deepEqual({ t: meta.t, a: meta.a, al: meta.al, state: meta.state }, { t: 'Che Livello!', a: 'PIÙ VELOCE', al: 'Musica per te', state: 'playing' });
  assert.equal(meta.art, 3);
  await shot(page, '09-mini');
  // los botones del celular (siguiente / pausa) llegan a la app
  await page.getByRole('button', { name: 'Siguiente' }).first().click();
  await page.waitForFunction(() => navigator.mediaSession.metadata.title === 'Neon');
  await page.getByRole('button', { name: 'Pausar' }).first().click();
  await page.waitForFunction(() => window.__audios[0].paused && navigator.mediaSession.playbackState === 'paused');
  await page.getByRole('button', { name: 'Reproducir' }).first().click();
  await page.waitForFunction(() => !window.__audios[0].paused);
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
  await page.waitForFunction(() => window.__audios[0].currentTime > 3);
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
