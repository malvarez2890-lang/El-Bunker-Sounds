// Álbum con canciones "por salir" (TRACKLIST.txt): solo suenan las que tienen archivo; el resto aparece en gris.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeApp } from './helpers.js';
import { parseTracklist, parseDateText, decodeText } from '../server/scanner.js';
import { revisar } from '../server/cli/revisar-tracklist.js';
import { loadConfig } from '../server/config.js';

const TRACKLIST = `PIÙ VELOCE
LA VITA È UN GIOCO
# comentario
Lanzamiento: 21 de noviembre de 2026
01.  Pronti, Via!
02.  Il Re del Bar
03.  Tutto Sotto Controllo
04.  Telefono Occupato
05.  Noi Siamo
06.  Un Gettone Ancora
07.  Domenica Elettrica
08.  Birra Elegante
09.  Soldi Finti
10.  Cinque Minuti
11.  Non Mi Prendere Sul Serio
12.  Quando Si Spengono le Luci
13.  La Vita È Un Gioco
`;

describe('lectura más tolerante del TRACKLIST.txt', () => {
  test('UTF-16 del Bloc de notas (con tildes) se entiende igual', () => {
    const texto = 'Lanzamiento: 21 de noviembre de 2026\r\nDisponibles: 3, 4\r\n01. La Vita È Un Gioco\r\n';
    for (const buf of [Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(texto, 'utf16le')]), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(texto, 'utf16le').swap16()]), Buffer.from('\uFEFF' + texto, 'utf8')]) {
      const r = parseTracklist(decodeText(buf));
      assert.equal(r.releaseDate, '2026-11-21');
      assert.deepEqual(r.available, [3, 4]);
      assert.equal(r.entries[0].title, 'La Vita È Un Gioco');
    }
  });
  test('otras formas de escribir la fecha y los disponibles', () => {
    const r = parseTracklist('Fecha de lanzamiento: 21 noviembre 2026\nYa disponibles: 3, 4, 5 y 8\n01. A');
    assert.equal(r.releaseDate, '2026-11-21');
    assert.deepEqual(r.available, [3, 4, 5, 8]);
    assert.equal(parseTracklist('Sencillos: 2\n01. A').available[0], 2);
    assert.equal(parseDateText('21 de noviembre'), `${new Date().getFullYear()}-11-21`);
  });
});

describe('lectura del TRACKLIST.txt', () => {
  test('canciones numeradas y fecha de lanzamiento', () => {
    const r = parseTracklist(TRACKLIST);
    assert.equal(r.entries.length, 13);
    assert.deepEqual(r.entries[0], { no: 1, title: 'Pronti, Via!' });
    assert.equal(r.entries[12].title, 'La Vita È Un Gioco');
    assert.equal(r.releaseDate, '2026-11-21');
  });
  test('fechas en varios formatos', () => {
    assert.equal(parseDateText('2026-11-21'), '2026-11-21');
    assert.equal(parseDateText('21/11/2026'), '2026-11-21');
    assert.equal(parseDateText('21-11-2026'), '2026-11-21');
    assert.equal(parseDateText('21 de noviembre de 2026'), '2026-11-21');
    assert.equal(parseDateText('1 de Enero de 2027'), '2027-01-01');
    assert.equal(parseDateText('mañana'), null);
  });
});

