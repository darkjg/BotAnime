const http = require('node:http');
const {
	getNotifyDayWindows,
	setNotifyDayWindows,
	getNotifyWindow,
	getActiveSeason,
	getAllAnime,
	listPendingNotices,
	listRecentAv1Notices,
	getWatchersWithProgress,
	getLastNotifiedAv1Episode,
} = require('./services/db');
const { isBackupMode, setBackupMode, isWarpEnabled, enableWarp, disableWarp } = require('./services/av1Net');
const { getLastAv1Check } = require('./av1Backup');
const { getFootballStatus } = require('./futbolCheck');
const { checkAndNotifyAv1 } = require('./scheduler');

// Ajustes del bot que se editan desde la Homepage de la Pi (gethomepage, puerto 3003, custom.js).
// Solo red local: NO pasa por Caddy ni se publica, y además se rechaza cualquier IP que no sea privada
// o cualquier Origin que no sea la propia Homepage.
const PORT = 3006;
const ALLOWED_ORIGIN = process.env.HOMEPAGE_ORIGIN || 'http://192.168.1.100:3003';
const MAX_BODY_BYTES = 4 * 1024;
// Anti DNS-rebinding: solo se atiende si el Host es el de la Pi (o localhost), no un dominio ajeno que apunte aquí.
const ALLOWED_HOSTS = new Set([`${new URL(ALLOWED_ORIGIN).hostname}:${PORT}`, `localhost:${PORT}`, `127.0.0.1:${PORT}`]);

function isPrivateIp(address = '') {
	const ip = address.replace(/^::ffff:/, '');
	if (ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
	const m = /^172\.(\d+)\./.exec(ip);
	return Boolean(m && Number(m[1]) >= 16 && Number(m[1]) <= 31);
}

function readJson(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error('cuerpo demasiado grande'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch {
				reject(new Error('JSON inválido'));
			}
		});
		req.on('error', reject);
	});
}

// Siete {startHour, endHour} enteros 0-24 (domingo primero). start == end = sin avisos ese día.
function parseDays(body) {
	const days = body?.days;
	if (!Array.isArray(days) || days.length !== 7) return null;
	const out = [];
	for (const d of days) {
		const startHour = d?.startHour;
		const endHour = d?.endHour;
		if (![startHour, endHour].every((h) => Number.isInteger(h) && h >= 0 && h <= 24)) return null;
		if (endHour < startHour) return null;
		out.push({ startHour, endHour });
	}
	return out;
}

// Lo que ve la página: lo guardado por día, y donde falta, la ventana del servidor.
function currentDays(guildId) {
	const saved = getNotifyDayWindows();
	return Array.from({ length: 7 }, (_, i) => {
		const day = saved?.[i];
		if (day) return { startHour: day.startHour, endHour: day.endHour };
		// Un día sin valor propio usa la ventana del servidor: se busca una fecha de ese día de la semana.
		const base = new Date(2026, 0, 4 + i); // 4-ene-2026 es domingo
		const w = getNotifyWindow(guildId, base);
		return { startHour: w.startHour, endHour: w.endHour };
	});
}

const ES_WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
let checking = false;

// Animes de la temporada activa que alguien ve (voto verde/naranja), con sus votantes y progreso.
function watchedAnime(guildId, season) {
	if (!season) return [];
	return getAllAnime()
		.filter((a) => a.seasonLabel === season && (!a.guildId || a.guildId === guildId))
		.map((a) => ({ anime: a, watchers: getWatchersWithProgress({ seasonLabel: season, malId: a.malId }) }))
		.filter((x) => x.watchers.length > 0);
}

// Capítulos que le quedan por ver a cada persona (contra lo último avisado de cada anime).
function pendingByPerson(guildId, season, tracked) {
	const people = new Map();
	for (const { anime, watchers } of tracked) {
		const last = getLastNotifiedAv1Episode({ seasonLabel: season, malId: anime.malId, guildId });
		for (const w of watchers) {
			const missing = Math.max(0, last - w.episodesWatched);
			if (!missing) continue;
			const p = people.get(w.discordId) ?? { name: w.displayName, episodes: 0, animes: 0 };
			p.episodes += missing;
			p.animes += 1;
			people.set(w.discordId, p);
		}
	}
	return [...people.values()].sort((a, b) => b.episodes - a.episodes);
}

