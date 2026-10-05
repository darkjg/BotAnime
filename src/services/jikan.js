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

// Jikan (la API no oficial de MyAnimeList) se cae seguido: sus 502/503/504 y los cortes de red suelen durar
// segundos, así que se reintenta con espera antes de rendirse. Las consultas de un solo anime (que pueden
// venir de un botón) esperan poco; la lista completa de una temporada, que se pide desde un comando ya
// diferido, espera bastante más.
const ESPERAS_CORTAS_MS = [1_500, 4_000];
const ESPERAS_TEMPORADA_MS = [3_000, 6_000, 12_000, 20_000, 30_000];
const ESTADOS_TRANSITORIOS = new Set([500, 502, 503, 504]);

// Sin timeout explícito, un fetch() a secas puede quedarse colgado varios minutos cuando la conexión
// se cae del todo (visto en vivo 2026-10-04: ni siquiera llega a abrirse la conexión TCP) en vez de
// fallar rápido — eso multiplicado por los reintentos de abajo podía convertir "Jikan no responde"
// en un bloqueo de 20+ minutos antes de caer al respaldo de AniList. 20s por intento es margen de
// sobra para una respuesta lenta pero real; si no contesta en eso, mejor que el reintento (o el
// respaldo de AniList) se encargue a que siga esperando a ciegas.
const TIMEOUT_PETICION_MS = 20_000;

// Solo para las pruebas: permite cambiar la espera y la forma de pedir sin esperar de verdad.
const ajustes = { dormir: sleep, pedir: (url) => fetch(url, { signal: AbortSignal.timeout(TIMEOUT_PETICION_MS) }) };

async function jikanGet(path, { esperas = ESPERAS_CORTAS_MS } = {}) {
	let reintentos = 0;
	for (;;) {
		let res;
		try {
			res = await ajustes.pedir(`${BASE_URL}${path}`);
		} catch (err) {
			if (reintentos >= esperas.length) throw err;
			await ajustes.dormir(esperas[reintentos++]);
			continue;
		}
		if (res.status === 429) {
			await ajustes.dormir(1500);
			continue;
		}
		if (ESTADOS_TRANSITORIOS.has(res.status) && reintentos < esperas.length) {
			await ajustes.dormir(esperas[reintentos++]);
			continue;
		}
		if (!res.ok) {
			throw new Error(`Jikan request failed (${res.status}): ${path}`);
		}
		return res.json();
	}
}

// Cada vez más series de temporada salen catalogadas como ONA en vez de TV (las de plataformas de
// streaming: Edgerunners 2, JoJo SBR, Yasei no Last Boss 2nd Season...). Pidiendo solo "tv" se caían
// de la lista sin avisar. El `filter` de Jikan acepta un valor por llamada, así que se pide uno por
// formato y se unifica después. Tampoco se piden movie/ova/special: no son series semanales de
// temporada y meterían ruido al foro. tv_short SÍ se pide (a petición expresa, 2026-10-04: caso real
// "Dark Summoner to Dekiteiru" catalogado como TV_SHORT que se quedaba fuera sin esto).
const FORMATOS_TEMPORADA = ['tv', 'ona', 'tv_short'];

