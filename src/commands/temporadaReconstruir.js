const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { rebuildSeasonTab } = require('../seasonRebuild');
const { autoCleanupReply } = require('../ephemeral');
const { autocompleteTemporada } = require('../seasonAutocomplete');
const { textoProgreso } = require('../progressBar');

const data = new SlashCommandBuilder()
	.setName('temporada-reconstruir')
	.setDescription('Borra y reconstruye la pestaña de una temporada desde cero, usando los votos guardados')
	.addStringOption((option) =>
		option
			.setName('nombre')
			.setDescription('Temporada (pestaña de la sheet) a reconstruir: elígela de la lista')
			.setAutocomplete(true)
			.setRequired(true),
	)
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

const ICONO_TRABAJO = String.fromCodePoint(0x1f527);
const ICONO_LISTO = String.fromCodePoint(0x2705);
const ICONO_FALLO = String.fromCodePoint(0x274c);

async function execute(interaction) {
	await interaction.deferReply({ ephemeral: true });

	const nombre = interaction.options.getString('nombre', true);
	console.log(`[temporada-reconstruir] reconstruyendo "${nombre}"...`);

	const titulo = `${ICONO_TRABAJO} Reconstruyendo **${nombre}** (lo pidió ${interaction.user})`;
	// El progreso va en un mensaje del canal, no en la respuesta del comando: Discord solo deja editar esa
	// respuesta 15 minutos y reconstruir tarda más. El mensaje del bot se puede editar hasta el final.
	const mensaje = (await interaction.channel?.send(textoProgreso({ titulo, hecho: 0, total: 0, fase: 'Preparando...' })).catch(() => null)) ?? null;
	const mostrar = (texto) => {
		if (mensaje) mensaje.edit(texto).catch(() => {});
		else interaction.editReply(texto).catch(() => {});
	};
	if (!mensaje) await interaction.editReply('Reconstruyendo... (no puedo escribir en este canal, te aviso aquí)').catch(() => {});

	try {
		const { animeCount, votesApplied } = await rebuildSeasonTab(nombre, interaction.guildId, {
			onProgress: ({ hecho, total, fase, segundosPorPaso }) => mostrar(textoProgreso({ titulo, hecho, total, fase, segundosPorPaso })),
		});
		console.log(`[temporada-reconstruir] "${nombre}" reconstruida: ${animeCount} anime(s), ${votesApplied} voto(s) reaplicados`);
		const resumen = `Reconstruí **${nombre}** desde cero: ${animeCount} anime(s) con ${votesApplied} voto(s) reaplicados.`;
		if (mensaje) {
			await mensaje.edit(`${ICONO_LISTO} ${interaction.user} ${resumen}`).catch(() => {});
			await interaction.editReply(resumen).catch(() => {});
		} else {
			await interaction.editReply(resumen).catch(async () => {
				await interaction.channel?.send(`${interaction.user} ${resumen}`).catch(() => {});
			});
		}
	} catch (err) {
		console.error(`[temporada-reconstruir] no pude reconstruir "${nombre}":`, err.message);
		const fallo = `No pude reconstruir "${nombre}": ${err.message}`;
		if (mensaje) await mensaje.edit(`${ICONO_FALLO} ${interaction.user} ${fallo}`).catch(() => {});
		await interaction.editReply(fallo).catch(() => {});
	}
	autoCleanupReply(interaction);
}

module.exports = { data, execute, autocomplete: autocompleteTemporada };
