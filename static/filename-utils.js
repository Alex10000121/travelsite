// Eigenes Modul statt Teil von api.js, damit Tests, die api.js komplett mocken
// (kein Netzwerk in Unit-Tests), diese reine String-Funktion trotzdem bekommen.

/**
 * Kodiert einen (ggf. Unterordner enthaltenden) Dateinamen für die Verwendung in
 * einer URL, ohne die Pfad-Trenner selbst zu kodieren (Backend nutzt <path:filename>).
 * Ohne das würden Zeichen wie '#', '?', '&' oder '%' im Dateinamen die Thumb-/Delete-URL
 * zerschneiden oder falsch interpretieren lassen.
 * @param {string} filename
 * @returns {string}
 */
export function encodeFilenamePath(filename) {
    return filename.split('/').map(encodeURIComponent).join('/');
}