async function fetchSeasonPath(path) {
	const anime = [];

	for (const filtro of FORMATOS_TEMPORADA) {
		const sep = path.includes('?') ? '&' : '?';
		let page = 1;
		let hasNextPage = true;

		while (hasNextPage) {
			const data = await jikanGet(`${path}${sep}filter=${filtro}&page=${page}`, { esperas: ESPERAS_TEMPORADA_MS });
			anime.push(...data.data);
			hasNextPage = data.pagination?.has_next_page ?? false;
			page += 1;
			if (hasNextPage) await sleep(400);
		}
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

function mergeSeasonAnimeEntries(primaryList, fallbackList) {
	const byMalId = new Map();
	for (const entry of [...primaryList, ...fallbackList]) {
		if (!entry?.malId && !entry?.idMal) continue;
		const malId = Number(entry.malId ?? entry.idMal);
		if (!Number.isFinite(malId)) continue;

		const current = byMalId.get(malId);
		byMalId.set(malId, current ? {
			...fallbackList.find((it) => Number(it.malId ?? it.idMal) === malId) ?? {},
			...current,
			...entry,
			malId,
		} : {
			...entry,
			malId,
		});
	}

	return [...byMalId.values()].map((entry) => ({
		malId: Number(entry.malId ?? entry.idMal),
		title: entry.title ?? entry.titleEnglish ?? entry.title_english ?? null,
		titleEnglish: entry.titleEnglish ?? entry.title_english ?? null,
		synopsis: entry.synopsis ?? null,
		imageUrl: entry.imageUrl ?? entry.coverImage?.extraLarge ?? entry.coverImage?.large ?? null,
		episodes: entry.episodes ?? null,
		broadcastDay: entry.broadcastDay ?? null,
		studios: entry.studios ?? null,
		url: entry.url ?? `https://myanimelist.net/anime/${entry.malId ?? entry.idMal}`,
		season: entry.season ?? null,
		year: entry.year ?? null,
		isSequel: Boolean(entry.isSequel),
	}));
}

// Plan B cuando Jikan está caído: AniList (GraphQL, otra infraestructura). Trae el id de MAL (idMal), así que
// los animes son los mismos y todo lo demás (hoja, hilos, votos) sigue funcionando con malId.
const ANILIST_URL = 'https://graphql.anilist.co';
const ANILIST_QUERY = `query ($season: MediaSeason, $year: Int, $page: Int) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage }
    media(season: $season, seasonYear: $year, type: ANIME, format_in: [TV, ONA, TV_SHORT], sort: POPULARITY_DESC) {
      idMal title { romaji english } description(asHtml: false) coverImage { extraLarge large }
      episodes studios(isMain: true) { nodes { name } } season seasonYear
      nextAiringEpisode { airingAt }
    }
  }
}`;

ajustes.pedirAniList = (variables) => fetch(ANILIST_URL, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
	body: JSON.stringify({ query: ANILIST_QUERY, variables }),
	signal: AbortSignal.timeout(TIMEOUT_PETICION_MS),
});

function diaEmision(airingAt) {
	if (!airingAt) return null;
	const dia = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'Asia/Tokyo' }).format(new Date(airingAt * 1000));
	return DAY_TO_ES[`${dia}s`] ?? null;
}

async function fetchSeasonAniList(year, season) {
	const media = [];
	for (let page = 1; ; page++) {
		let res;
		for (let intento = 0; ; intento++) {
			res = await ajustes.pedirAniList({ season: season.toUpperCase(), year: Number(year), page });
			if ((res.status === 429 || res.status >= 500) && intento < 2) { await ajustes.dormir(2_000 * (intento + 1)); continue; }
			break;
		}
		if (!res.ok) throw new Error(`AniList request failed (${res.status})`);
		const json = await res.json();
		if (json.errors) throw new Error(`AniList request failed: ${json.errors[0]?.message ?? 'error'}`);
		media.push(...json.data.Page.media);
		if (!json.data.Page.pageInfo.hasNextPage) break;
		await ajustes.dormir(700);
	}

	const unicos = [...new Map(media.filter((m) => m.idMal).map((m) => [m.idMal, m])).values()];
	return unicos.map((m) => ({
		malId: m.idMal,
		title: m.title.romaji ?? m.title.english,
		titleEnglish: m.title.english ?? null,
		synopsis: m.description ? m.description.replace(/<[^>]+>/g, '').trim() : null,
		imageUrl: m.coverImage?.extraLarge ?? m.coverImage?.large,
		episodes: m.episodes ?? null,
		broadcastDay: diaEmision(m.nextAiringEpisode?.airingAt),
		studios: (m.studios?.nodes ?? []).map((s) => s.name).join(', '),
		url: `https://myanimelist.net/anime/${m.idMal}`,
		season: m.season?.toLowerCase() ?? season,
		year: m.seasonYear ?? Number(year),
		isSequel: isSequel(m.title.romaji ?? '') || isSequel(m.title.english ?? ''),
	}));
}

