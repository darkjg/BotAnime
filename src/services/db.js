const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, '..', '..', 'botanime.sqlite'));

db.exec(`
	CREATE TABLE IF NOT EXISTS anime (
		mal_id INTEGER NOT NULL,
		season_label TEXT NOT NULL,
		guild_id TEXT NOT NULL,
		title TEXT NOT NULL,
		url TEXT,
		broadcast_day TEXT,
		PRIMARY KEY (mal_id, season_label)
	);

	CREATE TABLE IF NOT EXISTS votes (
		season_label TEXT NOT NULL,
		mal_id INTEGER NOT NULL,
		discord_id TEXT NOT NULL,
		display_name TEXT NOT NULL,
		vote_type TEXT NOT NULL,
		PRIMARY KEY (season_label, mal_id, discord_id)
	);

	CREATE TABLE IF NOT EXISTS notification_channels (
		guild_id TEXT PRIMARY KEY,
		channel_id TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS notified_episodes (
		season_label TEXT NOT NULL,
		mal_id INTEGER NOT NULL,
		notified_date TEXT NOT NULL,
		PRIMARY KEY (season_label, mal_id, notified_date)
	);
`);

// Recuerda un anime publicado (título, día de emisión, a qué server/temporada pertenece) para que
// el aviso semanal pueda encontrarlo después de un reinicio, sin depender de la caché en memoria.
function upsertAnime({ malId, seasonLabel, guildId, title, url, broadcastDay }) {
	db.prepare(
		`INSERT INTO anime (mal_id, season_label, guild_id, title, url, broadcast_day)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(mal_id, season_label) DO UPDATE SET guild_id = excluded.guild_id, title = excluded.title,
			url = excluded.url, broadcast_day = excluded.broadcast_day`,
	).run(malId, seasonLabel, guildId, title, url ?? null, broadcastDay ?? null);
}

// "Verde"/"naranja" cuentan como que la persona sigue el anime; "rojo" se maneja con removeVote.
function recordVote({ seasonLabel, malId, discordId, displayName, voteType }) {
	db.prepare(
		`INSERT INTO votes (season_label, mal_id, discord_id, display_name, vote_type)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(season_label, mal_id, discord_id) DO UPDATE SET display_name = excluded.display_name, vote_type = excluded.vote_type`,
	).run(seasonLabel, malId, discordId, displayName, voteType);
}

function removeVote({ seasonLabel, malId, discordId }) {
	db.prepare(`DELETE FROM votes WHERE season_label = ? AND mal_id = ? AND discord_id = ?`).run(seasonLabel, malId, discordId);
}

function getWatchers({ seasonLabel, malId }) {
	const rows = db
		.prepare(`SELECT discord_id FROM votes WHERE season_label = ? AND mal_id = ? AND vote_type IN ('verde', 'naranja')`)
		.all(seasonLabel, malId);
	return rows.map((row) => row.discord_id);
}

// 'verde' si alguien ya dijo que lo va a ver, si no 'naranja' si alguien lo está pensando, si no null.
function getVoteState({ seasonLabel, malId }) {
	const row = db
		.prepare(
			`SELECT vote_type FROM votes WHERE season_label = ? AND mal_id = ?
			 ORDER BY CASE vote_type WHEN 'verde' THEN 0 WHEN 'naranja' THEN 1 ELSE 2 END LIMIT 1`,
		)
		.get(seasonLabel, malId);
	return row?.vote_type ?? null;
}

function setNotificationChannel({ guildId, channelId }) {
	db.prepare(
		`INSERT INTO notification_channels (guild_id, channel_id) VALUES (?, ?)
		 ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id`,
	).run(guildId, channelId);
}

function getNotificationChannel(guildId) {
	const row = db.prepare(`SELECT channel_id FROM notification_channels WHERE guild_id = ?`).get(guildId);
	return row?.channel_id ?? null;
}

function getAnimeAiringOn(dayLabel) {
	return db.prepare(`SELECT mal_id AS malId, season_label AS seasonLabel, guild_id AS guildId, title, url FROM anime WHERE broadcast_day = ?`).all(dayLabel);
}

function wasNotifiedToday({ seasonLabel, malId, dateKey }) {
	const row = db
		.prepare(`SELECT 1 FROM notified_episodes WHERE season_label = ? AND mal_id = ? AND notified_date = ?`)
		.get(seasonLabel, malId, dateKey);
	return Boolean(row);
}

function markNotifiedToday({ seasonLabel, malId, dateKey }) {
	db.prepare(`INSERT OR IGNORE INTO notified_episodes (season_label, mal_id, notified_date) VALUES (?, ?, ?)`).run(seasonLabel, malId, dateKey);
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
};
