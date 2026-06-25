const animeByMalId = new Map();
const seasonLabelBySlug = new Map();
const seasonOrderBySlug = new Map();

function rememberAnime(anime) {
	animeByMalId.set(anime.malId, anime);
}

function getAnime(malId) {
	return animeByMalId.get(malId);
}

function rememberSeasonLabel(slug, label) {
	seasonLabelBySlug.set(slug, label);
}

function getSeasonLabel(slug) {
	return seasonLabelBySlug.get(slug);
}

function rememberSeasonOrder(slug, malIds) {
	seasonOrderBySlug.set(slug, malIds);
}

function getSeasonOrder(slug) {
	return seasonOrderBySlug.get(slug);
}

module.exports = { rememberAnime, getAnime, rememberSeasonLabel, getSeasonLabel, rememberSeasonOrder, getSeasonOrder };
