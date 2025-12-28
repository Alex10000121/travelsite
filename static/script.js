document.addEventListener("DOMContentLoaded", () => {

    /**
     * KONFIGURATION & KONSTANTEN
     * Hier definieren wir Styles und Basiseinstellungen zentral.
     */
    const CONFIG = {
        zoomLevel: 6,
        center: [50, 10],
        tileLayerUrl: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
        tileAttribution: '&copy; OpenStreetMap &copy; CARTO',
        styles: {
            active: { radius: 10, fillColor: '#3b82f6', color: '#fff', weight: 4, fillOpacity: 1 },
            inactive: { radius: 6, fillColor: '#64748b', color: '#fff', weight: 1, fillOpacity: 0.6 },
            line: { color: '#3b82f6', weight: 3, opacity: 0.5, dashArray: '5, 10' }
        },
        animationDuration: 1.5 // Sekunden für Map-FlyTo
    };

    // Prüfen, ob ein Token vorhanden ist (Sicherheits-Check)
    const TOKEN = document.body.dataset.token;
    if (!TOKEN) {
        console.error("Kein Token im Body-Dataset gefunden. Abbruch.");
        return;
    }

    /**
     * DOM-ELEMENTE CACHEN
     * Wir speichern Referenzen auf HTML-Elemente einmal ab, anstatt sie
     * bei jedem Klick neu zu suchen (Performance-Optimierung).
     */
    const dom = {
        map: document.getElementById('map'),
        currentPhoto: document.getElementById('current-photo'),
        bgPhoto: document.getElementById('bg-photo'),
        statsModal: document.getElementById('stats-modal'),
        btnStats: document.getElementById('open-stats'),
        fileInput: document.getElementById('file-input'),
        btnCloseStats: document.getElementById('close-stats'),
        tutorialModal: document.getElementById('tutorial-modal'),
        btnCloseTutorial: document.getElementById('close-tutorial'),
        btnHelp: document.getElementById('open-help'),
        // Text-Felder
        txtLocation: document.getElementById('photo-location'),
        txtDate: document.getElementById('photo-date')
    };

    /**
     * STATE MANAGEMENT
     * Variablen, die den aktuellen Zustand der App speichern.
     */
    const state = {
        allPhotos: [],      // Array aller geladenen Foto-Objekte
        currentIndex: 0,    // Welches Foto wird gerade angezeigt?
        mapMarkers: [],     // Referenzen zu den Leaflet-Markern
        mapInstance: null,  // Die Leaflet Karte
        adminUpload: {      // Status für den Upload-Prozess
            clickTimer: null,
            tempPassword: null
        }
    };

    // -------------------------------------------------------------------------
    // 1. KARTE INITIALISIEREN
    // -------------------------------------------------------------------------

    state.mapInstance = L.map(dom.map, { zoomControl: false }).setView(CONFIG.center, CONFIG.zoomLevel);

    L.control.zoom({ position: 'bottomright' }).addTo(state.mapInstance);

    L.tileLayer(CONFIG.tileLayerUrl, {
        attribution: CONFIG.tileAttribution,
        maxZoom: 19
    }).addTo(state.mapInstance);


    // -------------------------------------------------------------------------
    // 2. DATEN VOM SERVER LADEN
    // -------------------------------------------------------------------------

    fetch(`/api/route?token=${TOKEN}`)
        .then(response => {
            if (!response.ok) throw new Error(`HTTP Fehler: ${response.status}`);
            return response.json();
        })
        .then(data => {
            const { photos, stats } = data;

            // Statistik anzeigen (falls vorhanden)
            if (stats) {
                animateValue("stat-km", 0, stats.total_km, 1500);
                setText("stat-countries", stats.countries);
                setText("stat-days", stats.days);
                setText("stat-photos", stats.photo_count);
            }

            // Fotos verarbeiten
            if (!photos || photos.length === 0) return;

            // OPTIMIERUNG: Wir berechnen den Ländercode einmalig hier,
            // damit wir ihn nicht bei jedem Wechsel neu parsen müssen.
            state.allPhotos = photos.map(photo => ({
                ...photo,
                countryCode: extractCountryCode(photo.location)
            }));

            renderMapElements();
            updateView(); // Erstes Foto anzeigen
        })
        .catch(error => console.error("Fehler beim Laden der Routen-Daten:", error));


    function renderMapElements() {
        // Linie zeichnen
        const coords = state.allPhotos.map(photo => [photo.lat, photo.lon]);
        L.polyline(coords, CONFIG.styles.line).addTo(state.mapInstance);

        // Marker setzen
        state.allPhotos.forEach((photo, index) => {
            const marker = L.circleMarker([photo.lat, photo.lon], CONFIG.styles.inactive)
                .addTo(state.mapInstance);

            // Klick auf Marker öffnet Foto
            marker.on('click', () => {
                state.currentIndex = index;
                updateView();
            });

            state.mapMarkers.push(marker);
        });
    }

    // -------------------------------------------------------------------------
    // 3. ANSICHT AKTUALISIEREN (CORE LOGIK)
    // -------------------------------------------------------------------------

    function updateView() {
        if (!state.allPhotos.length) return;

        const photo = state.allPhotos[state.currentIndex];
        const imgEl = dom.currentPhoto;
        const bgEl = dom.bgPhoto;

        // Reset Fullscreen bei Bildwechsel
        if (imgEl) imgEl.classList.remove('is-fullscreen');

        // Fade-Out Effekt starten
        if (imgEl) imgEl.style.opacity = 0;
        if (bgEl) bgEl.style.opacity = 0;

        // Kurze Verzögerung für weichen Übergang
        setTimeout(() => {
            const thumbUrl = `/api/thumb/${photo.filename}?token=${TOKEN}`;

            if (imgEl) {
                imgEl.src = thumbUrl;
                imgEl.style.display = 'block';
                // Erst wenn geladen, wieder einblenden
                imgEl.onload = () => { imgEl.style.opacity = 1; };
            }

            if (bgEl) {
                bgEl.src = thumbUrl;
                bgEl.style.display = 'block';
                // Hintergrund parallel einblenden (onload hier optional, aber sicherer)
                bgEl.onload = () => { bgEl.style.opacity = 1; };
            }
        }, 150);

        // Texte aktualisieren
        setTextElement(dom.txtLocation, photo.location || "Unbekannt");
        setTextElement(dom.txtDate, photo.date_str || "Datum unbekannt");

        // Karte zentrieren
        state.mapInstance.flyTo(
            [photo.lat, photo.lon],
            10,
            { animate: true, duration: CONFIG.animationDuration }
        );

        // Marker Styles aktualisieren (Aktiver Marker hervorheben)
        state.mapMarkers.forEach((marker, index) => {
            if (index === state.currentIndex) {
                marker.setStyle(CONFIG.styles.active);
                marker.bringToFront();
            } else {
                marker.setStyle(CONFIG.styles.inactive);
            }
        });
    }

    // -------------------------------------------------------------------------
    // 4. NAVIGATION & STEUERUNG
    // -------------------------------------------------------------------------

    /**
     * Wechselt das Foto vor oder zurück.
     * Wird an 'window' gebunden, falls Inline-HTML (onclick) darauf zugreift.
     */
    window.changePhoto = (direction) => {
        if (!state.allPhotos.length) return;
        // Modulo-Logik für Endlos-Schleife (funktioniert auch bei negativen Zahlen)
        state.currentIndex = (state.currentIndex + direction + state.allPhotos.length) % state.allPhotos.length;
        updateView();
    };

    /**
     * Springt zum nächsten/vorherigen Land basierend auf dem Location-String.
     */
    window.changeLocation = (direction) => {
        if (!state.allPhotos.length) return;

        const currentCountry = state.allPhotos[state.currentIndex].countryCode;
        let index = state.currentIndex;
        let stepsChecked = 0;
        const total = state.allPhotos.length;

        if (direction === 1) {
            // Vorwärts suchen bis das Land sich ändert
            while (stepsChecked < total) {
                index = (index + 1) % total;
                if (state.allPhotos[index].countryCode !== currentCountry) {
                    state.currentIndex = index;
                    break;
                }
                stepsChecked++;
            }
        } else {
            // Rückwärts ist komplexer: Wir wollen zum Anfang des vorherigen Landes

            // 1. Zuerst zurückgehen, bis das Land sich ändert
            while (stepsChecked < total) {
                let prevIndex = (index - 1 + total) % total;
                if (state.allPhotos[prevIndex].countryCode !== currentCountry) break;
                index = prevIndex;
                stepsChecked++;
            }

            // 2. Jetzt sind wir am Anfang des aktuellen Landes. Einen Schritt zurück ins neue Land.
            index = (index - 1 + total) % total;
            const targetCountry = state.allPhotos[index].countryCode;

            // 3. Jetzt im neuen Land so weit zurück, bis dieses Land auch wieder endet (um Start zu finden)
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

    // Tastatur-Events
    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') window.changePhoto(-1);
        if (e.key === 'ArrowRight') window.changePhoto(1);
        if (e.key === 'ArrowUp') { e.preventDefault(); window.changeLocation(-1); }
        if (e.key === 'ArrowDown') { e.preventDefault(); window.changeLocation(1); }
    });

    // Touch-Gesten (Swipe)
    const touchZone = document.querySelector('.gallery-panel');
    let touchStartX = 0, touchStartY = 0;

    if (touchZone) {
        touchZone.addEventListener('touchstart', (e) => {
            touchStartX = e.changedTouches[0].screenX;
            touchStartY = e.changedTouches[0].screenY;
        }, { passive: false });

        touchZone.addEventListener('touchend', (e) => {
            const xDiff = e.changedTouches[0].screenX - touchStartX;
            const yDiff = e.changedTouches[0].screenY - touchStartY;
            const threshold = 50; // Mindest-Pixel für Swipe

            if (Math.abs(xDiff) > Math.abs(yDiff)) {
                // Horizontaler Swipe (Foto wechseln)
                if (Math.abs(xDiff) > threshold) window.changePhoto(xDiff < 0 ? 1 : -1);
            } else {
                // Vertikaler Swipe (Land wechseln)
                if (Math.abs(yDiff) > threshold) window.changeLocation(yDiff < 0 ? 1 : -1);
            }
        }, { passive: false });
    }

    // Fullscreen Toggle
    if (dom.currentPhoto) {
        dom.currentPhoto.addEventListener('click', () => {
            const el = dom.currentPhoto;
            if (el.classList.contains('is-fullscreen')) {
                el.classList.remove('is-fullscreen');
            } else {
                // High-Res Bild laden beim Vergrößern
                if (state.allPhotos.length > 0) {
                    const photo = state.allPhotos[state.currentIndex];
                    el.src = `/api/thumb/${photo.filename}?token=${TOKEN}&size=original`;
                }
                el.classList.add('is-fullscreen');
            }
        });
    }


    // -------------------------------------------------------------------------
    // 5. ADMIN UPLOAD & STATISTIK (Doppelklick-Logik)
    // -------------------------------------------------------------------------

    if (dom.btnStats && dom.fileInput && dom.statsModal) {

        dom.btnStats.addEventListener('click', (e) => {
            e.preventDefault();

            if (state.adminUpload.clickTimer) {
                // === DOPPELKLICK ERKANNT ===
                clearTimeout(state.adminUpload.clickTimer);
                state.adminUpload.clickTimer = null;

                // Passwort abfragen für Admin-Upload
                const password = prompt("🔒 Admin-Upload: Passwort eingeben:");
                if (password) {
                    state.adminUpload.tempPassword = password;
                    dom.fileInput.click(); // Dateidialog öffnen
                }

            } else {
                // === ERSTER KLICK ===
                // 300ms warten, ob ein zweiter Klick kommt
                state.adminUpload.clickTimer = setTimeout(() => {
                    // Kein zweiter Klick -> Normale Statistik öffnen
                    dom.statsModal.classList.add('show');
                    state.adminUpload.clickTimer = null;
                }, 300);
            }
        });

        // Datei-Auswahl Event
        dom.fileInput.addEventListener('change', async () => {
            const files = dom.fileInput.files;

            // Abbruch wenn keine Dateien oder kein Passwort (sollte durch Logic oben abgedeckt sein)
            if (files.length === 0 || !state.adminUpload.tempPassword) {
                state.adminUpload.tempPassword = null;
                dom.fileInput.value = "";
                return;
            }

            // UI Feedback: Button orange färben
            const originalColor = dom.btnStats.style.color;
            dom.btnStats.style.color = "#f59e0b";
            dom.btnStats.style.transform = "scale(1.2)";

            let successCount = 0;
            const password = state.adminUpload.tempPassword;
            state.adminUpload.tempPassword = null; // Passwort sofort aus State löschen

            // Dateien sequentiell hochladen
            for (let i = 0; i < files.length; i++) {
                const formData = new FormData();
                formData.append('photo', files[i]);
                formData.append('admin_token', password);

                try {
                    const res = await fetch('/api/upload', { method: 'POST', body: formData });
                    if (res.ok) {
                        successCount++;
                    } else {
                        const errData = await res.json();
                        // Bei erstem Fehler abbrechen und User warnen
                        if (i === 0) {
                            alert("Upload Fehler: " + (errData.error || "Unbekannt"));
                            break;
                        }
                    }
                } catch (error) {
                    console.error("Netzwerkfehler beim Upload:", error);
                }
            }

            // UI Reset
            dom.btnStats.style.color = originalColor;
            dom.btnStats.style.transform = "none";

            // Anzahl speichern, bevor das Feld geleert wird
            const totalFiles = files.length;
            dom.fileInput.value = "";

            if (successCount > 0) {
                // Gespeicherte Variable 'totalFiles' statt 'files.length' nutzen
                alert(`${successCount} von ${totalFiles} Fotos erfolgreich hochgeladen!`);
                location.reload();
            }
        });
    }


    // -------------------------------------------------------------------------
    // 6. HELFER-FUNKTIONEN
    // -------------------------------------------------------------------------

    function setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.innerText = text;
    }

    // Optimierte Helper-Funktion für DOM-Elemente, die wir schon gecacht haben
    function setTextElement(element, text) {
        if (element) element.innerText = text;
    }

    // Extrahiert den Ländercode (letzter Teil des Location-Strings)
    function extractCountryCode(locationString) {
        if (!locationString) return "UNK";
        const parts = locationString.split(',');
        return parts.length > 1 ? parts[parts.length - 1].trim() : "UNK";
    }

    // Zahlen-Animation (Count-Up)
    function animateValue(id, start, end, duration) {
        const obj = document.getElementById(id);
        if (!obj) return;

        let startTimestamp = null;
        const step = (timestamp) => {
            if (!startTimestamp) startTimestamp = timestamp;
            const progress = Math.min((timestamp - startTimestamp) / duration, 1);
            obj.innerHTML = Math.floor(progress * (end - start) + start).toLocaleString('de-DE');

            if (progress < 1) window.requestAnimationFrame(step);
        };
        window.requestAnimationFrame(step);
    }


    // -------------------------------------------------------------------------
    // 7. UI EVENT HANDLER (Modals & Tutorial)
    // -------------------------------------------------------------------------

    // Statistik Modal schließen
    if (dom.statsModal) {
        if(dom.btnCloseStats) dom.btnCloseStats.addEventListener('click', () => dom.statsModal.classList.remove('show'));

        // Klick auf Hintergrund schließt Modal
        dom.statsModal.addEventListener('click', (e) => {
            if (e.target === dom.statsModal) dom.statsModal.classList.remove('show');
        });
    }

    // Tutorial Logik (nur einmal anzeigen via LocalStorage)
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