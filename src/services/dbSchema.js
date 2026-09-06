// Esquema SQLite compartido entre db.js (que abre la base ya migrada, en cada arranque del bot) y
// scripts/migrate-to-sqlite.js (que crea la base desde cero a partir del botanime.json viejo). Vive
// en un módulo aparte para que los dos nunca puedan quedar desincronizados entre sí.
//
// notifiedEpisodes (un campo del store JSON viejo) no se migra: no tiene ningún getter/setter ni se usa
// en ningún otro archivo del proyecto, es una reliquia sin uso.
const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS anime (
  guildId       TEXT    NOT NULL,
  seasonLabel   TEXT    NOT NULL,
  malId         INTEGER NOT NULL,
  title         TEXT,
  url           TEXT,
  imageUrl      TEXT,
  broadcastDay  TEXT,
  isSequel      INTEGER NOT NULL DEFAULT 0,
  isCarryover   INTEGER NOT NULL DEFAULT 0,
  isAbandoned   INTEGER NOT NULL DEFAULT 0,
  slug          TEXT,
  PRIMARY KEY (guildId, seasonLabel, malId)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_anime_season_mal ON anime(seasonLabel, malId);

CREATE TABLE IF NOT EXISTS votes (
  seasonLabel  TEXT NOT NULL,
  malId        INTEGER NOT NULL,
  discordId    TEXT NOT NULL,
  displayName  TEXT,
  voteType     TEXT NOT NULL CHECK (voteType IN ('verde', 'naranja')),
  PRIMARY KEY (seasonLabel, malId, discordId)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_votes_season_discord ON votes(seasonLabel, discordId);

CREATE TABLE IF NOT EXISTS progress (
  seasonLabel      TEXT NOT NULL,
  malId            INTEGER NOT NULL,
  discordId        TEXT NOT NULL,
  displayName      TEXT,
  episodesWatched  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (seasonLabel, malId, discordId)
) STRICT;

CREATE TABLE IF NOT EXISTS av1_notified_episodes (
  guildId      TEXT NOT NULL,
  seasonLabel  TEXT NOT NULL,
  malId        INTEGER NOT NULL,
  episode      INTEGER NOT NULL,
  detectedAt   INTEGER,
  PRIMARY KEY (guildId, seasonLabel, malId)
) STRICT;

CREATE TABLE IF NOT EXISTS av1_forum_threads (
  guildId      TEXT NOT NULL,
  seasonLabel  TEXT NOT NULL,
  malId        INTEGER NOT NULL,
  threadId     TEXT NOT NULL,
  PRIMARY KEY (guildId, seasonLabel, malId)
) STRICT;

CREATE TABLE IF NOT EXISTS episode_link_messages (
  guildId      TEXT NOT NULL,
  seasonLabel  TEXT NOT NULL,
  malId        INTEGER NOT NULL,
  episode      INTEGER NOT NULL,
  title        TEXT,
  slug         TEXT,
  threadId     TEXT,
  messageId    TEXT,
  providers    TEXT NOT NULL DEFAULT '[]',
  hasErai      INTEGER NOT NULL DEFAULT 0,
  postedAt     INTEGER NOT NULL,
  PRIMARY KEY (guildId, seasonLabel, malId, episode)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_episode_link_messages_postedAt ON episode_link_messages(postedAt);

-- Reemplaza la lectura del orden de pestañas de la Sheet para decidir "temporada anterior"/carryover
-- (ver temporadaShared.js: recordSeasonHistory/getPreviousSeasonLabel).
CREATE TABLE IF NOT EXISTS seasons (
  guildId              TEXT NOT NULL,
  seasonLabel          TEXT NOT NULL,
  previousSeasonLabel  TEXT,
  createdAt            INTEGER NOT NULL,
  PRIMARY KEY (guildId, seasonLabel)
) STRICT;

-- Consolida las 6 configuraciones por-guild que antes eran mapas JSON independientes (activeSeasons,
-- notificationChannels, forumChannels, voteRoles, notifyWindows, linkFixEnabled).
CREATE TABLE IF NOT EXISTS guild_settings (
  guildId               TEXT PRIMARY KEY,
  activeSeasonLabel     TEXT,
  notificationChannelId TEXT,
  forumChannelId        TEXT,
  forumSeasonLabel      TEXT,
  voteRoleId            TEXT,
  notifyStartHour       INTEGER,
  notifyEndHour         INTEGER,
  linkFixEnabled        INTEGER NOT NULL DEFAULT 0
) STRICT;
`;

function applySchema(db) {
	db.exec(SCHEMA_SQL);
}

module.exports = { SCHEMA_SQL, applySchema };
