const { getAnimeAcrossGuilds, isCaughtUpThisWeek, getDisplayTitle } = require('./services/db');
const { setVote, clearVote } = require('./services/sheets');
const { esErrorDeCuota } = require('./services/reintento');

// Refresca en la sheet la celda de una persona para un anime (su voto, su capítulo y el check de "al día").
// La sheet es una sola aunque el anime esté registrado en varios servidores: antes se escribía una vez por
// servidor (mismas celdas, el doble de llamadas a Google y el doble de riesgo de pasarse de la cuota).
// Ahora se escribe UNA vez; el check solo se tilda, así que basta con que en algún servidor la persona
// esté al día. `extra` se mezcla en los datos del anime (por ejemplo isSequel). No lanza: devuelve
// { ok: true } o { ok: false, error }.
async function refrescarCeldaDeProgreso({ seasonLabel, malId, displayName, voteType, episodesWatched, extra = {} }) {
	const registros = getAnimeAcrossGuilds({ seasonLabel, malId });
	if (registros.length === 0) return { ok: true };

	const alDia = registros.some((registro) => isCaughtUpThisWeek({ seasonLabel, malId, guildId: registro.guildId, episodesWatched }));
	const registro = registros[0];
	try {
		await setVote(seasonLabel, displayName, { ...registro, ...extra, title: getDisplayTitle(registro) }, voteType, episodesWatched, alDia);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err };
	}
}

// Quita de la sheet la celda de voto de una persona para un anime, una sola vez por la misma razón. No
// lanza: devuelve { ok: true, cleared } (cleared = había algo que borrar) o { ok: false, error }.
async function limpiarCeldaDeVoto({ seasonLabel, malId, displayName }) {
	const [registro] = getAnimeAcrossGuilds({ seasonLabel, malId });
	if (!registro) return { ok: true, cleared: false };
	try {
		return { ok: true, cleared: Boolean(await clearVote(seasonLabel, displayName, registro)) };
	} catch (err) {
		return { ok: false, error: err };
	}
}

// Por qué falló, para decírselo a la persona.
function motivoFalloSheet(error) {
	return esErrorDeCuota(error) ? 'Google limitó las consultas' : 'hubo un problema con la sheet';
}

// Aviso para la respuesta al usuario cuando la sheet no se pudo actualizar (el capítulo sí quedó guardado
// en la base). fallidos: [{ displayName, error }]. Vacío si no falló nada.
function textoFallosSheet(fallidos) {
	if (fallidos.length === 0) return '';
	const nombres = fallidos.map((f) => `**${f.displayName}**`).join(', ');
	const porCuota = fallidos.every((f) => esErrorDeCuota(f.error));
	return (
		`\n⚠️ El capítulo quedó guardado, pero no pude actualizar la sheet de ${nombres}${porCuota ? ' (Google limitó las consultas)' : ''}. ` +
		'Se verá en la sheet la próxima vez que se actualice su capítulo.'
	);
}

module.exports = { refrescarCeldaDeProgreso, limpiarCeldaDeVoto, motivoFalloSheet, textoFallosSheet };