// season en inglés: winter | spring | summer | fall
async function getSeasonAnime(year, season) {
	let jikanError = null;
	let jikanList = [];
	try {
		jikanList = await fetchSeasonPath(`/seasons/${year}/${season}`);
	} catch (err) {
		jikanError = err;
		console.error(`[jikan] falló (${err.message}); probando AniList`);
	}

	let anilistList = [];
	try {
		anilistList = await fetchSeasonAniList(year, season);
	} catch (err) {
		console.error('[anilist] también falló:', err.message);
	}

	const merged = mergeSeasonAnimeEntries(jikanList, anilistList);
	if (merged.length > 0) {
		const onlyJikan = jikanList.length > 0 && anilistList.length === 0;
		const onlyAniList = jikanList.length === 0 && anilistList.length > 0;
		const both = jikanList.length > 0 && anilistList.length > 0;
		if (onlyJikan) console.log(`[jikan] temporada ${year}/${season}: ${jikanList.length} resultados (sin AniList)`);
		if (onlyAniList) console.log(`[anilist] temporada ${year}/${season}: ${anilistList.length} resultados (fallback completo)`);
		if (both) console.log(`[merge] temporada ${year}/${season}: ${jikanList.length} de Jikan + ${anilistList.length} de AniList -> ${merged.length} únicos`);
		return merged;
	}

	if (jikanError) throw jikanError;
	throw new Error(`No se pudo cargar la temporada ${year}/${season} ni desde Jikan ni desde AniList`);
}

const prequelCache = new Map();

// Señal más fiable que el título: ¿este anime tiene una precuela registrada en MAL?
// (cubre casos como "Attack on Titan: The Final Season", que no dice "2nd Season").
async function hasPrequel(malId) {
	if (prequelCache.has(malId)) return prequelCache.get(malId);

	let result;
	try {
		const data = await jikanGet(`/anime/${malId}/relations`);
		result = (data.data ?? []).some((rel) => rel.relation.toLowerCase() === 'prequel');
	} catch {
		// Si Jikan falla no se sabe: se asume que no y se sigue, pero SIN guardarlo, para que la próxima vez se
		// vuelva a preguntar (guardado, marcaría mal la sección de la sheet hasta el próximo reinicio).
		return false;
	}

	prequelCache.set(malId, result);
	return result;
}

// Jikan casi nunca sabe cuándo termina un anime que se está emitiendo (aired.to null, a veces sin nº de
// episodios); AniList sí: estado, total de episodios y cuándo sale el próximo. Se usa para decidir si un anime
// sigue en la temporada siguiente. Devuelve null si AniList no responde o no lo conoce.
const ANILIST_MEDIA_QUERY = `query ($id: Int) { Media(idMal: $id, type: ANIME) { status episodes nextAiringEpisode { episode airingAt } } }`;

ajustes.pedirAniListMedia = (id) => fetch(ANILIST_URL, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
	body: JSON.stringify({ query: ANILIST_MEDIA_QUERY, variables: { id } }),
	signal: AbortSignal.timeout(TIMEOUT_PETICION_MS),
});

async function getAniListEmision(malId) {
	try {
		const res = await ajustes.pedirAniListMedia(malId);
		if (!res.ok) return null;
		const media = (await res.json()).data?.Media;
		if (!media) return null;
		const siguiente = media.nextAiringEpisode;
		// Último episodio = el próximo que sale + los que faltan después (uno por semana).
		const ultimoEpisodioMs = siguiente && media.episodes
			? siguiente.airingAt * 1000 + Math.max(0, media.episodes - siguiente.episode) * 7 * 24 * 60 * 60 * 1000
			: null;
		return { status: media.status, episodes: media.episodes ?? null, ultimoEpisodioMs };
	} catch {
		return null;
	}
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
		airedTo: entry.aired?.to ?? null,
		airedFrom: entry.aired?.from ?? null,
		episodes: entry.episodes ?? null,
		anilist: await getAniListEmision(entry.mal_id),
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

module.exports = { getSeasonAnime, getTrailers, hasPrequel, getAnimeById, getAniListEmision, jikanGet, ajustes, ESPERAS_CORTAS_MS, ESPERAS_TEMPORADA_MS };
