const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.SHEET_ID;
const KEY_FILE = process.env.GOOGLE_APPLICATION_CREDENTIALS || 'credentials.json';

// Layout (1-indexed rows/cols como en Sheets):
// Col A: rows 1-3 = leyenda, rows 4-6 = vacío (acompaña la imagen), row 7 = "Nombre", row 8+ = usuarios
// del bloque "nuevo". Tras su fila "Día de emisión" se dejan 2 filas en blanco y se repite la misma
// estructura (etiqueta + imagen + título + usuarios + día) para el bloque "continuación", que a su vez
// tiene dos subgrupos de columnas lado a lado: secuelas (2da/3ra/... temporada) y, más a la derecha
// bajo la etiqueta "CONTINUAN", animes que ya se emitían la temporada pasada y siguen en emisión.
const NAME_COL_INDEX = 0; // A
const FIRST_ANIME_COL_INDEX = 1; // B
const IMAGE_ROW_SPAN = 6;
const NUEVO_TITLE_ROW = 7;
const NUEVO_USER_START = 8;
const BLANK_ROWS_BETWEEN_BLOCKS = 2;
const DAY_LABEL = 'Día de emisión';
const NAME_LABEL = 'Nombre';
const CONTINUACION_LABEL = '2/3/4/5 TEMPORADAS';
const SIGUEN_LABEL = 'CONTINUAN';
const BLACK = { red: 0, green: 0, blue: 0 };
const THIN_BLACK_BORDER = { style: 'SOLID', width: 1, color: BLACK };
const THICK_BLACK_BORDER = { style: 'SOLID_THICK', width: 3, color: BLACK };
const BROADCAST_DAY_ORDER = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

function broadcastDayRank(day) {
	const index = BROADCAST_DAY_ORDER.indexOf(day);
	return index === -1 ? BROADCAST_DAY_ORDER.length : index;
}

// Caché en memoria de "malId -> columna" por temporada, para no preguntarle a Sheets la misma
// ubicación en cada click de navegación. Se invalida por temporada entera cuando se crea una
// columna nueva (puede correr otras columnas hacia la derecha).
const animeColumnCache = new Map();

function invalidateColumnCache(seasonName) {
	const prefix = `${seasonName}::`;
	for (const key of animeColumnCache.keys()) {
		if (key.startsWith(prefix)) animeColumnCache.delete(key);
	}
}

const VOTE_STYLES = {
	verde: { label: '0', color: { red: 0, green: 1, blue: 0 } },
	naranja: { label: '0', color: { red: 1, green: 0.6, blue: 0 } },
	rojo: { label: '0', color: { red: 1, green: 0, blue: 0 } },
};

const LEGEND = [
	{ text: 'CON TODO', color: VOTE_STYLES.verde.color },
	{ text: 'UNOS CAP TIMIDINES', color: VOTE_STYLES.naranja.color },
	{ text: 'DROP DESPIADADO', color: VOTE_STYLES.rojo.color },
];

let sheetsClientPromise = null;

function getSheetsClient() {
	if (!sheetsClientPromise) {
		sheetsClientPromise = (async () => {
			const auth = new google.auth.GoogleAuth({
				keyFile: KEY_FILE,
				scopes: ['https://www.googleapis.com/auth/spreadsheets'],
			});
			return google.sheets({ version: 'v4', auth: await auth.getClient() });
		})();
	}
	return sheetsClientPromise;
}

function columnLetter(index) {
	let letter = '';
	let n = index;
	while (n >= 0) {
		letter = String.fromCharCode((n % 26) + 65) + letter;
		n = Math.floor(n / 26) - 1;
	}
	return letter;
}

async function findSheetByTitle(sheets, title) {
	const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
	return meta.data.sheets.find((s) => s.properties.title === title) ?? null;
}

