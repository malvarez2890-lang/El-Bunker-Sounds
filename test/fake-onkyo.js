// Onkyo simulado para las pruebas: habla eISCP (encendido, entrada, volumen) y DLNA (AVTransport) como el TX-8130 real.
import net from 'node:net';
import http from 'node:http';
import { iscpFrame, iscpFrames } from '../server/onkyo.js';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

export async function startFakeOnkyo({ playMs = 1500, durSec = 8 } = {}) {
  const dev = { power: false, input: '05', volume: 10 };
  const log = []; // todo lo que le piden, para comprobarlo
  const av = { uri: null, meta: null, state: 'NO_MEDIA_PRESENT', startedAt: 0, fetched: [], rejectPlays: 0 };

  const iscp = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (const f of iscpFrames(buf)) {
        const cmd = f.slice(2);
        log.push(cmd);
        const reply = (c) => sock.write(iscpFrame(c));
        if (cmd === 'PWRQSTN') reply(`PWR${dev.power ? '01' : '00'}`);
        else if (cmd === 'SLIQSTN') reply(`SLI${dev.input}`);
        else if (cmd === 'MVLQSTN') reply(`MVL${dev.volume.toString(16).toUpperCase().padStart(2, '0')}`);
        else if (cmd === 'PWR01') { setTimeout(() => { dev.power = true; }, 100); reply('PWR01'); }
        else if (cmd === 'PWR00') { dev.power = false; av.state = 'NO_MEDIA_PRESENT'; reply('PWR00'); }
        else if (/^SLI/.test(cmd)) { dev.input = cmd.slice(3); reply(cmd); }
        else if (/^MVL[0-9A-F]{2}$/.test(cmd)) { dev.volume = parseInt(cmd.slice(3), 16); reply(cmd); }
      }
      buf = Buffer.alloc(0);
    });
    sock.on('error', () => {});
  });

  const state = () => {
    if (av.state === 'PLAYING' && Date.now() - av.startedAt > playMs) av.state = 'STOPPED';
    return av.state;
  };
  const upnp = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/upnp_descriptor_0') {
      res.setHeader('content-type', 'text/xml');
      return res.end(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>TX-8130 falso</friendlyName><serviceList>
<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/upnp_control_0</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/upnp_control_2</controlURL></service></serviceList></device></root>`);
    }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const action = /#(\w+)"?$/.exec(String(req.headers.soapaction || ''))?.[1];
      if (req.method !== 'POST' || req.url !== '/upnp_control_2' || !action) { res.statusCode = 404; return res.end(); }
      log.push(`AV:${action}`);
      const ok = (inner = '') => { res.setHeader('content-type', 'text/xml'); res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response>${inner}</u:${action}Response></s:Body></s:Envelope>`); };
      if (action === 'SetAVTransportURI') {
        av.uri = /<CurrentURI>([^<]*)<\/CurrentURI>/.exec(body)?.[1].replace(/&amp;/g, '&');
        av.meta = /<CurrentURIMetaData>([^<]*)<\/CurrentURIMetaData>/.exec(body)?.[1];
        av.state = 'STOPPED';
        return ok();
      }
      if (action === 'Play') {
        if (av.rejectPlays > 0) { av.rejectPlays--; res.statusCode = 500; return res.end('<errorCode>701</errorCode>'); }
        // Como el Onkyo real: baja la canción del enlace que le dieron.
        const r = await fetch(av.uri, { headers: { range: 'bytes=0-' } });
        const data = Buffer.from(await r.arrayBuffer());
        av.fetched.push({ uri: av.uri, status: r.status, bytes: data.length, type: r.headers.get('content-type') });
        av.state = 'PLAYING'; av.startedAt = Date.now();
        return ok();
      }
      if (action === 'Pause') { av.state = 'PAUSED_PLAYBACK'; return ok(); }
      if (action === 'Stop') { av.state = 'STOPPED'; return ok(); }
      if (action === 'GetTransportInfo') return ok(`<CurrentTransportState>${state()}</CurrentTransportState>`);
      if (action === 'GetPositionInfo') {
        const el = Math.min(durSec, Math.floor((Date.now() - av.startedAt) / 1000 * (durSec / (playMs / 1000))));
        return ok(`<TrackDuration>0:00:0${durSec}</TrackDuration><RelTime>0:00:0${el}</RelTime>`);
      }
      res.statusCode = 501; res.end();
    });
  });

  const eiscpPort = await listen(iscp);
  const upnpPort = await listen(upnp);
  return { dev, log, av, eiscpPort, upnpPort, close: () => { iscp.close(); upnp.close(); iscp.closeAllConnections?.(); upnp.closeAllConnections?.(); } };
}
