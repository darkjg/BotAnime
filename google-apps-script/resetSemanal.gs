/**
 * Script de Google Apps Script, vive DENTRO de la sheet (Extensiones > Apps Script), no forma parte
 * del bot de Node ni se despliega con él. Se guarda una copia acá solo para tenerlo versionado por si
 * hay que tocarlo. Para actualizarlo hace falta pegar los cambios a mano en el editor de Apps Script
 * de la sheet real — no lo puedo ejecutar ni probar desde acá, así que esto hay que probarlo en la
 * sheet real antes de confiar en que corre bien.
 *
 * updateCountersAndReset corre con un trigger periódico: por cada checkbox tildado, suma +1 al
 * capítulo (celda a la izquierda, si está en verde) y resetea el checkbox. syncColores sincroniza el
 * color de fondo del checkbox con el de la celda de voto de al lado.
 *
 * 2026-07-30 (pedido del usuario): antes de sumar, hay que revisar si el capítulo de esta semana ya
 * salió según el día de emisión del anime (fila "Día de emisión" de su mismo bloque) — si hoy todavía
 * no llegamos a ese día dentro de la semana, no corresponde sumar ni resetear todavía, se deja para
 * la próxima corrida. También corregido nombreHoja: decía "Primavera 2026" pero la temporada activa
 * real es "Verano 2026".
 */

var nombreHoja = "Verano 2026";

var DAY_LABEL = "Día de emisión";
var DAY_ORDER = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

function getSheet(nombre) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(nombre);
}

// JS: Date.getDay() da 0=domingo..6=sábado; lo pasamos al orden Lunes=0..Domingo=6 que usa DAY_ORDER.
function todayRank() {
  var jsDay = new Date().getDay();
  return (jsDay + 6) % 7;
}

// Busca, subiendo desde `row` por la columna A, la fila donde dice "Día de emisión" (cabecera del
// bloque de animes al que pertenece esta fila: "nuevo", "secuela" o "CONTINUAN" tienen la suya
// propia). Devuelve null si no la encuentra.
function findDayRow(sheet, row) {
  for (var r = row; r >= 1; r--) {
    if (sheet.getRange(r, 1).getValue() === DAY_LABEL) return r;
  }
  return null;
}

// True si el capítulo de esta semana ya debería haber salido para el anime de `animeCol`, según su
// día de emisión: si hoy todavía no llegamos a ese día de la semana (lunes a domingo), el capítulo de
// esta semana todavía no salió y no corresponde sumar/resetear. Si no se puede determinar el día (fila
// no encontrada, celda vacía), no bloquea — se comporta como antes.
function yaEmitioEstaSemana(sheet, row, animeCol) {
  var dayRow = findDayRow(sheet, row);
  if (!dayRow) return true;

  var dia = sheet.getRange(dayRow, animeCol).getValue();
  var rank = DAY_ORDER.indexOf(dia);
  if (rank === -1) return true;

  return todayRank() >= rank;
}

function updateCountersAndReset() {
  var sheet = getSheet(nombreHoja);
  if (!sheet) return;

  var lastRow = sheet.getLastRow();//Obtenemos la ultima fila
  var lastColumn = sheet.getLastColumn();//Obtenemos la ultima columna

  // Revisamos toda la hoja
  for (var r = 1; r <= lastRow; r++) {
    for (var c = 2; c <= lastColumn; c++) { // empezamos en col 2 porque necesitamos c-1
      processCheckbox(sheet, r, c);
    }
  }
}

/**
 * Procesa un checkbox en la celda (r, c).
 * Si está marcado y el capítulo de esta semana ya salió, actualiza la celda de la izquierda.
 */
function processCheckbox(sheet, r, c) {
  var checkboxCell = sheet.getRange(r, c);
  var checkboxValue = checkboxCell.getValue();// si existe chechkbox obtenemos el valor

  if (checkboxValue === true) {
    if (!yaEmitioEstaSemana(sheet, r, c - 1)) return; // todavía no toca esta semana: se deja para la próxima corrida

    var targetCell = sheet.getRange(r, c - 1);//Restamos uno para indicar que el cambio se realiza en la columna anterior y misma fila
    updateIfGreen(targetCell);
    checkboxCell.clearContent(); // resetear checkbox
  }
}

/**
 * Suma +1 al valor de la celda anterior si:
 *  - Tiene un número
 *  - Su color de fondo es verde
 */
function updateIfGreen(cell) {
  var val = cell.getValue();
  var color = cell.getBackground().toLowerCase();

  if ((color === "#00ff00" || color === "green") && val !== "" && !isNaN(val)) {
    cell.setValue((parseInt(val, 10) || 0) + 1);
  }
}


function syncColores(e) {
   var sheet = getSheet(nombreHoja);
  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  // Recorremos todas las celdas menos la última columna
  for (var row = 1; row <= lastRow; row++) {
    for (var col = 1; col < lastCol; col++) {
      var cell = sheet.getRange(row, col);
      var checkboxCell = sheet.getRange(row, col + 1);

      // Comprobar si en la celda de la derecha hay un checkbox
      if (checkboxCell.getDataValidation() &&
          checkboxCell.getDataValidation().getCriteriaType() == SpreadsheetApp.DataValidationCriteria.CHECKBOX) {

        var colorOriginal = cell.getBackground();
        var colorCheckbox = checkboxCell.getBackground();

        // Si los colores son distintos → sincronizar
        if (colorOriginal !== colorCheckbox) {
          checkboxCell.setBackground(colorOriginal);
        }
      }
    }
  }
}
