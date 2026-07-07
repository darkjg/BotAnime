require('dotenv').config();
require('./src/logging');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const temporadaForo = require('./src/commands/temporadaForo');
const temporadaReparar = require('./src/commands/temporadaReparar');
const temporadaReconstruir = require('./src/commands/temporadaReconstruir');
const avisos = require('./src/commands/avisos');
const votoRol = require('./src/commands/votoRol');
const capitulo = require('./src/commands/capitulo');
const recargaCaps = require('./src/commands/recargaCaps');

const { handleInteraction } = require('./src/interactions');
const { startAv1EpisodeNotifier } = require('./src/scheduler');


const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.commands = new Collection();
client.commands.set(temporadaForo.data.name, temporadaForo);
client.commands.set(temporadaReparar.data.name, temporadaReparar);
client.commands.set(temporadaReconstruir.data.name, temporadaReconstruir);
client.commands.set(avisos.data.name, avisos);
client.commands.set(votoRol.data.name, votoRol);
client.commands.set(capitulo.data.name, capitulo);
client.commands.set(recargaCaps.data.name, recargaCaps);



client.once('clientReady', () => {
	console.log(`Conectado como ${client.user.tag}`);
	startAv1EpisodeNotifier(client);
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

		if (interaction.isAutocomplete()) {
			const command = client.commands.get(interaction.commandName);
			if (command?.autocomplete) await command.autocomplete(interaction);
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
