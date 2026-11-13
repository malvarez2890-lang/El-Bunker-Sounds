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
    services, controls = [], {}
    for sv in root.iter('{urn:schemas-upnp-org:device-1-0}service'):
        t = sv.findtext('d:serviceType', default='', namespaces=ns)
        services.append(t)
        controls[t] = sv.findtext('d:controlURL', default='', namespaces=ns)
    return {'name': g('friendlyName'), 'maker': g('manufacturer'), 'model': g('modelName'), 'type': g('deviceType'), 'services': services, 'controls': controls}

def _frame(cmd):
    data = ('!1' + cmd + '\r').encode()
    return b'ISCP' + struct.pack('>I', 16) + struct.pack('>I', len(data)) + b'\x01\x00\x00\x00' + data

def _frames(buf):
    out = []
    while len(buf) >= 16 and buf[:4] == b'ISCP':
        hs, ds = struct.unpack('>II', buf[4:12])
        if len(buf) < hs + ds:
            break
        out.append(buf[hs:hs + ds].decode('utf-8', 'replace'))
        buf = buf[hs + ds:]
    return out

def eiscp_ask(ip, cmds, port=60128, wait=1.2):
    """Hace preguntas de SOLO LECTURA (…QSTN) y devuelve las respuestas. Una conexión nueva por pregunta (más confiable)."""
    got = []
    for cmd in cmds:
        try:
            with socket.create_connection((ip, port), timeout=3) as c:
                c.sendall(_frame(cmd))
                c.settimeout(0.3)
                buf, end = b'', time.time() + wait
                while time.time() < end:
                    try:
                        chunk = c.recv(65536)
                    except socket.timeout:
                        continue
                    if not chunk:
                        break
                    buf += chunk
            got += _frames(buf)
        except OSError:
            continue
    return got

def eiscp_query(ip, port=60128):
    """Pregunta "¿estás encendido?". Es solo una consulta."""
    for r in eiscp_ask(ip, ['PWRQSTN'], port, wait=1.0):
        m = re.search(r'!1PWR(\w\w)', r)
        if m:
            return m.group(1)
    return None

def ficha_onkyo(ip):
    """Modelo, versión, entrada y volumen actuales, y servicios de red que declara el equipo (solo lectura)."""
    print(f'\nFicha del equipo en {ip} (solo preguntas, no cambia nada):')
    try:
        res = eiscp_ask(ip, ['SLIQSTN', 'MVLQSTN', 'NRIQSTN'])
    except Exception as e:
        print('  (no pude leerla:', e, ')')
        return
    for r in res:
        m = re.search(r'!1SLI(\w\w)', r)
        if m: print(f'  Entrada actual (código): {m.group(1)}   (2B = red/NET)')
        m = re.search(r'!1MVL(\w\w)', r)
        if m: print(f'  Volumen actual (hex): {m.group(1)}')
        if 'NRI' in r:
            for tag, label in (('model', 'Modelo'), ('firmwareversion', 'Versión'), ('macaddress', 'MAC')):
                m = re.search(rf'<{tag}>([^<]*)</{tag}>', r)
                if m: print(f'  {label}: {m.group(1)}')
            svcs = re.findall(r'<netservice [^>]*name="([^"]*)"', r)
            if svcs: print('  Servicios de red:', ', '.join(svcs))

def ssdp_directo(ip, timeout=3.0):
    """Pregunta por UPnP/DLNA DIRECTAMENTE a la IP del equipo (funciona aunque el router no deje pasar la búsqueda general)."""
    found = {}
    for st in ('ssdp:all', 'urn:schemas-upnp-org:device:MediaRenderer:1', 'urn:schemas-upnp-org:service:AVTransport:1'):
        msg = (f'M-SEARCH * HTTP/1.1\r\nHOST: {ip}:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: {st}\r\n\r\n').encode()
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.sendto(msg, (ip, 1900))
        end = time.time() + timeout / 3
        while time.time() < end:
            try:
                data, addr = s.recvfrom(65507)
            except (socket.timeout, OSError):
                continue
            loc = re.search(r'(?im)^location:\s*(\S+)', data.decode('utf-8', 'replace'))
            if loc:
                found.setdefault(loc.group(1), addr[0])
        s.close()
    return found

def puertos_abiertos(ip, puertos, timeout=0.3):
    def probe(p):
        try:
            with socket.create_connection((ip, p), timeout=timeout):
                return p
        except OSError:
            return None
    with ThreadPoolExecutor(400) as ex:
        return sorted(p for p in ex.map(probe, puertos) if p)

DESC_PATHS = ['/description.xml', '/', '/upnp/desc.xml', '/rootDesc.xml', '/MediaRenderer/desc.xml', '/dmr/rootdesc.xml', '/Basic/rootDesc.xml', '/dd.xml', '/DeviceDescription.xml']

def upnp_por_puertos(ip):
    """Sin usar mensajes "a todos": prueba los puertos del equipo y busca la descripción UPnP/DLNA directamente."""
    puertos = [p for p in list(range(1, 1025)) + list(range(1025, 10000)) + list(range(49152, 65536)) if p != 60128]
    print('  Probando puertos del equipo (unos 15 segundos)…')
    abiertos = puertos_abiertos(ip, puertos)
    print('  Puertos abiertos:', ', '.join(map(str, abiertos)) or 'ninguno')
    hallados = {}
    for p in abiertos:
        for path in DESC_PATHS:
            url = f'http://{ip}:{p}{path}'
            try:
                body = urllib.request.urlopen(url, timeout=2).read(200000)
            except Exception:
                continue
            if b'urn:schemas-upnp-org:device-1-0' in body:
                hallados[url] = ip
                break
    return hallados

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
            return
        ficha_onkyo(ip)
        print(f'\nPreguntando por DLNA/UPnP directamente a {ip} …')
        directo = ssdp_directo(ip)
        if not directo:
            print('  No contestó a la pregunta directa. Pruebo por puertos…')
            directo = upnp_por_puertos(ip)
        if not directo:
            print('  El equipo no muestra ningún servicio DLNA/UPnP. Ponlo en la entrada NET (red) con su control remoto y vuelve a correr esto.')
        for loc, addr in directo.items():
            d = describe(loc)
            if not d:
                print(f'  • {addr}: contestó, pero no pude leer su descripción ({loc})')
                continue
            puede = any('AVTransport' in x for x in d['services'])
            print(f"  • {d['name'] or '(sin nombre)'}  {d['maker']} {d['model']}  tipo: {d['type'].split(':')[-2] if ':' in d['type'] else d['type']}")
            print('    ' + ('✅ PUEDE RECIBIR MÚSICA (AVTransport): se le puede mandar una canción' if puede else '- no ofrece recibir música; sí puede mostrar su biblioteca' if any('ContentDirectory' in x for x in d['services']) else '- sin funciones de música'))
            print('    servicios:', ', '.join(sorted({x.split(':')[-2] for x in d['services'] if ':' in x})))
            print('    dirección de la descripción:', loc)
            for t, c in d.get('controls', {}).items():
                if 'AVTransport' in t or 'RenderingControl' in t:
                    print(f"    control {t.split(':')[-2]}: {c}")

if __name__ == '__main__':
    main()