// Resumen del bot para la Homepage (solo lectura).
function buildStatus(client, guildId) {
	const season = getActiveSeason(guildId);
	const window = getNotifyWindow(guildId);
	const tracked = watchedAnime(guildId, season);
	const startOfToday = new Date().setHours(0, 0, 0, 0);
	const today = ES_WEEKDAYS[new Date().getDay()];
	const recent = listRecentAv1Notices(guildId, 1000);
	return {
		uptimeSec: Math.round(process.uptime()),
		pingMs: client.ws.ping,
		season,
		animeCount: season ? getAllAnime().filter((a) => a.seasonLabel === season && (!a.guildId || a.guildId === guildId)).length : 0,
		todayWindow: window,
		warp: isWarpEnabled(),
		backup: isBackupMode(),
		pendingNotices: listPendingNotices().length,
		lastCheck: getLastAv1Check(),
		football: getFootballStatus(),
		checking,
		hoy: tracked
			.filter(({ anime }) => anime.broadcastDay === today)
			.map(({ anime, watchers }) => {
				const notified = recent.find((n) => n.seasonLabel === season && n.malId === anime.malId);
				return { title: anime.title, watchers: watchers.length, notified: Boolean(notified && notified.detectedAt >= startOfToday) };
			}),
		ultimos: recent
			.filter((n) => tracked.some((t) => t.anime.malId === n.malId && n.seasonLabel === season))
			.slice(0, 6)
			.map((n) => ({ title: n.title, episode: n.episode, at: n.detectedAt })),
		pendientes: pendingByPerson(guildId, season, tracked),
	};
}

function startSettingsServer(client) {
	const guildId = process.env.GUILD_ID;
	const server = http.createServer(async (req, res) => {
		const send = (status, payload) => {
			res.writeHead(status, {
				'Content-Type': 'application/json; charset=utf-8',
				'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
				'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type',
				Vary: 'Origin',
			});
			res.end(JSON.stringify(payload));
		};

		if (!isPrivateIp(req.socket.remoteAddress)) return send(403, { error: 'solo red local' });
		if (!ALLOWED_HOSTS.has(req.headers.host)) return send(403, { error: 'host no permitido' });
		// Lo que cambia estado exige venir de la Homepage (los navegadores siempre mandan Origin en POST/PUT).
		const mutates = req.method === 'POST' || req.method === 'PUT';
		if ((mutates || req.headers.origin) && req.headers.origin !== ALLOWED_ORIGIN) return send(403, { error: 'origen no permitido' });
		if (req.method === 'OPTIONS') return send(204, {});
		if (req.url === '/api/estado' && req.method === 'GET') return send(200, buildStatus(client, guildId));
		if (req.url === '/api/chequear' && req.method === 'POST') {
			if (checking) return send(409, { error: 'ya hay un chequeo en curso' });
			checking = true;
			checkAndNotifyAv1(client)
				.catch((err) => console.error('[settingsServer] falló el chequeo manual:', err.message))
				.finally(() => (checking = false));
			console.log('[settingsServer] chequeo de animeav1 pedido desde la Homepage');
			return send(202, { started: true });
		}
		if (req.url === '/api/warp' && req.method === 'POST') {
			try {
				const { action } = await readJson(req);
				if (action === 'off') {
					setBackupMode(false);
					await disableWarp();
					return send(200, { ok: true, warp: false });
				}
				if (action !== 'on') return send(400, { error: 'acción inválida' });
				setBackupMode(true);
				const result = await enableWarp();
				return send(200, { ok: result.ok, warp: isWarpEnabled(), reason: result.reason, detail: result.detail });
			} catch (err) {
				return send(400, { error: err.message });
			}
		}
		if (req.url !== '/api/avisos') return send(404, { error: 'no existe' });

		try {
			if (req.method === 'GET') return send(200, { days: currentDays(guildId) });
			if (req.method === 'PUT') {
				const days = parseDays(await readJson(req));
				if (!days) return send(400, { error: 'horas inválidas: 7 días, enteros de 0 a 24 y fin >= inicio' });
				setNotifyDayWindows(days);
				console.log('[settingsServer] horas de avisos por día actualizadas');
				return send(200, { days });
			}
			return send(405, { error: 'método no permitido' });
		} catch (err) {
			return send(400, { error: err.message });
		}
	});
	server.on('error', (err) => console.error('[settingsServer] error:', err.message));
	server.listen(PORT, '0.0.0.0', () => console.log(`[settingsServer] escuchando en :${PORT} (solo red local)`));
}

module.exports = { startSettingsServer, isPrivateIp, parseDays };
