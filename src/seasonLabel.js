const JIKAN_SEASON_TO_ES = {
	winter: 'Invierno',
	spring: 'Primavera',
	summer: 'Verano',
	fall: 'Otoño',
};

const ES_SEASON_TO_JIKAN = {
	invierno: 'winter',
	primavera: 'spring',
	verano: 'summer',
	otono: 'fall',
};

function defaultSeasonLabel(sampleAnimeEntry) {
	if (sampleAnimeEntry?.season && sampleAnimeEntry?.year) {
		const esSeason = JIKAN_SEASON_TO_ES[sampleAnimeEntry.season] ?? sampleAnimeEntry.season;
		return `${esSeason} ${sampleAnimeEntry.year}`;
	}

	const month = new Date().getMonth();
	const year = new Date().getFullYear();
	const esSeason = month <= 2 ? 'Invierno' : month <= 5 ? 'Primavera' : month <= 8 ? 'Verano' : 'Otoño';
	return `${esSeason} ${year}`;
}

function slugForCustomId(label) {
	return label.replace(/\s+/g, '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const JIKAN_SEASONS = ['winter', 'spring', 'summer', 'fall'];

// offset 0 = temporada actual, 1 = la siguiente, -1 = la anterior, etc.
function seasonAtOffset(offset, date = new Date()) {
	const month = date.getMonth();
	const currentIndex = month <= 2 ? 0 : month <= 5 ? 1 : month <= 8 ? 2 : 3;
	const totalIndex = currentIndex + offset;
	const year = date.getFullYear() + Math.floor(totalIndex / JIKAN_SEASONS.length);
	const seasonIndex = ((totalIndex % JIKAN_SEASONS.length) + JIKAN_SEASONS.length) % JIKAN_SEASONS.length;
	return { year, season: JIKAN_SEASONS[seasonIndex] };
}

function nextSeason(date = new Date()) {
	return seasonAtOffset(1, date);
}

module.exports = { defaultSeasonLabel, slugForCustomId, ES_SEASON_TO_JIKAN, JIKAN_SEASON_TO_ES, nextSeason, seasonAtOffset };
