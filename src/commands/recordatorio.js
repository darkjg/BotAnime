const { SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, PermissionFlagsBits } = require('discord.js');
const { createReminder, listPendingRemindersForUser, deleteReminder, deleteAllRemindersForUser } = require('../services/db');
const { parseDuracion, formatearDuracion, MIN_MS, MAX_MS, MIN_REPETICION_MS } = require('../reminders');
const { autoCleanupReply } = require('../ephemeral');

const data = new SlashCommandBuilder()
	.setName('recordatorio')
	.setDescription('Recordatorios personales, avisan en este mismo canal')
	.addSubcommand((sub) =>
		sub
			.setName('crear')
			.setDescription('Programa un aviso')
			.addStringOption((o) =>
				o
					.setName('tiempo')
					.setDescription('Cuánto falta: 1hora, 30min, 2dias, 1h30m...')
					.setRequired(true),
			)
			.addStringOption((o) => o.setName('mensaje').setDescription('Qué te tengo que recordar').setRequired(true))
			// Opcionales al final (Discord exige que las obligatorias vayan primero).
			.addBooleanOption((o) => o.setName('repetir').setDescription('¿Repetir el aviso cada cierto tiempo? (por defecto no)'))
			.addStringOption((o) =>
				o
					.setName('cada')
					.setDescription('Cada cuánto repetirlo: 1dia, 12h... (mín. 10 min; si no, usa el tiempo de arriba)'),
			),
	)
	.addSubcommand((sub) => sub.setName('listar').setDescription('Ver tus recordatorios pendientes'))
	.addSubcommand((sub) =>
		sub
			.setName('cancelar-usuario')
			.setDescription('Admin: borra todos los recordatorios pendientes de alguien (ej. si se fue del server)')
			.addUserOption((o) => o.setName('usuario').setDescription('A quién le borras los recordatorios').setRequired(true)),
	);

function formatearLista(recordatorios) {
	if (recordatorios.length === 0) return 'No tienes recordatorios pendientes.';
	const lineas = recordatorios.map((r) => {
		const repeticion = r.repeatEveryMs ? ` 🔁 cada ${formatearDuracion(r.repeatEveryMs)}` : '';
		return `• <t:${Math.floor(r.dueAt / 1000)}:R> — ${r.message}${repeticion}`;
	});
	return `**Tus recordatorios pendientes:**\n${lineas.join('\n')}`;
}

function buildCancelRow(recordatorios) {
	if (recordatorios.length === 0) return [];
	// Hasta 5 botones por fila y 5 filas por mensaje: con el tope de recordatorios que una persona
	// razonablemente tendría a la vez, alcanza de sobra sin paginar.
	const botones = recordatorios
		.slice(0, 25)
		.map((r) => new ButtonBuilder().setCustomId(`remindercancel:${r.id}`).setLabel(`❌ #${r.id}`).setStyle(ButtonStyle.Secondary));
	const filas = [];
	for (let i = 0; i < botones.length; i += 5) filas.push(new ActionRowBuilder().addComponents(botones.slice(i, i + 5)));
	return filas;
}

