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
 *
 * 2026-08-11 (pedido del usuario, tras un correo de "Exceeded maximum execution time" en syncColores):
 * las dos funciones hacían sheet.getRange(fila, col) UNA POR UNA dentro de loops anidados — con la
 * hoja ya en 1000+ filas eso son decenas de miles de llamadas, cada una un viaje de ida y vuelta a
 * Sheets, y supera fácil el límite de 6 minutos de ejecución de Apps Script. Reescritas para leer y
 * escribir la hoja entera en UN par de llamadas (getValues/getBackgrounds + setValues/setBackgrounds)
 * y trabajar sobre esos arrays en memoria, que es prácticamente instantáneo sin importar el tamaño.
 *
 * De paso, encontrado y corregido un bug real en findDayRow: buscaba "Día de emisión" subiendo desde
 * la fila del checkbox, pero esa fila queda DEBAJO de los usuarios en cada bloque (título, usuarios,
 * "Día de emisión"), nunca arriba — así que nunca la encontraba y el chequeo de "¿ya salió esta
 * semana?" quedaba siempre en true (no filtraba nada en la práctica). Ahora se busca la fila más
 * cercana en la misma columna A, mirando hacia ABAJO.
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

// Para cada fila (0-based) de `values`, calcula el índice de la fila más cercana en la MISMA columna A
// que diga "Día de emisión", buscando hacia abajo (esa fila viene siempre después de los usuarios de
// su bloque, nunca antes). -1 si no hay ninguna debajo.
function buildDayRowIndex(values) {
  var lastRow = values.length;
  var dayRowByRow = new Array(lastRow);
  var nextDayRow = -1;
  for (var r = lastRow - 1; r >= 0; r--) {
    if (values[r][0] === DAY_LABEL) nextDayRow = r;
    dayRowByRow[r] = nextDayRow;
  }
  return dayRowByRow;
}

/**
 * Recorre toda la hoja en memoria (una sola lectura de valores + colores, una sola escritura al
 * final): por cada checkbox tildado cuyo capítulo ya salió esta semana, suma +1 a la celda de la
 * izquierda si está en verde, y resetea el checkbox.
 */
function updateCountersAndReset() {
  var sheet = getSheet(nombreHoja);
  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  if (lastRow < 1 || lastColumn < 2) return;

  var range = sheet.getRange(1, 1, lastRow, lastColumn);
  var values = range.getValues();
  var backgrounds = range.getBackgrounds();
  var dayRowByRow = buildDayRowIndex(values);
  var todayRankValue = todayRank();

  var changed = false;
  for (var row = 0; row < lastRow; row++) {
    for (var col = 1; col < lastColumn; col++) {
      if (values[row][col] !== true) continue; // no es un checkbox tildado

      var animeCol = col - 1;
      var dayRow = dayRowByRow[row];
      var dia = dayRow === -1 ? null : values[dayRow][animeCol];
      var rank = DAY_ORDER.indexOf(dia);
      var yaEmitio = rank === -1 ? true : todayRankValue >= rank; // sin día conocido: no bloquea

      if (!yaEmitio) continue; // todavía no toca esta semana: se deja para la próxima corrida

      var val = values[row][animeCol];
      var color = (backgrounds[row][animeCol] || '').toLowerCase();
      if ((color === '#00ff00' || color === 'green') && val !== '' && !isNaN(val)) {
        values[row][animeCol] = (parseInt(val, 10) || 0) + 1;
      }
      values[row][col] = false; // resetear checkbox
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