// El texto de la celda de título puede ser un apodo editado a mano; identificamos el anime por el
// malId incrustado en el link, no por el texto visible. El link puede venir de: una fórmula
// =HYPERLINK(...), un hyperlink de texto enriquecido que cubre toda la celda (cell.hyperlink), o un
// hyperlink de texto enriquecido que cubre solo parte del texto (textFormatRuns[].format.link.uri —
// pasa apenas el link no llega exactamente hasta el último carácter). values.get no devuelve nada de
// esto, por eso usamos spreadsheets.get pidiendo los tres campos.
// startCol/endCol (exclusivo, absolutos) acotan la lectura a un subgrupo de columnas; por defecto
// cubre toda la fila.
async function getMalIdsInRange(sheets, title, titleRow, startCol = FIRST_ANIME_COL_INDEX, endCol = Infinity) {
	const res = await sheets.spreadsheets.get({
		spreadsheetId: SPREADSHEET_ID,
		ranges: [`'${title}'!${titleRow}:${titleRow}`],
		fields: 'sheets.data.rowData.values(userEnteredValue.formulaValue,hyperlink,textFormatRuns.format.link.uri)',
	});
	const row = res.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values ?? [];
	const malIds = [];
	for (let col = startCol; col < Math.min(row.length, endCol); col += 2) {
		const cell = row[col] ?? {};
		const runLinks = (cell.textFormatRuns ?? []).map((run) => run.format?.link?.uri).filter(Boolean);
		const sources = [cell.hyperlink, cell.userEnteredValue?.formulaValue, ...runLinks].filter(Boolean);
		const match = sources.map((source) => /myanimelist\.net\/anime\/(\d+)/.exec(source)).find(Boolean);
		malIds.push(match ? Number(match[1]) : null);
	}
	return malIds;
}

// Busca en una fila el índice de columna (absoluto) donde aparece exactamente `label`.
async function findColumnWithLabel(sheets, title, row, label) {
	const res = await sheets.spreadsheets.values.get({
		spreadsheetId: SPREADSHEET_ID,
		range: `'${title}'!${row}:${row}`,
	});
	const values = res.data.values?.[0] ?? [];
	const index = values.indexOf(label);
	return index === -1 ? null : index;
}

// Devuelve { dayRowIndex, userNames } buscando "Día de emisión" en la columna A a partir de userStart.
async function getUsersAndDayRow(sheets, title, userStart) {
	const res = await sheets.spreadsheets.values.get({
		spreadsheetId: SPREADSHEET_ID,
		range: `'${title}'!${columnLetter(NAME_COL_INDEX)}${userStart}:${columnLetter(NAME_COL_INDEX)}`,
	});
	const values = res.data.values?.map((row) => row[0] ?? '') ?? [];
	const dayOffset = values.findIndex((v) => v === DAY_LABEL);
	if (dayOffset === -1) {
		throw new Error(`No encontré la fila "${DAY_LABEL}" en la pestaña ${title} (a partir de la fila ${userStart})`);
	}
	return { dayRowIndex: userStart + dayOffset, userNames: values.slice(0, dayOffset) };
}

// Posición del bloque "continuación" en base a dónde terminó el bloque "nuevo". No escribe nada;
// `exists` indica si su cabecera ya fue creada.
//
// Lo normal es que haya BLANK_ROWS_BETWEEN_BLOCKS filas vacías entre el día de emisión del bloque
// "nuevo" y la etiqueta de "continuación", pero pestañas viejas (editadas a mano antes de que
// existiera este espaciado) pueden tener menos o más filas de margen. En vez de asumir ese offset
// fijo, buscamos la primera fila no vacía de la columna A cerca de donde debería estar.
async function peekContinuacionLayout(sheets, title) {
	const nuevo = await getUsersAndDayRow(sheets, title, NUEVO_USER_START);
	const defaultLabelRow = nuevo.dayRowIndex + BLANK_ROWS_BETWEEN_BLOCKS + 1;

	const searchStart = nuevo.dayRowIndex + 1;
	const searchEnd = defaultLabelRow + 3;
	const res = await sheets.spreadsheets.values.get({
		spreadsheetId: SPREADSHEET_ID,
		range: `'${title}'!${columnLetter(NAME_COL_INDEX)}${searchStart}:${columnLetter(NAME_COL_INDEX)}${searchEnd}`,
	});
	const values = res.data.values ?? [];
	const offset = values.findIndex((row) => (row[0] ?? '') !== '');
	const labelRow = offset === -1 ? defaultLabelRow : searchStart + offset;

	const imageRow = labelRow + 1;
	const titleRow = imageRow + IMAGE_ROW_SPAN;
	const userStart = titleRow + 1;

	const headerCheck = await sheets.spreadsheets.values.get({
		spreadsheetId: SPREADSHEET_ID,
		range: `'${title}'!A${titleRow}`,
	});
	return { labelRow, imageRow, titleRow, userStart, exists: Boolean(headerCheck.data.values) };
}

