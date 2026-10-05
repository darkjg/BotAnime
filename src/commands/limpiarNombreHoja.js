const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getAnimeAcrossGuilds, getDisplayTitle } = require('../services/db');
const { deleteUserRow, listSeasonTabs } = require('../services/sheets');
const { syncAbandonedState } = require('../interactions');
const { autoCleanupReply } = require('../ephemeral');

// Complemento de /quitar-usuario para gente que ya se borró de la BD ANTES de que ese comando
// también limpiara la sheet (o cualquier caso en que ya no queden votos suyos ahí): sin votos en la
// BD no hay forma de saber en qué temporadas tenía fila, así que esto busca por NOMBRE EXACTO en
// TODAS las pestañas de temporada directamente, sin depender de la BD para localizarla — solo la usa
// después, por cada anime que votaba, para decidir si quedó sin nadie viéndolo.
const data = new SlashCommandBuilder()
	.setName('limpiar-nombre-hoja')
	.setDescription('Admin: borra por nombre exacto su fila en todas las temporadas (para gente ya borrada de la BD)')
	.addStringOption((o) => o.setName('nombre').setDescription('Nombre exacto tal como aparece en la columna A de la hoja').setRequired(true))
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function execute(interaction) {
	const nombre = interaction.options.getString('nombre', true);
	await interaction.deferReply({ ephemeral: true });

	const temporadas = await listSeasonTabs();
	let filasBorradas = 0;
	let animesAbandonados = 0;
	const temporadasConFila = [];

	for (const seasonLabel of temporadas) {
		let resultado;
		try {
			resultado = await deleteUserRow(seasonLabel, nombre);
		} catch (err) {
			console.error(`[limpiar-nombre-hoja] no pude revisar "${seasonLabel}":`, err.message);
			continue;
		}
		if (!resultado.borrada) continue;

		filasBorradas++;
		temporadasConFila.push(seasonLabel);

		for (const malId of resultado.malIds) {
			try {
				// Sin fila suya en ningún lado ya, pero el malId puede no estar en nuestra BD (anime
				// nunca trackeado por nosotros, o de un guild distinto) — sin un registro no hay nada
				// que comprobar.
				const [registroAntes] = getAnimeAcrossGuilds({ seasonLabel, malId });
				if (!registroAntes) continue;
				const yaEstabaAbandonado = Boolean(registroAntes.isAbandoned);
				const title = getDisplayTitle(registroAntes);
				await syncAbandonedState(seasonLabel, malId, title);
				if (!yaEstabaAbandonado) {
					const [registroDespues] = getAnimeAcrossGuilds({ seasonLabel, malId });
					if (registroDespues?.isAbandoned) animesAbandonados++;
				}
			} catch (err) {
				console.error(`[limpiar-nombre-hoja] no pude comprobar abandono de malId ${malId} en "${seasonLabel}":`, err.message);
			}
		}

		// Pausa chica entre temporadas: recorrer todas de un tirón puede pegarle a la cuota de la API
		// de Sheets (ya pasó antes en otras operaciones masivas de este bot).
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	console.log(`[limpiar-nombre-hoja] ${interaction.user.tag} borró "${nombre}" de ${filasBorradas} temporada(s): ${temporadasConFila.join(', ') || '(ninguna)'}`);

	if (filasBorradas === 0) {
		await interaction.editReply(`No encontré ninguna fila con el nombre exacto "${nombre}" en ninguna temporada.`);
	} else {
		const resumenAbandonados = animesAbandonados > 0
			? `, y ${animesAbandonados} anime${animesAbandonados === 1 ? '' : 's'} que solo veía ella ${animesAbandonados === 1 ? 'pasó' : 'pasaron'} a ABANDONADOS`
			: '';
		await interaction.editReply(
			`Listo, borrada la fila de "${nombre}" en ${filasBorradas} temporada${filasBorradas === 1 ? '' : 's'} (${temporadasConFila.join(', ')})${resumenAbandonados}.`,
		);
	}
	autoCleanupReply(interaction);
}

module.exports = { data, execute };
