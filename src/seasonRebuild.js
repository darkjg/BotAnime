const { deleteSeasonTab, ensureSeasonTab, ensureAnimeColumn, setVote, canonicalSeasonTabName } = require('./services/sheets');
const { conReintentoDeCuota } = require('./services/reintento');
const { getAnimeForSeason, getVotesForSeason, getEpisodesWatched, getDisplayTitle } = require('./services/db');

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
// onProgress({ hecho, total, fase, segundosPorPaso }) se llama al empezar y tras cada paso (columna o voto).
// Esperas ante el límite de lecturas de Google (se renueva cada minuto). Reconstruir borra la pestaña antes de
// rehacerla, así que si un paso falla por cuota a medias la hoja se queda vacía: cada paso reintenta bastante
// antes de rendirse.
const ESPERAS_CUOTA_RECONSTRUIR_MS = [20_000, 40_000, 60_000, 60_000, 60_000];

async function rebuildSeasonTab(seasonLabel, guildId, { onProgress = null, throttleMs = THROTTLE_MS, esperasCuota = ESPERAS_CUOTA_RECONSTRUIR_MS, dormirCuota } = {}) {
	const reintentar = (tarea) => conReintentoDeCuota(tarea, { esperas: esperasCuota, ...(dormirCuota ? { dormir: dormirCuota } : {}) });
	const avisar = (datos) => { try { onProgress?.({ segundosPorPaso: throttleMs / 1000, ...datos }); } catch { /* el aviso de progreso nunca debe romper la reconstrucción */ } };

	// Si la pestaña existe con otras mayúsculas hay que trabajar con SU nombre: borrarla y recrearla con
	// otra variante dejaría la pestaña real borrada y la nueva vacía, porque los animes y votos de la base
	// están indexados con la cadena original y no se encontrarían.
	seasonLabel = await reintentar(() => canonicalSeasonTabName(seasonLabel));

	await reintentar(() => deleteSeasonTab(seasonLabel));
	await reintentar(() => ensureSeasonTab(seasonLabel));

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
	const columnas = [...animeByMalId.values()].filter((a) => a.isCarryover || a.isAbandoned);
	const votosAAplicar = votes.filter((v) => v.voteType !== 'rojo' && animeByMalId.has(v.malId));
	const total = columnas.length + votosAAplicar.length;
	let hecho = 0;
	avisar({ hecho, total, fase: 'Pestaña recreada, colocando columnas...' });

	// El carryover (CONTINUAN) crea su columna aunque nadie haya votado todavía; lo mismo un abandonado
	// (por definición ya no tiene votos verde/naranja que lo recreen abajo, así que sin esto
	// desaparecería de la sheet en cada reconstrucción). El resto de los animes solo tiene columna si
	// alguien votó verde/naranja por ellos. El progreso por usuario que tenía la columna de un
	// abandonado (quién iba por qué capítulo cuando lo dejó) no se puede recuperar acá: esa info solo
	// vivía en la celda de la sheet, no en la base local (los votos se borran al abandonar), así que se
	// pierde en una reconstrucción igual que ya pasaba con cualquier voto ya retirado.
	for (const anime of columnas) {
		await reintentar(() => ensureAnimeColumn(seasonLabel, { ...anime, title: getDisplayTitle(anime) }));
		hecho += 1;
		avisar({ hecho, total, fase: `Columna: ${getDisplayTitle(anime)}` });
		await sleep(throttleMs);
	}

	let votesApplied = 0;
	for (const vote of votosAAplicar) {
		const anime = animeByMalId.get(vote.malId);
		const episodesWatched = getEpisodesWatched({ seasonLabel, malId: vote.malId, discordId: vote.discordId });
		await setVote(seasonLabel, vote.displayName, { ...anime, title: getDisplayTitle(anime) }, vote.voteType, episodesWatched);
		votesApplied += 1;
		hecho += 1;
		avisar({ hecho, total, fase: `Voto de ${vote.displayName}: ${getDisplayTitle(anime)}` });
		await sleep(throttleMs);
	}

	return { animeCount: animeByMalId.size, votesApplied };
}

module.exports = { rebuildSeasonTab };
