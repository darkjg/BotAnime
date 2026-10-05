const { listPendingReminders, markReminderNotified, rescheduleReminder } = require('./services/db');
const { formatearDuracion, proximaOcurrencia } = require('./reminders');

const CHEQUEO_MS = 30 * 1000;

// Un recordatorio vencido hace mucho (el bot estuvo apagado un buen rato) igual se manda, pero avisando
// que llega tarde, en vez de fingir que salió a tiempo.
const AVISO_TARDE_MS = 5 * 60 * 1000;

// Errores de Discord que significan "este canal ya no sirve para siempre" (borrado, o el bot perdió acceso
// / permisos): ahí un recordatorio repetido deja de repetirse, en vez de fallar en cada ocurrencia hasta
// el fin de los tiempos. Cualquier otro error (caída de Discord, red...) se considera pasajero.
const CODIGOS_CANAL_PERDIDO = new Set([10003, 50001, 50013]);
const esCanalPerdido = (err) => CODIGOS_CANAL_PERDIDO.has(err?.code) || err?.message === 'el canal ya no existe o no es de texto';

async function enviarRecordatorio(client, r) {
	const canal = await client.channels.fetch(r.channelId);
	if (!canal?.isTextBased()) throw new Error('el canal ya no existe o no es de texto');

	const tarde = Date.now() - r.dueAt > AVISO_TARDE_MS;
	const aviso = tarde ? ' _(iba a avisarte antes, pero el bot estuvo caído)_' : '';
	const repeticion = r.repeatEveryMs ? ` 🔁 _(se repite cada ${formatearDuracion(r.repeatEveryMs)})_` : '';
	await canal.send(`⏰ <@${r.discordId}> recordatorio: ${r.message}${repeticion}${aviso}`);
}

async function procesarRecordatorios(client, ahora) {
	for (const r of listPendingReminders()) {
		if (r.dueAt > ahora) continue;
		// Se actualiza ANTES de mandar: si el envío falla (canal borrado, etc.) no tiene sentido reintentar
		// cada 30s para siempre, y ya se hizo lo que se pudo con el intento. Un recordatorio repetido se
		// mueve a su siguiente ocurrencia futura; uno normal se da por avisado.
		if (r.repeatEveryMs) rescheduleReminder(r.id, proximaOcurrencia(r.dueAt, r.repeatEveryMs, ahora));
		else markReminderNotified(r.id);
		try {
			await enviarRecordatorio(client, r);
			console.log(`[recordatorios] #${r.id} enviado a ${r.displayName}: "${r.message}"`);
		} catch (err) {
			console.error(`[recordatorios] #${r.id}: no pude avisarle a ${r.displayName}:`, err.message);
			if (r.repeatEveryMs && esCanalPerdido(err)) {
				markReminderNotified(r.id);
				console.error(`[recordatorios] #${r.id}: canal perdido, se deja de repetir`);
			}
		}
	}
}

function startRemindersNotifier(client) {
	const tick = () => procesarRecordatorios(client, Date.now()).catch((err) => console.error('[recordatorios] falló el chequeo:', err.message));
	tick();
	setInterval(tick, CHEQUEO_MS);
	console.log(`[recordatorios] chequeo iniciado, cada ${CHEQUEO_MS / 1000}s`);
}

module.exports = { procesarRecordatorios, startRemindersNotifier, AVISO_TARDE_MS };
