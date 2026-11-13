import nodemailer from 'nodemailer';
import fs from 'node:fs';
import path from 'node:path';

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
    async send({ to, subject, text, html }) {
      if (!transport) {
        fs.mkdirSync(outbox, { recursive: true });
        const file = path.join(outbox, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
        fs.writeFileSync(file, JSON.stringify({ to, subject, text }, null, 2));
        log?.info?.({ to, subject }, 'correo guardado en outbox (modo archivo)');
        return;
      }
      await transport.sendMail({ from: mail.from, to, subject, text, html });
    },
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function shell(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#090A0C;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#F3F0E9">
  <div style="max-width:420px;margin:0 auto;background:#141619;border-radius:16px;padding:28px;border-top:4px solid #FFCB24">
    <div style="font-weight:700;letter-spacing:.5px;font-size:15px">EL BÚNKER <span style="color:#FFCB24">SOUND</span></div>
    <h1 style="font-size:20px;margin:18px 0 10px">${esc(title)}</h1>${bodyHtml}
  </div></body></html>`;
}

export function loginCodeMail(code) {
  return {
    subject: `Tu código de El Búnker Sound: ${code}`,
    text: `Tu código para entrar a El Búnker Sound es ${code}.\nVence en 10 minutos. Si no lo pediste tú, ignora este mensaje.`,
    html: shell('Tu código para entrar', `<p style="color:#A2A5AC;margin:0 0 16px">Escríbelo en la app. Vence en 10 minutos.</p>
      <div style="font-size:34px;letter-spacing:8px;font-weight:700;color:#FFCB24;background:#090A0C;border-radius:12px;padding:16px;text-align:center">${esc(code)}</div>
      <p style="color:#A2A5AC;font-size:13px;margin:16px 0 0">Si no lo pediste tú, ignora este mensaje.</p>`),
  };
}

export function accessRequestMail(user, baseUrl) {
  return {
    subject: `${user.name} pidió entrar a El Búnker Sound`,
    text: `${user.name} (${user.email}) pidió acceso.\nApruébalo en la app: ${baseUrl}/#/admin`,
    html: shell('Alguien pidió entrar', `<p style="margin:0 0 6px"><b>${esc(user.name)}</b></p>
      <p style="color:#A2A5AC;margin:0 0 16px">${esc(user.email)}</p>
      <a href="${esc(baseUrl)}/#/admin" style="display:inline-block;background:#FFCB24;color:#090A0C;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:999px">Revisar solicitud</a>`),
  };
}