// Igual que peekContinuacionLayout, pero crea la cabecera (etiqueta + Nombre + Día de emisión)
// si todavía no existe, y devuelve también su dayRowIndex actual.
async function resolveContinuacionLayout(sheets, title) {
	const layout = await peekContinuacionLayout(sheets, title);

	if (!layout.exists) {
		await sheets.spreadsheets.values.batchUpdate({
			spreadsheetId: SPREADSHEET_ID,
			requestBody: {
				valueInputOption: 'RAW',
				data: [
					{ range: `'${title}'!A${layout.labelRow}`, values: [[CONTINUACION_LABEL]] },
					{ range: `'${title}'!A${layout.titleRow}`, values: [[NAME_LABEL]] },
					{ range: `'${title}'!A${layout.userStart}`, values: [[DAY_LABEL]] },
				],
			},
		});
	}

	const continuacion = await getUsersAndDayRow(sheets, title, layout.userStart);
	return { ...layout, dayRowIndex: continuacion.dayRowIndex };
}

async function ensureColumnCapacity(sheets, sheet, targetCol) {
	const needed = targetCol + 2;
	if (needed > sheet.properties.gridProperties.columnCount) {
		await sheets.spreadsheets.batchUpdate({
			spreadsheetId: SPREADSHEET_ID,
			requestBody: {
				requests: [
					{
						updateSheetProperties: {
							properties: { sheetId: sheet.properties.sheetId, gridProperties: { columnCount: needed } },
							fields: 'gridProperties.columnCount',
						},
					},
				],
			},
		});
		sheet.properties.gridProperties.columnCount = needed;
	}
}

