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
		// malId/seasonLabel/guildId/episodio -> mensaje del hilo de foro con los links de descarga, para
		// poder revisarlo unos días después y agregar proveedores que tarden más en aparecer (ver
		// collectDueEpisodeLinkChecks).
		episodeLinkMessages: {},
		// guildId -> bool: si /link-fix está activado para reemplazar embeds rotos de x.com/twitter.com.
		linkFixEnabled: {},
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

// Migración: antes av1NotifiedEpisodes guardaba directamente el número de episodio, sin fecha de
// detección. Al agregar detectedAt (para isCaughtUpThisWeek, el check de "lo vio la semana que
// salió"), las entradas viejas se quedarían sin fecha para siempre si a ese anime no le vuelven a
// detectar un episodio nuevo (p. ej. uno que ya terminó de emitir esta temporada), y el check nunca
// se tildaría para nadie. Se convierten una sola vez acá, usando el momento de este arranque como
// fecha: no es la fecha real en que salió, pero deja el check utilizable desde ya en vez de nunca.
let migratedAv1Entries = 0;
for (const [key, value] of Object.entries(store.av1NotifiedEpisodes)) {
	if (typeof value === 'number') {
		store.av1NotifiedEpisodes[key] = { episode: value, detectedAt: Date.now() };
		migratedAv1Entries += 1;
	}
}
if (migratedAv1Entries > 0) {
	console.log(`[db] migré ${migratedAv1Entries} entrada(s) vieja(s) de av1NotifiedEpisodes al formato con fecha`);
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
//
// isSequel/isCarryover son "pegajosos" (OR con lo que ya había, nunca bajan de true a false): la
// heurística automática (patrón del título + relación "Prequel" en MAL) puede fallar — MAL a veces
// tarda en cargar esa relación para animes recién agregados — y sin esto, una corrección manual (o un
// acierto previo) se perdía en el siguiente voto que volviera a evaluar la heurística y diera false,
// resucitando una columna duplicada en la sheet (bug real, visto dos veces).
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
		isSequel: Boolean(existing.isSequel) || Boolean(isSequel),
		isCarryover: Boolean(existing.isCarryover) || Boolean(isCarryover),
		// isAbandoned no se toca acá: a diferencia de isSequel/isCarryover (un hecho fijo del anime) esto
		// refleja si ahora mismo nadie lo está viendo, así que tiene que poder subir y bajar. Se
		// marca/desmarca aparte con setAnimeAbandoned (ver interactions.js), nunca se pisa en un voto normal.
		isAbandoned: Boolean(existing.isAbandoned),
		slug: slug ?? existing.slug ?? null,
	};
	save();
}

