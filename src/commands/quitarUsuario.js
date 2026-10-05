const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { deleteAllVotesForUser, getVotesForUser, getAnimeAcrossGuilds, getDisplayTitle } = require('../services/db');
const { deleteUserRow } = require('../services/sheets');
const { syncAbandonedState } = require('../interactions');
const { autoCleanupReply } = require('../ephemeral');

// Para cuando alguien se fue del server y el bot le sigue mandando avisos de nuevo capítulo: borra
// todos sus votos (verde/naranja) en cualquier temporada, que es lo que hace que getWatchers lo siga
// contando como que sigue esos animes. También limpia su rastro en la sheet (su fila en cada
// temporada donde tenía votos) y, si algún anime se quedó sin nadie viéndolo por su culpa, lo manda
// a ABANDONADOS (mismo mecanismo automático que un desvoto normal por botón, ver syncAbandonedState
// en interactions.js — ese flujo no se disparaba solo porque este comando borra directo en BD, sin
// pasar por los botones de voto).
const data = new SlashCommandBuilder()
	.setName('quitar-usuario')
	.setDescription('Admin: borra todos los votos de alguien (BD + sheet) para que el bot deje de mandarle avisos')
	.addUserOption((o) => o.setName('usuario').setDescription('A quién le borras los votos').setRequired(true))
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function execute(interaction) {
	const usuario = interaction.options.getUser('usuario', true);

	// Capturar ANTES de borrar: qué temporadas/animes tenía votados y con qué nombre(s) aparece en
	// la sheet de cada una (displayName puede variar si cambió de apodo entre votos) — una vez
	// borrados sus votos de la BD esta información ya no se puede reconstruir.
	const votosPrevios = getVotesForUser({ discordId: usuario.id });
	const cantidad = deleteAllVotesForUser({ discordId: usuario.id });
	console.log(`[quitar-usuario] ${interaction.user.tag} borró ${cantidad} voto(s) de ${usuario.tag}`);

	if (cantidad === 0) {
		await interaction.reply({ content: `${usuario.tag} no tenía votos registrados.`, ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}

	// Lo que sigue son varias llamadas a la API de Sheets (una fila por temporada, una comprobación
	// por anime) — puede tardar más de los 3s que da Discord para la respuesta inicial.
	await interaction.deferReply({ ephemeral: true });

	const porTemporada = new Map(); // seasonLabel -> { nombres: Set<string>, malIds: Set<number> }
	for (const v of votosPrevios) {
		if (!porTemporada.has(v.seasonLabel)) porTemporada.set(v.seasonLabel, { nombres: new Set(), malIds: new Set() });
		const entry = porTemporada.get(v.seasonLabel);
		if (v.displayName) entry.nombres.add(v.displayName);
		entry.malIds.add(v.malId);
	}

	let filasBorradas = 0;
	let animesAbandonados = 0;
	for (const [seasonLabel, { nombres, malIds }] of porTemporada) {
		for (const nombre of nombres) {
			try {
				const { borrada } = await deleteUserRow(seasonLabel, nombre);
				if (borrada) filasBorradas++;
			} catch (err) {
				console.error(`[quitar-usuario] no pude borrar la fila de "${nombre}" en "${seasonLabel}":`, err.message);
			}
		}

		for (const malId of malIds) {
			try {
				const [registroAntes] = getAnimeAcrossGuilds({ seasonLabel, malId });
				const yaEstabaAbandonado = Boolean(registroAntes?.isAbandoned);
				const title = registroAntes ? getDisplayTitle(registroAntes) : String(malId);
				await syncAbandonedState(seasonLabel, malId, title);
				if (!yaEstabaAbandonado) {
					const [registroDespues] = getAnimeAcrossGuilds({ seasonLabel, malId });
					if (registroDespues?.isAbandoned) animesAbandonados++;
				}
			} catch (err) {
				console.error(`[quitar-usuario] no pude comprobar abandono de malId ${malId} en "${seasonLabel}":`, err.message);
			}
		}
	}

	const resumenFilas = `${filasBorradas} fila${filasBorradas === 1 ? '' : 's'} en la hoja`;
	const resumenAbandonados = animesAbandonados > 0
		? `, y ${animesAbandonados} anime${animesAbandonados === 1 ? '' : 's'} que solo veía ella ${animesAbandonados === 1 ? 'pasó' : 'pasaron'} a ABANDONADOS`
		: '';
	await interaction.editReply(
		`Listo, borrados ${cantidad} voto${cantidad === 1 ? '' : 's'} de ${usuario.tag} (BD + ${resumenFilas}${resumenAbandonados}). Ya no le va a llegar ningún aviso automático de nuevo capítulo.`,
	);
	autoCleanupReply(interaction);
}

module.exports = { data, execute };