async function writeAnimeBlock(sheets, sheetId, title, anime, voteCol, imageRow, titleRow, dayRowIndex) {
	const col = columnLetter(voteCol);

	await sheets.spreadsheets.values.batchUpdate({
		spreadsheetId: SPREADSHEET_ID,
		requestBody: {
			valueInputOption: 'USER_ENTERED',
			data: [
				{ range: `'${title}'!${col}${imageRow}`, values: [[anime.imageUrl ? `=IMAGE("${anime.imageUrl}"; 1)` : '']] },
				{
					range: `'${title}'!${col}${titleRow}`,
					values: [[anime.url ? `=HYPERLINK("${anime.url}"; "${anime.title.replace(/"/g, "'")}")` : anime.title]],
				},
				{ range: `'${title}'!${col}${dayRowIndex}`, values: [[anime.broadcastDay ?? '']] },
			],
		},
	});

	const checkboxCol = voteCol + 1;

	await sheets.spreadsheets.batchUpdate({
		spreadsheetId: SPREADSHEET_ID,
		requestBody: {
			requests: [
				{
					updateDimensionProperties: {
						range: { sheetId, dimension: 'COLUMNS', startIndex: voteCol, endIndex: voteCol + 1 },
						properties: { pixelSize: 140 },
						fields: 'pixelSize',
					},
				},
				{
					updateDimensionProperties: {
						range: { sheetId, dimension: 'COLUMNS', startIndex: checkboxCol, endIndex: checkboxCol + 1 },
						properties: { pixelSize: 35 },
						fields: 'pixelSize',
					},
				},
				{
					mergeCells: {
						range: {
							sheetId,
							startRowIndex: imageRow - 1,
							endRowIndex: imageRow - 1 + IMAGE_ROW_SPAN,
							startColumnIndex: voteCol,
							endColumnIndex: checkboxCol + 1,
						},
						mergeType: 'MERGE_ALL',
					},
				},
				{
					repeatCell: {
						range: {
							sheetId,
							startRowIndex: imageRow - 1,
							endRowIndex: imageRow - 1 + IMAGE_ROW_SPAN,
							startColumnIndex: voteCol,
							endColumnIndex: checkboxCol + 1,
						},
						cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE' } },
						fields: 'userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment',
					},
				},
				{
					repeatCell: {
						range: { sheetId, startRowIndex: titleRow - 1, endRowIndex: titleRow, startColumnIndex: voteCol, endColumnIndex: voteCol + 1 },
						cell: {
							userEnteredFormat: { horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' },
						},
						fields: 'userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy',
					},
				},
				{
					updateBorders: {
						range: {
							sheetId,
							startRowIndex: imageRow - 1,
							endRowIndex: dayRowIndex,
							startColumnIndex: voteCol,
							endColumnIndex: checkboxCol + 1,
						},
						top: THIN_BLACK_BORDER,
						bottom: THIN_BLACK_BORDER,
						left: THIN_BLACK_BORDER,
						right: THIN_BLACK_BORDER,
						innerHorizontal: THIN_BLACK_BORDER,
						innerVertical: THIN_BLACK_BORDER,
					},
				},
			],
		},
	});
}

// Envuelve solo el subgrupo "CONTINUAN" en un borde negro más grueso, recalculando su ancho
// actual cada vez que se agrega una columna nueva. Las secuelas no llevan este borde.
async function applyContinuacionOuterBorder(sheets, sheetId, title, layout) {
	const siguenStartCol = await findColumnWithLabel(sheets, title, layout.labelRow, SIGUEN_LABEL);
	if (siguenStartCol === null) return;

	const siguenMalIds = await getMalIdsInRange(sheets, title, layout.titleRow, siguenStartCol);
	const endColumnIndex = siguenStartCol + siguenMalIds.length * 2;

	await sheets.spreadsheets.batchUpdate({
		spreadsheetId: SPREADSHEET_ID,
		requestBody: {
			requests: [
				{
					updateBorders: {
						range: {
							sheetId,
							startRowIndex: layout.labelRow - 1,
							endRowIndex: layout.dayRowIndex,
							startColumnIndex: siguenStartCol,
							endColumnIndex,
						},
						top: THICK_BLACK_BORDER,
						bottom: THICK_BLACK_BORDER,
						left: THICK_BLACK_BORDER,
						right: THICK_BLACK_BORDER,
						innerVertical: THIN_BLACK_BORDER,
					},
				},
			],
		},
	});
}

async function writeLegendAndHeader(sheets, sheetId, title) {
	await sheets.spreadsheets.values.batchUpdate({
		spreadsheetId: SPREADSHEET_ID,
		requestBody: {
			valueInputOption: 'RAW',
			data: [
				{ range: `'${title}'!A1`, values: [[LEGEND[0].text]] },
				{ range: `'${title}'!A3`, values: [[LEGEND[1].text]] },
				{ range: `'${title}'!A5`, values: [[LEGEND[2].text]] },
				{ range: `'${title}'!A${NUEVO_TITLE_ROW}`, values: [[NAME_LABEL]] },
				{ range: `'${title}'!A${NUEVO_USER_START}`, values: [[DAY_LABEL]] },
			],
		},
	});

	await sheets.spreadsheets.batchUpdate({
		spreadsheetId: SPREADSHEET_ID,
		requestBody: {
			requests: [
				...LEGEND.flatMap((entry, i) => {
					const startRowIndex = i * 2;
					const endRowIndex = startRowIndex + 2;
					const range = { sheetId, startRowIndex, endRowIndex, startColumnIndex: 0, endColumnIndex: 1 };
					return [
						{ mergeCells: { range, mergeType: 'MERGE_ALL' } },
						{
							repeatCell: {
								range,
								cell: {
									userEnteredFormat: {
										backgroundColor: entry.color,
										horizontalAlignment: 'CENTER',
										verticalAlignment: 'MIDDLE',
									},
								},
								fields:
									'userEnteredFormat.backgroundColor,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment',
							},
						},
					];
				}),
				{
					updateDimensionProperties: {
						range: { sheetId, dimension: 'COLUMNS', startIndex: NAME_COL_INDEX, endIndex: NAME_COL_INDEX + 1 },
						properties: { pixelSize: 110 },
						fields: 'pixelSize',
					},
				},
			],
		},
	});
}

// Crea la pestaña (con leyenda y cabecera del bloque "nuevo") si no existe todavía. No escribe
// ningún anime: las columnas se crean al vuelo (ver ensureAnimeColumn) solo cuando alguien vota
// verde/naranja, en el bloque/subgrupo que corresponda.
async function ensureSeasonTab(seasonName) {
	const sheets = await getSheetsClient();
	const sheet = await findSheetByTitle(sheets, seasonName);
	if (sheet) return;

	const created = await sheets.spreadsheets.batchUpdate({
		spreadsheetId: SPREADSHEET_ID,
		requestBody: {
			requests: [{ addSheet: { properties: { title: seasonName, index: 0, gridProperties: { columnCount: 26 } } } }],
		},
	});
	await writeLegendAndHeader(sheets, created.data.replies[0].addSheet.properties.sheetId, seasonName);
}

// Decide en qué columna absoluta debe escribirse un anime nuevo dentro de un subgrupo de `count`
// animes ya existentes (columnas startCol, startCol+2, ...), comparando su día de emisión contra el
// de cada uno ya escrito en `dayRowIndex`. Si ya hay alguno con un día "más tarde" en la semana,
// devuelve esa columna con insertBefore=true para abrir espacio ahí; si no, se puede escribir al
// final del subgrupo sin insertar nada.
async function findSortedInsertionColumn(sheets, title, dayRowIndex, startCol, count, newDay) {
	if (count === 0) return { col: startCol, insertBefore: false };

	const res = await sheets.spreadsheets.values.get({
		spreadsheetId: SPREADSHEET_ID,
		range: `'${title}'!${dayRowIndex}:${dayRowIndex}`,
	});
	const row = res.data.values?.[0] ?? [];
	const newRank = broadcastDayRank(newDay);

	for (let i = 0; i < count; i += 1) {
		const col = startCol + i * 2;
		if (broadcastDayRank(row[col] ?? null) > newRank) return { col, insertBefore: true };
	}
	return { col: startCol + count * 2, insertBefore: false };
}

// inheritFromBefore: false NO deja las columnas nuevas en blanco — significa que heredan el formato
// de la columna siguiente (la que estaba a la derecha del punto de inserción). Si esa columna tenía
// color de fondo (la barra verde/naranja del voto), la columna recién insertada se queda con esa
// mancha hasta que se le escribe contenido propio. Por eso limpiamos el formato explícitamente acá,
// antes de que writeAnimeBlock/setVote escriban lo suyo.
async function insertColumnsAt(sheets, sheetId, col) {
	await sheets.spreadsheets.batchUpdate({
		spreadsheetId: SPREADSHEET_ID,
		requestBody: {
			requests: [
				{
					insertDimension: {
						range: { sheetId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 2 },
						inheritFromBefore: false,
					},
				},
				{
					repeatCell: {
						range: { sheetId, startColumnIndex: col, endColumnIndex: col + 2 },
						cell: { userEnteredFormat: {} },
						fields: 'userEnteredFormat',
					},
				},
			],
		},
	});
}

// Crea la columna de un anime si todavía no existe en su bloque/subgrupo (identificado por malId).
// Devuelve { animeIndex: colIndex absoluto de su columna de voto, userStart: fila donde empiezan
// los usuarios de ese bloque }.
async function ensureAnimeColumn(seasonName, anime) {
	const sheets = await getSheetsClient();
	const sheet = await findSheetByTitle(sheets, seasonName);
	if (!sheet) throw new Error(`No existe la pestaña de temporada: ${seasonName}`);

	if (!anime.isSequel && !anime.isCarryover) {
		const [malIds, { dayRowIndex }] = await Promise.all([
			getMalIdsInRange(sheets, seasonName, NUEVO_TITLE_ROW, FIRST_ANIME_COL_INDEX),
			getUsersAndDayRow(sheets, seasonName, NUEVO_USER_START),
		]);
		const existingIndex = malIds.indexOf(anime.malId);
		if (existingIndex !== -1) return { animeIndex: FIRST_ANIME_COL_INDEX + existingIndex * 2, userStart: NUEVO_USER_START };

		const { col: targetCol, insertBefore } = await findSortedInsertionColumn(
			sheets,
			seasonName,
			dayRowIndex,
			FIRST_ANIME_COL_INDEX,
			malIds.length,
			anime.broadcastDay,
		);
		if (insertBefore) await insertColumnsAt(sheets, sheet.properties.sheetId, targetCol);
		await ensureColumnCapacity(sheets, sheet, targetCol);
		const imageRow = NUEVO_TITLE_ROW - IMAGE_ROW_SPAN;
		await writeAnimeBlock(sheets, sheet.properties.sheetId, seasonName, anime, targetCol, imageRow, NUEVO_TITLE_ROW, dayRowIndex);
		invalidateColumnCache(seasonName);
		return { animeIndex: targetCol, userStart: NUEVO_USER_START };
	}

	const layout = await resolveContinuacionLayout(sheets, seasonName);
	const siguenStartCol = await findColumnWithLabel(sheets, seasonName, layout.labelRow, SIGUEN_LABEL);

	if (!anime.isCarryover) {
		// Subgrupo "secuela": columnas desde B, hasta donde empiece el subgrupo "siguen" (si existe).
		const secuelaMalIds = await getMalIdsInRange(sheets, seasonName, layout.titleRow, FIRST_ANIME_COL_INDEX, siguenStartCol ?? Infinity);
		const existingIndex = secuelaMalIds.indexOf(anime.malId);
		if (existingIndex !== -1) {
			return { animeIndex: FIRST_ANIME_COL_INDEX + existingIndex * 2, userStart: layout.userStart };
		}

		const { col: targetCol, insertBefore } = await findSortedInsertionColumn(
			sheets,
			seasonName,
			layout.dayRowIndex,
			FIRST_ANIME_COL_INDEX,
			secuelaMalIds.length,
			anime.broadcastDay,
		);
		if (insertBefore) {
			await insertColumnsAt(sheets, sheet.properties.sheetId, targetCol);
		} else if (siguenStartCol !== null && targetCol >= siguenStartCol) {
			// Appendeando al final del subgrupo secuela, pero eso pisaría el inicio de "siguen": lo corremos.
			await insertColumnsAt(sheets, sheet.properties.sheetId, siguenStartCol);
		}
		await ensureColumnCapacity(sheets, sheet, targetCol);
		await writeAnimeBlock(sheets, sheet.properties.sheetId, seasonName, anime, targetCol, layout.imageRow, layout.titleRow, layout.dayRowIndex);
		await applyContinuacionOuterBorder(sheets, sheet.properties.sheetId, seasonName, layout);
		invalidateColumnCache(seasonName);
		return { animeIndex: targetCol, userStart: layout.userStart };
	}

	// Subgrupo "siguen" (CONTINUAN): a la derecha del subgrupo "secuela".
	const secuelaCount = (await getMalIdsInRange(sheets, seasonName, layout.titleRow, FIRST_ANIME_COL_INDEX, siguenStartCol ?? Infinity)).length;
	let startCol = siguenStartCol;
	if (startCol === null) {
		startCol = FIRST_ANIME_COL_INDEX + secuelaCount * 2;
		await sheets.spreadsheets.values.update({
			spreadsheetId: SPREADSHEET_ID,
			range: `'${seasonName}'!${columnLetter(startCol)}${layout.labelRow}`,
			valueInputOption: 'RAW',
			requestBody: { values: [[SIGUEN_LABEL]] },
		});
	}

	const siguenMalIds = await getMalIdsInRange(sheets, seasonName, layout.titleRow, startCol);
	const existingIndex = siguenMalIds.indexOf(anime.malId);
	if (existingIndex !== -1) return { animeIndex: startCol + existingIndex * 2, userStart: layout.userStart };

	const { col: targetCol, insertBefore } = await findSortedInsertionColumn(
		sheets,
		seasonName,
		layout.dayRowIndex,
		startCol,
		siguenMalIds.length,
		anime.broadcastDay,
	);
	if (insertBefore) await insertColumnsAt(sheets, sheet.properties.sheetId, targetCol);
	await ensureColumnCapacity(sheets, sheet, targetCol);
	await writeAnimeBlock(sheets, sheet.properties.sheetId, seasonName, anime, targetCol, layout.imageRow, layout.titleRow, layout.dayRowIndex);
	await applyContinuacionOuterBorder(sheets, sheet.properties.sheetId, seasonName, layout);
	invalidateColumnCache(seasonName);
	return { animeIndex: targetCol, userStart: layout.userStart };
}

async function ensureUserRow(seasonName, username, userStart) {
	const sheets = await getSheetsClient();
	const sheet = await findSheetByTitle(sheets, seasonName);
	if (!sheet) throw new Error(`No existe la pestaña de temporada: ${seasonName}`);

	const { dayRowIndex, userNames } = await getUsersAndDayRow(sheets, seasonName, userStart);
	const existingIndex = userNames.indexOf(username);
	if (existingIndex !== -1) return userStart + existingIndex;

	await sheets.spreadsheets.batchUpdate({
		spreadsheetId: SPREADSHEET_ID,
		requestBody: {
			requests: [
				{
					insertDimension: {
						range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: dayRowIndex - 1, endIndex: dayRowIndex },
						inheritFromBefore: false,
					},
				},
			],
		},
	});

	await sheets.spreadsheets.values.update({
		spreadsheetId: SPREADSHEET_ID,
		range: `'${seasonName}'!${columnLetter(NAME_COL_INDEX)}${dayRowIndex}`,
		valueInputOption: 'RAW',
		requestBody: { values: [[username]] },
	});
	return dayRowIndex;
}

