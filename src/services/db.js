const fs = require('node:fs');
const path = require('node:path');

// Antes usaba node:sqlite, pero ese módulo requiere Node 22.5+ y no hay build oficial de Node para
// armv7l (Raspberry Pi de 32 bits) más allá de la v18. Esto guarda lo mismo en un archivo JSON
// plano: los datos son chicos (votos, animes recordados, canales configurados) y no justifican una
// base real, así que funciona en cualquier versión de Node sin módulos nativos que compilar.
const DB_PATH = path.join(__dirname, '..', '..', 'botanime.json');

function emptyStore() {
	return {
		anime: {},
		votes: {},
		notificationChannels: {},
		notifiedEpisodes: {},
		av1NotifiedEpisodes: {},
		forumChannels: {},
		// malId/seasonLabel -> Discord threadId donde se publica el hilo del anime en el foro
		av1ForumThreads: {},
		activeSeasons: {},

		voteRoles: {},
		progress: {},
		notifyWindows: {},
	};
}

// Ventana horaria por defecto en la que se manda el aviso de "hoy sale capítulo" (hora local del
// servidor). endHour es exclusivo: 23 significa "hasta las 22:59".
const DEFAULT_NOTIFY_WINDOW = { startHour: 17, endHour: 23 };

function loadStore() {
	if (!fs.existsSync(DB_PATH)) return emptyStore();
	try {
		return { ...emptyStore(), ...JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) };
	} catch (err) {
		console.error(`No pude leer ${DB_PATH}, arranco con datos vacíos:`, err.message);
		return emptyStore();
	}
}

const store = loadStore();

// Migración: antes el rol requerido para votar era un único VOTE_ROLE_ID global en .env, el mismo
// para todos los guilds. Al hacerlo configurable por servidor (para poder tener un guild de pruebas
// sin esa restricción), sembramos ese valor una sola vez para el guild de producción (GUILD_ID) así
// no hace falta correr ningún comando a mano para no perder el comportamiento que ya tenía.
if (process.env.GUILD_ID && process.env.VOTE_ROLE_ID && !(process.env.GUILD_ID in store.voteRoles)) {
	store.voteRoles[process.env.GUILD_ID] = process.env.VOTE_ROLE_ID;
	save();
}

function save() {
	fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 1));
}

// Incluye guildId porque dos guilds pueden compartir la misma etiqueta de temporada (ej. un guild de
// pruebas y el de producción publicando "Verano 2026" a la vez); sin el guildId en la clave, el
// segundo que corriera /temporada-foro pisaría el guildId guardado por el primero para todo malId
// repetido, aunque cada uno tenga su propio canal de foro.
const animeKey = (malId, seasonLabel, guildId) => `${guildId}::${seasonLabel}::${malId}`;
// Incluye guildId por el mismo motivo que animeKey: si dos guilds comparten etiqueta de temporada,
// el "último episodio avisado" de uno no debe afectar al del otro (ej. al recrear el hilo de un
// guild de pruebas no hay que resetear el contador del hilo real de producción).
const av1NotifiedKey = (malId, seasonLabel, guildId) => `${guildId}::${seasonLabel}::${malId}`;
const voteKey = (seasonLabel, malId, discordId) => `${seasonLabel}::${malId}::${discordId}`;
const progressKey = (seasonLabel, malId, discordId) => `${seasonLabel}::${malId}::${discordId}`;

// Recuerda un anime publicado (título, día de emisión, a qué server/temporada pertenece) para que
// el aviso semanal pueda encontrarlo después de un reinicio, sin depender de la caché en memoria, y
// para poder reconstruir la pestaña de la sheet desde cero (ver rebuildSeasonTab). isSequel/isCarryover
// no se conocen todavía cuando se publica la temporada (se resuelven recién al votar, o al detectar
// carryover); por eso esto hace merge campo por campo en vez de pisar el registro entero, así una
// llamada posterior puede completar isSequel/imageUrl sin perder lo que ya había.
function upsertAnime({ malId, seasonLabel, guildId, title, url, imageUrl, broadcastDay, isSequel, isCarryover, slug }) {
	const key = animeKey(malId, seasonLabel, guildId);
	const existing = store.anime[key] ?? {};
	store.anime[key] = {
		malId,
		seasonLabel,
		guildId,
		title: title ?? existing.title ?? null,
		url: url ?? existing.url ?? null,
		imageUrl: imageUrl ?? existing.imageUrl ?? null,
		broadcastDay: broadcastDay ?? existing.broadcastDay ?? null,
		isSequel: isSequel ?? existing.isSequel ?? false,
		isCarryover: isCarryover ?? existing.isCarryover ?? false,
		slug: slug ?? existing.slug ?? null,
	};
	save();
}

