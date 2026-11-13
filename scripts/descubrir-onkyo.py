#!/usr/bin/env python3
"""Averigua qué sabe hacer tu equipo de música en la red (por ejemplo el Onkyo). SOLO LEE: no enciende, no cambia volumen, no reproduce nada.

Uso (en el servidor, fuera de Docker):   python3 scripts/descubrir-onkyo.py [IP_del_equipo]
 1) Busca en tu red los equipos de audio/video (UPnP/DLNA) y dice si pueden "recibir música" (MediaRenderer) o solo "mostrar biblioteca".
 2) Si le das la IP, prueba el puerto de control de Onkyo (60128) y le pregunta si está encendido.
"""
import socket, struct, sys, re, time, ipaddress, subprocess, urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

def interfaces():
    """Direcciones IPv4 de este servidor, sin las redes internas de Docker ni la de Tailscale."""
    out = []
    try:
        txt = subprocess.run(['ip', '-4', '-o', 'addr', 'show'], capture_output=True, text=True, timeout=5).stdout
        for line in txt.splitlines():
            m = re.search(r'^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/(\d+)', line)
            if not m:
                continue
            name, ip, bits = m.group(1), m.group(2), int(m.group(3))
            if name == 'lo' or name.startswith(('docker', 'br-', 'veth', 'virbr', 'tailscale', 'ts')) or ip.startswith('100.'):
                continue
            out.append((name, ip, bits))
    except Exception:
        pass
    if not out:  # plan B para saber la dirección de este servidor
        try:
            u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); u.connect(('192.0.2.1', 9)); out.append(('red', u.getsockname()[0], 24)); u.close()
        except OSError:
            pass
    return out

def ssdp(ips, timeout=4.0):
    """Busca equipos UPnP/DLNA saliendo por CADA interfaz de red (si solo se usa la de por defecto, a veces no llega a la red de la casa)."""
    msg = ('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 3\r\nST: ssdp:all\r\n\r\n').encode()
    socks = []
    for ip in ips or [None]:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        try:
            if ip:
                s.bind((ip, 0))
                s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(ip))
        except OSError:
            continue
        s.settimeout(0.3)
        for _ in range(3):
            s.sendto(msg, ('239.255.255.250', 1900))
        socks.append(s)
    found, end = {}, time.time() + timeout
    while time.time() < end:
        for s in socks:
            try:
                data, addr = s.recvfrom(65507)
            except (socket.timeout, OSError):
                continue
            loc = re.search(r'(?im)^location:\s*(\S+)', data.decode('utf-8', 'replace'))
            if loc:
                found.setdefault(loc.group(1), addr[0])
    return found

def scan_port(network, port=60128):
    """Plan B: prueba el puerto de control de Onkyo en cada dirección de la red."""
    def probe(ip):
        try:
            with socket.create_connection((str(ip), port), timeout=0.6):
                return str(ip)
        except OSError:
            return None
    hosts = list(network.hosts())
    with ThreadPoolExecutor(64) as ex:
        return [h for h in ex.map(probe, hosts) if h]

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
    args = [a for a in sys.argv[1:]]
    net_arg = None
    if '--red' in args:
        i = args.index('--red'); net_arg = args[i + 1]; del args[i:i + 2]
    ip = args[0] if args else None
    ifs = interfaces()
    print('Este servidor está en la red:', ', '.join(f'{n} {a}/{b}' for n, a, b in ifs) or '(no pude saberlo)')
    print('\nBuscando equipos en tu red (unos 5 segundos)…\n')
    seen = set()
    for loc, addr in ssdp([a for _, a, _ in ifs]).items():
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
        print('Por el método DLNA no apareció ningún equipo.\n')

    # Plan B: buscar directamente el puerto de control de Onkyo en toda la red local
    nets = [ipaddress.ip_network(net_arg, strict=False)] if net_arg else [ipaddress.ip_network(f'{a}/{max(b, 24)}', strict=False) for _, a, b in ifs]
    candidates = []
    for n in nets:
        print(f'Buscando el puerto de control de Onkyo (60128) en {n} …')
        candidates += scan_port(n)
    if candidates:
        print('\n✅ Equipos que responden como Onkyo:')
        for c in candidates:
            try:
                st = eiscp_query(c)
                estado = {'00': 'apagado (en espera)', '01': 'encendido'}.get(st, str(st))
                print(f'   • {c}  → {estado}')
            except Exception as e:
                print(f'   • {c}  (respondió el puerto, pero no la consulta: {e})')
        print('\nVuelve a correr el script con esa IP para ver el detalle:  python3 scripts/descubrir-onkyo.py ' + candidates[0])
    else:
        print('\nNo encontré ningún equipo con el puerto de control de Onkyo abierto.')
        print('Revisa en el Onkyo: que esté ENCENDIDO, con el cable de red conectado, y en Setup → Hardware → Network que tenga una IP.')
    if ip:
        print(f'\nProbando el puerto de control de Onkyo en {ip}:60128…')
        try:
            st = eiscp_query(ip)
            print('  ✅ Responde. Estado:', {'00': 'APAGADO (en espera)', '01': 'ENCENDIDO'}.get(st, st))
        except Exception as e:
            print('  ❌ No respondió:', e)
            print('     (En el equipo: Setup → Hardware → Network → "Network Standby" debe estar en On para poder encenderlo por red.)')

if __name__ == '__main__':
    main()
