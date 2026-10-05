const { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType } = require('discord.js');
const { sendBackupPrompt, buildPromptMessage, getOwnerId } = require('../av1Backup');
const { autoCleanupReply } = require('../ephemeral');

// Contextos Guild + BotDM: tiene que poder usarse escribiéndole al bot por MD, y los comandos de
// servidor no aparecen ahí, así que se registra como global (ver deploy-commands.js).
const data = new SlashCommandBuilder()
	.setName('respaldo-animeav1')
	.setDescription('Solo el dueño del bot: activa/desactiva el modo respaldo (WARP) de animeav1')
	.setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
	.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

async function execute(interaction) {
	if (interaction.user.id !== (await getOwnerId(interaction.client))) {
		await interaction.reply({ content: 'Solo el dueño del bot puede usar este comando.', ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}

	// Ya está en el MD con el bot: la pregunta es la propia respuesta, sin mandar otro MD.
	if (!interaction.inGuild()) {
		await interaction.reply(buildPromptMessage({ manual: true }));
		return;
	}

	await interaction.deferReply({ ephemeral: true });
	try {
		await sendBackupPrompt(interaction.client, { manual: true });
		await interaction.editReply('Te mandé un MD con la pregunta.');
	} catch (err) {
		await interaction.editReply(`No pude mandarte el MD (¿los tenés cerrados?): ${err.message}`);
	}
	autoCleanupReply(interaction);
}

module.exports = { data, execute };
