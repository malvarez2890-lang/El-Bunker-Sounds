#!/usr/bin/env python3
"""Prueba qué tipo de enlace acepta el Onkyo (solo "recibir un enlace": NO reproduce nada ni toca el volumen).
Uso:  python3 scripts/probar-onkyo-envio.py [IP_DEL_ONKYO] [IP_DE_ESTE_SERVIDOR]
Cada prueba manda SetAVTransportURI con un enlace de mentira y anota si el Onkyo lo acepta (200) o lo rechaza (error 501, etc.)."""
import sys, re, urllib.request, urllib.error
from urllib.parse import urljoin
from xml.sax.saxutils import escape

onkyo = sys.argv[1] if len(sys.argv) > 1 else '192.168.100.10'
server = sys.argv[2] if len(sys.argv) > 2 else '192.168.100.201'
import os
base = f'http://{onkyo}:' + os.environ.get('ONKYO_UPNP_PORT', '8888')
AVT = 'urn:schemas-upnp-org:service:AVTransport:1'

def get(url):
    return urllib.request.urlopen(url, timeout=5).read().decode('utf-8', 'replace')

def soap(ctl, action, args=''):
    body = (f'<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
            f's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:{action} xmlns:u="{AVT}"><InstanceID>0</InstanceID>{args}'
            f'</u:{action}></s:Body></s:Envelope>').encode()
    req = urllib.request.Request(ctl, data=body, headers={'Content-Type': 'text/xml; charset="utf-8"', 'SOAPACTION': f'"{AVT}#{action}"'})
    try:
        return 200, urllib.request.urlopen(req, timeout=6).read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        t = e.read().decode('utf-8', 'replace')
        m = re.search(r'<errorCode>(\d+)</errorCode>', t)
        return e.code, (m.group(1) if m else t[:80])
    except Exception as e:
        return 0, str(e)

def didl(url, mime, dlna):
    info = f'http-get:*:{mime}:' + ('DLNA.ORG_PN=MP3;DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000' if dlna else '*')
    return ('<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" '
            'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="1" parentID="0" restricted="1"><dc:title>Prueba</dc:title>'
            f'<upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo="{escape(info)}">{escape(url)}</res></item></DIDL-Lite>')

try:
    desc = get(f'{base}/upnp_descriptor_0')
except Exception as e:
    sys.exit(f'No pude leer la descripción del Onkyo en {base}: {e}')
ctl = None
scpd = None
for blk in re.findall(r'<service>.*?</service>', desc, re.S):
    if 'AVTransport' in blk:
        ctl = urljoin(base, re.search(r'<controlURL>(.*?)</controlURL>', blk).group(1))
        m = re.search(r'<SCPDURL>(.*?)</SCPDURL>', blk)
        scpd = urljoin(base, m.group(1)) if m else None
if not ctl:
    sys.exit('El Onkyo no ofrece AVTransport.')
print(f'Onkyo: {onkyo}   control: {ctl}')
# Qué sabe hacer el Onkyo (solo lectura): sirve para saber si acepta "dejar lista la siguiente canción" (sin silencio entre canciones) y saltar de minuto.
try:
    acts = sorted(set(re.findall(r'<action>\s*<name>(.*?)</name>', get(scpd), re.S)))
    print('Acciones que ofrece:', ', '.join(acts))
    print('  · Saltar de minuto (Seek):', 'SÍ' if 'Seek' in acts else 'NO')
    print('  · Dejar lista la siguiente (SetNextAVTransportURI):', 'SÍ' if 'SetNextAVTransportURI' in acts else 'NO')
except Exception as e:
    print('(No pude leer la lista de acciones del Onkyo:', e, ')')
c, t = soap(ctl, 'GetTransportInfo')
print('Estado del transporte:', re.search(r'<CurrentTransportState>(.*?)<', t).group(1) if c == 200 and '<CurrentTransportState>' in t else f'error {c} {t}')
print('Detengo cualquier cosa anterior (Stop)…', soap(ctl, 'Stop')[0])

payload = 'eyJ0IjoxLCJmIjoibXAzIiwiZSI6MTc5NDYxMTA1OX0'
sig = 'A' * 32
tests = [
    ('largo .mp3 (como el de la app)', f'http://{server}:8099/onkyo/{payload}.{sig}.mp3', 'audio/mpeg'),
    ('largo .m4a', f'http://{server}:8099/onkyo/{payload}.{sig}.m4a', 'audio/mp4'),
    ('largo .wav', f'http://{server}:8099/onkyo/{payload}.{sig}.wav', 'audio/wav'),
    ('largo sin extensión', f'http://{server}:8099/onkyo/{payload}.{sig}', 'audio/mpeg'),
    ('corto .mp3', f'http://{server}:8099/a.mp3', 'audio/mpeg'),
    ('corto .m4a', f'http://{server}:8099/a.m4a', 'audio/mp4'),
    ('corto .wav', f'http://{server}:8099/a.wav', 'audio/wav'),
]
print('\nResultado de cada prueba (✅ = el Onkyo acepta el enlace, ❌ = lo rechaza):')
for name, url, mime in tests:
    for meta_name, meta in (('con ficha DLNA', didl(url, mime, True)), ('sin ficha', '')):
        c, t = soap(ctl, 'SetAVTransportURI', f'<CurrentURI>{escape(url)}</CurrentURI><CurrentURIMetaData>{escape(meta)}</CurrentURIMetaData>')
        print(f'  {"✅" if c == 200 else "❌"} {name:<28} {meta_name:<15} {"" if c == 200 else f"(HTTP {c}, código {t})"}  [{len(url)} letras]')
        soap(ctl, 'Stop')
print('\nListo. No se reprodujo nada. Mándame esta pantalla completa.')
