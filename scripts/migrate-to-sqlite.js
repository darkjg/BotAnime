// Migración de una sola corrida: botanime.json (JSON plano viejo) -> botanime.sqlite (nueva fuente de
// verdad). Se corre a mano ANTES de desplegar el db.js nuevo (que ya asume que botanime.sqlite existe y
// se niega a arrancar si no está) — nunca se corre sola desde el arranque del bot, a propósito: el
// dueño del proyecto revisa el resumen de conteos antes de que el bot dependa de la base migrada.
//
// botanime.json NUNCA se toca ni se borra acá: queda como respaldo intacto, y es lo que sigue usando la
// versión vieja del bot (con el db.js de JSON) si hace falta un rollback.
//
// Uso: node scripts/migrate-to-sqlite.js
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { applySchema } = require('../src/services/dbSchema');

const ROOT = path.join(__dirname, '..');
const JSON_PATH = path.join(ROOT, 'botanime.json');
const FINAL_SQLITE_PATH = path.join(ROOT, 'botanime.sqlite');
const TMP_SQLITE_PATH = path.join(ROOT, 'botanime.sqlite.tmp');

const toBit = (value) => (value ? 1 : 0);

// Tolera el mismo formato viejo que el db.js de JSON toleraba (antes de agregar detectedAt, la entrada
// era directamente el número de episodio, sin fecha). No debería quedar ninguna así en producción a
// esta altura, pero es gratis mantenerlo acá para una migración de una sola vez.
function readAv1Entry(raw) {
	if (raw == null) return { episode: 0, detectedAt: null };
	if (typeof raw === 'number') return { episode: raw, detectedAt: null };
	return { episode: raw.episode ?? 0, detectedAt: raw.detectedAt ?? null };
}