// "No lo veré" (rojo) nunca se escribe en la sheet: ni columna, ni fila, ni voto.
async function setVote(seasonName, username, anime, voteType) {
	const style = VOTE_STYLES[voteType];
	if (!style) throw new Error(`Voto desconocido: ${voteType}`);
	if (voteType === 'rojo') return;

	const { animeIndex: colIndex, userStart } = await ensureAnimeColumn(seasonName, anime);

	const sheets = await getSheetsClient();
	const sheet = await findSheetByTitle(sheets, seasonName);
	const rowIndex = await ensureUserRow(seasonName, username, userStart);

	const cellA1 = `${columnLetter(colIndex)}${rowIndex}`;
	await sheets.spreadsheets.values.update({
		spreadsheetId: SPREADSHEET_ID,
		range: `'${seasonName}'!${cellA1}`,
		valueInputOption: 'USER_ENTERED',
		requestBody: { values: [[style.label]] },
	});

	const checkboxRange = {
		sheetId: sheet.properties.sheetId,
		startRowIndex: rowIndex - 1,
		endRowIndex: rowIndex,
		startColumnIndex: colIndex + 1,
		endColumnIndex: colIndex + 2,
	};

	await sheets.spreadsheets.batchUpdate({
		spreadsheetId: SPREADSHEET_ID,
		requestBody: {
			requests: [
				{
					repeatCell: {
						range: {
							sheetId: sheet.properties.sheetId,
							startRowIndex: rowIndex - 1,
							endRowIndex: rowIndex,
							startColumnIndex: colIndex,
							endColumnIndex: colIndex + 1,
						},
						cell: { userEnteredFormat: { backgroundColor: style.color } },
						fields: 'userEnteredFormat.backgroundColor',
					},
				},
				{
					setDataValidation: {
						range: checkboxRange,
						rule: { condition: { type: 'BOOLEAN' }, strict: true },
					},
				},
			],
		},
	});
}