// Todos los animes recordados de una temporada (para reconstruir su pestaña desde cero).
function getAnimeForSeason(seasonLabel) {
	return Object.values(store.anime).filter((a) => a.seasonLabel === seasonLabel);
}

// Todos los animes recordados de cualquier temporada (para reconstruir seasonCache.js desde cero si
// hace falta, ver seasonCache.js).
function getAllAnime() {
	return Object.values(store.anime);
}

// Todos los votos de una temporada (para reconstruir su pestaña desde cero).
function getVotesForSeason(seasonLabel) {
	return Object.values(store.votes).filter((v) => v.seasonLabel === seasonLabel);
}

// Recuerda cuál es la temporada "activa" de un guild (la última publicada con /temporada o
// /temporada-foro), para que la reconstrucción automática sepa qué pestaña tocar sin tener que
// adivinarlo. Se guarda una por guild porque cada servidor puede estar en una temporada distinta.
function setActiveSeason({ guildId, seasonLabel }) {
	store.activeSeasons[guildId] = seasonLabel;
	save();
}

function getActiveSeason(guildId) {
	return store.activeSeasons[guildId] ?? null;
}

// Lista sin duplicados de las temporadas activas de todos los guilds (varios servidores pueden
// compartir la misma pestaña/temporada).
function listActiveSeasonLabels() {
	return [...new Set(Object.values(store.activeSeasons))];
}

// "Verde"/"naranja" cuentan como que la persona sigue el anime; "rojo" se maneja con removeVote.
function recordVote({ seasonLabel, malId, discordId, displayName, voteType }) {
	store.votes[voteKey(seasonLabel, malId, discordId)] = { seasonLabel, malId, discordId, displayName, voteType };
	save();
}

function removeVote({ seasonLabel, malId, discordId }) {
	delete store.votes[voteKey(seasonLabel, malId, discordId)];
	save();
}

function getWatchers({ seasonLabel, malId }) {
	return Object.values(store.votes)
		.filter((v) => v.seasonLabel === seasonLabel && v.malId === malId && (v.voteType === 'verde' || v.voteType === 'naranja'))
		.map((v) => v.discordId);
}

// El voto de una persona puntual para un anime, o null si no votó. Se usa para saber si hay que
// refrescar la celda de la sheet (con el capítulo nuevo) cuando cambia su progreso.
function getUserVote({ seasonLabel, malId, discordId }) {
	return store.votes[voteKey(seasonLabel, malId, discordId)] ?? null;
}

// malId de los animes que esta persona votó verde/naranja en la temporada (para el autocompletado de
// /capitulo: no tiene sentido ofrecer animes que no está siguiendo).
function getUserVotedAnime({ seasonLabel, discordId }) {
	return Object.values(store.votes)
		.filter((v) => v.seasonLabel === seasonLabel && v.discordId === discordId && (v.voteType === 'verde' || v.voteType === 'naranja'))
		.map((v) => v.malId);
}

// 'verde' si alguien ya dijo que lo va a ver, si no 'naranja' si alguien lo está pensando, si no null.
function getVoteState({ seasonLabel, malId }) {
	const relevant = Object.values(store.votes).filter((v) => v.seasonLabel === seasonLabel && v.malId === malId);
	if (relevant.some((v) => v.voteType === 'verde')) return 'verde';
	if (relevant.some((v) => v.voteType === 'naranja')) return 'naranja';
	return null;
}

// El progreso (capítulo por el que va cada persona) se guarda separado de los votos a propósito:
// tiene que poder marcarse aunque el voto sea rojo o todavía no exista, y los botones +/- de capítulo
// no dependen de haber votado.
function addEpisodesWatched({ seasonLabel, malId, discordId, displayName, delta }) {
	const key = progressKey(seasonLabel, malId, discordId);
	const current = store.progress[key]?.episodesWatched ?? 0;
	const episodesWatched = Math.max(0, current + delta);
	store.progress[key] = { seasonLabel, malId, discordId, displayName, episodesWatched };
	save();
	return episodesWatched;
}

