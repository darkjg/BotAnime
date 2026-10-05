const { getAllAnime } = require('./services/db');

const ORDEN_ESTACION = { invierno: 0, primavera: 1, verano: 2, otoño: 3 };

// "Otoño 2026" -> año * 4 + estación (para ordenar de la más nueva a la más vieja); una pestaña con otro
// nombre (un nombre personalizado) no se puede ordenar y va al final.
function rangoTemporada(label) {
	const m = /^(\S+)\s+(\d{4})$/.exec(label);
	const estacion = m ? ORDEN_ESTACION[m[1].toLowerCase()] : undefined;
	return estacion === undefined ? -1 : Number(m[2]) * 4 + estacion;
}

// Temporadas que ya tienen animes guardados para ese servidor, la más reciente primero.
function temporadasDelServidor(guildId) {
	const labels = new Set(getAllAnime().filter((a) => a.guildId === guildId).map((a) => a.seasonLabel));
	return [...labels].sort((a, b) => rangoTemporada(b) - rangoTemporada(a) || a.localeCompare(b));
}

// Autocompletado de la opción "nombre" (la pestaña de la sheet) de los comandos de temporada.
async function autocompleteTemporada(interaction) {
	const focused = interaction.options.getFocused().toLowerCase();
	const choices = temporadasDelServidor(interaction.guildId)
		.filter((label) => label.toLowerCase().includes(focused))
		.slice(0, 25)
		.map((label) => ({ name: label, value: label }));
	await interaction.respond(choices);
}

module.exports = { temporadasDelServidor, autocompleteTemporada, rangoTemporada };
