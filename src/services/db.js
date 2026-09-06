const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { applySchema } = require('./dbSchema');

// Antes esto era JSON plano (motivo histórico: node:sqlite requería Node 22.5+ sin build oficial para
// armv7l/32 bits, la arquitectura vieja del Pi). Ahora que el Pi corre Node moderno de 64 bits, pasa a
// ser la única fuente de verdad real: la Google Sheet es un reflejo de esto, no una base paralela (ver
// el checkbox de "capítulo visto", que dejó de sumar por su cuenta en resetSemanal.gs).
const DB_PATH = path.join(__dirname, '..', '..', 'botanime.sqlite');

if (!fs.existsSync(DB_PATH)) {
	throw new Error(
		`No existe ${DB_PATH}. Corré primero "node scripts/migrate-to-sqlite.js" para migrar los datos de botanime.json antes de arrancar el bot.`,
	);
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
applySchema(db);

// Ventana horaria por defecto en la que se manda el aviso de "hoy sale capítulo" (hora local del
// servidor). endHour es exclusivo: 23 significa "hasta las 22:59".
const DEFAULT_NOTIFY_WINDOW = { startHour: 17, endHour: 23 };

// node:sqlite no acepta boolean/objetos crudos como parámetro (tira excepción) — hay que convertir a
// mano a 0/1 en cada punto de escritura, y de vuelta a boolean al leer.
const toBit = (value) => (value ? 1 : 0);

function animeRowToObject(row) {
	return { ...row, isSequel: Boolean(row.isSequel), isCarryover: Boolean(row.isCarryover), isAbandoned: Boolean(row.isAbandoned) };
}

// --- anime ---------------------------------------------------------------------------------------

const upsertAnimeStmt = db.prepare(`
	INSERT INTO anime (guildId, seasonLabel, malId, title, url, imageUrl, broadcastDay, isSequel, isCarryover, isAbandoned, slug)
	VALUES (@guildId, @seasonLabel, @malId, @title, @url, @imageUrl, @broadcastDay, @isSequel, @isCarryover, 0, @slug)
	ON CONFLICT (guildId, seasonLabel, malId) DO UPDATE SET
		title        = COALESCE(excluded.title, title),
		url          = COALESCE(excluded.url, url),
		imageUrl     = COALESCE(excluded.imageUrl, imageUrl),
		broadcastDay = COALESCE(excluded.broadcastDay, broadcastDay),
		isSequel     = MAX(isSequel, excluded.isSequel),
		isCarryover  = MAX(isCarryover, excluded.isCarryover),
		slug         = COALESCE(excluded.slug, slug)
`);

// isSequel/isCarryover son "pegajosos" (OR con lo que ya había, nunca bajan de true a false): la
// heurística automática (patrón del título + relación "Prequel" en MAL) puede fallar — MAL a veces
// tarda en cargar esa relación para animes recién agregados — y sin esto, una corrección manual (o un
// acierto previo) se perdía en el siguiente voto que volviera a evaluar la heurística y diera false,
// resucitando una columna duplicada en la sheet (bug real, visto dos veces). isAbandoned nunca se toca
// acá (a diferencia de esas dos, sube y baja libremente): se marca/desmarca aparte con setAnimeAbandoned.
function upsertAnime({ malId, seasonLabel, guildId, title, url, imageUrl, broadcastDay, isSequel, isCarryover, slug }) {
	upsertAnimeStmt.run({
		guildId,
		seasonLabel,
		malId,
		title: title ?? null,
		url: url ?? null,
		imageUrl: imageUrl ?? null,
		broadcastDay: broadcastDay ?? null,
		isSequel: toBit(isSequel),
		isCarryover: toBit(isCarryover),
		slug: slug ?? null,
	});
}

const setAnimeAbandonedStmt = db.prepare(`UPDATE anime SET isAbandoned = ? WHERE seasonLabel = ? AND malId = ?`);

// Afecta TODOS los registros (uno por guild) de este malId+temporada de una sola vez: es un solo hecho
// real, no depende de en qué guild se detectó (mismo motivo que getAnimeAcrossGuilds).
function setAnimeAbandoned({ seasonLabel, malId, abandoned }) {
	setAnimeAbandonedStmt.run(toBit(abandoned), seasonLabel, malId);
}

const selectAnimeForSeasonStmt = db.prepare(`SELECT * FROM anime WHERE seasonLabel = ?`);
function getAnimeForSeason(seasonLabel) {
	return selectAnimeForSeasonStmt.all(seasonLabel).map(animeRowToObject);
}

const selectAllAnimeStmt = db.prepare(`SELECT * FROM anime`);
function getAllAnime() {
	return selectAllAnimeStmt.all().map(animeRowToObject);
}

const selectAnimeAcrossGuildsStmt = db.prepare(`SELECT * FROM anime WHERE seasonLabel = ? AND malId = ?`);
function getAnimeAcrossGuilds({ seasonLabel, malId }) {
	return selectAnimeAcrossGuildsStmt.all(seasonLabel, malId).map(animeRowToObject);
}

// --- temporadas (seasons) -------------------------------------------------------------------------

const insertSeasonHistoryStmt = db.prepare(`
	INSERT INTO seasons (guildId, seasonLabel, previousSeasonLabel, createdAt)
	VALUES (?, ?, ?, ?)
	ON CONFLICT (guildId, seasonLabel) DO NOTHING
`);

// Se llama al publicar una temporada nueva, ANTES de pisar la temporada activa con setActiveSeason (ver
// temporadaShared.js). Reemplaza a sheets.getPreviousSeasonLabel, que leía el orden de las pestañas de
// la Sheet — ahora es un hecho guardado explícitamente en la base. Idempotente (ON CONFLICT DO NOTHING):
// si /temporada-foro se corre dos veces para la misma etiqueta, no pisa el valor real ya guardado.
function recordSeasonHistory({ guildId, seasonLabel, previousSeasonLabel }) {
	insertSeasonHistoryStmt.run(guildId, seasonLabel, previousSeasonLabel ?? null, Date.now());
}

const selectPreviousSeasonLabelStmt = db.prepare(`SELECT previousSeasonLabel FROM seasons WHERE guildId = ? AND seasonLabel = ?`);
function getPreviousSeasonLabel({ guildId, seasonLabel }) {
	return selectPreviousSeasonLabelStmt.get(guildId, seasonLabel)?.previousSeasonLabel ?? null;
}

// --- guild_settings (activeSeasons/notificationChannels/forumChannels/voteRoles/notifyWindows/linkFixEnabled) ---

const selectGuildSettingsStmt = db.prepare(`SELECT * FROM guild_settings WHERE guildId = ?`);
function getGuildSettingsRow(guildId) {
	return selectGuildSettingsStmt.get(guildId) ?? null;
}

// Único guild_settings tiene muchas columnas nulleables independientes; en vez de un upsert por
// columna, esto arma dinámicamente el UPSERT para la columna pedida. `column` siempre es un literal fijo
// que este mismo archivo elige en cada call site (nunca algo derivado de afuera), así que no hay riesgo
// de inyección al interpolarlo en el texto de la sentencia.
function upsertGuildSetting(guildId, column, value) {
	db.prepare(`INSERT INTO guild_settings (guildId, ${column}) VALUES (?, ?) ON CONFLICT (guildId) DO UPDATE SET ${column} = excluded.${column}`).run(
		guildId,
		value,
	);
}

function setActiveSeason({ guildId, seasonLabel }) {
	upsertGuildSetting(guildId, 'activeSeasonLabel', seasonLabel);
}

function getActiveSeason(guildId) {
	return getGuildSettingsRow(guildId)?.activeSeasonLabel ?? null;
}

const selectActiveSeasonLabelsStmt = db.prepare(`SELECT DISTINCT activeSeasonLabel FROM guild_settings WHERE activeSeasonLabel IS NOT NULL`);
function listActiveSeasonLabels() {
	return selectActiveSeasonLabelsStmt.all().map((row) => row.activeSeasonLabel);
}

function setNotificationChannel({ guildId, channelId }) {
	upsertGuildSetting(guildId, 'notificationChannelId', channelId);
}

function getNotificationChannel(guildId) {
	return getGuildSettingsRow(guildId)?.notificationChannelId ?? null;
}

function getNotifyWindow(guildId) {
	const row = getGuildSettingsRow(guildId);
	if (!row || row.notifyStartHour == null || row.notifyEndHour == null) return DEFAULT_NOTIFY_WINDOW;
	return { startHour: row.notifyStartHour, endHour: row.notifyEndHour };
}

const upsertNotifyWindowStmt = db.prepare(`
	INSERT INTO guild_settings (guildId, notifyStartHour, notifyEndHour) VALUES (?, ?, ?)
	ON CONFLICT (guildId) DO UPDATE SET notifyStartHour = excluded.notifyStartHour, notifyEndHour = excluded.notifyEndHour
`);
function setNotifyWindow({ guildId, startHour, endHour }) {
	upsertNotifyWindowStmt.run(guildId, startHour, endHour);
}

function getVoteRole(guildId) {
	return getGuildSettingsRow(guildId)?.voteRoleId ?? null;
}

function setVoteRole({ guildId, roleId }) {
	upsertGuildSetting(guildId, 'voteRoleId', roleId);
}

function getLinkFixEnabled(guildId) {
	return Boolean(getGuildSettingsRow(guildId)?.linkFixEnabled);
}

function setLinkFixEnabled(guildId, enabled) {
	upsertGuildSetting(guildId, 'linkFixEnabled', toBit(enabled));
}

function getForumChannel(guildId) {
	const row = getGuildSettingsRow(guildId);
	if (!row || row.forumChannelId == null) return null;
	return { channelId: row.forumChannelId, seasonLabel: row.forumSeasonLabel };
}

const upsertForumChannelStmt = db.prepare(`
	INSERT INTO guild_settings (guildId, forumChannelId, forumSeasonLabel) VALUES (?, ?, ?)
	ON CONFLICT (guildId) DO UPDATE SET forumChannelId = excluded.forumChannelId, forumSeasonLabel = excluded.forumSeasonLabel
`);
function setForumChannel({ guildId, channelId, seasonLabel }) {
	upsertForumChannelStmt.run(guildId, channelId, seasonLabel);
}

// --- votes -----------------------------------------------------------------------------------------

const upsertVoteStmt = db.prepare(`
	INSERT INTO votes (seasonLabel, malId, discordId, displayName, voteType) VALUES (?, ?, ?, ?, ?)
	ON CONFLICT (seasonLabel, malId, discordId) DO UPDATE SET displayName = excluded.displayName, voteType = excluded.voteType
`);
// "Verde"/"naranja" cuentan como que la persona sigue el anime; "rojo" se maneja con removeVote (nunca
// se guarda, igual que antes).
function recordVote({ seasonLabel, malId, discordId, displayName, voteType }) {
	upsertVoteStmt.run(seasonLabel, malId, discordId, displayName, voteType);
}

const deleteVoteStmt = db.prepare(`DELETE FROM votes WHERE seasonLabel = ? AND malId = ? AND discordId = ?`);
function removeVote({ seasonLabel, malId, discordId }) {
	deleteVoteStmt.run(seasonLabel, malId, discordId);
}

const selectWatchersStmt = db.prepare(`SELECT discordId FROM votes WHERE seasonLabel = ? AND malId = ? AND voteType IN ('verde', 'naranja')`);
function getWatchers({ seasonLabel, malId }) {
	return selectWatchersStmt.all(seasonLabel, malId).map((row) => row.discordId);
}

const selectUserVoteStmt = db.prepare(`SELECT * FROM votes WHERE seasonLabel = ? AND malId = ? AND discordId = ?`);
// El voto de una persona puntual para un anime, o null si no votó. Se usa para saber si hay que
// refrescar la celda de la sheet (con el capítulo nuevo) cuando cambia su progreso.
function getUserVote({ seasonLabel, malId, discordId }) {
	return selectUserVoteStmt.get(seasonLabel, malId, discordId) ?? null;
}

const selectUserVotedAnimeStmt = db.prepare(
	`SELECT malId FROM votes WHERE seasonLabel = ? AND discordId = ? AND voteType IN ('verde', 'naranja')`,
);
// malId de los animes que esta persona votó verde/naranja en la temporada (para el autocompletado de
// /capitulo: no tiene sentido ofrecer animes que no está siguiendo).
function getUserVotedAnime({ seasonLabel, discordId }) {
	return selectUserVotedAnimeStmt.all(seasonLabel, discordId).map((row) => row.malId);
}

// 'verde' si alguien ya dijo que lo va a ver, si no 'naranja' si alguien lo está pensando, si no null.
// El ORDER BY prioriza 'verde' sobre 'naranja' para que LIMIT 1 devuelva el que corresponde sin tener
// que traer todas las filas.
const selectVoteStateStmt = db.prepare(
	`SELECT voteType FROM votes WHERE seasonLabel = ? AND malId = ? ORDER BY (voteType = 'naranja') LIMIT 1`,
);
function getVoteState({ seasonLabel, malId }) {
	return selectVoteStateStmt.get(seasonLabel, malId)?.voteType ?? null;
}

// --- progress --------------------------------------------------------------------------------------

const selectEpisodesWatchedStmt = db.prepare(`SELECT episodesWatched FROM progress WHERE seasonLabel = ? AND malId = ? AND discordId = ?`);
function getEpisodesWatched({ seasonLabel, malId, discordId }) {
	return selectEpisodesWatchedStmt.get(seasonLabel, malId, discordId)?.episodesWatched ?? 0;
}

const addEpisodesWatchedStmt = db.prepare(`
	INSERT INTO progress (seasonLabel, malId, discordId, displayName, episodesWatched)
	VALUES (@seasonLabel, @malId, @discordId, @displayName, MAX(0, @delta))
	ON CONFLICT (seasonLabel, malId, discordId) DO UPDATE SET
		displayName = excluded.displayName,
		episodesWatched = MAX(0, episodesWatched + @delta)
	RETURNING episodesWatched
`);
// El progreso (capítulo por el que va cada persona) se guarda separado de los votos a propósito: tiene
// que poder marcarse aunque el voto sea rojo o todavía no exista, y los botones +/- de capítulo no
// dependen de haber votado.
function addEpisodesWatched({ seasonLabel, malId, discordId, displayName, delta }) {
	return addEpisodesWatchedStmt.get({ seasonLabel, malId, discordId, displayName, delta }).episodesWatched;
}

const setEpisodesWatchedStmt = db.prepare(`
	INSERT INTO progress (seasonLabel, malId, discordId, displayName, episodesWatched)
	VALUES (@seasonLabel, @malId, @discordId, @displayName, MAX(0, @episodesWatched))
	ON CONFLICT (seasonLabel, malId, discordId) DO UPDATE SET
		displayName = excluded.displayName,
		episodesWatched = MAX(0, @episodesWatched)
	RETURNING episodesWatched
`);
// A diferencia de addEpisodesWatched (delta +/-, para el flujo de botón+modal), esto fija el número
// absoluto: lo usa /capitulo, donde el autocompletado ya sugiere el capítulo actual y la persona escribe
// directamente "por cuál va", no cuánto sumar.
function setEpisodesWatched({ seasonLabel, malId, discordId, displayName, episodesWatched }) {
	return setEpisodesWatchedStmt.get({ seasonLabel, malId, discordId, displayName, episodesWatched }).episodesWatched;
}

const selectVotesForSeasonStmt = db.prepare(`SELECT * FROM votes WHERE seasonLabel = ?`);
function getVotesForSeason(seasonLabel) {
	return selectVotesForSeasonStmt.all(seasonLabel);
}

// Todos los que están viendo este anime (voto verde/naranja) con el capítulo por el que van (0 si
// todavía no lo marcaron): a diferencia de mirar solo la tabla de progreso, esto muestra a TODA la gente
// que sigue el anime aunque no haya tocado /capitulo todavía, para que el embed del hilo refleje quién
// lo está viendo, no solo quién ya reportó avance. Un solo LEFT JOIN en vez de N+1 consultas.
const selectWatchersWithProgressStmt = db.prepare(`
	SELECT v.discordId, v.displayName, COALESCE(p.episodesWatched, 0) AS episodesWatched
	FROM votes v
	LEFT JOIN progress p ON p.seasonLabel = v.seasonLabel AND p.malId = v.malId AND p.discordId = v.discordId
	WHERE v.seasonLabel = ? AND v.malId = ? AND v.voteType IN ('verde', 'naranja')
`);
function getWatchersWithProgress({ seasonLabel, malId }) {
	return selectWatchersWithProgressStmt.all(seasonLabel, malId);
}

// --- av1NotifiedEpisodes -----------------------------------------------------------------------------

const selectAv1EntryStmt = db.prepare(`SELECT episode, detectedAt FROM av1_notified_episodes WHERE guildId = ? AND seasonLabel = ? AND malId = ?`);
const upsertAv1EntryStmt = db.prepare(`
	INSERT INTO av1_notified_episodes (guildId, seasonLabel, malId, episode, detectedAt) VALUES (?, ?, ?, ?, ?)
	ON CONFLICT (guildId, seasonLabel, malId) DO UPDATE SET episode = excluded.episode, detectedAt = excluded.detectedAt
`);

// Último episodio de animeav1 ya avisado para este anime, para no repetir el aviso en cada chequeo.
function getLastNotifiedAv1Episode({ seasonLabel, malId, guildId }) {
	return selectAv1EntryStmt.get(guildId, seasonLabel, malId)?.episode ?? 0;
}

function setLastNotifiedAv1Episode({ seasonLabel, malId, guildId, episode }) {
	upsertAv1EntryStmt.run(guildId, seasonLabel, malId, episode, Date.now());
}

// Antes comparaba semana calendario (lunes a domingo): un episodio detectado el sábado dejaba de contar
// el martes siguiente aunque solo hubieran pasado 3 días, porque ya se había cruzado a la semana
// calendario nueva. Cambiado a una ventana corrediza de 7 días desde la detección (pedido del usuario
// 2026-08-11), que no tiene ese corte artificial a mitad de semana.
const CAUGHT_UP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// True si la persona ya está al día con el último episodio que animeav1 detectó para este anime Y
// todavía no pasó una semana desde que se detectó. Se usa para tildar el check de "lo vio a tiempo" en
// la sheet: ponerse al día con capítulos viejos (semanas atrás, vía /recarga o /capitulo) no cuenta, solo
// estar al día dentro de la primera semana. El checkbox de la sheet es puramente visual (ver
// resetSemanal.gs); esto solo decide cuándo tildarlo, nunca lo destilda.
function isCaughtUpThisWeek({ seasonLabel, malId, guildId, episodesWatched }) {
	const row = selectAv1EntryStmt.get(guildId, seasonLabel, malId);
	if (!row || !row.episode || row.detectedAt == null) return false;
	if (episodesWatched < row.episode) return false;
	return Date.now() - row.detectedAt <= CAUGHT_UP_WINDOW_MS;
}

// --- av1ForumThreads -----------------------------------------------------------------------------

const upsertAv1ForumThreadStmt = db.prepare(`
	INSERT INTO av1_forum_threads (guildId, seasonLabel, malId, threadId) VALUES (?, ?, ?, ?)
	ON CONFLICT (guildId, seasonLabel, malId) DO UPDATE SET threadId = excluded.threadId
`);
function setAv1ForumThread({ guildId, seasonLabel, malId, threadId }) {
	upsertAv1ForumThreadStmt.run(guildId, seasonLabel, malId, threadId);
}

const selectAv1ForumThreadStmt = db.prepare(`SELECT threadId FROM av1_forum_threads WHERE guildId = ? AND seasonLabel = ? AND malId = ?`);
function getAv1ForumThread({ guildId, seasonLabel, malId }) {
	return selectAv1ForumThreadStmt.get(guildId, seasonLabel, malId)?.threadId ?? null;
}

// --- episodeLinkMessages -----------------------------------------------------------------------------

const insertEpisodeLinkMessageStmt = db.prepare(`
	INSERT INTO episode_link_messages (guildId, seasonLabel, malId, episode, title, slug, threadId, messageId, providers, hasErai, postedAt)
	VALUES (@guildId, @seasonLabel, @malId, @episode, @title, @slug, @threadId, @messageId, @providers, @hasErai, @postedAt)
	ON CONFLICT (guildId, seasonLabel, malId, episode) DO UPDATE SET
		title = excluded.title, slug = excluded.slug, threadId = excluded.threadId, messageId = excluded.messageId,
		providers = excluded.providers, hasErai = excluded.hasErai, postedAt = excluded.postedAt
`);
// Recuerda el mensaje del hilo de foro donde se publicaron los links de descarga de un capítulo puntual
// (con qué proveedores ya se incluyeron), para poder revisarlo unos días después y agregar los que
// aparezcan más tarde (Mega/torrent suelen tardar más que 1Fichier/MP4Upload en subirse).
function recordEpisodeLinkMessage({ guildId, seasonLabel, malId, episode, title, slug, threadId, messageId, providers, hasErai }) {
	insertEpisodeLinkMessageStmt.run({
		guildId,
		seasonLabel,
		malId,
		episode,
		title: title ?? null,
		slug: slug ?? null,
		threadId: threadId ?? null,
		messageId: messageId ?? null,
		providers: JSON.stringify(providers ?? []),
		hasErai: toBit(hasErai),
		postedAt: Date.now(),
	});
}

const updateEpisodeLinkMessageProvidersStmt = db.prepare(`
	UPDATE episode_link_messages SET providers = ?, hasErai = ?
	WHERE guildId = ? AND seasonLabel = ? AND malId = ? AND episode = ?
`);
// Actualiza los proveedores ya vistos de una entrada existente sin tocar postedAt (la ventana de
// rechequeo se cuenta desde la publicación original, no desde la última vez que se encontró algo
// nuevo). No hace nada si la entrada ya no existe (p. ej. se borró por encontrar todo o por vencerse).
function updateEpisodeLinkMessageProviders({ guildId, seasonLabel, malId, episode, providers, hasErai }) {
	updateEpisodeLinkMessageProvidersStmt.run(JSON.stringify(providers ?? []), toBit(hasErai), guildId, seasonLabel, malId, episode);
}

const deleteEpisodeLinkMessageStmt = db.prepare(`DELETE FROM episode_link_messages WHERE guildId = ? AND seasonLabel = ? AND malId = ? AND episode = ?`);
function deleteEpisodeLinkMessage({ guildId, seasonLabel, malId, episode }) {
	deleteEpisodeLinkMessageStmt.run(guildId, seasonLabel, malId, episode);
}

const deleteExpiredEpisodeLinkMessagesStmt = db.prepare(`DELETE FROM episode_link_messages WHERE postedAt < ?`);
const selectDueEpisodeLinkMessagesStmt = db.prepare(`SELECT * FROM episode_link_messages WHERE postedAt >= ?`);

// Devuelve las entradas todavía dentro de la ventana de rechequeo (no más viejas que maxAgeMs), podando
// de paso las que ya se pasaron: no tiene sentido seguir revisando capítulos de hace semanas para
// siempre.
function collectDueEpisodeLinkChecks(maxAgeMs) {
	const cutoff = Date.now() - maxAgeMs;
	deleteExpiredEpisodeLinkMessagesStmt.run(cutoff);
	return selectDueEpisodeLinkMessagesStmt.all(cutoff).map((row) => ({ ...row, providers: JSON.parse(row.providers), hasErai: Boolean(row.hasErai) }));
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

	recordSeasonHistory,
	getPreviousSeasonLabel,
};