// Solo devuelve a quienes tienen progreso > 0, para no mostrar en el embed a todo el mundo en "cap. 0".
function getProgressForAnime({ seasonLabel, malId }) {
	return Object.values(store.progress).filter((p) => p.seasonLabel === seasonLabel && p.malId === malId && p.episodesWatched > 0);
}

function getEpisodesWatched({ seasonLabel, malId, discordId }) {
	return store.progress[progressKey(seasonLabel, malId, discordId)]?.episodesWatched ?? 0;
}

// A diferencia de addEpisodesWatched (delta +/-, para el flujo de botón+modal), esto fija el número
// absoluto: lo usa /capitulo, donde el autocompletado ya sugiere el capítulo actual y la persona
// escribe directamente "por cuál va", no cuánto sumar.
function setEpisodesWatched({ seasonLabel, malId, discordId, displayName, episodesWatched }) {
	const key = progressKey(seasonLabel, malId, discordId);
	store.progress[key] = { seasonLabel, malId, discordId, displayName, episodesWatched: Math.max(0, episodesWatched) };
	save();
	return store.progress[key].episodesWatched;
}

function setNotificationChannel({ guildId, channelId }) {
	store.notificationChannels[guildId] = channelId;
	save();
}

function getNotificationChannel(guildId) {
	return store.notificationChannels[guildId] ?? null;
}

// Último episodio de animeav1 ya avisado para este anime, para no repetir el aviso en cada chequeo.
function getLastNotifiedAv1Episode({ seasonLabel, malId, guildId }) {
	return store.av1NotifiedEpisodes[av1NotifiedKey(malId, seasonLabel, guildId)] ?? 0;
}

function setLastNotifiedAv1Episode({ seasonLabel, malId, guildId, episode }) {
	store.av1NotifiedEpisodes[av1NotifiedKey(malId, seasonLabel, guildId)] = episode;
	save();
}

// Ventana horaria del aviso de "hoy sale capítulo" para un guild (ver DEFAULT_NOTIFY_WINDOW). Guardado
// por guild para poder ajustarla con un comando más adelante sin afectar a otros servidores.
function getNotifyWindow(guildId) {
	return store.notifyWindows[guildId] ?? DEFAULT_NOTIFY_WINDOW;
}

function setNotifyWindow({ guildId, startHour, endHour }) {
	store.notifyWindows[guildId] = { startHour, endHour };
	save();
}

// Rol requerido para votar en un guild; si no hay ninguno configurado, cualquiera puede votar ahí
// (así el guild de pruebas puede no tener restricción sin afectar producción).
function getVoteRole(guildId) {
	return store.voteRoles[guildId] ?? null;
}

function setVoteRole({ guildId, roleId }) {
	store.voteRoles[guildId] = roleId;
	save();
}

function getForumChannel(guildId) {
	return store.forumChannels[guildId] ?? null;
}

function setForumChannel({ guildId, channelId, seasonLabel }) {
	store.forumChannels[guildId] = { channelId, seasonLabel };
	save();
}

function av1ThreadKey({ guildId, seasonLabel, malId }) {
	return `${guildId}::${seasonLabel}::${malId}`;
}

function setAv1ForumThread({ guildId, seasonLabel, malId, threadId }) {
	store.av1ForumThreads[av1ThreadKey({ guildId, seasonLabel, malId })] = threadId;
	save();
}

function getAv1ForumThread({ guildId, seasonLabel, malId }) {
	return store.av1ForumThreads[av1ThreadKey({ guildId, seasonLabel, malId })] ?? null;
}

module.exports = {

	upsertAnime,
	recordVote,
	removeVote,
	getWatchers,
	getUserVote,
	getVoteState,
	getUserVotedAnime,
	addEpisodesWatched,
	setEpisodesWatched,
	getEpisodesWatched,
	getProgressForAnime,
	setNotificationChannel,
	getNotificationChannel,
	getLastNotifiedAv1Episode,
	setLastNotifiedAv1Episode,
	getNotifyWindow,
	setNotifyWindow,
	getVoteRole,
	setVoteRole,
	getForumChannel,
	setForumChannel,
	getAv1ForumThread,
	setAv1ForumThread,
	getAnimeForSeason,

	getAllAnime,
	getVotesForSeason,
	setActiveSeason,
	getActiveSeason,
	listActiveSeasonLabels,
};
