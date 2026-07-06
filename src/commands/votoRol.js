const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { setVoteRole } = require('../services/db');

const data = new SlashCommandBuilder()
	.setName('voto-rol')
	.setDescription('Configura qué rol puede votar en este servidor (si no se configura ninguno, puede votar cualquiera)')
	.addRoleOption((option) => option.setName('rol').setDescription('Rol que va a poder votar').setRequired(true))
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function execute(interaction) {
	const role = interaction.options.getRole('rol', true);
	setVoteRole({ guildId: interaction.guildId, roleId: role.id });
	console.log(`[voto-rol] rol de voto del guild ${interaction.guildId} configurado a "${role.name}" (${role.id})`);
	await interaction.reply(`Listo, a partir de ahora solo quienes tengan el rol **${role.name}** van a poder votar en este servidor.`);
}

module.exports = { data, execute };