function main() {
	if (!fs.existsSync(JSON_PATH)) {
		console.error(`No encontré ${JSON_PATH}. Nada que migrar.`);
		process.exit(1);
	}
	if (fs.existsSync(FINAL_SQLITE_PATH)) {
		console.error(`Ya existe ${FINAL_SQLITE_PATH}. Si de verdad querés volver a migrar, borralo/renombralo primero a mano.`);
		process.exit(1);
	}
	if (fs.existsSync(TMP_SQLITE_PATH)) fs.rmSync(TMP_SQLITE_PATH);

	const store = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
	const counts = {
		anime: Object.keys(store.anime ?? {}).length,
		votes: Object.keys(store.votes ?? {}).length,
		progress: Object.keys(store.progress ?? {}).length,
		av1NotifiedEpisodes: Object.keys(store.av1NotifiedEpisodes ?? {}).length,
		av1ForumThreads: Object.keys(store.av1ForumThreads ?? {}).length,
		episodeLinkMessages: Object.keys(store.episodeLinkMessages ?? {}).length,
	};

	const db = new DatabaseSync(TMP_SQLITE_PATH);
	db.exec('PRAGMA journal_mode = WAL');
	applySchema(db);

	const insertAnime = db.prepare(`
		INSERT INTO anime (guildId, seasonLabel, malId, title, url, imageUrl, broadcastDay, isSequel, isCarryover, isAbandoned, slug)
		VALUES (@guildId, @seasonLabel, @malId, @title, @url, @imageUrl, @broadcastDay, @isSequel, @isCarryover, @isAbandoned, @slug)
	`);
	const insertVote = db.prepare(`INSERT INTO votes (seasonLabel, malId, discordId, displayName, voteType) VALUES (?, ?, ?, ?, ?)`);
	const insertProgress = db.prepare(`INSERT INTO progress (seasonLabel, malId, discordId, displayName, episodesWatched) VALUES (?, ?, ?, ?, ?)`);
	const insertAv1Entry = db.prepare(`INSERT INTO av1_notified_episodes (guildId, seasonLabel, malId, episode, detectedAt) VALUES (?, ?, ?, ?, ?)`);
	const insertAv1Thread = db.prepare(`INSERT INTO av1_forum_threads (guildId, seasonLabel, malId, threadId) VALUES (?, ?, ?, ?)`);
	const insertEpisodeLinkMessage = db.prepare(`
		INSERT INTO episode_link_messages (guildId, seasonLabel, malId, episode, title, slug, threadId, messageId, providers, hasErai, postedAt)
		VALUES (@guildId, @seasonLabel, @malId, @episode, @title, @slug, @threadId, @messageId, @providers, @hasErai, @postedAt)
	`);
	const upsertGuildSettingCol = (guildId, column, value) =>
		db
			.prepare(`INSERT INTO guild_settings (guildId, ${column}) VALUES (?, ?) ON CONFLICT (guildId) DO UPDATE SET ${column} = excluded.${column}`)
			.run(guildId, value);

	db.exec('BEGIN');
	try {
		for (const anime of Object.values(store.anime ?? {})) {
			insertAnime.run({
				guildId: anime.guildId,
				seasonLabel: anime.seasonLabel,
				malId: anime.malId,
				title: anime.title ?? null,
				url: anime.url ?? null,
				imageUrl: anime.imageUrl ?? null,
				broadcastDay: anime.broadcastDay ?? null,
				isSequel: toBit(anime.isSequel),
				isCarryover: toBit(anime.isCarryover),
				isAbandoned: toBit(anime.isAbandoned),
				slug: anime.slug ?? null,
			});
		}

		let skippedVotes = 0;
		for (const vote of Object.values(store.votes ?? {})) {
			if (vote.voteType !== 'verde' && vote.voteType !== 'naranja') {
				skippedVotes += 1; // no debería pasar (rojo nunca se guardaba), pero no abortar la migración por esto
				continue;
			}
			insertVote.run(vote.seasonLabel, vote.malId, vote.discordId, vote.displayName ?? null, vote.voteType);
		}
		if (skippedVotes > 0) console.log(`(aviso) ${skippedVotes} voto(s) con voteType inesperado, no migrados`);

		for (const p of Object.values(store.progress ?? {})) {
			insertProgress.run(p.seasonLabel, p.malId, p.discordId, p.displayName ?? null, p.episodesWatched ?? 0);
		}

		let skippedAv1Entries = 0;
		for (const [key, raw] of Object.entries(store.av1NotifiedEpisodes ?? {})) {
			const parts = key.split('::');
			// Huérfanos de un formato de clave anterior a que se agregara guildId (2 partes en vez de 3):
			// ya son inalcanzables por el código actual (av1NotifiedKey siempre arma 3 partes), no hace
			// falta migrarlos.
			if (parts.length !== 3) {
				skippedAv1Entries += 1;
				continue;
			}
			const [guildId, seasonLabel, malIdStr] = parts;
			const { episode, detectedAt } = readAv1Entry(raw);
			insertAv1Entry.run(guildId, seasonLabel, Number(malIdStr), episode, detectedAt);
		}
		if (skippedAv1Entries > 0) console.log(`(aviso) ${skippedAv1Entries} entrada(s) de av1NotifiedEpisodes con clave vieja (sin guildId), no migradas`);

		let skippedAv1Threads = 0;
		for (const [key, threadId] of Object.entries(store.av1ForumThreads ?? {})) {
			const parts = key.split('::');
			if (parts.length !== 3) {
				skippedAv1Threads += 1;
				continue;
			}
			const [guildId, seasonLabel, malIdStr] = parts;
			insertAv1Thread.run(guildId, seasonLabel, Number(malIdStr), threadId);
		}
		if (skippedAv1Threads > 0) console.log(`(aviso) ${skippedAv1Threads} entrada(s) de av1ForumThreads con clave vieja (sin guildId), no migradas`);

		for (const msg of Object.values(store.episodeLinkMessages ?? {})) {
			insertEpisodeLinkMessage.run({
				guildId: msg.guildId,
				seasonLabel: msg.seasonLabel,
				malId: msg.malId,
				episode: msg.episode,
				title: msg.title ?? null,
				slug: msg.slug ?? null,
				threadId: msg.threadId ?? null,
				messageId: msg.messageId ?? null,
				providers: JSON.stringify(msg.providers ?? []),
				hasErai: toBit(msg.hasErai),
				postedAt: msg.postedAt ?? Date.now(),
			});
		}

		// Consolida las 6 config por-guild en guild_settings, combinando lo que haya en cada mapa por guildId.
		const guildIds = new Set([
			...Object.keys(store.activeSeasons ?? {}),
			...Object.keys(store.notificationChannels ?? {}),
			...Object.keys(store.forumChannels ?? {}),
			...Object.keys(store.voteRoles ?? {}),
			...Object.keys(store.notifyWindows ?? {}),
			...Object.keys(store.linkFixEnabled ?? {}),
		]);
		for (const guildId of guildIds) {
			if (store.activeSeasons?.[guildId] != null) upsertGuildSettingCol(guildId, 'activeSeasonLabel', store.activeSeasons[guildId]);
			if (store.notificationChannels?.[guildId] != null) upsertGuildSettingCol(guildId, 'notificationChannelId', store.notificationChannels[guildId]);
			if (store.voteRoles?.[guildId] != null) upsertGuildSettingCol(guildId, 'voteRoleId', store.voteRoles[guildId]);
			if (store.linkFixEnabled?.[guildId] != null) upsertGuildSettingCol(guildId, 'linkFixEnabled', toBit(store.linkFixEnabled[guildId]));
			const forum = store.forumChannels?.[guildId];
			if (forum) {
				db.prepare(
					`INSERT INTO guild_settings (guildId, forumChannelId, forumSeasonLabel) VALUES (?, ?, ?)
					 ON CONFLICT (guildId) DO UPDATE SET forumChannelId = excluded.forumChannelId, forumSeasonLabel = excluded.forumSeasonLabel`,
				).run(guildId, forum.channelId, forum.seasonLabel);
			}
			const window = store.notifyWindows?.[guildId];
			if (window) {
				db.prepare(
					`INSERT INTO guild_settings (guildId, notifyStartHour, notifyEndHour) VALUES (?, ?, ?)
					 ON CONFLICT (guildId) DO UPDATE SET notifyStartHour = excluded.notifyStartHour, notifyEndHour = excluded.notifyEndHour`,
				).run(guildId, window.startHour, window.endHour);
			}
		}

		// seasons queda vacía a propósito: no hay forma de derivar el historial completo de "temporada
		// anterior" desde el JSON sin volver a leer el orden de pestañas de la Sheet, y no hace falta — se
		// puebla sola desde el próximo /temporada-foro (ver recordSeasonHistory en db.js).

		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		db.close();
		fs.rmSync(TMP_SQLITE_PATH, { force: true });
		console.error('Migración abortada, no se creó ningún archivo final:', err);
		process.exit(1);
	}

	// Verificación de conteos antes de confirmar.
	const finalCounts = {
		anime: db.prepare('SELECT COUNT(*) AS n FROM anime').get().n,
		votes: db.prepare('SELECT COUNT(*) AS n FROM votes').get().n,
		progress: db.prepare('SELECT COUNT(*) AS n FROM progress').get().n,
		av1NotifiedEpisodes: db.prepare('SELECT COUNT(*) AS n FROM av1_notified_episodes').get().n,
		av1ForumThreads: db.prepare('SELECT COUNT(*) AS n FROM av1_forum_threads').get().n,
		episodeLinkMessages: db.prepare('SELECT COUNT(*) AS n FROM episode_link_messages').get().n,
	};
	db.close();

	// votes/av1NotifiedEpisodes/av1ForumThreads pueden migrar MENOS que el conteo origen si había entradas
	// con formato de clave viejo/inválido (huérfanas, ya inalcanzables por el código actual) — no es un
	// error, se loguea aparte arriba. El resto de las tablas tiene que coincidir exacto.
	const canBeFewer = new Set(['votes', 'av1NotifiedEpisodes', 'av1ForumThreads']);
	console.log('Conteos origen (JSON) vs destino (SQLite):');
	let mismatch = false;
	for (const table of Object.keys(counts)) {
		const ok = canBeFewer.has(table) ? finalCounts[table] <= counts[table] : finalCounts[table] === counts[table];
		if (!ok) mismatch = true;
		console.log(`  ${table}: ${counts[table]} -> ${finalCounts[table]} ${ok ? 'OK' : '¡DISTINTO!'}`);
	}

	if (mismatch) {
		console.error('\nLos conteos no cuadran. Dejo el archivo temporal para inspección manual:', TMP_SQLITE_PATH);
		process.exit(1);
	}

	fs.renameSync(TMP_SQLITE_PATH, FINAL_SQLITE_PATH);
	console.log(`\nListo: ${FINAL_SQLITE_PATH} creado. botanime.json queda intacto como respaldo.`);
}

main();