// Ubica la columna de voto de un anime sin crear nada (a diferencia de ensureAnimeColumn), usando
// la caché en memoria cuando ya se resolvió antes para esta temporada.
async function findAnimeColumn(sheets, seasonName, anime) {
	const cacheKey = `${seasonName}::${anime.malId}`;
	if (animeColumnCache.has(cacheKey)) return animeColumnCache.get(cacheKey);

	const result = await locateAnimeColumn(sheets, seasonName, anime);
	if (result) animeColumnCache.set(cacheKey, result);
	return result;
}

// Busca por malId en los tres bloques reales (nuevo, secuela, CONTINUAN) en vez de confiar en
// anime.isSequel / anime.isCarryover: esas banderas son una heurística de título que puede no
// coincidir con dónde quedó realmente la columna (ensureAnimeColumn usa una comprobación más
// precisa al escribir). Devuelve null si el anime no tiene columna en ningún bloque.
async function locateAnimeColumn(sheets, seasonName, anime) {
	const nuevoMalIds = await getMalIdsInRange(sheets, seasonName, NUEVO_TITLE_ROW, FIRST_ANIME_COL_INDEX);
	const nuevoIndex = nuevoMalIds.indexOf(anime.malId);
	if (nuevoIndex !== -1) return { col: FIRST_ANIME_COL_INDEX + nuevoIndex * 2, userStart: NUEVO_USER_START };

	const layout = await peekContinuacionLayout(sheets, seasonName);
	if (!layout.exists) return null;

	// Una sola lectura de la fila de títulos sirve para los dos subgrupos (secuela + CONTINUAN);
	// se corta en JS según dónde empiece "CONTINUAN", en vez de pedirle a la API la misma fila dos veces.
	const [siguenStartCol, continuacionMalIds] = await Promise.all([
		findColumnWithLabel(sheets, seasonName, layout.labelRow, SIGUEN_LABEL),
		getMalIdsInRange(sheets, seasonName, layout.titleRow, FIRST_ANIME_COL_INDEX),
	]);
	const splitIndex = siguenStartCol === null ? continuacionMalIds.length : (siguenStartCol - FIRST_ANIME_COL_INDEX) / 2;

	const secuelaIndex = continuacionMalIds.slice(0, splitIndex).indexOf(anime.malId);
	if (secuelaIndex !== -1) return { col: FIRST_ANIME_COL_INDEX + secuelaIndex * 2, userStart: layout.userStart };

	if (siguenStartCol === null) return null;
	const siguenIndex = continuacionMalIds.slice(splitIndex).indexOf(anime.malId);
	return siguenIndex === -1 ? null : { col: siguenStartCol + siguenIndex * 2, userStart: layout.userStart };
}

