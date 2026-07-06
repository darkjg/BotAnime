const { deleteSeasonTab, ensureSeasonTab, ensureAnimeColumn, setVote } = require('./services/sheets');
const { getAnimeForSeason, getVotesForSeason } = require('./services/db');

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
async function rebuildSeasonTab(seasonLabel) {
	await deleteSeasonTab(seasonLabel);
	await ensureSeasonTab(seasonLabel);

	const animeByMalId = new Map(getAnimeForSeason(seasonLabel).map((a) => [a.malId, a]));
	const votes = getVotesForSeason(seasonLabel);

	// El carryover (CONTINUAN) crea su columna aunque nadie haya votado todavía; el resto de los
	// animes solo tiene columna si alguien votó verde/naranja por ellos.
	for (const anime of animeByMalId.values()) {
		if (!anime.isCarryover) continue;
		await ensureAnimeColumn(seasonLabel, anime);
		await sleep(THROTTLE_MS);
	}

	let votesApplied = 0;
	for (const vote of votes) {
		if (vote.voteType === 'rojo') continue;
		const anime = animeByMalId.get(vote.malId);
		if (!anime) continue;
		await setVote(seasonLabel, vote.displayName, anime, vote.voteType);
		votesApplied += 1;
		await sleep(THROTTLE_MS);
	}

	return { animeCount: animeByMalId.size, votesApplied };
}

module.exports = { rebuildSeasonTab };