describe('álbum con 4 canciones listas y 9 por salir', () => {
  let t, dir, A, F, albumId;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebs-porsalir-'));
    const album = path.join(dir, 'Artista', 'PIÙ VELOCE', 'Albums', '05. La Vita È Un Gioco');
    fs.mkdirSync(album, { recursive: true });
    for (const n of ['03. Tutto Sotto Controllo', '04. Telefono Occupato', '05. Noi Siamo', '08. Birra Elegante']) {
      execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', path.join(album, `${n}.wav`)]);
    }
    fs.writeFileSync(path.join(album, 'TRACKLIST.txt'), TRACKLIST);
    t = await makeApp({ MUSIC_DIR: dir });
    A = t.api((await t.login('admin@test.cl')).cookie);
    const friend = await t.login('amigo@test.cl');
    await A('POST', `/api/admin/users/${friend.res.json().user.id}`, { status: 'active' });
    F = t.api(friend.cookie);
    albumId = (await A('GET', '/api/albums')).json().albums[0].id;
  });
  after(() => t.close());

  test('el álbum muestra las 13 canciones en orden; solo 4 se pueden escuchar', async () => {
    const a = (await F('GET', `/api/albums/${albumId}`)).json();
    assert.equal(a.totalCount, 13);
    assert.equal(a.trackCount, 4);
    assert.equal(a.releaseDate, '2026-11-21');
    assert.deepEqual(a.tracks.map((x) => x.trackNo), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    assert.deepEqual(a.tracks.filter((x) => x.ready).map((x) => x.title), ['Tutto Sotto Controllo', 'Telefono Occupato', 'Noi Siamo', 'Birra Elegante']);
    const up = a.tracks.filter((x) => x.upcoming);
    assert.equal(up.length, 9);
    assert.ok(up.every((x) => x.ready === false));
    assert.equal(a.tracks[0].title, 'Pronti, Via!');
  });

  test('lo que está por salir no suena, no se busca y no cuenta como música lista', async () => {
    const a = (await F('GET', `/api/albums/${albumId}`)).json();
    const ghost = a.tracks.find((x) => x.upcoming);
    assert.equal((await F('GET', `/api/stream/${ghost.id}`)).statusCode, 404);
    assert.equal((await F('GET', '/api/search?q=pronti')).json().tracks.length, 0);
    assert.equal((await F('GET', '/api/search?q=noi siamo')).json().tracks.length, 1);
    assert.equal((await F('GET', '/api/home')).json().counts.tracks, 4);
    const shuffle = (await F('GET', '/api/shuffle')).json().tracks;
    assert.ok(shuffle.every((x) => !x.upcoming));
  });

  test('el título oficial viene del TRACKLIST (con tildes) y el lanzamiento aparece en la lista de álbumes', async () => {
    const list = (await F('GET', '/api/albums')).json().albums;
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'La Vita È Un Gioco');
    assert.equal(list[0].totalCount, 13);
  });

  test('al llegar un archivo nuevo, esa canción deja de estar en gris sola', async () => {
    const album = path.join(dir, 'Artista', 'PIÙ VELOCE', 'Albums', '05. La Vita È Un Gioco');
    execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=520:duration=1', path.join(album, '01. Pronti, Via!.wav')]);
    await t.ctx.library.scan();
    await t.ctx.transcoder.whenIdle();
    const a = (await F('GET', `/api/albums/${albumId}`)).json();
    assert.equal(a.totalCount, 13);
    assert.equal(a.trackCount, 5);
    assert.equal(a.tracks.filter((x) => x.upcoming).length, 8);
    const first = a.tracks[0];
    assert.equal(first.title, 'Pronti, Via!');
    assert.equal(first.ready, true);
    assert.equal(first.upcoming, false);
    assert.equal((await F('GET', `/api/stream/${first.id}`)).statusCode, 200);
  });

  test('renombraste una canción: el archivo viejo y el nuevo conviven en el servidor, pero se muestra solo uno (el que dice la lista)', async () => {
    const album = path.join(dir, 'Artista', 'PIÙ VELOCE', 'Albums', '05. La Vita È Un Gioco');
    // la lista ahora llama a la 8 "Birra Fina" y suma una canción nueva (la 14)
    fs.writeFileSync(path.join(album, 'TRACKLIST.txt'), TRACKLIST.replace('08.  Birra Elegante', '08.  Birra Fina') + '14.  Bonus Notturno\n');
    execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=900:duration=1', path.join(album, '08. Birra Fina.wav')]);
    await t.ctx.library.scan(); await t.ctx.transcoder.whenIdle();
    let a = (await F('GET', `/api/albums/${albumId}`)).json();
    const eights = a.tracks.filter((x) => x.trackNo === 8);
    assert.equal(eights.length, 1, 'una sola canción número 8');
    assert.equal(eights[0].title, 'Birra Fina');
    assert.equal(eights[0].ready, true);
    assert.equal(a.tracks.some((x) => /Elegante/.test(x.title)), false, 'el nombre viejo ya no aparece');
    assert.equal(a.totalCount, 14);
    assert.equal(a.tracks.at(-1).title, 'Bonus Notturno');
    assert.equal(a.tracks.at(-1).upcoming, true);
    // si la lista vuelve a llamarla como antes, gana el archivo que se llama así (aunque sea el más viejo)
    fs.writeFileSync(path.join(album, 'TRACKLIST.txt'), TRACKLIST);
    await t.ctx.library.scan();
    a = (await F('GET', `/api/albums/${albumId}`)).json();
    assert.equal(a.tracks.filter((x) => x.trackNo === 8).length, 1);
    assert.equal(a.tracks.find((x) => x.trackNo === 8).title, 'Birra Elegante');
  });

  test('si se borra el TRACKLIST.txt, quedan solo las canciones con archivo', async () => {
    const album = path.join(dir, 'Artista', 'PIÙ VELOCE', 'Albums', '05. La Vita È Un Gioco');
    fs.unlinkSync(path.join(album, 'TRACKLIST.txt'));
    await t.ctx.library.scan();
    const a = (await F('GET', `/api/albums/${albumId}`)).json();
    assert.equal(a.tracks.length, 6); // sin lista no se elige nada: se ven todos los archivos (incluidos los dos de la 8)
    assert.equal(a.totalCount, 6);
  });
});

