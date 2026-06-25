const { buildTemporadaCommandData, runTemporadaCommand } = require('./temporadaShared');

const data = buildTemporadaCommandData(
	'temporada-foro',
	'Publica los animes de una temporada como hilos de foro (uno por anime) para votar si los veremos',
);

async function execute(interaction) {
	await runTemporadaCommand(interaction, 'foro');
}

module.exports = { data, execute };
