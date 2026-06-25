const { buildTemporadaCommandData, runTemporadaCommand } = require('./temporadaShared');

const data = buildTemporadaCommandData('temporada', 'Publica los animes de una temporada para votar si los veremos');

async function execute(interaction) {
	await runTemporadaCommand(interaction, 'carousel');
}

module.exports = { data, execute };
