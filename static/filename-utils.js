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

/**
 * Baut die Thumbnail-URL für ein Foto. token/size sind optional und werden nur
 * gesetzt, wenn übergeben - Admin-Ansichten laufen z.B. über die Session statt
 * über ein Token und lassen token weg.
 * @param {string} filename
 * @param {object} [opts]
 * @param {string} [opts.token]
 * @param {string} [opts.size]
 * @returns {string}
 */
export function buildThumbUrl(filename, { token, size } = {}) {
    const params = new URLSearchParams();
    if (token !== undefined) params.set('token', token);
    if (size !== undefined) params.set('size', size);
    const query = params.toString();
    return `/api/thumb/${encodeFilenamePath(filename)}${query ? `?${query}` : ''}`;
}
