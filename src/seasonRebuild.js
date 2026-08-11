const { deleteSeasonTab, ensureSeasonTab, ensureAnimeColumn, setVote } = require('./services/sheets');
const { getAnimeForSeason, getVotesForSeason, getEpisodesWatched } = require('./services/db');

// Cada ensureAnimeColumn/setVote dispara varias llamadas de lectura a la API de Sheets (buscar
// columna, leer día de emisión, revisar huecos...). Reconstruir una temporada entera vota "de nuevo"
// cada voto guardado en secuencia, así que en una temporada con muchos votos ese ráfaga de lecturas
// alcanza fácil la cuota de "lecturas por minuto por usuario" de Sheets (lo vimos en pruebas reales:
// 15 votos ya la agotaban). Esta pausa entre cada voto/anime espacia las llamadas para no pegarle al
// límite; para el job diario automático es una demora aceptable.
const THROTTLE_MS = 20000;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Reconstruye la pestaña de una temporada desde cero, usando la base local (animes + votos) como
// única fuente de verdad en vez de ir parchando la estructura que ya existe en la sheet. Borra la
// pestaña entera (sin restos de merges/bordes/huecos de inserciones o reparaciones anteriores) y la
// vuelve a armar votando "de nuevo" cada voto guardado, en el mismo orden en que ensureAnimeColumn ya
// sabe ordenar por día de emisión.
async function rebuildSeasonTab(seasonLabel, guildId) {
	await deleteSeasonTab(seasonLabel);
	await ensureSeasonTab(seasonLabel);

	// getAnimeForSeason no filtra por guild: dos guilds pueden compartir la misma etiqueta de
	// temporada (hoy apuntan a la misma sheet, pero eso podría cambiar) y sin este filtro se
	// reconstruiría mezclando animes/metadata de ambos. getVotesForSeason tampoco tiene guildId (los
	// votos no lo guardan), pero al filtrar animeByMalId por guild alcanza: el loop de votos ya
	// descarta los que no tengan anime en el mapa (`if (!anime) continue`), así que solo se aplican
	// votos de animes que pertenecen a este guild.
	const animeByMalId = new Map(
		getAnimeForSeason(seasonLabel)
			.filter((a) => a.guildId === guildId)
			.map((a) => [a.malId, a]),
	);
	const votes = getVotesForSeason(seasonLabel);

	// El carryover (CONTINUAN) crea su columna aunque nadie haya votado todavía; lo mismo un abandonado
	// (por definición ya no tiene votos verde/naranja que lo recreen abajo, así que sin esto
	// desaparecería de la sheet en cada reconstrucción). El resto de los animes solo tiene columna si
	// alguien votó verde/naranja por ellos. El progreso por usuario que tenía la columna de un
	// abandonado (quién iba por qué capítulo cuando lo dejó) no se puede recuperar acá: esa info solo
	// vivía en la celda de la sheet, no en la base local (los votos se borran al abandonar), así que se
	// pierde en una reconstrucción igual que ya pasaba con cualquier voto ya retirado.
	for (const anime of animeByMalId.values()) {
		if (!anime.isCarryover && !anime.isAbandoned) continue;
		await ensureAnimeColumn(seasonLabel, anime);
		await sleep(THROTTLE_MS);
	}

	let votesApplied = 0;
	for (const vote of votes) {
		if (vote.voteType === 'rojo') continue;
		const anime = animeByMalId.get(vote.malId);
		if (!anime) continue;
		const episodesWatched = getEpisodesWatched({ seasonLabel, malId: vote.malId, discordId: vote.discordId });
		await setVote(seasonLabel, vote.displayName, anime, vote.voteType, episodesWatched);
		votesApplied += 1;
		await sleep(THROTTLE_MS);
	}

	return { animeCount: animeByMalId.size, votesApplied };
}

module.exports = { rebuildSeasonTab };
