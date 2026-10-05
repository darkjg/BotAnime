const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getAllAnime, getAnimeNickname, setAnimeNickname } = require('../services/db');
const { findNicknameCandidates } = require('../services/sheets');
const { autoCleanupReply } = require('../ephemeral');

const data = new SlashCommandBuilder()
	.setName('apodos-importar')
	.setDescription('Revisa temporadas anteriores por apodos puestos a mano en la sheet y los guarda para /apodo')
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

// De vez en cuando alguien le escribía un apodo a mano encima del título real en la sheet, antes de que
// existiera /apodo. Esto recorre TODAS las pestañas buscando esas diferencias (título mostrado vs. el
// que tenemos guardado del malId, ver getAllAnime) y las carga en la base de apodos, para que a partir
// de ahora cualquier temporada nueva del mismo anime ya salga con ese apodo sin tener que ponerlo de
// nuevo. No toca los hilos/embeds de la temporada activa — para eso está /apodo o /refrescar-hilos.
async function execute(interaction) {
	await interaction.deferReply({ ephemeral: true });
	await interaction.editReply('Revisando las pestañas anteriores, puede tardar un rato...');

	let candidates;
	try {
		candidates = await findNicknameCandidates();
	} catch (err) {
		await interaction.editReply(`No pude terminar de revisar las pestañas: ${err.message}`);
		autoCleanupReply(interaction);
		return;
	}

	// getAllAnime no distingue temporada/guild: si el mismo malId aparece en varios registros (lo normal
	// para un anime que ya pasó por varias temporadas), cualquiera de ellos sirve como "título real" —
	// upsertAnime nunca pisa el título real por otra cosa que no sea el propio título real de MAL.
	const realTitles = new Map(getAllAnime().map((a) => [a.malId, a.title]));

	let imported = 0;
	let alreadyHadNickname = 0;
	let unknownAnime = 0;
	const importedList = [];

	for (const [malId, displayedTitle] of candidates) {
		const real = realTitles.get(malId);
		if (!real) {
			unknownAnime += 1;
			continue;
		}
		if (displayedTitle === real) continue; // coincide con el real, no es un apodo

		if (getAnimeNickname(malId)) {
			alreadyHadNickname += 1;
			continue;
		}

		setAnimeNickname({ malId, nickname: displayedTitle, setBy: 'apodos-importar' });
		imported += 1;
		importedList.push(`**${real}** → ${displayedTitle}`);
	}

	console.log(`[apodos-importar] ${interaction.user.tag}: ${imported} apodo(s) importado(s), ${alreadyHadNickname} ya tenían, ${unknownAnime} sin verificar`);

	const lines = [`Listo. Importé **${imported}** apodo(s) de pestañas anteriores.`];
	if (importedList.length > 0) {
		const shown = importedList.slice(0, 25);
		lines.push(shown.map((l) => `• ${l}`).join('\n'));
		if (importedList.length > shown.length) lines.push(`…y ${importedList.length - shown.length} más.`);
	}
	if (alreadyHadNickname > 0) lines.push(`${alreadyHadNickname} ya tenían un apodo puesto con /apodo, no los toqué.`);
	if (unknownAnime > 0) {
		lines.push(`${unknownAnime} anime(s) con texto distinto al link pero que no tengo registrados acá, no los pude verificar.`);
	}
	lines.push('Esto no cambió los hilos de la temporada activa — corré /refrescar-hilos si querés verlo reflejado ahí ya mismo.');

	let content = lines.join('\n\n');
	if (content.length > 1900) content = `${content.slice(0, 1900)}\n…(recortado)`;
	await interaction.editReply(content);
	autoCleanupReply(interaction);
}

module.exports = { data, execute };