// Marca o desmarca un anime como "abandonado" (nadie lo sigue viendo) en TODOS los registros (uno por
// guild) que tenga para esta temporada — mismo motivo que el loop de setVote en getAnimeAcrossGuilds:
// es un solo hecho real, no depende de en qué guild se detectó. sheets.relocateAnimeColumn es quien
// mueve la columna real en la sheet cuando esto cambia (ver interactions.js).
function setAnimeAbandoned({ seasonLabel, malId, abandoned }) {
	for (const anime of getAnimeAcrossGuilds({ seasonLabel, malId })) {
		store.anime[animeKey(anime.malId, anime.seasonLabel, anime.guildId)] = { ...anime, isAbandoned: abandoned };
	}
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

// Todos los registros (uno por guild) de un mismo anime en una temporada. malId identifica al anime
// en sí, no depende de en qué guild se vio; y el voto/progreso de una persona es un solo hecho real,
// no "uno por guild". Hoy todos los guilds comparten la misma sheet (SHEET_ID es uno solo), pero si
// en el futuro cada guild apunta a la suya, escribir el voto en TODOS estos registros asegura que se
// vea reflejado en cualquier sheet donde el anime esté, sin importar en qué guild se disparó el voto.
function getAnimeAcrossGuilds({ seasonLabel, malId }) {
	return getAllAnime().filter((a) => a.seasonLabel === seasonLabel && a.malId === malId);
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

// Todos los que están viendo este anime (voto verde/naranja) con el capítulo por el que van (0 si
// todavía no lo marcaron): a diferencia de mirar solo la tabla de progreso, esto muestra a TODA la
// gente que sigue el anime aunque no haya tocado /capitulo todavía, para que el embed del hilo
// refleje quién lo está viendo, no solo quién ya reportó avance.
function getWatchersWithProgress({ seasonLabel, malId }) {
	return Object.values(store.votes)
		.filter((v) => v.seasonLabel === seasonLabel && v.malId === malId && (v.voteType === 'verde' || v.voteType === 'naranja'))
		.map((v) => ({
			discordId: v.discordId,
			displayName: v.displayName,
			episodesWatched: getEpisodesWatched({ seasonLabel, malId, discordId: v.discordId }),
		}));
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

// Lee una entrada de av1NotifiedEpisodes tolerando el formato viejo (antes de agregar detectedAt, la
// entrada era directamente el número de episodio, sin fecha). Con formato viejo detectedAt queda en
// null: no hay forma de saber en qué semana se detectó, así que isCaughtUpThisWeek lo trata como "no
// esta semana" en vez de asumir cualquier cosa.
function readAv1Entry(key) {
	const raw = store.av1NotifiedEpisodes[key];
	if (raw == null) return { episode: 0, detectedAt: null };
	if (typeof raw === 'number') return { episode: raw, detectedAt: null };
	return { episode: raw.episode ?? 0, detectedAt: raw.detectedAt ?? null };
}

// Último episodio de animeav1 ya avisado para este anime, para no repetir el aviso en cada chequeo.
function getLastNotifiedAv1Episode({ seasonLabel, malId, guildId }) {
	return readAv1Entry(av1NotifiedKey(malId, seasonLabel, guildId)).episode;
}

function setLastNotifiedAv1Episode({ seasonLabel, malId, guildId, episode }) {
	store.av1NotifiedEpisodes[av1NotifiedKey(malId, seasonLabel, guildId)] = { episode, detectedAt: Date.now() };
	save();
}

// Antes comparaba semana calendario (lunes a domingo): un episodio detectado el sábado dejaba de
// contar el martes siguiente aunque solo hubieran pasado 3 días, porque ya se había cruzado a la
// semana calendario nueva. Cambiado a una ventana corrediza de 7 días desde la detección (pedido del
// usuario 2026-08-11), que no tiene ese corte artificial a mitad de semana.
const CAUGHT_UP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// True si la persona ya está al día con el último episodio que animeav1 detectó para este anime Y
// todavía no pasó una semana desde que se detectó. Se usa para tildar el check de "lo vio a tiempo" en
// la sheet: ponerse al día con capítulos viejos (semanas atrás, vía /recarga o /capitulo) no cuenta,
// solo estar al día dentro de la primera semana. El reset semanal del check en sí lo hace un script
// aparte de la sheet, los domingos; esto solo decide cuándo tildarlo, nunca lo destilda.
function isCaughtUpThisWeek({ seasonLabel, malId, guildId, episodesWatched }) {
	const { episode, detectedAt } = readAv1Entry(av1NotifiedKey(malId, seasonLabel, guildId));
	if (!episode || !detectedAt) return false;
	if (episodesWatched < episode) return false;
	return Date.now() - detectedAt <= CAUGHT_UP_WINDOW_MS;
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

// Si /link-fix está activado para este guild (desactivado por defecto: hay que optar explícitamente,
// porque implica que el bot borre mensajes ajenos).
function getLinkFixEnabled(guildId) {
	return store.linkFixEnabled[guildId] ?? false;
}

function setLinkFixEnabled(guildId, enabled) {
	store.linkFixEnabled[guildId] = enabled;
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

function episodeLinkMessageKey({ guildId, seasonLabel, malId, episode }) {
	return `${guildId}::${seasonLabel}::${malId}::${episode}`;
}

// Recuerda el mensaje del hilo de foro donde se publicaron los links de descarga de un capítulo
// puntual (con qué proveedores ya se incluyeron), para poder revisarlo unos días después y agregar los
// que aparezcan más tarde (Mega/torrent suelen tardar más que 1Fichier/MP4Upload en subirse).
function recordEpisodeLinkMessage({ guildId, seasonLabel, malId, episode, title, slug, threadId, messageId, providers, hasErai }) {
	const key = episodeLinkMessageKey({ guildId, seasonLabel, malId, episode });
	store.episodeLinkMessages[key] = { guildId, seasonLabel, malId, episode, title, slug, threadId, messageId, providers, hasErai, postedAt: Date.now() };
	save();
}

// Actualiza los proveedores ya vistos de una entrada existente sin tocar postedAt (la ventana de
// rechequeo se cuenta desde la publicación original, no desde la última vez que se encontró algo
// nuevo). No hace nada si la entrada ya no existe (p. ej. se borró por encontrar todo o por vencerse).
function updateEpisodeLinkMessageProviders({ guildId, seasonLabel, malId, episode, providers, hasErai }) {
	const key = episodeLinkMessageKey({ guildId, seasonLabel, malId, episode });
	const existing = store.episodeLinkMessages[key];
	if (!existing) return;
	store.episodeLinkMessages[key] = { ...existing, providers, hasErai };
	save();
}

function deleteEpisodeLinkMessage({ guildId, seasonLabel, malId, episode }) {
	delete store.episodeLinkMessages[episodeLinkMessageKey({ guildId, seasonLabel, malId, episode })];
	save();
}

// Devuelve las entradas todavía dentro de la ventana de rechequeo (no más viejas que maxAgeMs), podando
// de paso las que ya se pasaron: no tiene sentido seguir revisando capítulos de hace semanas para
// siempre.
function collectDueEpisodeLinkChecks(maxAgeMs) {
	const now = Date.now();
	const due = [];
	for (const [key, entry] of Object.entries(store.episodeLinkMessages)) {
		if (now - entry.postedAt > maxAgeMs) {
			delete store.episodeLinkMessages[key];
		} else {
			due.push(entry);
		}
	}
	save();
	return due;
}

module.exports = {

	upsertAnime,
	setAnimeAbandoned,
	recordVote,
	removeVote,
	getWatchers,
	getUserVote,
	getVoteState,
	getUserVotedAnime,
	addEpisodesWatched,
	setEpisodesWatched,
	getEpisodesWatched,
	getWatchersWithProgress,
	setNotificationChannel,
	getNotificationChannel,
	getLastNotifiedAv1Episode,
	setLastNotifiedAv1Episode,
	isCaughtUpThisWeek,
	getNotifyWindow,
	setNotifyWindow,
	getVoteRole,
	setVoteRole,
	getLinkFixEnabled,
	setLinkFixEnabled,
	getForumChannel,
	setForumChannel,
	getAv1ForumThread,
	setAv1ForumThread,
	recordEpisodeLinkMessage,
	updateEpisodeLinkMessageProviders,
	deleteEpisodeLinkMessage,
	collectDueEpisodeLinkChecks,
	getAnimeForSeason,

	getAllAnime,
	getAnimeAcrossGuilds,
	getVotesForSeason,
	setActiveSeason,
	getActiveSeason,
	listActiveSeasonLabels,
};
