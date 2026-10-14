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

-- Copia local de los gifs de reacciones (/reaccion) sincronizados desde la base de otro bot, Aurora
-- (ver auroraSync.js). Mismo esquema que la tabla reaction_gifs real de Aurora: el PRIMARY KEY
-- (accion, url) es lo que garantiza que un sync nunca inserte un gif duplicado, sin necesitar
-- rastrear "qué es nuevo" a mano (Aurora no tiene columna de fecha/id para eso).
CREATE TABLE IF NOT EXISTS reaction_gifs (
  accion  TEXT NOT NULL,
  url     TEXT NOT NULL,
  PRIMARY KEY (accion, url)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_reaction_gifs_accion ON reaction_gifs(accion);

-- Además de URLs, Aurora tiene reacciones con archivos subidos directo al dashboard (no quedan en
-- reaction_gifs, solo en el filesystem del lado de Aurora — ver auroraSync.js). Se guardan acá como
-- base64 en la propia base (a diferencia de reaction_gifs, no hay una URL pública para mostrar, hay
-- que mandarlos como adjunto de Discord).
CREATE TABLE IF NOT EXISTS reaction_gif_files (
  accion    TEXT NOT NULL,
  fileName  TEXT NOT NULL,
  mimeType  TEXT NOT NULL,
  data      TEXT NOT NULL,
  PRIMARY KEY (accion, fileName)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_reaction_gif_files_accion ON reaction_gif_files(accion);

-- Qué tan reciente es la última vez que se revisaron los archivos locales de una acción (aparte de las
-- URLs, que se sincronizan enteras cada vez porque son baratas). Revisar archivos implica un pedido
-- HTTP aparte por acción (Aurora lee su filesystem y base64-codifica cada archivo, ver
-- listReactionGifsFull en BotQueryServer.js) — no conviene hacerlo para las ~90+ acciones en cada
-- sync, así que cada vuelta se revisa solo un lote chico, empezando por las menos revisadas.
CREATE TABLE IF NOT EXISTS reaction_file_sync_state (
  accion         TEXT PRIMARY KEY,
  lastCheckedAt  INTEGER NOT NULL DEFAULT 0
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

-- Id interno de animeav1 por malId (ver getMediaId en animeav1.js) — NO sale en ninguna URL, solo en
-- el bloque de datos de la ficha, así que se guarda la primera vez que se pide en vez de releerlo
-- siempre. Sirve para identificar qué anime es un archivo descargado de animeav1 a partir de su
-- nombre de archivo ("<av1MediaId>_<capitulo>_SUB"), sin depender de que el nombre tenga el título.
CREATE TABLE IF NOT EXISTS av1_media_ids (
  malId       INTEGER PRIMARY KEY,
  av1MediaId  INTEGER NOT NULL UNIQUE
) STRICT;

-- Token personal por persona para el vigilante de VLC (ver watchServer.js y /vlc-watcher-token): su
-- programa local, corriendo en SU PC (no en la LAN del bot), lo manda por HTTPS público para decir
-- "acabo de ver tal capítulo". El token es lo único que demuestra quién es sin pedirle login de
-- Discord de verdad — por eso es largo y aleatorio, no un PIN corto.
CREATE TABLE IF NOT EXISTS watch_tokens (
  discordId     TEXT PRIMARY KEY,
  token         TEXT NOT NULL UNIQUE,
  createdAt     INTEGER NOT NULL,
  -- Si está en 1, cuando esta persona marque un capítulo visto sin estar conectada a ningún canal
  -- de voz (ver watchServer.js), el aviso de cortesía le llega por DM en vez de publicarse (aunque
  -- sea un segundo) en el canal de avisos del server. Por defecto 0: se mantiene el comportamiento
  -- de siempre, publicar en el canal.
  avisoPrivado  INTEGER NOT NULL DEFAULT 0
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

	// Mismo caso: watch_tokens ya existía (desde antes de la preferencia de aviso privado) en la base de
	// la Pi sin esta columna.
	const columnasWatchTokens = db.prepare('PRAGMA table_info(watch_tokens)').all().map((c) => c.name);
	if (!columnasWatchTokens.includes('avisoPrivado')) db.exec('ALTER TABLE watch_tokens ADD COLUMN avisoPrivado INTEGER NOT NULL DEFAULT 0');
}

module.exports = { SCHEMA_SQL, applySchema };
