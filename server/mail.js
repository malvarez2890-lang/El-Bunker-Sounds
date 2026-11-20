import nodemailer from 'nodemailer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Logo de la app, que va dentro de cada correo (adjunto en línea: se ve sin tener que "cargar imágenes").
export const LOGO_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'icons', 'icon-192.png');
const logoAttachment = () => (fs.existsSync(LOGO_PATH) ? [{ filename: 'logo.png', path: LOGO_PATH, cid: 'logo@ebs' }] : []);

/** Envío de correos. Con MAIL_MODE=file (pruebas) se guardan en data/outbox en vez de enviarse. */
export function createMailer({ config, log }) {
  const { mail } = config;
  let transport = null;
  if (mail.mode === 'smtp') {
    transport = nodemailer.createTransport({
      host: mail.host, port: mail.port, secure: mail.port === 465,
      auth: { user: mail.user, pass: mail.pass },
    });
  }
  const outbox = path.join(config.dataDir, 'outbox');

  return {
    mode: mail.mode,
    async send({ to, subject, text, html, attachments }) {
      if (!transport) {
        fs.mkdirSync(outbox, { recursive: true });
        const file = path.join(outbox, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
        fs.writeFileSync(file, JSON.stringify({ to, subject, text, attachments: (attachments || []).map((a) => a.cid || a.filename) }, null, 2));
        log?.info?.({ to, subject }, 'correo guardado en outbox (modo archivo)');
        return;
      }
      await transport.sendMail({ from: mail.from, to, subject, text, html, attachments });
    },
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function shell(title, bodyHtml, { eyebrow = '', hero = '' } = {}) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#090A0C">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#090A0C"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#141619;border-radius:18px;border-top:4px solid #FFCB24;font-family:Arial,Helvetica,sans-serif;color:#F3F0E9">
    <tr><td align="center" style="padding:26px 24px 6px">
      <img src="cid:logo@ebs" width="84" height="84" alt="El Búnker Sound" style="display:block;border-radius:20px;border:0">
      <div style="font-weight:800;letter-spacing:3px;font-size:15px;margin-top:12px;color:#F3F0E9">EL BÚNKER <span style="color:#FFCB24">SOUND</span></div>
    </td></tr>
    ${hero ? `<tr><td align="center" style="padding:18px 24px 0">${hero}</td></tr>` : ''}
    <tr><td style="padding:20px 28px 28px">
      ${eyebrow ? `<div style="color:#FFCB24;font-weight:800;letter-spacing:3px;font-size:12px;text-align:center;margin-bottom:8px">${esc(eyebrow)}</div>` : ''}
      <h1 style="font-size:24px;line-height:1.25;margin:0 0 12px;text-align:center">${esc(title)}</h1>${bodyHtml}
    </td></tr>
    <tr><td style="border-top:1px solid #202328;padding:14px 24px;text-align:center;color:#6f737b;font-size:12px">Tu música. Tu refugio.</td></tr>
  </table></td></tr></table></body></html>`;
}

export function loginCodeMail(code) {
  return {
    subject: `Tu código de El Búnker Sound: ${code}`,
    text: `Tu código para entrar a El Búnker Sound es ${code}.\nVence en 10 minutos. Si no lo pediste tú, ignora este mensaje.`,
    attachments: logoAttachment(),
    html: shell('Tu código para entrar', `<p style="color:#A2A5AC;margin:0 0 16px">Escríbelo en la app. Vence en 10 minutos.</p>
      <div style="font-size:34px;letter-spacing:8px;font-weight:700;color:#FFCB24;background:#090A0C;border-radius:12px;padding:16px;text-align:center">${esc(code)}</div>
      <p style="color:#A2A5AC;font-size:13px;margin:16px 0 0">Si no lo pediste tú, ignora este mensaje.</p>`),
  };
}

export function accessRequestMail(user, baseUrl) {
  return {
    subject: `${user.name} pidió entrar a El Búnker Sound`,
    text: `${user.name} (${user.email}) pidió acceso.\nApruébalo en la app: ${baseUrl}/#/admin`,
    attachments: logoAttachment(),
    html: shell('Alguien pidió entrar', `<p style="margin:0 0 6px"><b>${esc(user.name)}</b></p>
      <p style="color:#A2A5AC;margin:0 0 16px">${esc(user.email)}</p>
      <a href="${esc(baseUrl)}/#/admin" style="display:inline-block;background:#FFCB24;color:#090A0C;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:999px">Revisar solicitud</a>`),
  };
}

/** Aviso de que salió un álbum. coverPath (opcional): carátula del álbum, que se muestra grande dentro del correo. */
export function albumReleasedMail({ name, albumTitle, artistName, text, baseUrl, coverPath }) {
  const cover = coverPath && fs.existsSync(coverPath);
  const hero = cover ? `<img src="cid:cover@ebs" width="300" alt="${esc(albumTitle)}" style="display:block;width:300px;max-width:100%;height:auto;border-radius:14px;border:0">` : '';
  return {
    subject: `¡Ya salió ${albumTitle}! · El Búnker Sound`,
    text: `Hola ${name}:\n\n${text}\n\nEscúchalo en la app: ${baseUrl}\n\nEl Búnker Sound`,
    attachments: [...logoAttachment(), ...(cover ? [{ filename: 'portada.jpg', path: coverPath, cid: 'cover@ebs' }] : [])],
    html: shell(albumTitle, `<p style="color:#FFCB24;margin:0 0 14px;text-align:center;font-size:15px;font-weight:700">${esc(artistName)}</p>
      <p style="margin:0 0 22px;line-height:1.55;text-align:center;color:#D8D5CD">Hola ${esc(name)}, ${esc(text)}</p>
      <div style="text-align:center"><a href="${esc(baseUrl)}" style="display:inline-block;background:#FFCB24;color:#090A0C;text-decoration:none;font-weight:800;padding:14px 28px;border-radius:999px;font-size:16px">▶ Escuchar ahora</a></div>`, { eyebrow: '¡NUEVO LANZAMIENTO!', hero }),
  };
}
