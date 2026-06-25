const BASE_URL = 'https://api.jikan.moe/v4';

const DAY_TO_ES = {
	Mondays: 'Lunes',
	Tuesdays: 'Martes',
	Wednesdays: 'Miércoles',
	Thursdays: 'Jueves',
	Fridays: 'Viernes',
	Saturdays: 'Sábado',
	Sundays: 'Domingo',
};

// Heurística: ¿el título indica que es la 2da/3ra/4ta... temporada de algo (una continuación)?
const SEQUEL_PATTERN = /\b(2nd|3rd|[4-9]th|\d{1,2}th)\s+Season\b|\bSeason\s*\d+\b|\bPart\s*\d+\b|\bCour\s*\d+\b/i;

function isSequel(title) {
	return SEQUEL_PATTERN.test(title);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jikanGet(path) {
	const res = await fetch(`${BASE_URL}${path}`);
	if (res.status === 429) {
		await sleep(1500);
		return jikanGet(path);
	}
	if (!res.ok) {
		throw new Error(`Jikan request failed (${res.status}): ${path}`);
	}
	return res.json();
}

async function fetchSeasonPath(path) {
	const anime = [];
	let page = 1;
	let hasNextPage = true;

	while (hasNextPage) {
		const data = await jikanGet(`${path}${path.includes('?') ? '&' : '?'}filter=tv&page=${page}`);
		anime.push(...data.data);
		hasNextPage = data.pagination?.has_next_page ?? false;
		page += 1;
		if (hasNextPage) await sleep(400);
	}

	const uniqueAnime = [...new Map(anime.map((entry) => [entry.mal_id, entry])).values()];

	return uniqueAnime.map((entry) => ({
		malId: entry.mal_id,
		title: entry.title,
		titleEnglish: entry.title_english,
		synopsis: entry.synopsis,
		imageUrl: entry.images?.jpg?.large_image_url,
		episodes: entry.episodes,
		broadcastDay: DAY_TO_ES[entry.broadcast?.day] ?? entry.broadcast?.day ?? null,
		studios: entry.studios?.map((s) => s.name).join(', '),
		url: entry.url,
		season: entry.season,
		year: entry.year,
		isSequel: isSequel(entry.title) || isSequel(entry.title_english ?? ''),
	}));
}

// season en inglés: winter | spring | summer | fall
async function getSeasonAnime(year, season) {
	return fetchSeasonPath(`/seasons/${year}/${season}`);
}

const prequelCache = new Map();

// Señal más fiable que el título: ¿este anime tiene una precuela registrada en MAL?
// (cubre casos como "Attack on Titan: The Final Season", que no dice "2nd Season").
async function hasPrequel(malId) {
	if (prequelCache.has(malId)) return prequelCache.get(malId);

	let result = false;
	try {
		const data = await jikanGet(`/anime/${malId}/relations`);
		result = (data.data ?? []).some((rel) => rel.relation.toLowerCase() === 'prequel');
	} catch {
		result = false;
	}

	prequelCache.set(malId, result);
	return result;
}

// Recurso completo de un anime (usado para revisar si sigue "Currently Airing" al
// comparar con la temporada anterior, y para tener título/imagen/url actualizados).
async function getAnimeById(malId) {
	const data = await jikanGet(`/anime/${malId}`);
	const entry = data.data;
	return {
		malId: entry.mal_id,
		title: entry.title,
		imageUrl: entry.images?.jpg?.large_image_url,
		broadcastDay: DAY_TO_ES[entry.broadcast?.day] ?? entry.broadcast?.day ?? null,
		url: entry.url,
		status: entry.status,
		isSequel: isSequel(entry.title) || isSequel(entry.title_english ?? ''),
	};
}

// Jikan suele devolver trailer.youtube_id en null aunque sí haya trailer; el id real
// queda únicamente dentro de embed_url (ej. ".../embed/8RF09G8Ymqg?..."), así que lo
// extraemos de ahí como respaldo.
function youtubeIdFromTrailer(trailer) {
	if (trailer?.youtube_id) return trailer.youtube_id;
	const match = trailer?.embed_url?.match(/\/embed\/([^?]+)/);
	return match?.[1] ?? null;
}

async function getTrailers(malId) {
	const data = await jikanGet(`/anime/${malId}/videos`);
	const promos = data.data?.promo ?? [];
	return promos
		.map((promo) => ({ title: promo.title || 'Trailer', youtubeId: youtubeIdFromTrailer(promo.trailer) }))
		.filter((promo) => promo.youtubeId)
		.map((promo) => ({ title: promo.title, url: `https://www.youtube.com/watch?v=${promo.youtubeId}` }));
}

module.exports = { getSeasonAnime, getTrailers, hasPrequel, getAnimeById };