describe('lanzamiento programado: el álbum completo ya está en la carpeta pero se libera el día elegido', () => {
  let t, dir, A, F, albumId;
  const wav = (album, name, hz) => execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=1`, path.join(album, name)]);
  before(async () => {
    process.env.EBS_FAKE_TODAY = '2026-11-19'; // "hoy" para la prueba
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebs-programado-'));
    const album = path.join(dir, 'Artista', 'PIÙ VELOCE', 'Albums', '05. La Vita È Un Gioco');
    fs.mkdirSync(album, { recursive: true });
    ['01. Pronti, Via!', '02. Il Re del Bar', '03. Tutto Sotto Controllo', '04. Telefono Occupato', '05. Noi Siamo', '08. Birra Elegante'].forEach((n, i) => wav(album, `${n}.wav`, 300 + i * 50));
    fs.writeFileSync(path.join(album, 'TRACKLIST.txt'), `Lanzamiento: 21 de noviembre de 2026\nDisponibles: 3, 4, 5 y 8\n${TRACKLIST.split('\n').filter((l) => /^\d/.test(l)).join('\n')}\n`);
    t = await makeApp({ MUSIC_DIR: dir });
    A = t.api((await t.login('admin@test.cl')).cookie);
    const friend = await t.login('amigo@test.cl');
    await A('POST', `/api/admin/users/${friend.res.json().user.id}`, { status: 'active' });
    F = t.api(friend.cookie);
    albumId = (await A('GET', '/api/albums')).json().albums[0].id;
  });
  after(async () => { delete process.env.EBS_FAKE_TODAY; await t.close(); });

  test('lee la línea "Disponibles"', () => {
    assert.deepEqual(parseTracklist('Disponibles: 3, 4, 5 y 8\n01. A').available, [3, 4, 5, 8]);
    assert.deepEqual(parseTracklist('Singles: 3-4\n01. A').available, [3, 4]);
    assert.deepEqual(parseTracklist('01. A').available, []);
  });

  test('antes de la fecha: solo suenan los 4 singles, aunque los otros archivos ya estén en la carpeta', async () => {
    const a = (await F('GET', `/api/albums/${albumId}`)).json();
    assert.equal(a.trackCount, 4);
    assert.equal(a.totalCount, 13);
    assert.deepEqual(a.tracks.filter((x) => x.ready).map((x) => x.trackNo), [3, 4, 5, 8]);
    const guardadas = a.tracks.filter((x) => x.trackNo === 1 || x.trackNo === 2);
    assert.ok(guardadas.every((x) => x.upcoming && !x.ready), 'la 1 y la 2 tienen archivo pero están en gris');
    assert.equal((await F('GET', `/api/stream/${guardadas[0].id}`)).statusCode, 404, 'no se puede bajar antes de tiempo');
    assert.equal((await F('GET', '/api/search?q=pronti')).json().tracks.length, 0);
    assert.equal((await F('GET', '/api/home')).json().counts.tracks, 4);
    assert.ok((await F('GET', '/api/shuffle')).json().tracks.every((x) => [3, 4, 5, 8].includes(x.trackNo)));
    assert.equal(t.ctx.db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE audio_status='ok'").get().n, 6, 'las 6 ya están convertidas y listas para el día del lanzamiento');
  });

  test('el aviso de "música nueva" espera a que salga: se manda el día del lanzamiento, no antes', async () => {
    t.ctx.db.prepare('UPDATE tracks SET announced = 0').run();
    t.ctx.push.setAutoNewMusic(true); // lo que ya suena queda como avisado; lo programado sigue pendiente
    assert.equal(t.ctx.db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE announced = 0").get().n, 2, 'solo la 1 y la 2 (programadas)');
    assert.equal(await t.ctx.push.announceNewMusic(), null, 'antes de la fecha no hay nada que avisar');
    process.env.EBS_FAKE_TODAY = '2026-11-21';
    const r = await t.ctx.push.announceNewMusic(); // ya salió: se avisa (no hay celulares en la prueba, pero se marca)
    assert.ok(r && r.sent === 0);
    assert.equal(t.ctx.db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE announced = 0").get().n, 0);
    t.ctx.push.setAutoNewMusic(false);
    process.env.EBS_FAKE_TODAY = '2026-11-19';
  });

  test('el día 21 se liberan solas, sin tocar nada ni volver a escanear', async () => {
    process.env.EBS_FAKE_TODAY = '2026-11-21';
    const a = (await F('GET', `/api/albums/${albumId}`)).json();
    assert.equal(a.trackCount, 6);
    assert.equal(a.totalCount, 13);
    assert.deepEqual(a.tracks.filter((x) => x.ready).map((x) => x.trackNo), [1, 2, 3, 4, 5, 8]);
    const primera = a.tracks[0];
    assert.equal((await F('GET', `/api/stream/${primera.id}`)).statusCode, 200);
    assert.equal((await F('GET', '/api/search?q=pronti')).json().tracks.length, 1);
    assert.equal((await F('GET', '/api/home')).json().counts.tracks, 6);
    process.env.EBS_FAKE_TODAY = '2026-11-19';
  });

  test('sin fecha o sin lista de "Disponibles", no se programa nada', async () => {
    const album = path.join(dir, 'Artista', 'PIÙ VELOCE', 'Albums', '05. La Vita È Un Gioco');
    fs.writeFileSync(path.join(album, 'TRACKLIST.txt'), `Lanzamiento: 21 de noviembre de 2026\n${TRACKLIST.split('\n').filter((l) => /^\d/.test(l)).join('\n')}\n`);
    await t.ctx.library.scan();
    let a = (await F('GET', `/api/albums/${albumId}`)).json();
    assert.equal(a.trackCount, 6, 'sin "Disponibles" todo lo que tiene archivo suena');
    fs.writeFileSync(path.join(album, 'TRACKLIST.txt'), `Disponibles: 3, 4, 5, 8\n${TRACKLIST.split('\n').filter((l) => /^\d/.test(l)).join('\n')}\n`);
    await t.ctx.library.scan();
    a = (await F('GET', `/api/albums/${albumId}`)).json();
    assert.equal(a.trackCount, 6, 'sin fecha tampoco se programa');
  });
});

describe('comando de revisión (revisar-tracklist)', () => {
  test('explica qué entendió y qué hará con cada canción; avisa si faltan líneas', async () => {
    process.env.EBS_FAKE_TODAY = '2026-11-19';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebs-revisar-'));
    const album = path.join(dir, 'Artista', 'PIÙ VELOCE', 'Albums', '05. La Vita È Un Gioco');
    fs.mkdirSync(album, { recursive: true });
    for (const [i, n] of ['01. Pronti, Via!', '03. Tutto Sotto Controllo'].entries()) execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 80}:duration=1`, path.join(album, `${n}.wav`)]);
    const cfg = loadConfig({ MUSIC_DIR: dir, DATA_DIR: dir });
    fs.writeFileSync(path.join(album, 'TRACKLIST.txt'), '01. Pronti, Via!\n02. Il Re del Bar\n03. Tutto Sotto Controllo\n');
    let txt = await revisar(cfg);
    assert.match(txt, /No encontré una línea “Lanzamiento/);
    assert.match(txt, /No encontré una línea “Disponibles/);
    assert.match(txt, /02\. Il Re del Bar → en gris: todavía no tiene archivo/);
    fs.writeFileSync(path.join(album, 'TRACKLIST.txt'), 'Lanzamiento: 21 de noviembre de 2026\nDisponibles: 3\n01. Pronti, Via!\n02. Il Re del Bar\n03. Tutto Sotto Controllo\n');
    txt = await revisar(cfg);
    assert.match(txt, /Lanzamiento: 2026-11-21/);
    assert.match(txt, /Disponibles desde ya: 3/);
    assert.match(txt, /01\. Pronti, Via! → 🔒 en gris hasta el 2026-11-21/);
    assert.match(txt, /03\. Tutto Sotto Controllo → 🔊 suena ahora/);
    process.env.EBS_FAKE_TODAY = '2026-11-21';
    assert.match(await revisar(cfg), /01\. Pronti, Via! → 🔊 suena ahora/);
    delete process.env.EBS_FAKE_TODAY;
    fs.unlinkSync(path.join(album, 'TRACKLIST.txt'));
    assert.match(await revisar(cfg), /No encontré ningún TRACKLIST\.txt/);
  });
});
