document.addEventListener("DOMContentLoaded", () => {

    /**
     * =============================================================================
     * 1. KONFIGURATION & SETUP
     * =============================================================================
     * Hier definieren wir alle grundlegenden Einstellungen für die Karte,
     * die visuellen Stile der Marker und die Animationen.
     */
    const CONFIG = {
        // Start-Zoomstufe der Karte
        zoomLevel: 6,

        // Start-Mittelpunkt (grob Mitte Europa)
        center: [50, 10],

        // URL für die Karten-Kacheln (Tiles) - Hier nutzen wir CARTO Voyager (hell & modern)
        tileLayerUrl: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',

        // Copyright-Hinweis für die Karte
        tileAttribution: '&copy; OpenStreetMap &copy; CARTO',

        // Visuelle Stile für Marker und Linien
        styles: {
            // Aktiver Marker (Das aktuell angezeigte Foto)
            // Blau, etwas größer, voll deckend
            active: {
                radius: 10,
                fillColor: '#3b82f6',
                color: '#fff',
                weight: 4,
                fillOpacity: 1
            },

            // Inaktive Marker (Alle anderen Fotos)
            // Grau, kleiner, leicht transparent
            inactive: {
                radius: 6,
                fillColor: '#64748b',
                color: '#fff',
                weight: 1,
                fillOpacity: 0.6
            },

            // Die Route (Verbindungslinie zwischen den Orten)
            // Blau, gestrichelt
            line: {
                color: '#3b82f6',
                weight: 3,
                opacity: 0.5,
                dashArray: '5, 10'
            }
        },

        // Wie lange die Kamerafahrt zu einem neuen Punkt dauert (in Sekunden)
        animationDuration: 1.5
    };

    // Wir holen das Sicherheits-Token aus dem HTML-Body (data-token Attribut)
    // Ohne dieses Token funktionieren keine API-Anfragen an das Backend.
    const TOKEN = document.body.dataset.token;
    if (!TOKEN) {
        console.error("KRITISCH: Kein Token im Body-Dataset gefunden. Die App kann nicht starten.");
        return;
    }

    /**
     * =============================================================================
     * 2. DOM ELEMENTE CACHEN
     * =============================================================================
     * Wir speichern Referenzen auf alle HTML-Elemente, die wir später steuern wollen.
     * Das verbessert die Performance, da wir nicht ständig `getElementById` aufrufen müssen.
     */
    const dom = {
        // --- Haupt-Ansicht ---
        map: document.getElementById('map'),
        currentPhoto: document.getElementById('current-photo'),
        bgPhoto: document.getElementById('bg-photo'),

        // --- Info-Bereich unter dem Bild ---
        infoStandard: document.getElementById('info-standard'), // Normaler Text (Ort & Datum)
        fixInterface: document.getElementById('fix-interface'), // Editor-UI (Erscheint wenn Ort fehlt)
        fixSaveBtn: document.getElementById('fix-save-btn'),    // Der "Position bestätigen" Button

        txtLocation: document.getElementById('photo-location'),
        txtDate: document.getElementById('photo-date'),

        // --- Modals (Popups) ---
        statsModal: document.getElementById('stats-modal'),
        tutorialModal: document.getElementById('tutorial-modal'),
        progressModal: document.getElementById('progress-modal'),

        // --- Buttons in der Header-Leiste ---
        btnStats: document.getElementById('open-stats'),        // Statistik & Admin-Upload (Doppelklick)
        btnHelp: document.getElementById('open-help'),          // Hilfe
        btnFixMissing: document.getElementById('btn-fix-missing'), // Warn-Button (nur sichtbar bei Fehlern)

        // --- Schließen-Buttons der Modals ---
        btnCloseStats: document.getElementById('close-stats'),
        btnCloseTutorial: document.getElementById('close-tutorial'),

        // --- Upload & Fortschrittsanzeige ---
        progressBar: document.getElementById('progress-bar-fill'),
        progressText: document.getElementById('progress-text'),
        fileInput: document.getElementById('file-input')        // Das versteckte Datei-Auswahlfeld
    };

    /**
     * =============================================================================
     * 3. STATE MANAGEMENT (Zustand der App)
     * =============================================================================
     * Hier speichern wir alle variablen Daten, die sich während der Laufzeit ändern.
     */
    const state = {
        // --- Daten ---
        allPhotos: [],       // Liste aller geladenen Foto-Objekte vom Server
        currentIndex: 0,     // Welches Foto schauen wir gerade an? (0 bis n)

        // --- Karte ---
        mapMarkers: [],      // Liste der Leaflet-Marker-Objekte (synchron zu allPhotos)
        mapInstance: null,   // Die Leaflet Karten-Instanz
        clusterGroup: null,  // Die MarkerCluster Gruppe (für Performance bei vielen Punkten)

        // --- Upload Logik ---
        adminUpload: {
            clickTimer: null,   // Timer, um einfachen Klick von Doppelklick zu unterscheiden
            tempPassword: null  // Das Passwort wird hier kurzzeitig gespeichert
        },

        // --- GPS Fix & Bereinigung ---
        missingGpsQueue: [], // Warteschlange: Dateinamen von Fotos, die keinen Ort haben
        isFixingMode: false, // Ist true, wenn wir gerade Orte nachtragen (blockiert normale Navigation)
        fixMarker: null      // Der blaue, verschiebbare Marker (Nadel) im Fix-Modus
    };

    // -----------------------------------------------------------------------------
    // 4. KARTEN INITIALISIERUNG
    // -----------------------------------------------------------------------------

    // Karte erstellen und auf Startposition setzen
    state.mapInstance = L.map(dom.map, { zoomControl: false }).setView(CONFIG.center, CONFIG.zoomLevel);

    // Zoom-Steuerung (Plus/Minus) nach unten rechts verschieben
    L.control.zoom({ position: 'bottomright' }).addTo(state.mapInstance);

    // Karten-Hintergrund laden
    L.tileLayer(CONFIG.tileLayerUrl, {
        attribution: CONFIG.tileAttribution,
        maxZoom: 19
    }).addTo(state.mapInstance);

    // SPEZIAL-EVENT: Klick auf Karte
    // Dieses Event ist NUR aktiv, wenn wir uns im "Fixing Mode" befinden.
    // Es setzt die blaue Nadel an die angeklickte Stelle.
    state.mapInstance.on('click', (e) => {
        if (state.isFixingMode) {
            setFixMarker(e.latlng.lat, e.latlng.lng);
        }
    });

    // -----------------------------------------------------------------------------
    // 5. DATEN VOM SERVER LADEN
    // -----------------------------------------------------------------------------

    // Wir laden die Route und Statistiken vom Server
    fetch(`/api/route?token=${TOKEN}`)
        .then(response => {
            if (!response.ok) throw new Error(`HTTP Fehler: ${response.status}`);
            return response.json();
        })
        .then(data => {
            const { photos, stats } = data;

            // Statistik im Modal aktualisieren (falls Daten vorhanden)
            if (stats) {
                animateValue("stat-km", 0, stats.total_km, 1500);
                setText("stat-countries", stats.countries);
                setText("stat-days", stats.days);
                setText("stat-photos", stats.photo_count);
            }

            // Wenn keine Fotos da sind, können wir nichts anzeigen -> Abbruch
            if (!photos || photos.length === 0) return;

            // Daten verarbeiten: Wir fügen jedem Foto den Ländercode hinzu
            state.allPhotos = photos.map(photo => ({
                ...photo,
                countryCode: extractCountryCode(photo.location)
            }));

            // --- AUTO-DELETE PRÜFUNG (Garbage Collection) ---
            // Wir prüfen beim Start, ob es "kaputte" Fotos gibt (kein GPS).
            // Das passiert z.B., wenn der Upload abgebrochen wurde oder der Browser neu geladen wurde.
            const garbage = state.allPhotos.filter(p => p.lat == null || p.lon == null);

            if (garbage.length > 0) {
                // Wir schauen, ob das Passwort noch im SessionStorage liegt (vom Upload vor dem Reload)
                const cachedPw = sessionStorage.getItem('travel_admin_token');

                if (cachedPw) {
                    // Passwort ist da -> Wir löschen die kaputten Dateien sofort und lautlos.
                    console.log(`Auto-Bereinigung gestartet für ${garbage.length} Dateien...`);
                    cleanupGarbage(garbage, cachedPw, true); // true = silent mode (kein Popup)
                } else {
                    // Kein Passwort da -> Wir zeigen den kleinen Warn-Button an.
                    // Der User kann dann manuell draufklicken, um aufzuräumen.
                    console.log("Kaputte Dateien gefunden, aber kein Passwort. Zeige Warn-Button.");
                    if(dom.btnFixMissing) {
                        dom.btnFixMissing.style.display = 'flex';
                        // Kleiner Pulse-Effekt für Aufmerksamkeit
                        dom.btnFixMissing.style.animation = "pulse 2s infinite";
                    }
                }
            }

            // Karte Marker erstellen und erstes Bild anzeigen
            renderMapElements();
            updateView();
        })
        .catch(error => console.error("Fehler beim Laden der Daten:", error));


    /**
     * Funktion zum Löschen von unvollständigen Bildern (Garbage Collection)
     */
    async function cleanupGarbage(files, password, silent = false) {
        let deletedCount = 0;

        // Wir gehen jedes kaputte Foto durch und senden einen Löschbefehl
        for (const photo of files) {
            try {
                const res = await fetch('/api/delete', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        admin_token: password,
                        filename: photo.filename
                    })
                });

                if (res.ok) {
                    deletedCount++;
                } else {
                    console.error(`Fehler beim Löschen von ${photo.filename}:`, res.status);
                }
            } catch (e) {
                console.error("Netzwerkfehler beim Löschen:", e);
            }
        }

        if (deletedCount > 0) {
            if (!silent) {
                alert(`Bereinigung abgeschlossen. ${deletedCount} unvollständige Dateien entfernt.`);
            }
            // Seite neu laden, damit die gelöschten Bilder aus der Galerie verschwinden
            location.reload();
        } else {
            if (!silent) {
                alert("Konnte Dateien nicht löschen. Falsches Passwort?");
            }
        }
    }


    /**
     * Zeichnet Marker und die Route auf die Karte.
     * Nutzt MarkerCluster für bessere Performance.
     */
    function renderMapElements() {
        // 1. Route zeichnen (Verbindungslinie)
        // Wir nehmen nur Fotos, die auch wirklich GPS-Daten haben.
        const validCoords = state.allPhotos
            .filter(p => p.lat != null && p.lon != null)
            .map(p => [p.lat, p.lon]);

        if (validCoords.length > 0) {
            L.polyline(validCoords, CONFIG.styles.line).addTo(state.mapInstance);
        }

        // 2. Marker Cluster Gruppe erstellen
        const markers = L.markerClusterGroup({
            showCoverageOnHover: false,
            spiderfyDistanceMultiplier: 2
        });

        // 3. Marker für jedes Foto erstellen
        state.allPhotos.forEach((photo, index) => {
            // Wenn kein GPS da ist: 'null' merken (für Index-Treue), aber KEINEN Marker setzen.
            if (photo.lat == null || photo.lon == null) {
                state.mapMarkers.push(null);
                return;
            }

            const marker = L.circleMarker([photo.lat, photo.lon], CONFIG.styles.inactive);

            // Klick-Event: Foto anzeigen
            // (Wird blockiert, wenn wir gerade im Fix-Modus sind)
            marker.on('click', () => {
                if(state.isFixingMode) return;
                state.currentIndex = index;
                updateView();
            });

            // Marker zur Cluster-Gruppe hinzufügen
            markers.addLayer(marker);
            state.mapMarkers.push(marker);
        });

        // Die Gruppe zur Karte hinzufügen
        state.mapInstance.addLayer(markers);
        state.clusterGroup = markers;
    }

    /**
     * Aktualisiert die Hauptansicht (Bild, Text, Karten-Zoom).
     * Wird bei jedem Navigieren aufgerufen.
     */
    function updateView() {
        if (!state.allPhotos.length) return;

        const photo = state.allPhotos[state.currentIndex];

        // 1. Bild laden
        displayImage(photo.filename);

        // 2. Texte setzen (Nur wenn NICHT im Fix-Modus)
        // Im Fix-Modus wird dieser Bereich ausgeblendet.
        if (!state.isFixingMode) {
            setTextElement(dom.txtLocation, photo.location || "Unbekannt");
            setTextElement(dom.txtDate, photo.date_str || "Datum unbekannt");
        }

        // 3. Karte aktualisieren
        const targetMarker = state.mapMarkers[state.currentIndex];

        // Wir zoomen nur, wenn ein Marker existiert (also GPS vorhanden ist)
        if (targetMarker) {
            // Alle Marker durchgehen und Styles anpassen
            state.mapMarkers.forEach((marker, index) => {
                if (!marker) return; // Null-Marker ignorieren

                const isActive = (index === state.currentIndex);

                if (isActive) {
                    marker.setStyle(CONFIG.styles.active);
                    if (marker.bringToFront) marker.bringToFront();
                } else {
                    marker.setStyle(CONFIG.styles.inactive);
                }
            });

            // Zoom-Logik mit Cluster-Support:
            if (state.clusterGroup) {
                // Öffnet den Cluster, falls der Marker darin versteckt ist
                state.clusterGroup.zoomToShowLayer(targetMarker, () => {});
            } else {
                state.mapInstance.flyTo(
                    [photo.lat, photo.lon],
                    10,
                    { animate: true, duration: CONFIG.animationDuration }
                );
            }
        }
    }

    /**
     * Lädt ein Bild und blendet es mit einem weichen Übergang ein.
     */
    function displayImage(filename) {
        const imgEl = dom.currentPhoto;
        const bgEl = dom.bgPhoto;

        // Erst ausblenden (transparent machen)
        if (imgEl) {
            imgEl.classList.remove('is-fullscreen');
            imgEl.style.opacity = 0;
        }
        if (bgEl) bgEl.style.opacity = 0;

        // Kurze Verzögerung, dann Quelle ändern und einblenden
        setTimeout(() => {
            const thumbUrl = `/api/thumb/${filename}?token=${TOKEN}`;

            if (imgEl) {
                imgEl.src = thumbUrl;
                imgEl.style.display = 'block';
                imgEl.onload = () => { imgEl.style.opacity = 1; };
            }
            if (bgEl) {
                bgEl.src = thumbUrl;
                bgEl.style.display = 'block';
                bgEl.onload = () => { bgEl.style.opacity = 1; };
            }
        }, 150);
    }

    // -------------------------------------------------------------------------
    // 6. NAVIGATION & STEUERUNG
    // -------------------------------------------------------------------------

    window.changePhoto = (direction) => {
        if (!state.allPhotos.length || state.isFixingMode) return;
        state.currentIndex = (state.currentIndex + direction + state.allPhotos.length) % state.allPhotos.length;
        updateView();
    };

    window.changeLocation = (direction) => {
        if (!state.allPhotos.length || state.isFixingMode) return;

        const currentCountry = state.allPhotos[state.currentIndex].countryCode;
        let index = state.currentIndex;
        let stepsChecked = 0;
        const total = state.allPhotos.length;

        // Logik: Zum nächsten Bild springen, das einen anderen Ländercode hat
        if (direction === 1) { // Vorwärts
            while (stepsChecked < total) {
                index = (index + 1) % total;
                if (state.allPhotos[index].countryCode !== currentCountry) {
                    state.currentIndex = index;
                    break;
                }
                stepsChecked++;
            }
        } else { // Rückwärts
            while (stepsChecked < total) {
                let prevIndex = (index - 1 + total) % total;
                if (state.allPhotos[prevIndex].countryCode !== currentCountry) break;
                index = prevIndex;
                stepsChecked++;
            }
            index = (index - 1 + total) % total;
            const targetCountry = state.allPhotos[index].countryCode;
            stepsChecked = 0;
            while (stepsChecked < total) {
                let prevIndex = (index - 1 + total) % total;
                if (state.allPhotos[prevIndex].countryCode !== targetCountry) break;
                index = prevIndex;
                stepsChecked++;
            }
            state.currentIndex = index;
        }
        updateView();
    };

    // Tastatursteuerung
    document.addEventListener('keydown', (e) => {
        if (state.isFixingMode) return;

        if (e.key === 'ArrowLeft') window.changePhoto(-1);
        if (e.key === 'ArrowRight') window.changePhoto(1);
        if (e.key === 'ArrowUp') { e.preventDefault(); window.changeLocation(-1); }
        if (e.key === 'ArrowDown') { e.preventDefault(); window.changeLocation(1); }
    });

    // Touch Support (Swipe)
    const touchZone = document.querySelector('.gallery-panel');
    let tX = 0, tY = 0;
    if (touchZone) {
        touchZone.addEventListener('touchstart', (e) => {
            tX = e.changedTouches[0].screenX;
            tY = e.changedTouches[0].screenY;
        }, { passive: false });

        touchZone.addEventListener('touchend', (e) => {
            if(state.isFixingMode) return;

            const xDiff = e.changedTouches[0].screenX - tX;
            const yDiff = e.changedTouches[0].screenY - tY;

            if (Math.abs(xDiff) > Math.abs(yDiff)) {
                if (Math.abs(xDiff) > 50) window.changePhoto(xDiff < 0 ? 1 : -1);
            } else {
                if (Math.abs(yDiff) > 50) window.changeLocation(yDiff < 0 ? 1 : -1);
            }
        }, { passive: false });
    }

    // Fullscreen bei Klick aufs Bild
    if (dom.currentPhoto) {
        dom.currentPhoto.addEventListener('click', () => {
            if(state.isFixingMode) return;

            const el = dom.currentPhoto;
            if (el.classList.contains('is-fullscreen')) {
                el.classList.remove('is-fullscreen');
            } else {
                if (state.allPhotos.length > 0) {
                    const photo = state.allPhotos[state.currentIndex];
                    el.src = `/api/thumb/${photo.filename}?token=${TOKEN}&size=original`;
                }
                el.classList.add('is-fullscreen');
            }
        });
    }

    // -------------------------------------------------------------------------
    // 7. ADMIN UPLOAD
    // -------------------------------------------------------------------------

    if (dom.btnStats && dom.fileInput) {
        // Doppelklick-Logik auf den Statistik-Button
        dom.btnStats.addEventListener('click', (e) => {
            e.preventDefault();
            if (state.adminUpload.clickTimer) {
                // Zweiter Klick -> Admin Modus aktivieren
                clearTimeout(state.adminUpload.clickTimer);
                state.adminUpload.clickTimer = null;

                const pw = prompt("🔒 Admin-Upload: Passwort eingeben:");
                if (pw) {
                    state.adminUpload.tempPassword = pw;
                    // WICHTIG: Passwort merken! Falls Reload passiert, können wir aufräumen.
                    sessionStorage.setItem('travel_admin_token', pw);
                    dom.fileInput.click();
                }
            } else {
                // Erster Klick -> Warte kurz, dann zeige Statistik
                state.adminUpload.clickTimer = setTimeout(() => {
                    if(dom.statsModal) dom.statsModal.classList.add('show');
                    state.adminUpload.clickTimer = null;
                }, 300);
            }
        });

        // Handler: Wenn Dateien ausgewählt wurden
        dom.fileInput.addEventListener('change', async () => {
            const files = dom.fileInput.files;

            // Sicherheits-Check: Haben wir Dateien und ein Passwort?
            if (files.length === 0 || !state.adminUpload.tempPassword) {
                state.adminUpload.tempPassword = null;
                dom.fileInput.value = "";
                return;
            }

            // UI: Ladebalken anzeigen
            if (dom.progressModal) dom.progressModal.classList.add('show');
            if (dom.progressBar) dom.progressBar.style.width = '0%';

            state.missingGpsQueue = [];
            let successCount = 0;
            let errorCount = 0;
            const totalFiles = files.length;
            const password = state.adminUpload.tempPassword; // Lokale Kopie für den Loop

            // Schleife über alle Dateien
            for (let i = 0; i < totalFiles; i++) {
                // Fortschrittstext
                if (dom.progressText) {
                    dom.progressText.innerText = `Lade Bild ${i + 1} von ${totalFiles} hoch...`;
                }

                const formData = new FormData();
                formData.append('photo', files[i]);
                formData.append('admin_token', password);

                try {
                    const res = await fetch('/api/upload', { method: 'POST', body: formData });
                    const json = await res.json();

                    if (res.ok) {
                        successCount++;
                        // Prüfen: Hat das Backend gemeldet, dass GPS fehlt?
                        if (json.missing_gps) {
                            state.missingGpsQueue.push(json.file);
                        }
                    } else {
                        errorCount++;
                        // Spezialfall: Falsches Passwort -> Sofort aufhören
                        if (res.status === 403 && i === 0) {
                            alert("Falsches Passwort.");
                            state.adminUpload.tempPassword = null;
                            break;
                        }
                    }
                } catch (error) {
                    console.error("Upload Fehler:", error);
                    errorCount++;
                }

                // Balken aktualisieren
                if (dom.progressBar) {
                    const percent = Math.round(((i + 1) / totalFiles) * 100);
                    dom.progressBar.style.width = `${percent}%`;
                }
            }

            // Aufräumen
            dom.fileInput.value = "";
            if (dom.progressModal) dom.progressModal.classList.remove('show');

            // --- ENTSCHEIDUNG ---
            if (state.missingGpsQueue.length > 0) {
                // Es gibt Fotos ohne GPS -> Sofort in den Fix-Modus (kein Alert mehr)
                startFixingProcess(password);
            } else {
                // Alles perfekt -> Erfolgsmeldung und Reload
                let msg = `Fertig! ${successCount} hochgeladen.`;
                if (errorCount > 0) msg += ` (${errorCount} Fehler)`;
                alert(msg);
                location.reload();
            }
        });
    }

    // Handler für den manuellen Warn-Button
    if (dom.btnFixMissing) {
        dom.btnFixMissing.addEventListener('click', () => {
             const pw = prompt("🔒 Admin-Passwort zum Aufräumen:");
             if(pw) {
                 sessionStorage.setItem('travel_admin_token', pw);
                 location.reload();
            }
        });
    }

    // -------------------------------------------------------------------------
    // 8. GPS FIX ASSISTENT FUNKTIONEN
    // -------------------------------------------------------------------------

    /**
     * Startet den Fix-Modus für Fotos ohne GPS
     */
    function startFixingProcess(password) {
        state.isFixingMode = true;
        state.adminUpload.tempPassword = password;

        // Statistik schließen, falls offen
        if (dom.statsModal) dom.statsModal.classList.remove('show');

        // UI Umschalten: Info ausblenden, Editor einblenden
        if(dom.infoStandard) dom.infoStandard.style.display = 'none';
        if(dom.fixInterface) dom.fixInterface.style.display = 'block';

        processNextFix();
    }

    /**
     * Lädt das nächste Foto aus der Queue
     */
    function processNextFix() {
        if (state.missingGpsQueue.length === 0) {
            alert("Großartig! Alle Orte gespeichert.");
            location.reload();
            return;
        }

        const currentFilename = state.missingGpsQueue[0];
        displayImage(currentFilename);

        // Marker zurücksetzen
        if (state.fixMarker) {
            state.mapInstance.removeLayer(state.fixMarker);
            state.fixMarker = null;
        }

        // Marker in die Kartenmitte setzen
        const center = state.mapInstance.getCenter();
        setFixMarker(center.lat, center.lng);
    }

    /**
     * Erzeugt oder bewegt den Fix-Marker
     */
    function setFixMarker(lat, lon) {
        if (state.fixMarker) {
            state.fixMarker.setLatLng([lat, lon]);
        } else {
            // Marker ist 'draggable' und 'autoPan' (bewegt Karte am Rand)
            state.fixMarker = L.marker([lat, lon], {
                draggable: true,
                autoPan: true
            }).addTo(state.mapInstance);
        }
        // Karte sanft zentrieren
        state.mapInstance.panTo([lat, lon]);
    }

    // EVENT: Speichern Button
    if (dom.fixSaveBtn) {
        dom.fixSaveBtn.addEventListener('click', async (e) => {
            // WICHTIG: stopPropagation verhindert, dass der Klick
            // durchschlägt und die Fullscreen-Ansicht des Bildes triggert.
            e.stopPropagation();
            e.preventDefault();

            if (!state.fixMarker) {
                alert("Bitte Karte verschieben um Marker zu setzen.");
                return;
            }

            const pos = state.fixMarker.getLatLng();
            const filename = state.missingGpsQueue[0];
            const password = state.adminUpload.tempPassword;

            try {
                const res = await fetch('/api/update_location', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        admin_token: password,
                        filename: filename,
                        lat: pos.lat,
                        lon: pos.lng
                    })
                });

                if (res.ok) {
                    // Erfolg -> Foto aus der Liste entfernen
                    state.missingGpsQueue.shift();
                    // Nächstes Foto laden
                    processNextFix();
                } else {
                    alert("Fehler beim Speichern (Passwort verloren?).");
                }
            } catch (err) {
                alert("Netzwerkfehler");
            }
        });
    }

    // -------------------------------------------------------------------------
    // 9. HELFER-FUNKTIONEN
    // -------------------------------------------------------------------------

    function setText(id, text) {
        const el = document.getElementById(id);
        if(el) el.innerText = text;
    }

    function setTextElement(element, text) {
        if (element) element.innerText = text;
    }

    function extractCountryCode(locationString) {
        if (!locationString) return "UNK";
        const parts = locationString.split(',');
        // Letzter Teil des Strings (nach dem letzten Komma) ist meist das Land
        return parts.length > 1 ? parts[parts.length - 1].trim() : "UNK";
    }

    function animateValue(id, start, end, duration) {
        const obj = document.getElementById(id);
        if (!obj) return;
        let startTimestamp = null;
        const step = (timestamp) => {
            if (!startTimestamp) startTimestamp = timestamp;
            const progress = Math.min((timestamp - startTimestamp) / duration, 1);
            // Zahlen formatieren (Tausenderpunkt)
            obj.innerHTML = Math.floor(progress * (end - start) + start).toLocaleString('de-DE');
            if (progress < 1) window.requestAnimationFrame(step);
        };
        window.requestAnimationFrame(step);
    }

    // -------------------------------------------------------------------------
    // 10. MODAL EVENTS
    // -------------------------------------------------------------------------

    if (dom.statsModal && dom.btnCloseStats) {
        dom.btnCloseStats.addEventListener('click', () => dom.statsModal.classList.remove('show'));
        // Klick auf Hintergrund schließt Modal
        dom.statsModal.addEventListener('click', (e) => {
            if (e.target === dom.statsModal) dom.statsModal.classList.remove('show');
        });
    }

    if (dom.tutorialModal && !localStorage.getItem('tutorial_seen')) {
        setTimeout(() => dom.tutorialModal.classList.add('show'), 1000);
    }

    if (dom.btnCloseTutorial) {
        dom.btnCloseTutorial.addEventListener('click', () => {
            dom.tutorialModal.classList.remove('show');
            localStorage.setItem('tutorial_seen', 'true');
        });
    }

    if (dom.btnHelp) {
        dom.btnHelp.addEventListener('click', () => {
            if (dom.statsModal) dom.statsModal.classList.remove('show');
            if (dom.tutorialModal) dom.tutorialModal.classList.add('show');
        });
    }
});