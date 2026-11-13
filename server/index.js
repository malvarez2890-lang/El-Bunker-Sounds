import { loadConfig } from './config.js';
import { buildApp } from './app.js';

try { process.loadEnvFile('.env'); } catch { /* sin .env: se usan las variables del entorno */ }

const config = loadConfig();
const { app, ctx } = await buildApp(config);

if (config.baseUrl.startsWith('http://localhost') === false && !config.secureCookies) {
  app.log.warn('BASE_URL no es https: las cookies no serán "secure". Usa https en producción.');
}
if (!config.adminEmails.length) app.log.warn('ADMIN_EMAILS está vacío: nadie podrá aprobar usuarios.');

await app.listen({ port: config.port, host: config.host });

// Primer escaneo al arrancar y luego cada cierto tiempo (solo recorre archivos, es liviano).
ctx.library.scan();
if (config.scanIntervalMin > 0) setInterval(() => ctx.library.scan(), config.scanIntervalMin * 60 * 1000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
