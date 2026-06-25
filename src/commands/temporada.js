const { SlashCommandBuilder, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getSeasonAnime, getAnimeById } = require('../services/jikan');
const { ensureSeasonTab, ensureAnimeColumn, getPreviousTabMalIds } = require('../services/sheets');
const { defaultSeasonLabel, slugForCustomId, ES_SEASON_TO_JIKAN, JIKAN_SEASON_TO_ES, nextSeason, seasonAtOffset } = require('../seasonLabel');
const { rememberAnime, rememberSeasonLabel, rememberSeasonOrder } = require('../seasonCache');
const { buildAnimeEmbed, buildVoteRow } = require('../components');

const VOTE_ROLE_ID = process.env.VOTE_ROLE_ID;
const MAX_MENTIONED_VOTERS = 10;
const SEASON_PICKER_RANGE = { from: -2, to: 4 }; // temporadas relativas a la actual que se muestran en el selector

async function getVoterNames(interaction) {
	const byId = new Map();

	if (VOTE_ROLE_ID && interaction.guild) {
		await interaction.guild.members.fetch();
		const role = interaction.guild.roles.cache.get(VOTE_ROLE_ID);
		role?.members.forEach((member) => byId.set(member.id, member.displayName));
	}

	for (let i = 1; i <= MAX_MENTIONED_VOTERS; i += 1) {
		const member = interaction.options.getMember(`usuario${i}`);
		const user = interaction.options.getUser(`usuario${i}`);
		if (user) byId.set(user.id, member?.displayName ?? user.username);
	}

	return [...byId.values()];
}

const data = new SlashCommandBuilder()
	.setName('temporada')
	.setDescription('Publica los animes de una temporada para votar si los veremos')
	.addStringOption((option) =>
		option
			.setName('estacion')
			.setDescription('Estación a publicar. Si se omite junto con "anio", se abre un selector.')
			.setRequired(false)
			.addChoices(
				{ name: 'Invierno', value: 'invierno' },
				{ name: 'Primavera', value: 'primavera' },
				{ name: 'Verano', value: 'verano' },
				{ name: 'Otoño', value: 'otono' },
			),
	)
	.addIntegerOption((option) =>
		option.setName('anio').setDescription('Año de la temporada, ej: 2026. Si se omite, se usa el año actual.').setRequired(false),
	)
	.addStringOption((option) =>
		option
			.setName('nombre')
			.setDescription('Nombre de la pestaña de la sheet, ej: "Verano 2026". Si se omite, se calcula automáticamente.')
			.setRequired(false),
	);

for (let i = 1; i <= MAX_MENTIONED_VOTERS; i += 1) {
	data.addUserOption((option) =>
		option.setName(`usuario${i}`).setDescription('Persona que va a votar en esta temporada').setRequired(false),
	);
}

function seasonOptionLabel({ year, season }) {
	return `${JIKAN_SEASON_TO_ES[season]} ${year}`;
}

function buildSeasonSelectRow() {
	const options = [];
	for (let offset = SEASON_PICKER_RANGE.from; offset <= SEASON_PICKER_RANGE.to; offset += 1) {
		const { year, season } = seasonAtOffset(offset);
		options.push({ label: seasonOptionLabel({ year, season }), value: `${year}:${season}` });
	}

	const select = new StringSelectMenuBuilder().setCustomId('seasonselect').setPlaceholder('Elige la temporada a publicar').addOptions(options);
	return new ActionRowBuilder().addComponents(select);
}

async function execute(interaction) {
	await interaction.deferReply();

	const estacionOpt = interaction.options.getString('estacion');
	const anioOpt = interaction.options.getInteger('anio');
	const nombreOverride = interaction.options.getString('nombre');
	const voterNames = await getVoterNames(interaction);

	if (!estacionOpt && !anioOpt) {
		await interaction.editReply({ content: '¿Qué temporada quieres publicar?', components: [buildSeasonSelectRow()] });
		const message = await interaction.fetchReply();
		interaction.client.seasonPickerCache = interaction.client.seasonPickerCache ?? new Map();
		interaction.client.seasonPickerCache.set(message.id, { nombreOverride, voterNames });
		return;
	}

	const fallback = nextSeason();
	const season = estacionOpt ? ES_SEASON_TO_JIKAN[estacionOpt] : fallback.season;
	const year = anioOpt ?? (estacionOpt ? new Date().getFullYear() : fallback.year);

	await publishSeason({
		channel: interaction.channel ?? (await interaction.client.channels.fetch(interaction.channelId)),
		respond: (content) => interaction.editReply(content),
		year,
		season,
		nombreOverride,
		voterNames,
	});
}

