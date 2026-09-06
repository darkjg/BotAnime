/**
 * Script de Google Apps Script, vive DENTRO de la sheet (Extensiones > Apps Script), no forma parte
 * del bot de Node ni se despliega con él. Se guarda una copia acá solo para tenerlo versionado por si
 * hay que tocarlo. Para actualizarlo hace falta pegar los cambios a mano en el editor de Apps Script
 * de la sheet real — no lo puedo ejecutar ni probar desde acá, así que esto hay que probarlo en la
 * sheet real antes de confiar en que corre bien.
 *
 * updateCountersAndReset corre con un trigger periódico: por cada checkbox tildado, lo resetea a
 * false. syncColores sincroniza el color de fondo del checkbox con el de la celda de voto de al lado.
 *
 * 2026-08-20 (pedido del usuario): el checkbox pasó a ser de solo lectura — ya no suma capítulos por
 * su cuenta. Antes, tildarlo sumaba +1 directamente a la celda del capítulo (sin pasar por la base de
 * datos del bot), y ese incremento podía perderse en silencio la próxima vez que el bot escribiera esa
 * misma celda (un voto, /capitulo, etc.), porque escribía el valor que tenía guardado sin saber del
 * incremento manual. Ahora la base de datos del bot es la única fuente de verdad para el capítulo por
 * el que va cada quien (siempre se marca desde Discord); el checkbox queda como indicador puramente
 * visual de "al día esta semana" (lo tilda el bot, ver setVoteImpl en sheets.js), y esta función solo
 * se encarga de resetearlo cada semana. Se cae toda la lógica de "¿ya salió el capítulo de esta
 * semana?" (día de emisión, color de la celda) porque ya no hace falta para decidir si sumar o no.
 */

var nombreHoja = "Verano 2026";

function getSheet(nombre) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(nombre);
}

/**
 * Recorre toda la hoja en memoria (una sola lectura, una sola escritura): resetea a false cada
 * checkbox que esté tildado.
 */
function updateCountersAndReset() {
  var sheet = getSheet(nombreHoja);
  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  if (lastRow < 1 || lastColumn < 2) return;

  var range = sheet.getRange(1, 1, lastRow, lastColumn);
  var values = range.getValues();

  var changed = false;
  for (var row = 0; row < lastRow; row++) {
    for (var col = 1; col < lastColumn; col++) {
      if (values[row][col] !== true) continue; // no es un checkbox tildado
      values[row][col] = false;
      changed = true;
    }
  }

  if (changed) range.setValues(values);
}

/**
 * Sincroniza el color de fondo de cada checkbox con el de la celda de voto de al lado (una sola
 * lectura + una sola escritura para toda la hoja).
 */
function syncColores(e) {
  var sheet = getSheet(nombreHoja);
  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 2) return;

  var range = sheet.getRange(1, 1, lastRow, lastCol);
  var backgrounds = range.getBackgrounds();
  var validations = range.getDataValidations();

  var changed = false;
  for (var row = 0; row < lastRow; row++) {
    for (var col = 0; col < lastCol - 1; col++) {
      var checkboxValidation = validations[row][col + 1];
      if (!checkboxValidation || checkboxValidation.getCriteriaType() !== SpreadsheetApp.DataValidationCriteria.CHECKBOX) continue;

      var colorOriginal = backgrounds[row][col];
      if (backgrounds[row][col + 1] !== colorOriginal) {
        backgrounds[row][col + 1] = colorOriginal;
        changed = true;
      }
    }
  }

  if (changed) range.setBackgrounds(backgrounds);
}
