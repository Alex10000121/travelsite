document.addEventListener("DOMContentLoaded", () => {

    /**
     * KONFIGURATION & KONSTANTEN
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
        animationDuration: 1.5
    };

    // Prüfen, ob ein Token vorhanden ist
    const TOKEN = document.body.dataset.token;
    if (!TOKEN) {
        console.error("Kein Token im Body-Dataset gefunden. Abbruch.");
        return;
    }

    /**
     * DOM-ELEMENTE CACHEN
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
        txtLocation: document.getElementById('photo-location'),
        txtDate: document.getElementById('photo-date'),
        // Neu für Ladebalken
        progressModal: document.getElementById('progress-modal'),
        progressBar: document.getElementById('progress-bar-fill'),
        progressText: document.getElementById('progress-text')
    };

    /**
     * STATE MANAGEMENT
     */
    const state = {
        allPhotos: [],
        currentIndex: 0,
        mapMarkers: [],
        mapInstance: null,
        clusterGroup: null, // Hinzugefügt für Cluster
        adminUpload: {
            clickTimer: null,
            tempPassword: null
        }
    };

    // -------------------------------------------------------------------------
    // 1. KARTE INITIALISIEREN
    // -------------------------------------------------------------------------

    state.mapInstance = L.map(dom.map, { zoomControl: false }).setView(CONFIG.center, CONFIG.zoomLevel);
    L.control.zoom({ position: 'bottomright' }).addTo(state.mapInstance);
    L.tileLayer(CONFIG.tileLayerUrl, { attribution: CONFIG.tileAttribution, maxZoom: 19 }).addTo(state.mapInstance);

    // -------------------------------------------------------------------------
    // 2. DATEN VOM SERVER LADEN (Hier fehlte wahrscheinlich etwas!)
    // -------------------------------------------------------------------------

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

            renderMapElements();
            updateView();
        })
        .catch(error => console.error("Fehler beim Laden der Routen-Daten:", error));


    function renderMapElements() {
        const coords = state.allPhotos.map(photo => [photo.lat, photo.lon]);
        L.polyline(coords, CONFIG.styles.line).addTo(state.mapInstance);

        // MarkerClusterGroup erstellen
        const markers = L.markerClusterGroup({
            showCoverageOnHover: false,
            spiderfyDistanceMultiplier: 2
        });

        state.allPhotos.forEach((photo, index) => {
            // Marker erstellen, aber NICHT direkt zur Map hinzufügen
            const marker = L.circleMarker([photo.lat, photo.lon], CONFIG.styles.inactive);

            marker.on('click', () => {
                state.currentIndex = index;
                updateView();
            });

            // Marker zur Cluster-Gruppe hinzufügen
            markers.addLayer(marker);
            state.mapMarkers.push(marker);
        });

        // Cluster-Gruppe zur Karte hinzufügen
        state.mapInstance.addLayer(markers);
        state.clusterGroup = markers;
    }

    // -------------------------------------------------------------------------
    // 3. ANSICHT AKTUALISIEREN
    // -------------------------------------------------------------------------

    function updateView() {
        if (!state.allPhotos.length) return;

        const photo = state.allPhotos[state.currentIndex];
        const imgEl = dom.currentPhoto;
        const bgEl = dom.bgPhoto;

        if (imgEl) imgEl.classList.remove('is-fullscreen');
        if (imgEl) imgEl.style.opacity = 0;
        if (bgEl) bgEl.style.opacity = 0;

        setTimeout(() => {
            const thumbUrl = `/api/thumb/${photo.filename}?token=${TOKEN}`;
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

        setTextElement(dom.txtLocation, photo.location || "Unbekannt");
        setTextElement(dom.txtDate, photo.date_str || "Datum unbekannt");

        const targetMarker = state.mapMarkers[state.currentIndex];

        // Funktion zum Hervorheben des Markers
        const highlightMarker = () => {
            state.mapMarkers.forEach((marker, index) => {
                if (index === state.currentIndex) {
                    marker.setStyle(CONFIG.styles.active);
                    marker.bringToFront();
                } else {
                    marker.setStyle(CONFIG.styles.inactive);
                }
            });
        };

        if (state.clusterGroup) {
            // Cluster bei Bedarf öffnen
            state.clusterGroup.zoomToShowLayer(targetMarker, () => {
                highlightMarker();
            });
        } else {
            // Fallback ohne Cluster
            state.mapInstance.flyTo(
                [photo.lat, photo.lon],
                10,
                { animate: true, duration: CONFIG.animationDuration }
            );
            highlightMarker();
        }
    }

    // -------------------------------------------------------------------------
    // 4. NAVIGATION & STEUERUNG
    // -------------------------------------------------------------------------

    window.changePhoto = (direction) => {
        if (!state.allPhotos.length) return;
        state.currentIndex = (state.currentIndex + direction + state.allPhotos.length) % state.allPhotos.length;
        updateView();
    };

    window.changeLocation = (direction) => {
        if (!state.allPhotos.length) return;
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
        if (e.key === 'ArrowLeft') window.changePhoto(-1);
        if (e.key === 'ArrowRight') window.changePhoto(1);
        if (e.key === 'ArrowUp') { e.preventDefault(); window.changeLocation(-1); }
        if (e.key === 'ArrowDown') { e.preventDefault(); window.changeLocation(1); }
    });

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
            const threshold = 50;
            if (Math.abs(xDiff) > Math.abs(yDiff)) {
                if (Math.abs(xDiff) > threshold) window.changePhoto(xDiff < 0 ? 1 : -1);
            } else {
                if (Math.abs(yDiff) > threshold) window.changeLocation(yDiff < 0 ? 1 : -1);
            }
        }, { passive: false });
    }

    if (dom.currentPhoto) {
        dom.currentPhoto.addEventListener('click', () => {
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
    // 5. ADMIN UPLOAD (MIT LADEBALKEN)
    // -------------------------------------------------------------------------

    if (dom.btnStats && dom.fileInput && dom.statsModal) {
        dom.btnStats.addEventListener('click', (e) => {
            e.preventDefault();
            if (state.adminUpload.clickTimer) {
                clearTimeout(state.adminUpload.clickTimer);
                state.adminUpload.clickTimer = null;
                const password = prompt("🔒 Admin-Upload: Passwort eingeben:");
                if (password) {
                    state.adminUpload.tempPassword = password;
                    dom.fileInput.click();
                }
            } else {
                state.adminUpload.clickTimer = setTimeout(() => {
                    dom.statsModal.classList.add('show');
                    state.adminUpload.clickTimer = null;
                }, 300);
            }
        });

        // HIER IST DER NEUE CODE FÜR DEN UPLOAD MIT LADEBALKEN
        dom.fileInput.addEventListener('change', async () => {
            const files = dom.fileInput.files;

            if (files.length === 0 || !state.adminUpload.tempPassword) {
                state.adminUpload.tempPassword = null;
                dom.fileInput.value = "";
                return;
            }

            // Modal anzeigen
            if (dom.progressModal) dom.progressModal.classList.add('show');
            if (dom.progressBar) dom.progressBar.style.width = '0%';

            let successCount = 0;
            let errorCount = 0;
            const password = state.adminUpload.tempPassword;
            state.adminUpload.tempPassword = null;

            const totalFiles = files.length;

            for (let i = 0; i < totalFiles; i++) {
                if (dom.progressText) {
                    dom.progressText.innerText = `Lade Bild ${i + 1} von ${totalFiles} hoch...`;
                }

                const formData = new FormData();
                formData.append('photo', files[i]);
                formData.append('admin_token', password);

                try {
                    const res = await fetch('/api/upload', { method: 'POST', body: formData });

                    if (res.ok) {
                        successCount++;
                    } else {
                        errorCount++;
                        // Bei Passwort-Fehler sofort abbrechen
                        if (res.status === 403 && i === 0) {
                            alert("Falsches Passwort.");
                            break;
                        }
                    }
                } catch (error) {
                    console.error("Netzwerkfehler:", error);
                    errorCount++;
                }

                if (dom.progressBar) {
                    const percent = Math.round(((i + 1) / totalFiles) * 100);
                    dom.progressBar.style.width = `${percent}%`;
                }
            }

            dom.fileInput.value = "";

            setTimeout(() => {
                if (dom.progressModal