document.addEventListener("DOMContentLoaded", () => {

    /**
     * =============================================================================
     * 1. KONFIGURATION & SETUP
     * =============================================================================
     */

    // NEU: Prüfung auf Darkmode
    const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

    const CONFIG = {
        zoomLevel: 6,
        center: [50, 10],
        // NEU: Wählt die URL basierend auf der Systemeinstellung
        tileLayerUrl: isDarkMode
            ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png' // Dark Mode Karte
            : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', // Light Mode Karte
        tileAttribution: '&copy; OpenStreetMap &copy; CARTO',
        styles: {
            active: {
                radius: 10,
                fillColor: '#3b82f6',
                // Im Darkmode einen dunklen Rand für die Punkte, im Lightmode weiß
                color: isDarkMode ? '#1e293b' : '#fff',
                weight: 4,
                fillOpacity: 1
            },
            inactive: {
                radius: 6,
                fillColor: '#64748b',
                color: isDarkMode ? '#1e293b' : '#fff',
                weight: 1,
                fillOpacity: 0.6
            },
            line: {
                color: '#3b82f6',
                weight: 3,
                opacity: 0.5,
                dashArray: '5, 10'
            }
        },
        animationDuration: 1.5
    };

    const TOKEN = document.body.dataset.token;
    if (!TOKEN) {
        console.error("KRITISCH: Kein Token im Body-Dataset gefunden.");
        return;
    }

    /**
     * =============================================================================
     * 2. DOM ELEMENTE CACHEN
     * =============================================================================
     */
    const dom = {
        // --- Haupt-Ansicht ---
        map: document.getElementById('map'),
        currentPhoto: document.getElementById('current-photo'),
        bgPhoto: document.getElementById('bg-photo'),

        // --- Info-Bereich ---
        infoStandard: document.getElementById('info-standard'),
        fixInterface: document.getElementById('fix-interface'),
        fixSaveBtn: document.getElementById('fix-save-btn'),
        txtLocation: document.getElementById('photo-location'),
        txtDate: document.getElementById('photo-date'),

        // --- Modals (Popups) ---
        statsModal: document.getElementById('stats-modal'),
        tutorialModal: document.getElementById('tutorial-modal'),
        progressModal: document.getElementById('progress-modal'),

        // --- Login Modal Elemente ---
        loginModal: document.getElementById('login-modal'),
        loginForm: document.getElementById('admin-login-form'),
        passwordInput: document.getElementById('admin-password-input'),

        // --- Buttons ---
        btnStats: document.getElementById('open-stats'),
        btnHelp: document.getElementById('open-help'),
        btnFixMissing: document.getElementById('btn-fix-missing'),

        // --- Schließen-Buttons ---
        btnCloseStats: document.getElementById('close-stats'),
        btnCloseTutorial: document.getElementById('close-tutorial'),
        btnCloseLogin: document.getElementById('close-login'),

        // --- Upload & Fortschritt ---
        progressBar: document.getElementById('progress-bar-fill'),
        progressText: document.getElementById('progress-text'),
        fileInput: document.getElementById('file-input')
    };

    /**
     * =============================================================================
     * 3. STATE MANAGEMENT
     * =============================================================================
     */
    const state = {
        allPhotos: [],
        currentIndex: 0,
        mapMarkers: [],
        mapInstance: null,
        clusterGroup: null,

        // Admin-Status
        adminUpload: {
            clickTimer: null,
            tempPassword: null // Wird nur für die Dauer der Aktion gehalten
        },
        loginAction: 'upload', // 'upload' oder 'cleanup' - was passiert nach Login?

        // GPS Fix & Queue
        missingGpsQueue: [],
        isFixingMode: false,
        fixMarker: null
    };

    // -----------------------------------------------------------------------------
    // 4. KARTEN INITIALISIERUNG
    // -----------------------------------------------------------------------------

    state.mapInstance = L.map(dom.map, { zoomControl: false }).setView(CONFIG.center, CONFIG.zoomLevel);
    L.control.zoom({ position: 'bottomright' }).addTo(state.mapInstance);

    L.tileLayer(CONFIG.tileLayerUrl, {
        attribution: CONFIG.tileAttribution,
        maxZoom: 19
    }).addTo(state.mapInstance);

    state.mapInstance.on('click', (e) => {
        if (state.isFixingMode) {
            setFixMarker(e.latlng.lat, e.latlng.lng);
        }
    });

    // -----------------------------------------------------------------------------
    // 5. DATEN VOM SERVER LADEN
    // -----------------------------------------------------------------------------

    fetch(`/api/route?token=${TOKEN}`)
        .then(response => {
            if (!response.ok) throw new Error(`HTTP Fehler: ${response.status}`);
            return response.json();
        })
        .then(data => {
            const { photos, stats } = data;

            if (stats) {
                animateValue("stat-km", 0, stats.total_km, 1500);
                setText("stat-countries", stats.countries);
                setText("stat-days", stats.days);
                setText("stat-photos", stats.photo_count);
            }

            if (!photos || photos.length === 0) return;

            state.allPhotos = photos.map(photo => ({
                ...photo,
                countryCode: extractCountryCode(photo.location)
            }));

            // --- AUTO-DELETE PRÜFUNG ---
            const garbage = state.allPhotos.filter(p => p.lat == null || p.lon == null);

            if (garbage.length > 0) {
                console.log("Unvollständige Dateien gefunden.");
                // Wir zeigen immer den Warn-Button an, da wir keine Passwörter mehr cachen.
                if(dom.btnFixMissing) {
                    dom.btnFixMissing.style.display = 'flex';
                    dom.btnFixMissing.style.animation = "pulse 2s infinite";
                }
            }

            renderMapElements();
            updateView();
        })
        .catch(error => console.error("Fehler beim Laden der Daten:", error));


    async function cleanupGarbage(files, password) {
        let deletedCount = 0;

        // Feedback für den User, dass etwas passiert
        if(dom.progressModal) {
            dom.progressModal.classList.add('show');
            if(dom.progressText) dom.progressText.innerText = "Räume auf...";
            if(dom.progressBar) dom.progressBar.style.width = "100%";
        }

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
                if (res.ok) deletedCount++;
            } catch (e) {
                console.error("Netzwerkfehler beim Löschen:", e);
            }
        }

        // Aufräumen
        state.adminUpload.tempPassword = null; // Passwort vergessen!

        if (deletedCount > 0) {
            alert(`Bereinigung abgeschlossen. ${deletedCount} defekte Dateien entfernt.`);
            location.reload();
        } else {
            if(dom.progressModal) dom.progressModal.classList.remove('show');
            alert("Konnte Dateien nicht löschen. Falsches Passwort?");
        }
    }


    function renderMapElements() {
        const validCoords = state.allPhotos
            .filter(p => p.lat != null && p.lon != null)
            .map(p => [p.lat, p.lon]);

        if (validCoords.length > 0) {
            L.polyline(validCoords, CONFIG.styles.line).addTo(state.mapInstance);
        }

        const markers = L.markerClusterGroup({
            showCoverageOnHover: false,
            spiderfyDistanceMultiplier: 2
        });

        state.allPhotos.forEach((photo, index) => {
            if (photo.lat == null || photo.lon == null) {
                state.mapMarkers.push(null);
                return;
            }

            const marker = L.circleMarker([photo.lat, photo.lon], CONFIG.styles.inactive);

            marker.on('click', () => {
                if(state.isFixingMode) return;
                state.currentIndex = index;
                updateView();
            });

            markers.addLayer(marker);
            state.mapMarkers.push(marker);
        });

        state.mapInstance.addLayer(markers);
        state.clusterGroup = markers;
    }

    function updateView() {
        if (!state.allPhotos.length) return;
        const photo = state.allPhotos[state.currentIndex];

        displayImage(photo.filename);

        if (!state.isFixingMode) {
            setTextElement(dom.txtLocation, photo.location || "Unbekannt");
            setTextElement(dom.txtDate, photo.date_str || "Datum unbekannt");
        }

        const targetMarker = state.mapMarkers[state.currentIndex];
        if (targetMarker) {
            state.mapMarkers.forEach((marker, index) => {
                if (!marker) return;
                const isActive = (index === state.currentIndex);
                if (isActive) {
                    marker.setStyle(CONFIG.styles.active);
                    if (marker.bringToFront) marker.bringToFront();
                } else {
                    marker.setStyle(CONFIG.styles.inactive);
                }
            });

            if (state.clusterGroup) {
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

    function displayImage(filename) {
        const imgEl = dom.currentPhoto;
        const bgEl = dom.bgPhoto;

        if (imgEl) {
            imgEl.classList.remove('is-fullscreen');
            imgEl.style.opacity = 0;
        }
        if (bgEl) bgEl.style.opacity = 0;

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
    // 6. NAVIGATION
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

        if (direction === 1) {
            while (stepsChecked < total) {
                index = (index + 1) % total;
                if (state.allPhotos[index].countryCode !== currentCountry) {
                    state.currentIndex = index;
                    break;
                }
                stepsChecked++;
            }
        } else {
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

    document.addEventListener('keydown', (e) => {
        if (state.isFixingMode) return;
        if (e.key === 'ArrowLeft') window.changePhoto(-1);
        if (e.key === 'ArrowRight') window.changePhoto(1);
        if (e.key === 'ArrowUp') { e.preventDefault(); window.changeLocation(-1); }
        if (e.key === 'ArrowDown') { e.preventDefault(); window.changeLocation(1); }
    });

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
    // 7. ADMIN UPLOAD & LOGIN (SICHERHEITS-UPDATE)
    // -------------------------------------------------------------------------

    if (dom.btnStats && dom.fileInput) {
        // Logik für den Statistik-Button (Upload via Doppelklick)
        dom.btnStats.addEventListener('click', (e) => {
            e.preventDefault();

            if (state.adminUpload.clickTimer) {
                // Zweiter Klick -> Admin Login anfordern
                clearTimeout(state.adminUpload.clickTimer);
                state.adminUpload.clickTimer = null;

                state.loginAction = 'upload'; // Ziel: Upload
                openLoginModal();
            } else {
                // Erster Klick -> Warte kurz, dann zeige Statistik
                state.adminUpload.clickTimer = setTimeout(() => {
                    if(dom.statsModal) dom.statsModal.classList.add('show');
                    state.adminUpload.clickTimer = null;
                }, 300);
            }
        });
    }

    // Logik für den "Aufräumen"-Button (nur bei Fehlern sichtbar)
    if (dom.btnFixMissing) {
        dom.btnFixMissing.addEventListener('click', () => {
             state.loginAction = 'cleanup'; // Ziel: Aufräumen
             openLoginModal();
        });
    }

    // Zentrale Funktion zum Öffnen des Logins
    function openLoginModal() {
        if (dom.loginModal) {
            dom.loginModal.classList.add('show');
            setTimeout(() => {
                if(dom.passwordInput) dom.passwordInput.focus();
            }, 100);
        } else {
            // Fallback für Browser ohne Modal-Support
            const pw = prompt("Admin Passwort:");
            if(pw) handleLoginSuccess(pw);
        }
    }

    // Formular Submit Handler
    if (dom.loginForm) {
        dom.loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const pw = dom.passwordInput.value;
            const btn = dom.loginForm.querySelector('button');

            if (!pw) return;

            // UI Feedback: Button sperren und Text ändern
            const originalText = btn.innerText;
            btn.innerText = "Prüfe...";
            btn.disabled = true;
            btn.style.opacity = "0.7";

            try {
                // Wir fragen den Server: Stimmt das Passwort?
                const res = await fetch('/api/check_login', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ admin_token: pw })
                });

                if (res.ok) {
                    // Passwort ist korrekt -> Weiter geht's!
                    handleLoginSuccess(pw);
                    dom.passwordInput.value = "";
                } else {
                    // Passwort ist falsch -> Fehler anzeigen (kleines Wackeln oder Alert)
                    alert("⛔️ Falsches Passwort!");
                    dom.passwordInput.value = "";
                    dom.passwordInput.focus();
                }
            } catch (err) {
                alert("Verbindungsfehler zum Server.");
                console.error(err);
            } finally {
                // Button wieder normalisieren
                btn.innerText = originalText;
                btn.disabled = false;
                btn.style.opacity = "1";
            }
        });
    }

    // Was passiert nach erfolgreicher Eingabe?
    function handleLoginSuccess(password) {
        state.adminUpload.tempPassword = password; // Nur im RAM halten
        // KEIN sessionStorage.setItem!

        // Modal schließen
        if (dom.loginModal) dom.loginModal.classList.remove('show');

        // Aktion ausführen
        if (state.loginAction === 'upload') {
            dom.fileInput.click();
        } else if (state.loginAction === 'cleanup') {
            const garbage = state.allPhotos.filter(p => p.lat == null || p.lon == null);
            cleanupGarbage(garbage, password);
        }
    }

    // Upload Handler: Wenn Dateien ausgewählt wurden
    if (dom.fileInput) {
        dom.fileInput.addEventListener('change', async () => {
            const files = dom.fileInput.files;

            if (files.length === 0 || !state.adminUpload.tempPassword) {
                state.adminUpload.tempPassword = null;
                dom.fileInput.value = "";
                return;
            }

            if (dom.progressModal) dom.progressModal.classList.add('show');
            if (dom.progressBar) dom.progressBar.style.width = '0%';

            state.missingGpsQueue = [];
            let successCount = 0;
            let errorCount = 0;
            const totalFiles = files.length;
            const password = state.adminUpload.tempPassword;

            for (let i = 0; i < totalFiles; i++) {
                if (dom.progressText) {
                    dom.progressText.innerText = `Lade Bild ${i + 1} von ${totalFiles} hoch...`;
                }

                const exifData = await readExifFromFile(files[i]);
                const formData = new FormData();
                formData.append('photo', files[i]);
                formData.append('admin_token', password);
                if (exifData.lat !== undefined) formData.append('lat', exifData.lat);
                if (exifData.lon !== undefined) formData.append('lon', exifData.lon);
                if (exifData.timestamp !== undefined) formData.append('timestamp', exifData.timestamp);

                try {
                    const res = await fetch('/api/upload', { method: 'POST', body: formData });
                    const json = await res.json();

                    if (res.ok) {
                        successCount++;
                        if (json.missing_gps) {
                            state.missingGpsQueue.push(json.file);
                        }
                    } else {
                        errorCount++;
                        if (res.status === 403) {
                            alert("Falsches Passwort.");
                            state.adminUpload.tempPassword = null; // Sofort vergessen
                            break;
                        }
                    }
                } catch (error) {
                    console.error("Upload Fehler:", error);
                    errorCount++;
                }

                if (dom.progressBar) {
                    const percent = Math.round(((i + 1) / totalFiles) * 100);
                    dom.progressBar.style.width = `${percent}%`;
                }
            }

            dom.fileInput.value = "";
            if (dom.progressModal) dom.progressModal.classList.remove('show');

            if (state.missingGpsQueue.length > 0) {
                // Bei fehlendem GPS halten wir das Passwort noch kurz für den Fix-Prozess
                startFixingProcess(password);
            } else {
                state.adminUpload.tempPassword = null; // Sicherheit: Passwort vergessen

                if (successCount > 0) {
                    alert(`Fertig! ${successCount} hochgeladen.`);
                    location.reload();
                } else if (errorCount > 0) {
                    alert("Es traten Fehler auf (siehe Konsole).");
                }
            }
        });
    }

    // -------------------------------------------------------------------------
    // 8. GPS FIX ASSISTENT
    // -------------------------------------------------------------------------

    function startFixingProcess(password) {
        state.isFixingMode = true;
        state.adminUpload.tempPassword = password;

        if (dom.statsModal) dom.statsModal.classList.remove('show');
        if(dom.infoStandard) dom.infoStandard.style.display = 'none';
        if(dom.fixInterface) dom.fixInterface.style.display = 'block';

        processNextFix();
    }

    function processNextFix() {
        if (state.missingGpsQueue.length === 0) {
            state.adminUpload.tempPassword = null; // Fertig -> Passwort vergessen
            alert("Großartig! Alle Orte gespeichert.");
            location.reload();
            return;
        }

        const currentFilename = state.missingGpsQueue[0];
        displayImage(currentFilename);

        if (state.fixMarker) {
            state.mapInstance.removeLayer(state.fixMarker);
            state.fixMarker = null;
        }

        const center = state.mapInstance.getCenter();
        setFixMarker(center.lat, center.lng);
    }

    function setFixMarker(lat, lon) {
        if (state.fixMarker) {
            state.fixMarker.setLatLng([lat, lon]);
        } else {
            state.fixMarker = L.marker([lat, lon], {
                draggable: true,
                autoPan: true
            }).addTo(state.mapInstance);
        }
        state.mapInstance.panTo([lat, lon]);
    }

    if (dom.fixSaveBtn) {
        dom.fixSaveBtn.addEventListener('click', async (e) => {
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
                    state.missingGpsQueue.shift();
                    processNextFix();
                } else {
                    alert("Fehler beim Speichern. Passwort evtl. abgelaufen?");
                }
            } catch (err) {
                alert("Netzwerkfehler");
            }
        });
    }

    // -------------------------------------------------------------------------
    // 9. HELFER & MODAL EVENTS
    // -------------------------------------------------------------------------

    function dmsToDecimal(dms, ref) {
        const decimal = dms[0] + dms[1] / 60 + dms[2] / 3600;
        return (ref === 'S' || ref === 'W') ? -decimal : decimal;
    }

    function parseExifDate(str) {
        const [datePart, timePart] = str.split(' ');
        const [year, month, day] = datePart.split(':').map(Number);
        const [hour, min, sec] = timePart.split(':').map(Number);
        return Math.floor(new Date(year, month - 1, day, hour, min, sec).getTime() / 1000);
    }

    function readExifFromFile(file) {
        return new Promise((resolve) => {
            EXIF.getData(file, function () {
                const latDms  = EXIF.getTag(this, 'GPSLatitude');
                const latRef  = EXIF.getTag(this, 'GPSLatitudeRef');
                const lonDms  = EXIF.getTag(this, 'GPSLongitude');
                const lonRef  = EXIF.getTag(this, 'GPSLongitudeRef');
                const dateStr = EXIF.getTag(this, 'DateTimeOriginal');
                const result  = {};
                if (latDms && lonDms && latRef && lonRef) {
                    result.lat = dmsToDecimal(latDms, latRef);
                    result.lon = dmsToDecimal(lonDms, lonRef);
                }
                if (dateStr) {
                    result.timestamp = parseExifDate(dateStr);
                }
                resolve(result);
            });
        });
    }

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
        return parts.length > 1 ? parts[parts.length - 1].trim() : "UNK";
    }

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

    // Modal Events
    if (dom.statsModal && dom.btnCloseStats) {
        dom.btnCloseStats.addEventListener('click', () => dom.statsModal.classList.remove('show'));
        dom.statsModal.addEventListener('click', (e) => {
            if (e.target === dom.statsModal) dom.statsModal.classList.remove('show');
        });
    }

    if (dom.loginModal && dom.btnCloseLogin) {
        dom.btnCloseLogin.addEventListener('click', () => dom.loginModal.classList.remove('show'));
        dom.loginModal.addEventListener('click', (e) => {
            if (e.target === dom.loginModal) dom.loginModal.classList.remove('show');
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