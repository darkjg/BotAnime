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

const upsertLinkFixSiteStmt = db.prepare(`
	INSERT INTO link_fix_sites (guildId, site, enabled) VALUES (?, ?, ?)
	ON CONFLICT (guildId, site) DO UPDATE SET enabled = excluded.enabled
`);
function setLinkFixSiteEnabled(guildId, site, enabled) {
	if (site === 'x') return setLinkFixEnabled(guildId, enabled);
	upsertLinkFixSiteStmt.run(guildId, site, toBit(enabled));
}

const selectLinkFixSitesStmt = db.prepare(`SELECT site FROM link_fix_sites WHERE guildId = ? AND enabled = 1`);
// Set con las claves de los sitios de /link-fix activos en el servidor (incluye 'x' si el
// interruptor histórico está activo).
function getLinkFixSitesEnabled(guildId) {
	const activos = new Set(selectLinkFixSitesStmt.all(guildId).map((row) => row.site));
	if (getLinkFixEnabled(guildId)) activos.add('x');
	return activos;
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

const selectSeasonForumStmt = db.prepare(`SELECT channelId FROM season_forums WHERE guildId = ? AND seasonLabel = ?`);
const upsertSeasonForumStmt = db.prepare(`
	INSERT INTO season_forums (guildId, seasonLabel, channelId) VALUES (?, ?, ?)
	ON CONFLICT (guildId, seasonLabel) DO UPDATE SET channelId = excluded.channelId
`);

// Id del canal de foro de esa temporada en ese servidor, o null si todavía no tiene uno.
function getSeasonForum({ guildId, seasonLabel }) {
	return selectSeasonForumStmt.get(guildId, seasonLabel)?.channelId ?? null;
}

function setSeasonForum({ guildId, seasonLabel, channelId }) {
	upsertSeasonForumStmt.run(guildId, seasonLabel, channelId);
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

// Para cuando alguien se fue del server y los avisos automáticos de nuevo capítulo le seguirían
// llegando para siempre (getWatchers sigue viendo sus votos "verde"/"naranja" en cada anime que
// seguía): borra TODOS sus votos de una, en cualquier temporada. Devuelve cuántos borró.
const deleteAllVotesForUserStmt = db.prepare(`DELETE FROM votes WHERE discordId = ?`);
function deleteAllVotesForUser({ discordId }) {
	return Number(deleteAllVotesForUserStmt.run(discordId).changes);
}

// Para /quitar-usuario: qué había que borrar, ANTES de borrarlo — así se sabe en qué temporadas
// tenía fila en la sheet (displayName) y qué animes hay que revisar por si se quedaron sin nadie
// viéndolos (ver syncAbandonedState en interactions.js, que hace exactamente eso tras un
// voto/desvoto normal pero no se dispara desde este borrado directo en BD).
const selectVotesForUserStmt = db.prepare(`SELECT seasonLabel, malId, displayName FROM votes WHERE discordId = ?`);
function getVotesForUser({ discordId }) {
	return selectVotesForUserStmt.all(discordId);
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
	const episodesWatched = addEpisodesWatchedStmt.get({ seasonLabel, malId, discordId, displayName, delta }).episodesWatched;
	syncEpisodesWatchedAcrossSeasons({ seasonLabel, malId, discordId, displayName, episodesWatched });
	return episodesWatched;
}

// Un anime que continúa de una temporada a otra (carryover, ej. One Piece) tiene una fila de progreso
// por cada temporada donde apareció, pero es la MISMA persona viendo el MISMO anime: el capítulo real no
// depende de en qué hilo (temporada) se haya pulsado "Actualizar capítulo". Sin esto, actualizar en el
// hilo de la temporada vieja (que sigue existiendo y la gente sigue usando por costumbre) dejaba la
// temporada nueva con un número desactualizado, y /pendientes avisaba de capítulos que ya se habían visto
// (caso real: One Piece, 2026-09-23). Se propaga como máximo (nunca hace retroceder un progreso mayor
// que ya estuviera en otra temporada) a todas las filas existentes de ese malId+persona, sin crear filas
// nuevas en temporadas donde ese anime no se llegó a trackear.
const syncEpisodesWatchedStmt = db.prepare(`
	UPDATE progress SET episodesWatched = MAX(episodesWatched, @episodesWatched), displayName = @displayName
	WHERE malId = @malId AND discordId = @discordId AND seasonLabel <> @seasonLabel
`);
function syncEpisodesWatchedAcrossSeasons({ seasonLabel, malId, discordId, displayName, episodesWatched }) {
	syncEpisodesWatchedStmt.run({ seasonLabel, malId, discordId, displayName, episodesWatched });
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
	const result = setEpisodesWatchedStmt.get({ seasonLabel, malId, discordId, displayName, episodesWatched }).episodesWatched;
	syncEpisodesWatchedAcrossSeasons({ seasonLabel, malId, discordId, displayName, episodesWatched: result });
	return result;
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

// --- botState ----------------------------------------------------------------------------------------

const selectBotStateStmt = db.prepare(`SELECT value FROM bot_state WHERE key = ?`);
const upsertBotStateStmt = db.prepare(`
	INSERT INTO bot_state (key, value) VALUES (?, ?)
	ON CONFLICT (key) DO UPDATE SET value = excluded.value
`);

function getBotState(key) {
	return selectBotStateStmt.get(key)?.value ?? null;
}

function setBotState(key, value) {
	upsertBotStateStmt.run(key, String(value));
}

// --- av1PendingNotices -------------------------------------------------------------------------------

const upsertPendingNoticeStmt = db.prepare(`
	INSERT INTO av1_pending_notices (guildId, seasonLabel, malId, episode, payload, createdAt) VALUES (?, ?, ?, ?, ?, ?)
	ON CONFLICT (guildId, seasonLabel, malId, episode) DO UPDATE SET payload = excluded.payload
`);
const hasPendingNoticeStmt = db.prepare(`SELECT 1 AS found FROM av1_pending_notices WHERE guildId = ? AND seasonLabel = ? AND malId = ? AND episode = ?`);
const listPendingNoticesStmt = db.prepare(`SELECT guildId, seasonLabel, malId, episode, payload, createdAt FROM av1_pending_notices ORDER BY createdAt`);
const deletePendingNoticeStmt = db.prepare(`DELETE FROM av1_pending_notices WHERE guildId = ? AND seasonLabel = ? AND malId = ? AND episode = ?`);

function savePendingNotice({ guildId, seasonLabel, malId, episode, payload }) {
	upsertPendingNoticeStmt.run(guildId, seasonLabel, malId, episode, JSON.stringify(payload), Date.now());
}

function hasPendingNotice({ guildId, seasonLabel, malId, episode }) {
	return Boolean(hasPendingNoticeStmt.get(guildId, seasonLabel, malId, episode));
}

function listPendingNotices() {
	return listPendingNoticesStmt.all().map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}

function deletePendingNotice({ guildId, seasonLabel, malId, episode }) {
	deletePendingNoticeStmt.run(guildId, seasonLabel, malId, episode);
}

// --- vacacionesGrebe ---------------------------------------------------------------------------------

const selectVacacionesStmt = db.prepare(`SELECT id, desde, hasta FROM vacaciones_grebe ORDER BY desde`);
const insertVacacionStmt = db.prepare(`INSERT INTO vacaciones_grebe (desde, hasta, creadoPor, creadoEn) VALUES (?, ?, ?, ?)`);
const deleteVacacionStmt = db.prepare(`DELETE FROM vacaciones_grebe WHERE id = ?`);

const MS_POR_DIA = 86_400_000;
const isoADia = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / MS_POR_DIA);
const diaAIso = (dia) => new Date(dia * MS_POR_DIA).toISOString().slice(0, 10);

function listVacacionesGrebe() {
	return selectVacacionesStmt.all().map((row) => ({ ...row }));
}

// Guarda un periodo (fechas 'YYYY-MM-DD', ambas incluidas) y lo une con los que se solapen o queden
// pegados, para que la lista nunca tenga periodos partidos. Devuelve el periodo resultante y cuántos
// existentes se unieron.
function saveVacacionGrebe({ desde, hasta, creadoPor }) {
	let inicio = isoADia(desde);
	let fin = isoADia(hasta);
	const nuevoInicio = inicio;
	const nuevoFin = fin;

	db.exec('BEGIN');
	try {
		const unidas = selectVacacionesStmt
			.all()
			.filter((row) => isoADia(row.desde) <= nuevoFin + 1 && isoADia(row.hasta) >= nuevoInicio - 1);
		for (const row of unidas) {
			inicio = Math.min(inicio, isoADia(row.desde));
			fin = Math.max(fin, isoADia(row.hasta));
			deleteVacacionStmt.run(row.id);
		}
		const res = insertVacacionStmt.run(diaAIso(inicio), diaAIso(fin), creadoPor, Date.now());
		db.exec('COMMIT');
		return { id: Number(res.lastInsertRowid), desde: diaAIso(inicio), hasta: diaAIso(fin), unidas: unidas.length };
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
}

function deleteVacacionGrebe(id) {
	return Number(deleteVacacionStmt.run(id).changes) > 0;
}

// --- quedadas ----------------------------------------------------------------------------------------

const insertQuedadaStmt = db.prepare(`
	INSERT INTO quedadas (guildId, seasonLabel, malId, title, fecha, hora, startsAt, weekly, note, createdBy, createdAt, hourSent, startSent)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
`);
const selectQuedadaStmt = db.prepare(`SELECT * FROM quedadas WHERE id = ?`);
const selectQuedadasGuildStmt = db.prepare(`SELECT * FROM quedadas WHERE guildId = ? ORDER BY startsAt`);
const selectQuedadasAllStmt = db.prepare(`SELECT * FROM quedadas ORDER BY startsAt`);
const deleteQuedadaStmt = db.prepare(`DELETE FROM quedadas WHERE id = ?`);

const quedadaFromRow = (row) => (row ? { ...row, weekly: Boolean(row.weekly), hourSent: Boolean(row.hourSent), startSent: Boolean(row.startSent) } : null);

function createQuedada({ guildId, seasonLabel, malId, title, fecha, hora, startsAt, weekly, note, createdBy, hourSent }) {
	const res = insertQuedadaStmt.run(guildId, seasonLabel, malId, title, fecha, hora, startsAt, toBit(weekly), note ?? null, createdBy, Date.now(), toBit(hourSent));
	return Number(res.lastInsertRowid);
}

function getQuedada(id) {
	return quedadaFromRow(selectQuedadaStmt.get(id));
}

function listQuedadasGuild(guildId) {
	return selectQuedadasGuildStmt.all(guildId).map(quedadaFromRow);
}

function listQuedadas() {
	return selectQuedadasAllStmt.all().map(quedadaFromRow);
}

function deleteQuedada(id) {
	return Number(deleteQuedadaStmt.run(id).changes) > 0;
}

// Solo lo que cambia al avanzar una quedada: los nombres de columna salen de esta lista, no de quien llama.
const CAMPOS_QUEDADA = new Set(['fecha', 'hora', 'startsAt', 'hourSent', 'startSent']);
function updateQuedada(id, campos) {
	const claves = Object.keys(campos);
	for (const clave of claves) if (!CAMPOS_QUEDADA.has(clave)) throw new Error(`campo de quedada no permitido: ${clave}`);
	const valores = claves.map((clave) => (typeof campos[clave] === 'boolean' ? toBit(campos[clave]) : campos[clave]));
	db.prepare(`UPDATE quedadas SET ${claves.map((clave) => `${clave} = ?`).join(', ')} WHERE id = ?`).run(...valores, id);
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

// Fallback de getAv1ForumThread para cuando el carryover a la temporada nueva no llegó a crear un hilo
// ahí (p.ej. falló esa creación puntual en publishSeasonForum y quedó sin loguear el detalle) — en vez
// de dejar el aviso/link sin ningún hilo, busca el hilo real que sí existe de otra temporada para el
// mismo anime (el hilo de Discord sigue existiendo y siendo válido aunque ya no sea el de la temporada activa).
const selectAv1ForumThreadAnySeasonStmt = db.prepare(`SELECT threadId FROM av1_forum_threads WHERE guildId = ? AND malId = ? LIMIT 1`);
function getAv1ForumThreadAnySeason({ guildId, malId }) {
	return selectAv1ForumThreadAnySeasonStmt.get(guildId, malId)?.threadId ?? null;
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

const selectEpisodeLinkMessageStmt = db.prepare(
	`SELECT threadId, messageId FROM episode_link_messages WHERE guildId = ? AND seasonLabel = ? AND malId = ? AND episode = ?`,
);
// A diferencia de collectDueEpisodeLinkChecks, esto NO poda nada (es de solo lectura) — lo usa
// /pendientes para linkear directo al mensaje de descargas del último capítulo detectado. Puede
// devolver null si ya se podó por vencer PROVIDER_RECHECK_MAX_AGE_MS (4 días) o si nunca se llegó a
// publicar (ver el bug real de getDownloadLinks en animeav1.js, corregido 2026-09-11): en ese caso
// quien llama debería caer a linkear el hilo del foro en general (getAv1ForumThread) en vez del capítulo puntual.
function getEpisodeLinkMessage({ guildId, seasonLabel, malId, episode }) {
	return selectEpisodeLinkMessageStmt.get(guildId, seasonLabel, malId, episode) ?? null;
}

// Devuelve las entradas todavía dentro de la ventana de rechequeo (no más viejas que maxAgeMs), podando
// de paso las que ya se pasaron: no tiene sentido seguir revisando capítulos de hace semanas para
// siempre.
function collectDueEpisodeLinkChecks(maxAgeMs) {
	const cutoff = Date.now() - maxAgeMs;
	deleteExpiredEpisodeLinkMessagesStmt.run(cutoff);
	return selectDueEpisodeLinkMessagesStmt.all(cutoff).map((row) => ({ ...row, providers: JSON.parse(row.providers), hasErai: Boolean(row.hasErai) }));
}

// --- anime_nicknames (/apodo) --------------------------------------------------------------------

const upsertAnimeNicknameStmt = db.prepare(`
	INSERT INTO anime_nicknames (malId, nickname, setBy, setAt) VALUES (?, ?, ?, ?)
	ON CONFLICT (malId) DO UPDATE SET nickname = excluded.nickname, setBy = excluded.setBy, setAt = excluded.setAt
`);
const deleteAnimeNicknameStmt = db.prepare(`DELETE FROM anime_nicknames WHERE malId = ?`);
// nickname vacío/null borra el apodo en vez de guardar un apodo vacío.
function setAnimeNickname({ malId, nickname, setBy }) {
	const trimmed = (nickname ?? '').trim();
	if (!trimmed) {
		deleteAnimeNicknameStmt.run(malId);
		return null;
	}
	upsertAnimeNicknameStmt.run(malId, trimmed, setBy ?? null, Date.now());
	return trimmed;
}

const selectAnimeNicknameStmt = db.prepare(`SELECT nickname FROM anime_nicknames WHERE malId = ?`);
function getAnimeNickname(malId) {
	return selectAnimeNicknameStmt.get(malId)?.nickname ?? null;
}

// Título a MOSTRAR (apodo si tiene, si no el título real de MAL) — usar en hilos/embeds/comandos/sheet.
// anime.title en sí (la tabla `anime`) nunca se toca: el cruce contra animeav1.com (checkAndNotifyAv1
// en scheduler.js) necesita el título real para emparejar, no el apodo.
function getDisplayTitle(anime) {
	return getAnimeNickname(anime.malId) ?? anime.title;
}

// --- yumi_games (/yumi) --------------------------------------------------------------------------

const insertYumiGameStmt = db.prepare(`INSERT INTO yumi_games (won, at) VALUES (?, ?)`);
function addYumiGame({ won }) {
	insertYumiGameStmt.run(won ? 1 : 0, Date.now());
}

const deleteLastYumiGameStmt = db.prepare(`DELETE FROM yumi_games WHERE id = (SELECT MAX(id) FROM yumi_games) RETURNING won`);
// Devuelve { won } de la partida borrada, o null si no había ninguna.
function undoLastYumiGame() {
	const row = deleteLastYumiGameStmt.get();
	return row ? { won: Boolean(row.won) } : null;
}

const selectYumiStatsStmt = db.prepare(`SELECT COUNT(*) AS games, COALESCE(SUM(1 - won), 0) AS losses FROM yumi_games`);
function getYumiStats() {
	const { games, losses } = selectYumiStatsStmt.get();
	return { games, losses, wins: games - losses };
}

// --- reminders (/recordatorio) -----------------------------------------------------------------------

const insertReminderStmt = db.prepare(`
	INSERT INTO reminders (guildId, channelId, discordId, displayName, message, dueAt, createdAt, notified, repeatEveryMs)
	VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
`);
// repeatEveryMs: null/omitido = aviso único; un número (ms) = se repite cada tanto hasta que se cancele.
function createReminder({ guildId, channelId, discordId, displayName, message, dueAt, repeatEveryMs = null }) {
	const res = insertReminderStmt.run(guildId, channelId, discordId, displayName, message, dueAt, Date.now(), repeatEveryMs);
	return Number(res.lastInsertRowid);
}

const reminderFromRow = (row) => (row ? { ...row, notified: Boolean(row.notified) } : null);

const selectReminderStmt = db.prepare(`SELECT * FROM reminders WHERE id = ?`);
function getReminder(id) {
	return reminderFromRow(selectReminderStmt.get(id));
}

// Ordenados por fecha, más próximo primero: es como tiene sentido mostrarlos en /recordatorios.
const selectPendingRemindersForUserStmt = db.prepare(
	`SELECT * FROM reminders WHERE guildId = ? AND discordId = ? AND notified = 0 ORDER BY dueAt`,
);
function listPendingRemindersForUser({ guildId, discordId }) {
	return selectPendingRemindersForUserStmt.all(guildId, discordId).map(reminderFromRow);
}

// Todos los pendientes de todos los servidores, para el chequeo periódico; el filtro por dueAt se hace
// en JS (pasar `ahora` acá obligaría a re-preparar el statement por cada chequeo).
const selectAllPendingRemindersStmt = db.prepare(`SELECT * FROM reminders WHERE notified = 0 ORDER BY dueAt`);
function listPendingReminders() {
	return selectAllPendingRemindersStmt.all().map(reminderFromRow);
}

const markReminderNotifiedStmt = db.prepare(`UPDATE reminders SET notified = 1 WHERE id = ?`);
function markReminderNotified(id) {
	markReminderNotifiedStmt.run(id);
}

// Para los recordatorios repetidos: en vez de darlos por avisados, se mueven a su siguiente ocurrencia.
const rescheduleReminderStmt = db.prepare(`UPDATE reminders SET dueAt = ? WHERE id = ?`);
function rescheduleReminder(id, dueAt) {
	rescheduleReminderStmt.run(dueAt, id);
}

const deleteReminderStmt = db.prepare(`DELETE FROM reminders WHERE id = ? AND discordId = ?`);
// Solo lo puede cancelar quien lo creó (discordId en el WHERE, no solo el id) — devuelve false si no
// era suyo o ya no existía, para poder avisar distinto en cada caso.
function deleteReminder({ id, discordId }) {
	return Number(deleteReminderStmt.run(id, discordId).changes) > 0;
}

// Para cuando alguien se fue del server y sus recordatorios pendientes se quedarían disparando para
// siempre: borra TODOS los suyos en este server de una, en vez de uno por uno. Devuelve cuántos borró.
const deleteAllRemindersForUserStmt = db.prepare(`DELETE FROM reminders WHERE guildId = ? AND discordId = ?`);
function deleteAllRemindersForUser({ guildId, discordId }) {
	return Number(deleteAllRemindersForUserStmt.run(guildId, discordId).changes);
}

module.exports = {
	addYumiGame,
	undoLastYumiGame,
	getYumiStats,
	createReminder,
	getReminder,
	listPendingRemindersForUser,
	listPendingReminders,
	markReminderNotified,
	rescheduleReminder,
	deleteReminder,
	deleteAllRemindersForUser,
	upsertAnime,
	setAnimeAbandoned,
	recordVote,
	removeVote,
	deleteAllVotesForUser,
	getVotesForUser,
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
	setLinkFixSiteEnabled,
	getLinkFixSitesEnabled,
	getBotState,
	setBotState,
	savePendingNotice,
	hasPendingNotice,
	listPendingNotices,
	deletePendingNotice,
	listVacacionesGrebe,
	saveVacacionGrebe,
	deleteVacacionGrebe,
	createQuedada,
	getQuedada,
	listQuedadasGuild,
	listQuedadas,
	deleteQuedada,
	updateQuedada,
	getForumChannel,
	setForumChannel,
	getSeasonForum,
	setSeasonForum,
	getAv1ForumThread,
	getAv1ForumThreadAnySeason,
	setAv1ForumThread,
	recordEpisodeLinkMessage,
	updateEpisodeLinkMessageProviders,
	deleteEpisodeLinkMessage,
	collectDueEpisodeLinkChecks,
	getEpisodeLinkMessage,
	getAnimeForSeason,

	getAllAnime,
	getAnimeAcrossGuilds,
	getVotesForSeason,
	setActiveSeason,
	getActiveSeason,
	listActiveSeasonLabels,

	recordSeasonHistory,
	getPreviousSeasonLabel,


	setAnimeNickname,
	getAnimeNickname,
	getDisplayTitle,
};