// Borra el voto de un usuario para un anime (valor + color de fondo de la celda), sin tocar la
// columna ni la fila si ya existían. Si el anime o el usuario no tienen celda todavía (p. ej. el
// voto era "rojo", que nunca se escribe), no hace nada y devuelve false.
async function clearVote(seasonName, username, anime) {
	const sheets = await getSheetsClient();

	const [sheet, animeLoc] = await Promise.all([findSheetByTitle(sheets, seasonName), findAnimeColumn(sheets, seasonName, anime)]);
	if (!sheet || !animeLoc) return false;

	const { userNames } = await getUsersAndDayRow(sheets, seasonName, animeLoc.userStart);
	const userIndex = userNames.indexOf(username);
	if (userIndex === -1) return false;
	const rowIndex = animeLoc.userStart + userIndex;

	await sheets.spreadsheets.values.update({
		spreadsheetId: SPREADSHEET_ID,
		range: `'${seasonName}'!${columnLetter(animeLoc.col)}${rowIndex}`,
		valueInputOption: 'RAW',
		requestBody: { values: [['']] },
	});

	await sheets.spreadsheets.batchUpdate({
		spreadsheetId: SPREADSHEET_ID,
		requestBody: {
			requests: [
				{
					repeatCell: {
						range: {
							sheetId: sheet.properties.sheetId,
							startRowIndex: rowIndex - 1,
							endRowIndex: rowIndex,
							startColumnIndex: animeLoc.col,
							endColumnIndex: animeLoc.col + 1,
						},
						cell: { userEnteredFormat: {} },
						fields: 'userEnteredFormat.backgroundColor',
					},
				},
			],
		},
	});

	return true;
}

