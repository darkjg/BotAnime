const { SlashCommandBuilder, PermissionFlagsBits, StringSelectMenuBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const {
	getActiveSeason,
	getAnimeForSeason,
	getUserVotedAnime,
	getWatchers,
	getVotesForSeason,
	getEpisodesWatched,
	getNotificationChannel,
	getDisplayTitle,
	createQuedada,
	getQuedada,
	listQuedadasGuild,
	deleteQuedada,
	getAllAnime,
} = require('../services/db');
const { resolverMomento, momentoTexto, sugerenciasDia, armarAviso, menciones, HORA_MS, MAX_DIAS_ADELANTE } = require('../quedadas');
const { publicarAviso } = require('../quedadasService');
const { autoCleanupReply } = require('../ephemeral');

const data = new SlashCommandBuilder()
	.setName('quedada')
	.setDescription('Quedadas para ver un anime juntos: avisa a quienes lo ven')
	.addSubcommand((sub) =>
		sub
			.setName('crear')
			.setDescription('Crea una quedada: selecciona personas y luego el anime que ven en común'),
	)
	.addSubcommand((sub) => sub.setName('listar').setDescription('Muestra las quedadas programadas'))
	.addSubcommand((sub) =>
		sub
			.setName('cancelar')
			.setDescription('Cancela una quedada')
			.addStringOption((o) => o.setName('quedada').setDescription('Quedada a cancelar').setRequired(true).setAutocomplete(true)),
	);

const ERRORES = {
	dia: 'No entendí el día. Escribí `hoy`, `mañana`, un día de la semana (`viernes`) o una fecha (`25/09`).',
	hora: 'No entendí la hora. Por ejemplo `21`, `21:30` o `21h30` (hora de Madrid).',
	inexistente: 'Esa hora no existe ese día (es el cambio de hora). Probá con otra.',
	pasado: 'Esa fecha y hora ya pasó.',
	lejos: `Está a más de ${MAX_DIAS_ADELANTE} días; revisá la fecha.`,
};

// Los errores solo le sirven a quien se equivocó: privados y se borran solos.
async function errorPrivado(interaction, content) {
	await interaction.reply({ content, ephemeral: true });
	autoCleanupReply(interaction);
}

// Un aviso a todo el grupo va al canal de avisos del servidor. Si el comando se usó justo en ese canal, el
// aviso es la propia respuesta (sin mensaje aparte); si no, se publica allí y quien lo usó recibe una
// confirmación privada. Devuelve la respuesta ya enviada.
async function publicarOResponder(interaction, canalId, quedada, tipo, votantes, imageUrl) {
	if (interaction.channelId === canalId) {
		await interaction.editReply({ content: `${tipo === 'cancelada' ? '❌' : '📺'} ${menciones(votantes, quedada.createdBy)}`, embeds: [armarAviso(tipo, quedada, { imageUrl })] });
		return true;
	}
	await publicarAviso(interaction.client, quedada, tipo);
	return false;
}

// Busca animes pendientes (capítulos sin ver) que TODAS las personas en `personasIds` tienen en común,
// en CUALQUIER temporada. Devuelve lista de {malId, title, seasonLabel, imageUrl, guildId}.
function buscarAnimesPendientesComunes(guildId, personasIds) {
	if (personasIds.length === 0) return [];

	// Mapa de qué animes y cuántos capítulos cada persona tiene pendiente, por temporada
	const animesPorPersona = new Map(); // `${malId}:${seasonLabel}` → Set(discordIds de quienes lo tienen pendiente)

	for (const personaId of personasIds) {
		const anime = getAllAnime().filter((a) => a.guildId === guildId);
		for (const a of anime) {
			// El último capítulo detectado (si no hay, no hay pendiente)
			const ultimoDetectado = getWatchers({ seasonLabel: a.seasonLabel, malId: a.malId }).includes(personaId) ? true : false;
			if (!ultimoDetectado) continue; // Esta persona no vota este anime en esta temporada

			const votoPersona = getVotesForSeason(a.seasonLabel).find((v) => v.malId === a.malId && v.discordId === personaId);
			if (!votoPersona || votoPersona.voteType === 'rojo') continue; // No lo está viendo

			// Tiene voto verde/naranja pero podría estar al día o tener pendiente
			const episodiosVistos = getEpisodesWatched({ seasonLabel: a.seasonLabel, malId: a.malId, discordId: personaId });
			if (episodiosVistos === 0) continue; // Nunca marcó capítulo, probablemente no lo está viendo de verdad

			const key = `${a.malId}:${a.seasonLabel}`;
			if (!animesPorPersona.has(key)) animesPorPersona.set(key, new Set());
			animesPorPersona.get(key).add(personaId);
		}
	}

	// Filtra solo animes donde TODAS las personas están viéndolo
	const comunes = [];
	for (const [key, personas] of animesPorPersona) {
		if (personas.size === personasIds.length) {
			const [malId, seasonLabel] = key.split(':');
			const anime = getAnimeForSeason(seasonLabel).find((a) => a.guildId === guildId && a.malId === Number(malId));
			if (anime) comunes.push(anime);
		}
	}

	return comunes;
}

async function crear(interaction) {
	const guildId = interaction.guildId;
	if (!getNotificationChannel(guildId)) {
		return errorPrivado(interaction, 'Falta el canal de avisos: un admin tiene que configurarlo con `/avisos-canal`.');
	}

	// Cargar miembros del guild si no está en caché
	if (interaction.guild.members.cache.size < interaction.guild.memberCount) {
		try {
			await interaction.guild.members.fetch();
		} catch (err) {
			console.error('[quedada] no pude refrescar la lista de miembros:', err.message);
		}
	}

	// Construir selector de usuarios: todos los que votaron ALGO en cualquier temporada
	const todosLosVotos = getVotesForSeason(getActiveSeason(guildId)).flatMap((v) =>
		getVotesForSeason(null) ? [] : v, // Esto no funciona, necesito obtener TODOS los votos
	);
	// Mejor: recorrer ALL temporadas
	const todasLasTemporadas = [...new Set(getAllAnime().filter((a) => a.guildId === guildId).map((a) => a.seasonLabel))];
	const votantesUnicos = new Set();
	for (const temp of todasLasTemporadas) {
		getVotesForSeason(temp)
			.filter((v) => v.voteType !== 'rojo')
			.forEach((v) => votantesUnicos.add(v.discordId));
	}

	const votantes = [...votantesUnicos]
		.map((id) => interaction.guild.members.cache.get(id))
		.filter(Boolean)
		.map((member) => ({ id: member.id, displayName: member.displayName }))
		.sort((a, b) => a.displayName.localeCompare(b.displayName));

	if (votantes.length === 0) {
		return errorPrivado(interaction, 'Nadie ha votado ningún anime todavía en este servidor.');
	}

	// StringSelectMenu para elegir personas
	const select = new StringSelectMenuBuilder()
		.setCustomId(`quedadapersonas:${interaction.id}`)
		.setPlaceholder('¿Quiénes van a la quedada? (sin seleccionar = solo tú)')
		.setMinValues(0)
		.setMaxValues(Math.min(votantes.length, 25))
		.addOptions(votantes.slice(0, 25).map((u) => ({ label: u.displayName, value: u.id })));

	await interaction.reply({
		content: `¿Quiénes van a ver el anime juntos? Sin seleccionar = solo tú. Luego elige el anime que tienen en común.`,
		components: [new ActionRowBuilder().addComponents(select)],
		ephemeral: true,
	});
}

// Manejador del selector de personas (StringSelectMenu quedadapersonas:...)
async function handleQuedadaPersonasSelect(interaction, token) {
	const guildId = interaction.guildId;
	const personasIds = interaction.values.length > 0 ? interaction.values : [interaction.user.id];

	// Buscar animes que esas personas tienen en común
	const animesPendientes = buscarAnimesPendientesComunes(guildId, personasIds);

	if (animesPendientes.length === 0) {
		await interaction.reply({
			content: 'No hay animes que esas personas tengan pendientes en común.',
			ephemeral: true,
		});
		return;
	}

	// Guardar en cache para el modal posterior
	interaction.client.quedadaFlowCache = interaction.client.quedadaFlowCache ?? new Map();
	interaction.client.quedadaFlowCache.set(token, {
		guildId,
		personasIds,
		personasDisplayNames: personasIds.map((id) => interaction.guild.members.cache.get(id)?.displayName ?? id),
		animesPendientes,
	});

	// Abrir modal con anime/dia/hora/repetir/nota
	const modal = new ModalBuilder().setCustomId(`quedadacrear:${token}`).setTitle('Crear quedada');

	const animeInput = new TextInputBuilder()
		.setCustomId('anime')
		.setLabel('¿Qué anime? (escribí para buscar)')
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setPlaceholder('Escribe el nombre del anime');

	const diaInput = new TextInputBuilder()
		.setCustomId('dia')
		.setLabel('¿Qué día? (hoy, mañana, viernes, 25/09)')
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setPlaceholder('Por ejemplo: mañana');

	const horaInput = new TextInputBuilder()
		.setCustomId('hora')
		.setLabel('¿Qué hora? (21:30)')
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setPlaceholder('Por ejemplo: 21:30');

	const notaInput = new TextInputBuilder()
		.setCustomId('nota')
		.setLabel('Nota (opcional, max 200 caracteres)')
		.setStyle(TextInputStyle.Paragraph)
		.setRequired(false)
		.setMaxLength(200);

	modal.addComponents(
		new ActionRowBuilder().addComponents(animeInput),
		new ActionRowBuilder().addComponents(diaInput),
		new ActionRowBuilder().addComponents(horaInput),
		new ActionRowBuilder().addComponents(notaInput),
	);

	await interaction.showModal(modal);
}

async function listar(interaction) {
	const lista = listQuedadasGuild(interaction.guildId);
	if (lista.length === 0) {
		await interaction.reply({ content: 'No hay quedadas programadas.' });
		return;
	}
	const lineas = lista
		.slice(0, 20)
		.map((q) => `**#${q.id}** · ${q.title} — ${momentoTexto(q.fecha, q.hora)}${q.weekly ? ' 🔁' : ''} · <@${q.createdBy}>`);
	if (lista.length > 20) lineas.push(`_…y ${lista.length - 20} más._`);
	await interaction.reply({ content: `**Quedadas programadas**\n${lineas.join('\n')}`, allowedMentions: { parse: [] } });
}

async function cancelar(interaction) {
	const quedada = getQuedada(Number(interaction.options.getString('quedada', true)));
	if (!quedada || quedada.guildId !== interaction.guildId) {
		return errorPrivado(interaction, 'No encontré esa quedada (¿ya empezó o la cancelaron?). Elegí una de la lista que aparece al escribir.');
	}
	const esAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
	if (quedada.createdBy !== interaction.user.id && !esAdmin) {
		return errorPrivado(interaction, 'Solo quien la organizó o un admin puede cancelarla.');
	}

	deleteQuedada(quedada.id);
	const canalId = getNotificationChannel(interaction.guildId);
	const votantes = getWatchers({ seasonLabel: quedada.seasonLabel, malId: quedada.malId });

	await interaction.deferReply({ ephemeral: interaction.channelId !== canalId });
	try {
		if (!canalId) throw new Error('el servidor no tiene canal de avisos configurado');
		const enElCanal = await publicarOResponder(interaction, canalId, quedada, 'cancelada', votantes, null);
		if (!enElCanal) {
			await interaction.editReply(`🗑️ Quedada **#${quedada.id}** cancelada. Avisé en <#${canalId}>.`);
			autoCleanupReply(interaction);
		}
	} catch (err) {
		console.error('[quedada] cancelada, pero no pude avisar en el canal:', err.message);
		await interaction.editReply(`🗑️ Quedada **#${quedada.id}** cancelada, pero no pude avisar al grupo (${err.message}).`);
	}
}

async function execute(interaction) {
	const sub = interaction.options.getSubcommand();
	if (sub === 'crear') return crear(interaction);
	if (sub === 'cancelar') return cancelar(interaction);
	return listar(interaction);
}

async function autocompleteAnime(interaction, seasonLabel) {
	const votados = new Set(getUserVotedAnime({ seasonLabel, discordId: interaction.user.id }));
	const buscado = interaction.options.getFocused().toLowerCase();
	const vistos = new Set();
	const opciones = getAnimeForSeason(seasonLabel)
		.filter((anime) => anime.guildId === interaction.guildId && votados.has(anime.malId))
		.filter((anime) => anime.title.toLowerCase().includes(buscado) || getDisplayTitle(anime).toLowerCase().includes(buscado))
		.filter((anime) => (vistos.has(anime.malId) ? false : (vistos.add(anime.malId), true)))
		.slice(0, 25)
		.map((anime) => ({ name: getDisplayTitle(anime).slice(0, 100), value: String(anime.malId) }));
	await interaction.respond(opciones);
}

async function autocomplete(interaction) {
	const sub = interaction.options.getSubcommand();
	const focused = interaction.options.getFocused(true);

	if (sub === 'crear' && focused.name === 'anime') {
		const seasonLabel = getActiveSeason(interaction.guildId);
		return seasonLabel ? autocompleteAnime(interaction, seasonLabel) : interaction.respond([]);
	}

	if (sub === 'crear' && focused.name === 'dia') {
		const buscado = focused.value.toLowerCase();
		const opciones = sugerenciasDia(Date.now())
			.filter((s) => s.etiqueta.toLowerCase().includes(buscado))
			.map((s) => ({ name: s.etiqueta, value: s.valor }));
		return interaction.respond(opciones);
	}

	if (sub === 'cancelar') {
		const buscado = focused.value.toLowerCase();
		const opciones = listQuedadasGuild(interaction.guildId)
			.map((q) => ({ name: `#${q.id} · ${q.title} — ${momentoTexto(q.fecha, q.hora)}`.slice(0, 100), value: String(q.id) }))
			.filter((o) => o.name.toLowerCase().includes(buscado))
			.slice(0, 25);
		return interaction.respond(opciones);
	}

	return interaction.respond([]);
}

async function handleQuedadaCrearModal(interaction, token) {
	const cached = interaction.client.quedadaFlowCache?.get(token);
	if (!cached) {
		await interaction.reply({ content: 'Esto ya expiró. Volvé a hacer `/quedada crear`.', ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}

	const { guildId, personasIds, personasDisplayNames, animesPendientes } = cached;
	const malIdTexto = interaction.fields.getTextInputValue('anime').toLowerCase();
	const diaTexto = interaction.fields.getTextInputValue('dia');
	const horaTexto = interaction.fields.getTextInputValue('hora');
	const notaTexto = interaction.fields.getTextInputValue('nota') || null;

	// Buscar el anime por nombre
	const animeElegido = animesPendientes.find(
		(a) => a.title.toLowerCase().includes(malIdTexto) || getDisplayTitle(a).toLowerCase().includes(malIdTexto),
	);
	if (!animeElegido) {
		await interaction.reply({
			content: `No encontré ese anime en los pendientes de ese grupo. Probá con otro nombre.`,
			ephemeral: true,
		});
		autoCleanupReply(interaction);
		return;
	}

	const canalId = getNotificationChannel(guildId);
	const ahora = Date.now();
	const momento = resolverMomento(diaTexto, horaTexto, ahora);
	if (momento.error) {
		await interaction.reply({ content: ERRORES[momento.error], ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}

	const { seasonLabel, malId } = animeElegido;
	if (
		listQuedadasGuild(guildId).some((q) => q.seasonLabel === seasonLabel && q.malId === malId && q.startsAt === momento.startsAt)
	) {
		await interaction.reply({ content: 'Ya hay una quedada de ese anime a esa hora.', ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}

	const quedada = {
		guildId,
		seasonLabel,
		malId,
		title: getDisplayTitle(animeElegido),
		fecha: momento.fecha,
		hora: momento.hora,
		startsAt: momento.startsAt,
		weekly: false, // Por ahora no repetir, se puede agregar después si se pide
		note: notaTexto,
		createdBy: interaction.user.id,
		hourSent: momento.startsAt - ahora < HORA_MS,
	};
	quedada.id = createQuedada(quedada);

	await interaction.deferReply({ ephemeral: interaction.channelId !== canalId });
	try {
		const votantes = getWatchers({ seasonLabel, malId });
		const enElCanal = await publicarOResponder(interaction, canalId, quedada, 'nueva', votantes, animeElegido.imageUrl);
		if (!enElCanal) {
			await interaction.editReply(
				`✅ Quedada **#${quedada.id}** creada: **${quedada.title}** con ${personasDisplayNames.join(', ')}, ${momentoTexto(quedada.fecha, quedada.hora)}. Avisé en <#${canalId}>.`,
			);
			autoCleanupReply(interaction);
		}
	} catch (err) {
		deleteQuedada(quedada.id);
		console.error('[quedada] no pude publicar el aviso, deshago la quedada:', err.message);
		await interaction.editReply(`No pude publicar el aviso en <#${canalId}> (${err.message}), así que no creé la quedada.`);
	}

	interaction.client.quedadaFlowCache?.delete(token);
}

module.exports = { data, execute, autocomplete, handleQuedadaPersonasSelect, handleQuedadaCrearModal };
