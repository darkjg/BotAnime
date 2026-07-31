require('dotenv').config();
require('./src/logging');
const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
const temporadaForo = require('./src/commands/temporadaForo');
const temporadaReparar = require('./src/commands/temporadaReparar');
const temporadaReconstruir = require('./src/commands/temporadaReconstruir');
const avisos = require('./src/commands/avisos');
const votoRol = require('./src/commands/votoRol');
const capitulo = require('./src/commands/capitulo');
const recargaCaps = require('./src/commands/recargaCaps');
const enComun = require('./src/commands/enComun');
const pendientes = require('./src/commands/pendientes');
const refrescarHilos = require('./src/commands/refrescarHilos');
const linkFix = require('./src/commands/linkFix');

const { handleInteraction } = require('./src/interactions');
const { startAv1EpisodeNotifier } = require('./src/scheduler');
const { handleMessage: handleLinkFixMessage, handleReactionAdd: handleLinkFixReaction } = require('./src/linkFixService');

// GuildMessages + MessageContent hacen falta para leer el texto de los mensajes (link de twitter/x a
// arreglar); MessageContent es un intent privilegiado, hay que habilitarlo en el Developer Portal del
// bot (Bot > Message Content Intent) o el login falla. GuildMessageReactions es para la reacción 🗑️
// que deshace el reemplazo. Los partials son necesarios porque esa reacción puede llegar sobre un
// mensaje que el cliente no tiene en caché (recién reiniciado el bot, por ejemplo).
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildMessageReactions,
	],
	partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.commands = new Collection();
client.commands.set(temporadaForo.data.name, temporadaForo);
client.commands.set(temporadaReparar.data.name, temporadaReparar);
client.commands.set(temporadaReconstruir.data.name, temporadaReconstruir);
client.commands.set(avisos.data.name, avisos);
client.commands.set(votoRol.data.name, votoRol);
client.commands.set(capitulo.data.name, capitulo);
client.commands.set(recargaCaps.data.name, recargaCaps);
client.commands.set(enComun.data.name, enComun);
client.commands.set(pendientes.data.name, pendientes);
client.commands.set(refrescarHilos.data.name, refrescarHilos);
client.commands.set(linkFix.data.name, linkFix);



client.once('clientReady', () => {
	console.log(`Conectado como ${client.user.tag}`);
	startAv1EpisodeNotifier(client);
});

client.on('messageCreate', (message) => {
	handleLinkFixMessage(message).catch((err) => console.error('[bot] error en linkFix:', err.message));
});

client.on('messageReactionAdd', async (reaction, user) => {
	try {
		if (reaction.partial) await reaction.fetch();
		await handleLinkFixReaction(reaction, user);
	} catch (err) {
		console.error('[bot] error en la reacción de linkFix:', err.message);
	}
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
