require('dotenv').config();
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const temporada = require('./src/commands/temporada');
const { handleInteraction } = require('./src/interactions');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.commands = new Collection();
client.commands.set(temporada.data.name, temporada);

client.once('clientReady', () => {
	console.log(`Conectado como ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
	try {
		if (interaction.isChatInputCommand()) {
			const command = client.commands.get(interaction.commandName);
			if (!command) return;
			await command.execute(interaction);
			return;
		}

		await handleInteraction(interaction);
	} catch (error) {
		console.error(error);
		const errorMessage = 'Ocurrió un error al procesar la interacción.';
		if (interaction.deferred || interaction.replied) {
			await interaction.editReply(errorMessage).catch(() => {});
		} else {
			await interaction.reply({ content: errorMessage, ephemeral: true }).catch(() => {});
		}
	}
});

client.login(process.env.DISCORD_TOKEN);
