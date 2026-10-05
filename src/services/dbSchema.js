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

-- Interruptor de /link-fix por sitio (tiktok, instagram, reddit...). 'x' NO va acá: sigue usando
-- guild_settings.linkFixEnabled para no romper los servidores que ya lo tenían activado.
CREATE TABLE IF NOT EXISTS link_fix_sites (
  guildId TEXT NOT NULL,
  site    TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guildId, site)
) STRICT;

-- Estado suelto del bot que no es de ningún servidor (clave/valor): modo respaldo de animeav1, cuándo
-- se le preguntó al dueño por MD, etc.
CREATE TABLE IF NOT EXISTS bot_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- Periodos de vacaciones de Grebe (/vacaciones): pisan el ciclo de 9 semanas de /horario-grebe. Fechas
-- como 'YYYY-MM-DD' (ambas incluidas). Los periodos que se solapan o quedan pegados se unen al guardar.
CREATE TABLE IF NOT EXISTS vacaciones_grebe (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  desde     TEXT NOT NULL,
  hasta     TEXT NOT NULL,
  creadoPor TEXT NOT NULL,
  creadoEn  INTEGER NOT NULL
) STRICT;

-- Foro de cada temporada (categoría "animes"): un foro por temporada, que se conserva al publicar la
-- siguiente en vez de vaciarse. guild_settings.forumChannelId sigue apuntando al de la temporada más reciente.
CREATE TABLE IF NOT EXISTS season_forums (
  guildId     TEXT NOT NULL,
  seasonLabel TEXT NOT NULL,
  channelId   TEXT NOT NULL,
  PRIMARY KEY (guildId, seasonLabel)
) STRICT;

-- Quedadas (/quedada): un día y hora para ver un anime juntos. fecha/hora son de Madrid; startsAt es esa
-- misma ocurrencia en ms epoch. En las semanales, al empezar una ocurrencia se avanza fecha/startsAt a la
-- semana siguiente y se reinician hourSent/startSent (recordatorio de 1 hora y aviso de inicio ya enviados).
CREATE TABLE IF NOT EXISTS quedadas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId     TEXT NOT NULL,
  seasonLabel TEXT NOT NULL,
  malId       INTEGER NOT NULL,
  title       TEXT NOT NULL,
  fecha       TEXT NOT NULL,
  hora        TEXT NOT NULL,
  startsAt    INTEGER NOT NULL,
  weekly      INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  createdBy   TEXT NOT NULL,
  createdAt   INTEGER NOT NULL,
  hourSent    INTEGER NOT NULL DEFAULT 0,
  startSent   INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Avisos de episodios nuevos ya armados (links, magnet, portada) y guardados a la espera de la ventana
-- horaria de avisos, para poder mandarlos aunque animeav1 no responda en ese momento (bloqueos por
-- partidos). payload es JSON. Solo se llena con el modo respaldo activo.
CREATE TABLE IF NOT EXISTS av1_pending_notices (
  guildId     TEXT NOT NULL,
  seasonLabel TEXT NOT NULL,
  malId       INTEGER NOT NULL,
  episode     INTEGER NOT NULL,
  payload     TEXT NOT NULL,
  createdAt   INTEGER NOT NULL,
  PRIMARY KEY (guildId, seasonLabel, malId, episode)
) STRICT;

-- Apodo de un anime (/apodo), por malId — NO por temporada/guild: un apodo puesto una vez sigue
-- aplicando aunque el anime vuelva en otra temporada (carryover) o vuelva a votarse más adelante.
-- Deliberadamente separado de anime.title: ese campo lo sigue usando el cruce contra animeav1.com
-- (checkAndNotifyAv1 en scheduler.js compara títulos normalizados) y NO puede reemplazarse por el
-- apodo sin romper esa detección. El apodo solo se aplica al momento de MOSTRAR el anime (hilo, embed,
-- comandos, sheet), nunca en la lógica interna de emparejamiento.
CREATE TABLE IF NOT EXISTS anime_nicknames (
  malId     INTEGER PRIMARY KEY,
  nickname  TEXT NOT NULL,
  setBy     TEXT,
  setAt     INTEGER NOT NULL
) STRICT;

-- Conteo de partidas de Yumi (LoL) de pegu (/yumi): una fila por partida, así se puede deshacer la
-- última y sacar totales sin depender de un contador suelto que pueda desincronizarse.
CREATE TABLE IF NOT EXISTS yumi_games (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  won  INTEGER NOT NULL,
  at   INTEGER NOT NULL
) STRICT;

-- Recordatorios personales (/recordatorio): dueAt en ms epoch, se avisa en el mismo canal donde se
-- creó mencionando a quien lo pidió. notified se pone en 1 justo antes de mandar el aviso (no se borra
-- la fila al toque) para poder distinguir "ya se mandó" de "se perdió el intento" si algo falla a mitad.
-- repeatEveryMs (NULL = no se repite): cada cuántos ms se vuelve a avisar; un recordatorio repetido nunca
-- pasa a notified=1 al avisar, en su lugar se mueve dueAt a la siguiente ocurrencia (ver remindersService.js).
CREATE TABLE IF NOT EXISTS reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId     TEXT NOT NULL,
  channelId   TEXT NOT NULL,
  discordId   TEXT NOT NULL,
  displayName TEXT NOT NULL,
  message     TEXT NOT NULL,
  dueAt       INTEGER NOT NULL,
  createdAt   INTEGER NOT NULL,
  notified    INTEGER NOT NULL DEFAULT 0,
  repeatEveryMs INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(notified, dueAt);
`;

function applySchema(db) {
	db.exec(SCHEMA_SQL);

	// CREATE TABLE IF NOT EXISTS no toca una tabla que ya existe, así que una base creada antes de que
	// hubiera recordatorios repetidos (la del Pi) no recibiría la columna nueva solo con el SCHEMA_SQL de
	// arriba: se añade a mano una vez, y en los arranques siguientes ya está y esto no hace nada.
	const columnasReminders = db.prepare('PRAGMA table_info(reminders)').all().map((c) => c.name);
	if (!columnasReminders.includes('repeatEveryMs')) db.exec('ALTER TABLE reminders ADD COLUMN repeatEveryMs INTEGER');
}

module.exports = { SCHEMA_SQL, applySchema };
