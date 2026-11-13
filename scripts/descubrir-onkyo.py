#!/usr/bin/env python3
"""Averigua qué sabe hacer tu equipo de música en la red (por ejemplo el Onkyo). SOLO LEE: no enciende, no cambia volumen, no reproduce nada.

Uso (en el servidor, fuera de Docker):   python3 scripts/descubrir-onkyo.py [IP_del_equipo]
 1) Busca en tu red los equipos de audio/video (UPnP/DLNA) y dice si pueden "recibir música" (MediaRenderer) o solo "mostrar biblioteca".
 2) Si le das la IP, prueba el puerto de control de Onkyo (60128) y le pregunta si está encendido.
"""
import socket, struct, sys, re, time, urllib.request
import xml.etree.ElementTree as ET

def ssdp(timeout=4.0):
    msg = ('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 3\r\nST: ssdp:all\r\n\r\n').encode()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    s.settimeout(0.5)
    for _ in range(2):
        s.sendto(msg, ('239.255.255.250', 1900))
    found, end = {}, time.time() + timeout
    while time.time() < end:
        try:
            data, addr = s.recvfrom(65507)
        except socket.timeout:
            continue
        text = data.decode('utf-8', 'replace')
        loc = re.search(r'(?im)^location:\s*(\S+)', text)
        if loc:
            found.setdefault(loc.group(1), addr[0])
    return found

def describe(url):
    try:
        xml = urllib.request.urlopen(url, timeout=3).read()
    except Exception as e:
        return None
    root = ET.fromstring(xml)
    ns = {'d': 'urn:schemas-upnp-org:device-1-0'}
    dev = root.find('d:device', ns)
    if dev is None:
        return None
    g = lambda tag: (dev.findtext(f'd:{tag}', default='', namespaces=ns) or '').strip()
    services = [s.findtext('d:serviceType', default='', namespaces=ns) for s in root.iter('{urn:schemas-upnp-org:device-1-0}service')]
    return {'name': g('friendlyName'), 'maker': g('manufacturer'), 'model': g('modelName'), 'type': g('deviceType'), 'services': services}

def eiscp_query(ip, port=60128):
    """Pregunta "¿estás encendido?" (!1PWRQSTN). Es solo una consulta."""
    data = b'!1PWRQSTN\r'
    packet = b'ISCP' + struct.pack('>I', 16) + struct.pack('>I', len(data)) + b'\x01\x00\x00\x00' + data
    with socket.create_connection((ip, port), timeout=3) as c:
        c.sendall(packet)
        c.settimeout(3)
        buf = c.recv(4096)
    m = re.search(rb'!1PWR(\w\w)', buf)
    return m.group(1).decode() if m else None

def main():
    ip = sys.argv[1] if len(sys.argv) > 1 else None
    print('Buscando equipos en tu red (unos 4 segundos)…\n')
    seen = set()
    for loc, addr in ssdp().items():
        d = describe(loc)
        if not d or (addr, d['name']) in seen:
            continue
        seen.add((addr, d['name']))
        kinds = []
        if any('AVTransport' in s for s in d['services']): kinds.append('PUEDE RECIBIR MÚSICA (se le puede mandar una canción)')
        if any('ContentDirectory' in s for s in d['services']): kinds.append('puede mostrar una biblioteca de música (servidor DLNA)')
        if any('RenderingControl' in s for s in d['services']): kinds.append('se le puede cambiar el volumen por DLNA')
        print(f"• {d['name'] or '(sin nombre)'}  [{addr}]  {d['maker']} {d['model']}")
        for k in kinds: print(f'    - {k}')
        if not kinds: print('    - (no ofrece funciones de música)')
        print()
    if not seen:
        print('No apareció ningún equipo. Revisa que el servidor y el equipo estén en la misma red (no dentro de Docker ni de Tailscale).\n')
    if ip:
        print(f'Probando el puerto de control de Onkyo en {ip}:60128…')
        try:
            st = eiscp_query(ip)
            print('  ✅ Responde. Estado:', {'00': 'APAGADO (en espera)', '01': 'ENCENDIDO'}.get(st, st))
        except Exception as e:
            print('  ❌ No respondió:', e)
            print('     (En el equipo: Setup → Hardware → Network → "Network Standby" debe estar en On para poder encenderlo por red.)')

if __name__ == '__main__':
    main()
