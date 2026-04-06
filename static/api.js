// Alle fetch-Aufrufe zum Backend.
// Jede Funktion wirft bei Fehler einen Error — kein fetch() außerhalb dieser Datei.

/**
 * Lädt alle Routendaten (Fotos + Statistiken) vom Server.
 * @param {string} token - Öffentlicher Lese-Token aus data-token
 * @returns {Promise<{photos: Array, stats: Object}>}
 */
export async function fetchRoute(token) {
    const res = await fetch(`/api/route?token=${token}`);
    if (!res.ok) {
        throw new Error(`Fehler beim Laden der Route (HTTP ${res.status})`);
    }
    return res.json();
}

/**
 * Prüft, ob ein Admin-Passwort korrekt ist.
 * @param {string} password - Das eingegebene Passwort
 * @returns {Promise<void>} - Löst auf bei Erfolg, wirft Error bei falschem Passwort oder Netzwerkfehler
 */
export async function checkLogin(password) {
    let res;
    try {
        res = await fetch('/api/check_login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ admin_token: password })
        });
    } catch (err) {
        throw new Error('Verbindungsfehler zum Server.');
    }

    if (!res.ok) {
        throw new Error('Falsches Passwort.');
    }
}

/**
 * Lädt ein einzelnes Foto hoch.
 * @param {FormData} formData - Muss 'photo', 'admin_token' und optional 'lat'/'lon' enthalten
 * @returns {Promise<Object>} - Die JSON-Antwort des Servers (file, lat, lon, location, timestamp, …)
 */
export async function uploadPhoto(formData) {
    let res;
    try {
        res = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });
    } catch (err) {
        throw new Error(`Netzwerkfehler beim Upload: ${err.message}`);
    }

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
        const err = new Error(json.error || `Upload fehlgeschlagen (HTTP ${res.status})`);
        err.status = res.status;
        err.missing_gps = json.missing_gps ?? false;
        throw err;
    }

    return json;
}

/**
 * Löscht eine Fotodatei auf dem Server.
 * @param {string} password - Admin-Passwort
 * @param {string} filename - Dateiname des zu löschenden Fotos
 * @returns {Promise<void>} - Löst auf bei Erfolg, wirft Error bei Misserfolg
 */
export async function deletePhoto(password, filename) {
    let res;
    try {
        res = await fetch('/api/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ admin_token: password, filename })
        });
    } catch (err) {
        throw new Error(`Netzwerkfehler beim Löschen von "${filename}": ${err.message}`);
    }

    if (!res.ok) {
        throw new Error(`Löschen fehlgeschlagen (HTTP ${res.status})`);
    }
}

/**
 * Speichert nachträglich GPS-Koordinaten für ein bereits hochgeladenes Foto.
 * @param {string} password - Admin-Passwort
 * @param {string} filename - Dateiname des Fotos
 * @param {number} lat - Breitengrad
 * @param {number} lon - Längengrad
 * @returns {Promise<void>} - Löst auf bei Erfolg, wirft Error bei Misserfolg
 */
export async function updateLocation(password, filename, lat, lon) {
    let res;
    try {
        res = await fetch('/api/update_location', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ admin_token: password, filename, lat, lon })
        });
    } catch (err) {
        throw new Error(`Netzwerkfehler beim Speichern des Ortes: ${err.message}`);
    }

    if (!res.ok) {
        throw new Error(`Ort konnte nicht gespeichert werden (HTTP ${res.status}). Passwort evtl. abgelaufen?`);
    }
}
