const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { getBotState, setBotState } = require('./db');

const execFileAsync = promisify(execFile);

// LaLiga bloquea por IP rangos de Cloudflare durante los partidos, y animeav1 está detrás de Cloudflare:
// desde la Pi la conexión ni siquiera se abre (timeout). Cloudflare WARP en modo PROXY (SOCKS5 local)
// deja salir por otra vía solo lo que se le manda explícitamente. Nunca en modo normal: enrutaría todo
// el tráfico de la Pi (Valheim, Pi-hole, etc.).
const WARP_PROXY_PORT = 40000;
const WARP_PROXY = `127.0.0.1:${WARP_PROXY_PORT}`;
const ANIMEAV1_HOME = 'https://animeav1.com/';
const DIRECT_TIMEOUT_MS = 15_000;
const PROXY_TIMEOUT_S = 25;
const DIRECT_SKIP_MS = 10 * 60 * 1000;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const BACKUP_KEY = 'av1Backup';
const WARP_KEY = 'av1Warp';

// Modo respaldo: guarda los avisos armados para mandarlos en la ventana horaria sin depender de animeav1.
function isBackupMode() {
	return getBotState(BACKUP_KEY) === '1';
}

function setBackupMode(on) {
	setBotState(BACKUP_KEY, on ? '1' : '0');
}

// WARP verificado y conectado: las lecturas que fallan directo se reintentan por el proxy.
function isWarpEnabled() {
	return getBotState(WARP_KEY) === '1';
}

// Tras una falla directa se salta el intento directo un rato, para no perder 15s de timeout en cada
// una de las lecturas de un mismo chequeo mientras dura el bloqueo.
let directBlockedUntil = 0;

async function curlFetch(url) {
	const { stdout } = await execFileAsync(
		'curl',
		['-sS', '-L', '--max-time', String(PROXY_TIMEOUT_S), '--socks5-hostname', WARP_PROXY, '-A', USER_AGENT, '-w', '\n%{http_code}', url],
		{ maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
	);
	const cut = stdout.lastIndexOf('\n');
	const status = Number(stdout.slice(cut + 1));
	const body = stdout.slice(0, cut);
	return { ok: status >= 200 && status < 300, status, text: async () => body };
}

// Reemplazo de fetch() para animeav1: solo se usan ok/status/text() de la respuesta.
async function av1Fetch(url) {
	const warp = isWarpEnabled();
	if (!warp || Date.now() >= directBlockedUntil) {
		try {
			return await fetch(url, { signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS) });
		} catch (err) {
			if (!warp) throw err;
			directBlockedUntil = Date.now() + DIRECT_SKIP_MS;
			console.warn(`[av1Net] lectura directa falló (${err.message}), uso WARP por ${DIRECT_SKIP_MS / 60_000} min`);
		}
	}
	return curlFetch(url);
}

function warpCli(...args) {
	return execFileAsync('warp-cli', ['--accept-tos', ...args], { timeout: 30_000, encoding: 'utf8' });
}

function firstLine(err) {
	return String(err.stderr || err.stdout || err.message).trim().split('\n')[0];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Devuelve { ok: true } o { ok: false, reason: 'not-installed' | 'error' | 'unverified', detail? }.
async function enableWarp() {
	try {
		await execFileAsync('warp-cli', ['--version'], { timeout: 10_000 });
	} catch (err) {
		if (err.code === 'ENOENT') return { ok: false, reason: 'not-installed' };
		return { ok: false, reason: 'error', detail: firstLine(err) };
	}

	try {
		try {
			await warpCli('registration', 'show');
		} catch {
			await warpCli('registration', 'new');
		}
		// El modo proxy va SIEMPRE antes del connect (ver el comentario de arriba).
		await warpCli('mode', 'proxy');
		await warpCli('proxy', 'port', String(WARP_PROXY_PORT));
		await warpCli('connect');
	} catch (err) {
		return { ok: false, reason: 'error', detail: firstLine(err) };
	}

	for (let attempt = 0; attempt < 4; attempt++) {
		await sleep(3000);
		try {
			if ((await curlFetch(ANIMEAV1_HOME)).ok) {
				setBotState(WARP_KEY, '1');
				return { ok: true };
			}
		} catch {
			// el túnel puede tardar unos segundos en levantar: se reintenta
		}
	}
	await warpCli('disconnect').catch(() => {});
	return { ok: false, reason: 'unverified' };
}

async function disableWarp() {
	setBotState(WARP_KEY, '0');
	directBlockedUntil = 0;
	await warpCli('disconnect').catch(() => {});
}

// El daemon de WARP suele recordar su último estado, pero por las dudas se reconecta al arrancar el bot.
async function ensureWarpOnStartup() {
	if (!isWarpEnabled()) return;
	try {
		await warpCli('connect');
		console.log('[av1Net] WARP reconectado al arrancar');
	} catch (err) {
		console.error('[av1Net] no pude reconectar WARP al arrancar:', firstLine(err));
	}
}

module.exports = { av1Fetch, isBackupMode, setBackupMode, isWarpEnabled, enableWarp, disableWarp, ensureWarpOnStartup };
