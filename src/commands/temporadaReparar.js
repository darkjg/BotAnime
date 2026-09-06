const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { repairSeasonTab } = require('../services/sheets');
const { getAnimeForSeason } = require('../services/db');
const { autoCleanupReply } = require('../ephemeral');

const data = new SlashCommandBuilder()
	.setName('temporada-reparar')
	.setDescription('Repara la pestaña de una temporada si quedó descolocada (huecos, duplicados o desorden por día)')
	.addStringOption((option) =>
		option
			.setName('nombre')
			.setDescription('Nombre exacto de la pestaña de la sheet a reparar, ej: "Verano 2026"')
			.setRequired(true),
	)
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

function summarizeBlock(label, result) {
	if (!result) return null;
	const { fixedDuplicates, fixedGaps, reordered } = result;
	if (fixedDuplicates === 0 && fixedGaps === 0 && reordered === 0) return null;

	const parts = [];
	if (fixedDuplicates > 0) parts.push(`${fixedDuplicates} columna(s) duplicada(s) borrada(s)`);
	if (fixedGaps > 0) parts.push(`${fixedGaps} hueco(s) cerrado(s)`);
	if (reordered > 0) parts.push(`${reordered} anime(s) reordenado(s) por día`);
	return `**${label}**: ${parts.join(', ')}`;
}

function summarizeCrossBlock(result) {
	if (!result || result.fixed === 0) return null;
	const base = `**Duplicados entre bloques**: ${result.fixed} anime(s) que estaban repetidos en más de un bloque (nuevo/secuela/CONTINUAN), arreglado.`;
	if (result.warnings.length === 0) return base;
	return `${base}\n⚠️ ${result.warnings.join('\n⚠️ ')}`;
}

// La base de datos manda para decidir carryover (ver temporadaShared.js: addCarryoverAnime lee
// getPreviousSeasonLabel/getAnimeForSeason, no la Sheet). Esto solo CONTRASTA esa decisión contra lo
// que hay físicamente en el bloque CONTINUAN y avisa si no coinciden — no corrige nada solo, porque
// cualquiera de los dos lados podría ser el "correcto" (un carryover borrado a mano en la Sheet, o un
// isCarryover que quedó mal seteado en la base) y auto-arreglarlo a ciegas podría pisar lo que sí estaba bien.
function summarizeCarryoverDiscrepancy(seasonLabel, continuanMalIds) {
	const dbCarryoverMalIds = new Set(
		getAnimeForSeason(seasonLabel)
			.filter((a) => a.isCarryover && !a.isAbandoned)
			.map((a) => a.malId),
	);
	const sheetMalIds = new Set(continuanMalIds ?? []);

	const soloEnBase = [...dbCarryoverMalIds].filter((id) => !sheetMalIds.has(id));
	const soloEnSheet = [...sheetMalIds].filter((id) => !dbCarryoverMalIds.has(id));
	if (soloEnBase.length === 0 && soloEnSheet.length === 0) return null;

	const partes = [];
	if (soloEnBase.length > 0) partes.push(`la base los marca como carryover pero no están en CONTINUAN: ${soloEnBase.join(', ')}`);
	if (soloEnSheet.length > 0) partes.push(`están en CONTINUAN pero la base no los marca como carryover: ${soloEnSheet.join(', ')}`);
	return `⚠️ **Discrepancia de carryover** (malId): ${partes.join(' · ')}. Revisar a mano, no se corrigió solo.`;
}

async function execute(interaction) {
	await interaction.deferReply({ ephemeral: true });

	const nombre = interaction.options.getString('nombre', true);
	console.log(`[temporada-reparar] reparando "${nombre}"...`);

	try {
		const report = await repairSeasonTab(nombre);
		const lines = [
			summarizeCrossBlock(report.crossBlock),
			summarizeBlock('Nuevo', report.nuevo),
			summarizeBlock('Secuela', report.secuela),
			summarizeBlock('CONTINUAN', report.continuan),
			summarizeBlock('ABANDONADOS', report.abandonados),
			summarizeCarryoverDiscrepancy(nombre, report.continuanMalIds),
		].filter(Boolean);

		console.log(`[temporada-reparar] "${nombre}" reparada: ${lines.join(' | ') || 'sin cambios'}`);
		await interaction.editReply(
			lines.length > 0 ? `Reparé **${nombre}**:\n${lines.join('\n')}` : `Revisé **${nombre}**, no encontré nada que reparar.`,
		);
	} catch (err) {
		console.error(`[temporada-reparar] no pude reparar "${nombre}":`, err.message);
		await interaction.editReply(`No pude reparar "${nombre}": ${err.message}`);
	}
	autoCleanupReply(interaction);
}

module.exports = { data, execute };
