const fs = require('node:fs');
const path = require('node:path');

// Antes usaba node:sqlite, pero ese módulo requiere Node 22.5+ y no hay build oficial de Node para
// armv7l (Raspberry Pi de 32 bits) más allá de la v18. Esto guarda lo mismo en un archivo JSON
// plano: los datos son chicos (votos, animes recordados, canales configurados) y no justifican una
// base real, así que funciona en cualquier versión de Node sin módulos nativos que compilar.
const DB_PATH = path.join(__dirname, '..', '..', 'botanime.json');

function emptyStore() {
	return { anime: {}, votes: {}, notificationChannels: {}, notifiedEpisodes: {}, forumChannels: {} };
}

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

function save() {
	fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 1));
}

const animeKey = (malId, seasonLabel) => `${seasonLabel}::${malId}`;
const voteKey = (seasonLabel, malId, discordId) => `${seasonLabel}::${malId}::${discordId}`;
const notifiedKey = (seasonLabel, malId, dateKey) => `${seasonLabel}::${malId}::${dateKey}`;

// Recuerda un anime publicado (título, día de emisión, a qué server/temporada pertenece) para que
// el aviso semanal pueda encontrarlo después de un reinicio, sin depender de la caché en memoria.
function upsertAnime({ malId, seasonLabel, guildId, title, url, broadcastDay }) {
	store.anime[animeKey(malId, seasonLabel)] = { malId, seasonLabel, guildId, title, url: url ?? null, broadcastDay: broadcastDay ?? null };
	save();
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

// 'verde' si alguien ya dijo que lo va a ver, si no 'naranja' si alguien lo está pensando, si no null.
function getVoteState({ seasonLabel, malId }) {
	const relevant = Object.values(store.votes).filter((v) => v.seasonLabel === seasonLabel && v.malId === malId);
	if (relevant.some((v) => v.voteType === 'verde')) return 'verde';
	if (relevant.some((v) => v.voteType === 'naranja')) return 'naranja';
	return null;
}

function setNotificationChannel({ guildId, channelId }) {
	store.notificationChannels[guildId] = channelId;
	save();
}

function getNotificationChannel(guildId) {
	return store.notificationChannels[guildId] ?? null;
}

function getAnimeAiringOn(dayLabel) {
	return Object.values(store.anime).filter((a) => a.broadcastDay === dayLabel);
}

function wasNotifiedToday({ seasonLabel, malId, dateKey }) {
	return Boolean(store.notifiedEpisodes[notifiedKey(seasonLabel, malId, dateKey)]);
}

function markNotifiedToday({ seasonLabel, malId, dateKey }) {
	store.notifiedEpisodes[notifiedKey(seasonLabel, malId, dateKey)] = true;
	save();
}

function getForumChannel(guildId) {
	return store.forumChannels[guildId] ?? null;
}

function setForumChannel({ guildId, channelId, seasonLabel }) {
	store.forumChannels[guildId] = { channelId, seasonLabel };
	save();
}

module.exports = {
	upsertAnime,
	recordVote,
	removeVote,
	getWatchers,
	getVoteState,
	setNotificationChannel,
	getNotificationChannel,
	getAnimeAiringOn,
	wasNotifiedToday,
	markNotifiedToday,
	getForumChannel,
	setForumChannel,
};