function buildConfirmRow(year, season) {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId(`seasonconfirm:${year}:${season}`).setLabel('Confirmar').setStyle(ButtonStyle.Success),
	);
}

// Llamada desde interactions.js tras elegir una opción del selector: muestra un botón de
// confirmación antes de publicar nada, por si el usuario se equivocó de temporada.
async function handleSeasonSelect(interaction, year, season) {
	await interaction.update({
		content: `Vas a publicar **${seasonOptionLabel({ year, season: season })}**. ¿Confirmas?`,
		components: [buildConfirmRow(year, season)],
	});
}

// Llamada desde interactions.js al pulsar "Confirmar": recupera el nombre/voters guardados al
// abrir el selector (van ligados al mensaje, no a esta nueva interacción) y publica la temporada.
async function handleSeasonConfirm(interaction, year, season) {
	const pending = interaction.client.seasonPickerCache?.get(interaction.message.id) ?? {};
	interaction.client.seasonPickerCache?.delete(interaction.message.id);

	await interaction.update({ content: `Publicando **${seasonOptionLabel({ year, season })}**...`, components: [] });

	await publishSeason({
		channel: interaction.channel ?? (await interaction.client.channels.fetch(interaction.channelId)),
		respond: (content) => interaction.editReply(content),
		year: Number(year),
		season,
		nombreOverride: pending.nombreOverride,
		voterNames: pending.voterNames ?? [],
	});
}

async function publishSeason({ channel, respond, year, season, nombreOverride, voterNames }) {
	const anime = await getSeasonAnime(year, season);
	if (anime.length === 0) {
		await respond('No encontré animes para esa temporada.');
		return;
	}

	const seasonLabel = nombreOverride ?? defaultSeasonLabel(anime[0]);
	await ensureSeasonTab(seasonLabel);
	anime.forEach(rememberAnime);
	const seasonSlug = slugForCustomId(seasonLabel);
	rememberSeasonLabel(seasonSlug, seasonLabel);
	rememberSeasonOrder(seasonSlug, anime.map((entry) => entry.malId));

	const carryoverCount = await addCarryoverAnime(seasonLabel, anime);

	const voterList = voterNames.length > 0 ? voterNames.map((name) => `**${name}**`).join(', ') : 'nadie con el rol de votación todavía';

	const carryoverNote =
		carryoverCount > 0 ? ` Además, agregué **${carryoverCount}** anime(s) que seguían en emisión de la temporada anterior a "CONTINUAN".` : '';

	await respond(
		`Publicando **${anime.length}** animes de **${seasonLabel}** en este canal. Los votos se guardarán en la pestaña "${seasonLabel}" de la sheet.${carryoverNote}\nVan a votar: ${voterList}.`,
	);

	const first = anime[0];
	await channel.send({
		embeds: [buildAnimeEmbed(first, { index: 0, total: anime.length })],
		components: buildVoteRow(seasonLabel, first.malId, { index: 0, total: anime.length }),
	});
}

// Animes que ya estaban en la pestaña anterior (en cualquiera de sus bloques) y que en MAL siguen
// "Currently Airing" se agregan directo al subgrupo CONTINUAN, sin esperar a que alguien vote.
async function addCarryoverAnime(seasonLabel, currentSeasonAnime) {
	const currentMalIds = new Set(currentSeasonAnime.map((a) => a.malId));
	const previousMalIds = await getPreviousTabMalIds(seasonLabel);

	let count = 0;
	for (const malId of previousMalIds) {
		if (currentMalIds.has(malId)) continue;
		try {
			const fullAnime = await getAnimeById(malId);
			if (fullAnime.status !== 'Currently Airing') continue;
			rememberAnime(fullAnime);
			await ensureAnimeColumn(seasonLabel, { ...fullAnime, isCarryover: true });
			count += 1;
		} catch {
			// si Jikan falla para este anime en particular, lo saltamos sin romper el comando
		}
	}
	return count;
}

module.exports = { data, execute, handleSeasonSelect, handleSeasonConfirm };
