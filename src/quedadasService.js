const {
	listQuedadas,
	updateQuedada,
	deleteQuedada,
	getNotificationChannel,
	getWatchers,
	getAnimeForSeason,
} = require('./services/db');
const { HORA_MS, ocurrenciaSemanaSiguiente, armarAviso, menciones } = require('./quedadas');

const CHEQUEO_MS = 60 * 1000;
// Si el bot estuvo caído justo a la hora, un "empieza ahora" solo sirve un rato; pasado esto se omite.
const GRACIA_INICIO_MS = 15 * 60 * 1000;

const PREFIJO = { nueva: '📺', hora: '⏰', ahora: '🎬', cancelada: '❌' };

// Manda un aviso de la quedada al canal de avisos del servidor, mencionando a los votantes del anime.
// Devuelve true si salió. `votantes` y `imageUrl` se buscan aquí para que siempre sean los de ese momento.
async function publicarAviso(client, quedada, tipo) {
	const canalId = getNotificationChannel(quedada.guildId);
	if (!canalId) throw new Error('el servidor no tiene canal de avisos configurado (/avisos-canal)');
	const canal = await client.channels.fetch(canalId);
	if (!canal?.isTextBased()) throw new Error('el canal de avisos no existe o no es de texto');

	const votantes = getWatchers({ seasonLabel: quedada.seasonLabel, malId: quedada.malId });
	const anime = getAnimeForSeason(quedada.seasonLabel).find((a) => a.guildId === quedada.guildId && a.malId === quedada.malId);
	await canal.send({
		content: `${PREFIJO[tipo]} ${menciones(votantes, quedada.createdBy)}`,
		embeds: [armarAviso(tipo, quedada, { imageUrl: anime?.imageUrl })],
	});
}

async function avisar(client, quedada, tipo) {
	try {
		await publicarAviso(client, quedada, tipo);
		console.log(`[quedadas] #${quedada.id} "${quedada.title}": aviso "${tipo}" enviado`);
	} catch (err) {
		// Se da por enviado igual: reintentar cada minuto llenaría el log y, pasado el momento, ya no sirve.
		console.error(`[quedadas] #${quedada.id} "${quedada.title}": no pude mandar el aviso "${tipo}":`, err.message);
	}
}

// Recorre las quedadas de todos los servidores y manda lo que toque en `ahora` (ms epoch):
//   - 1 hora antes: el recordatorio (mientras no haya empezado);
//   - a la hora: el aviso de inicio (si no pasó más de GRACIA_INICIO_MS);
//   - empezada: una quedada de una vez se borra; una semanal salta a la semana siguiente.
async function procesarQuedadas(client, ahora) {
	for (const quedada of listQuedadas()) {
		try {
			await procesarUna(client, quedada, ahora);
		} catch (err) {
			console.error(`[quedadas] #${quedada.id}: error procesando la quedada:`, err.message);
		}
	}
}

async function procesarUna(client, q, ahora) {
	if (!q.hourSent && ahora >= q.startsAt - HORA_MS) {
		if (ahora < q.startsAt) await avisar(client, q, 'hora');
		updateQuedada(q.id, { hourSent: true });
		q.hourSent = true;
	}

	if (!q.startSent && ahora >= q.startsAt) {
		if (ahora - q.startsAt <= GRACIA_INICIO_MS) await avisar(client, q, 'ahora');
		else console.log(`[quedadas] #${q.id} "${q.title}": ya pasó demasiado tiempo desde la hora, no mando el aviso de inicio`);
		updateQuedada(q.id, { startSent: true });
		q.startSent = true;
	}

	if (!q.startSent) return;

	if (!q.weekly) {
		deleteQuedada(q.id);
		return;
	}

	// Semanal: salta a la próxima ocurrencia futura (varias, si el bot estuvo mucho tiempo apagado).
	let { fecha, startsAt } = q;
	for (let i = 0; i < 520 && startsAt <= ahora; i++) ({ fecha, startsAt } = ocurrenciaSemanaSiguiente(fecha, q.hora));
	updateQuedada(q.id, { fecha, startsAt, hourSent: false, startSent: false });
}

function startQuedadasNotifier(client) {
	const tick = () => procesarQuedadas(client, Date.now()).catch((err) => console.error('[quedadas] falló el chequeo:', err.message));
	tick();
	setInterval(tick, CHEQUEO_MS);
	console.log(`[quedadas] chequeo iniciado, cada ${CHEQUEO_MS / 1000}s`);
}

module.exports = { publicarAviso, procesarQuedadas, startQuedadasNotifier, GRACIA_INICIO_MS };
