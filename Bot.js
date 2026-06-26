require('dotenv').config();
require('./src/logging');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const temporada = require('./src/commands/temporada');
const temporadaForo = require('./src/commands/temporadaForo');
const avisos = require('./src/commands/avisos');
const { handleInteraction } = require('./src/interactions');
const { startEpisodeNotifier } = require('./src/scheduler');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.commands = new Collection();
client.commands.set(temporada.data.name, temporada);
client.commands.set(temporadaForo.data.name, temporadaForo);
client.commands.set(avisos.data.name, avisos);

client.once('clientReady', () => {
	console.log(`Conectado como ${client.user.tag}`);
	startEpisodeNotifier(client);
});

client.on('interactionCreate', async (interaction) => {
	try {
		if (interaction.isChatInputCommand()) {
			console.log(`[bot] /${interaction.commandName} usado por ${interaction.user.tag} en guild ${interaction.guildId}`);
			const command = client.commands.get(interaction.commandName);
			if (!command) return;
			await command.execute(interaction);
			return;
		}

		await handleInteraction(interaction);
	} catch (error) {
		console.error('[bot] error procesando interacción:', error);
		const errorMessage = 'Ocurrió un error al procesar la interacción.';
		if (interaction.deferred || interaction.replied) {
			await interaction.editReply(errorMessage).catch(() => {});
		} else {
			await interaction.reply({ content: errorMessage, ephemeral: true }).catch(() => {});
		}
	}
});

client.login(process.env.DISCORD_TOKEN);
