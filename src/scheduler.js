const { getAnimeAiringOn, getWatchers, getNotificationChannel, wasNotifiedToday, markNotifiedToday } = require('./services/db');

const ES_WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

function todayKey() {
	return new Date().toISOString().slice(0, 10);
}

async function checkAndNotify(client) {
	const today = ES_WEEKDAYS[new Date().getDay()];
	const dateKey = todayKey();
	const airingToday = getAnimeAiringOn(today);

	for (const entry of airingToday) {
		if (wasNotifiedToday({ seasonLabel: entry.seasonLabel, malId: entry.malId, dateKey })) continue;

		const watchers = getWatchers({ seasonLabel: entry.seasonLabel, malId: entry.malId });
		markNotifiedToday({ seasonLabel: entry.seasonLabel, malId: entry.malId, dateKey });
		if (watchers.length === 0) continue;

		const channelId = getNotificationChannel(entry.guildId);
		if (!channelId) continue;

		try {
			const channel = await client.channels.fetch(channelId);
			const mentions = watchers.map((id) => `<@${id}>`).join(' ');
			await channel.send(`📢 Hoy sale nuevo capítulo de **${entry.title}**! ${mentions}`);
		} catch (err) {
			console.error(`No pude avisar sobre ${entry.title} en el canal configurado:`, err.message);
		}
	}
}

// Corre una vez al levantar el bot y luego cada hora; markNotifiedToday evita que se duplique el
// aviso si el check vuelve a correr el mismo día (reinicio del bot, etc.).
function startEpisodeNotifier(client) {
	checkAndNotify(client).catch((err) => console.error('Fallo el chequeo de avisos de episodios:', err));
	setInterval(() => {
		checkAndNotify(client).catch((err) => console.error('Fallo el chequeo de avisos de episodios:', err));
	}, CHECK_INTERVAL_MS);
}

module.exports = { startEpisodeNotifier };
