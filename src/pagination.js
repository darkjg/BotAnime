// Agrupa bloques de texto en páginas de hasta `maxCharsPerPage` caracteres, sin partir un bloque a la
// mitad salvo que el bloque solo ya supere el límite (caso raro: alguien con decenas de animes).
// Compartido entre /en-comun y /pendientes (antes duplicado en cada uno).
function paginateBlocks(blocks, maxCharsPerPage) {
	const pages = [];
	let current = [];
	let currentLen = 0;

	for (const block of blocks) {
		if (block.length > maxCharsPerPage) {
			if (current.length > 0) {
				pages.push(current.join('\n\n'));
				current = [];
				currentLen = 0;
			}
			for (const line of block.split('\n')) {
				if (currentLen + line.length + 1 > maxCharsPerPage && current.length > 0) {
					pages.push(current.join('\n'));
					current = [];
					currentLen = 0;
				}
				current.push(line);
				currentLen += line.length + 1;
			}
			pages.push(current.join('\n'));
			current = [];
			currentLen = 0;
			continue;
		}

		if (currentLen + block.length + 2 > maxCharsPerPage && current.length > 0) {
			pages.push(current.join('\n\n'));
			current = [];
			currentLen = 0;
		}
		current.push(block);
		currentLen += block.length + 2;
	}
	if (current.length > 0) pages.push(current.join('\n\n'));

	return pages.length > 0 ? pages : [''];
}

module.exports = { paginateBlocks };
