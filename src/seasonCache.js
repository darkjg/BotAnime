const fs = require('node:fs');
const path = require('node:path');
const { getAllAnime } = require('./services/db');
const { slugForCustomId } = require('./seasonLabel');

// Antes esto vivía solo en memoria (Maps), así que un reinicio del bot (deploy, crash, reboot del
// Pi) dejaba sin funcionar los botones de voto de todos los hilos ya publicados hasta volver a
// correr /temporada-foro. Guardándolo en disco igual que botanime.json, los botones viejos siguen
// andando después de un reinicio sin tener que re-publicar nada.
const CACHE_PATH = path.join(__dirname, '..', 'seasonCache.json');

function emptyState() {
	return { anime: {}, seasonLabels: {} };
}

// La primera vez que corre esta versión (todavía no existe seasonCache.json) no hay nada que leer en
// disco, pero botanime.json ya tiene guardado el título/url/imagen/día de emisión de cada anime
// publicado (ver upsertAnime en services/db.js). Reconstruimos la caché a partir de eso para que los
// botones de hilos ya publicados vuelvan a andar sin esperar a que alguien vote o se re-publique la
// temporada. Lo único que no se puede recuperar es la sinopsis/episodios/estudio (esos campos no se
// guardan en botanime.json); el embed simplemente los muestra como "Desconocido" si hace falta
// reconstruirlo.
function backfillFromDb() {
	const state = emptyState();
	const seasonLabels = new Set();

	for (const entry of getAllAnime()) {
		state.anime[entry.malId] = {
			malId: entry.malId,
			title: entry.title,
			url: entry.url,
			imageUrl: entry.imageUrl,
			broadcastDay: entry.broadcastDay,
			isSequel: entry.isSequel,
			isCarryover: entry.isCarryover,
		};
		seasonLabels.add(entry.seasonLabel);
	}

	for (const seasonLabel of seasonLabels) {
		state.seasonLabels[slugForCustomId(seasonLabel)] = seasonLabel;
	}

	const animeCount = Object.keys(state.anime).length;
	if (animeCount > 0) {
		console.log(`[seasonCache] no había seasonCache.json, reconstruyo desde botanime.json: ${animeCount} anime(s), ${seasonLabels.size} temporada(s)`);
	}
	return state;
}

function loadState() {
	if (!fs.existsSync(CACHE_PATH)) return backfillFromDb();
	try {
		return { ...emptyState(), ...JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) };
	} catch (err) {
		console.error(`No pude leer ${CACHE_PATH}, reconstruyo desde botanime.json:`, err.message);
		return backfillFromDb();
	}
}

const state = loadState();
save();

function save() {
	fs.writeFileSync(CACHE_PATH, JSON.stringify(state));
}

function rememberAnime(anime) {
	state.anime[anime.malId] = anime;
	save();
}

function getAnime(malId) {
	return state.anime[malId];
}

function rememberSeasonLabel(slug, label) {
	state.seasonLabels[slug] = label;
	save();
}

function getSeasonLabel(slug) {
	return state.seasonLabels[slug] ?? null;
}

module.exports = { rememberAnime, getAnime, rememberSeasonLabel, getSeasonLabel };
