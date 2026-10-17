const { getBotState, setBotState, getNotificationChannel } = require('./services/db');
const { isWarpEnabled, isBackupMode } = require('./services/av1Net');
const { getOwnerId, buildPromptRow } = require('./av1Backup');

// hayahora.futbol publica, por operadora e IP de Cloudflare, si LaLiga la tiene bloqueada. Fuera de partidos
// casi ninguna está en true; durante uno son cientos.
const URL = 'https://hayahora.futbol/estado/data.json';
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const MIN_BLOCKED = 50;
const PROMPT_KEY = 'futbolPromptDay';

async function isFootballBlocking() {
	const res = await fetch(URL, { signal: AbortSignal.timeout(20_000) });
	if (!res.ok) throw new Error(`hayahora.futbol respondió ${res.status}`);
	const { data } = await res.json();
	const blocked = data.filter((d) => d.stateChanges.at(-1)?.state === true).length;
	return { blocking: blocked >= MIN_BLOCKED, blocked };
}

// Última comprobación (la muestra la página de ajustes de la Homepage).
let lastStatus = null;
function getFootballStatus() {
	return lastStatus;
}

async function checkFootball(client) {
	const { blocking, blocked } = await isFootballBlocking();
	lastStatus = { at: Date.now(), blocking, blocked };
	if (isWarpEnabled()) return; // con WARP ya activo las lecturas caen solas al proxy
	if (!blocking) return;

	const today = new Date().toDateString();
	if (getBotState(PROMPT_KEY) === today) return;
	setBotState(PROMPT_KEY, today);

	const message = {
		content:
			`⚽ **Hay fútbol**: hayahora.futbol marca ${blocked} IPs de Cloudflare bloqueadas, así que animeav1 puede no responder desde la Pi y los avisos de hoy no saldrían.\n` +
			'¿Activo el modo respaldo con **WARP**? (solo el dueño del bot puede responder)',
		components: [buildPromptRow(isBackupMode(), isWarpEnabled())],
		allowedMentions: { parse: [] },
	};
	const channelId = getNotificationChannel(process.env.GUILD_ID);
	const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
	if (channel) {
		await channel.send(message);
	} else {
		// Sin canal de avisos configurado (/avisos-canal) se le pregunta al dueño por MD.
		const owner = await client.users.fetch(await getOwnerId(client));
		await owner.send(message);
	}
	console.log(`[futbol] hay fútbol (${blocked} IPs bloqueadas), pregunté si activar WARP en ${channel ? `#${channel.name}` : 'MD al dueño'}`);
}

function startFootballCheck(client) {
	const run = () => checkFootball(client).catch((err) => console.error('[futbol] no pude comprobar hayahora.futbol:', err.message));
	run();
	setInterval(run, CHECK_INTERVAL_MS);
}

module.exports = { startFootballCheck, getFootballStatus };