async function crear(interaction) {
	const tiempoTexto = interaction.options.getString('tiempo', true);
	const mensaje = interaction.options.getString('mensaje', true);

	const ms = parseDuracion(tiempoTexto);
	if (ms == null) {
		await interaction.reply({
			content: `No entendí "${tiempoTexto}". Probá algo como \`1hora\`, \`30min\`, \`2dias\` o \`1h30m\`.`,
			ephemeral: true,
		});
		autoCleanupReply(interaction);
		return;
	}
	if (ms < MIN_MS) {
		await interaction.reply({ content: 'Es muy poco tiempo (mínimo 30 segundos).', ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}
	if (ms > MAX_MS) {
		await interaction.reply({ content: 'Es demasiado tiempo (máximo 90 días).', ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}

	// Repetición: `cada` por sí solo ya la activa; `repetir: sí` sin `cada` repite con el mismo tiempo de
	// `tiempo` (ej. "en 1 día" + repetir = todos los días). Lo único contradictorio es pedir explícitamente
	// NO repetir y a la vez dar un intervalo: se rechaza en vez de adivinar cuál de las dos cosas querían.
	const repetir = interaction.options.getBoolean('repetir');
	const cadaTexto = interaction.options.getString('cada');
	let repeatEveryMs = null;
	if (repetir === false && cadaTexto) {
		await interaction.reply({ content: 'Pusiste `repetir: no` pero también `cada`. Quita uno de los dos.', ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}
	if (repetir === true || cadaTexto) {
		repeatEveryMs = cadaTexto ? parseDuracion(cadaTexto) : ms;
		if (repeatEveryMs == null) {
			await interaction.reply({
				content: `No entendí "${cadaTexto}" en \`cada\`. Probá algo como \`1dia\`, \`12h\` o \`1semana\`.`,
				ephemeral: true,
			});
			autoCleanupReply(interaction);
			return;
		}
		if (repeatEveryMs < MIN_REPETICION_MS) {
			await interaction.reply({
				content: `Para repetirlo, el intervalo mínimo es ${formatearDuracion(MIN_REPETICION_MS)} (si no, sería spam en el canal).`,
				ephemeral: true,
			});
			autoCleanupReply(interaction);
			return;
		}
		if (repeatEveryMs > MAX_MS) {
			await interaction.reply({ content: 'El intervalo de repetición es demasiado largo (máximo 90 días).', ephemeral: true });
			autoCleanupReply(interaction);
			return;
		}
	}

	const dueAt = Date.now() + ms;
	const id = createReminder({
		guildId: interaction.guildId,
		channelId: interaction.channelId,
		discordId: interaction.user.id,
		displayName: interaction.member?.displayName ?? interaction.user.username,
		message: mensaje,
		dueAt,
		repeatEveryMs,
	});

	const repeticion = repeatEveryMs ? `, y después se repite cada ${formatearDuracion(repeatEveryMs)}` : '';
	console.log(
		`[recordatorio] #${id} creado por ${interaction.user.tag}: "${mensaje}" para <t:${Math.floor(dueAt / 1000)}:f>${repeatEveryMs ? ` (repite cada ${formatearDuracion(repeatEveryMs)})` : ''}`,
	);
	await interaction.reply(`Listo, te aviso en este canal <t:${Math.floor(dueAt / 1000)}:R>${repeticion} (#${id}): ${mensaje}`);
	autoCleanupReply(interaction);
}

async function listar(interaction) {
	const propios = listPendingRemindersForUser({ guildId: interaction.guildId, discordId: interaction.user.id });
	await interaction.reply({ content: formatearLista(propios), components: buildCancelRow(propios), ephemeral: true });
	autoCleanupReply(interaction);
}

// No usa setDefaultMemberPermissions porque el resto del comando (crear/listar) es para cualquiera; el
// chequeo va solo en este subcomando, igual que /quedada cancelar.
async function cancelarUsuario(interaction) {
	const esAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
	if (!esAdmin) {
		await interaction.reply({ content: 'Solo un admin puede usar esto.', ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}
	const usuario = interaction.options.getUser('usuario', true);
	const cantidad = deleteAllRemindersForUser({ guildId: interaction.guildId, discordId: usuario.id });
	if (cantidad === 0) {
		await interaction.reply({ content: `${usuario.tag} no tenía recordatorios pendientes.`, ephemeral: true });
	} else {
		await interaction.reply({
			content: `Borrados ${cantidad} recordatorio${cantidad === 1 ? '' : 's'} pendiente${cantidad === 1 ? '' : 's'} de ${usuario.tag}.`,
			ephemeral: true,
		});
	}
	autoCleanupReply(interaction);
}

async function execute(interaction) {
	const sub = interaction.options.getSubcommand();
	if (sub === 'crear') await crear(interaction);
	else if (sub === 'listar') await listar(interaction);
	else if (sub === 'cancelar-usuario') await cancelarUsuario(interaction);
}

// Botón "❌ #id" de /recordatorio listar: borra y refresca la lista en el mismo mensaje (en vez de un
// mensaje nuevo), para poder cancelar varios seguidos sin que se acumulen respuestas.
async function handleCancelButton(interaction, id) {
	const borrado = deleteReminder({ id: Number(id), discordId: interaction.user.id });
	if (!borrado) {
		await interaction.reply({ content: 'Ese recordatorio ya no existe (¿ya se avisó, o ya lo habías cancelado?).', ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}
	const propios = listPendingRemindersForUser({ guildId: interaction.guildId, discordId: interaction.user.id });
	await interaction.update({ content: formatearLista(propios), components: buildCancelRow(propios) });
	autoCleanupReply(interaction);
}

module.exports = { data, execute, handleCancelButton, formatearLista, buildCancelRow };