// Recoge los malId de todos los animes (nuevo + continuación, ambos subgrupos) de la pestaña
// inmediatamente anterior a `seasonName` (la que estaba en el índice 0 antes de crear ésta).
async function getPreviousTabMalIds(seasonName) {
	const sheets = await getSheetsClient();
	const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
	const sorted = [...meta.data.sheets].sort((a, b) => a.properties.index - b.properties.index);
	const currentPos = sorted.findIndex((s) => s.properties.title === seasonName);
	const previous = currentPos === -1 ? null : sorted[currentPos + 1];
	if (!previous) return [];

	const previousTitle = previous.properties.title;

	// La pestaña anterior puede no haber sido creada por el bot (formato manual antiguo) y no
	// seguir exactamente nuestra estructura esperada; si falla, simplemente no hay carryover que detectar.
	try {
		const nuevoMalIds = await getMalIdsInRange(sheets, previousTitle, NUEVO_TITLE_ROW, FIRST_ANIME_COL_INDEX);
		const continuacionLayout = await peekContinuacionLayout(sheets, previousTitle);
		const continuacionMalIds = continuacionLayout.exists
			? await getMalIdsInRange(sheets, previousTitle, continuacionLayout.titleRow, FIRST_ANIME_COL_INDEX)
			: [];

		return [...new Set([...nuevoMalIds, ...continuacionMalIds].filter(Boolean))];
	} catch (err) {
		console.error(`getPreviousTabMalIds: no pude leer "${previousTitle}", no hay carryover que detectar:`, err.message);
		return [];
	}
}

module.exports = { ensureSeasonTab, ensureAnimeColumn, ensureUserRow, setVote, clearVote, getPreviousTabMalIds };
