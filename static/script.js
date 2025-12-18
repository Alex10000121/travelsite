document.addEventListener("DOMContentLoaded", () => {

    // =========================================================
    // 1. SETUP & INITIALISIERUNG
    // =========================================================

    const TOKEN = document.body.dataset.token;
    if (!TOKEN) {
        // Falls kein Token (z.B. auf Login Seite), Script abbrechen
        return;
    }

    // Karte initialisieren (Leaflet)
    const map = L.map('map', { zoomControl: false }).setView([50, 10], 6);
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        maxZoom: 19
    }).addTo(map);

    // Globale Variablen
    let allPhotos = [];
    let currentIndex = 0;
    let mapMarkers = [];

    // Marker Styles
    const activeStyle = { radius: 10, fillColor: '#3b82f6', color: '#fff', weight: 4, fillOpacity: 1 };
    const inactiveStyle = { radius: 6, fillColor: '#64748b', color: '#fff', weight: 1, fillOpacity: 0.6 };

    // =========================================================
    // 2. DATEN LADEN (API)
    // =========================================================

    fetch(`/api/route?token=${TOKEN}`)
        .then(r => r.json())
        .then(response => {
            const photos = response.photos;
            const stats = response.stats;

            // A) Statistik (Zahlen hochzählen)
            if (stats) {
                animateValue("stat-km", 0, stats.total_km, 1500);
                setText("stat-countries", stats.countries);
                setText("stat-days", stats.days);
                setText("stat-photos", stats.photo_count);
            }

            // B) Fotos & Route
            if (!photos || photos.length === 0) return;
            allPhotos = photos;

            // Route zeichnen (Blaue Linie)
            const coords = photos.map(p => [p.lat, p.lon]);
            L.polyline(coords, {
                color: '#3b82f6', weight: 3, opacity: 0.5, dashArray: '5, 10'
            }).addTo(map);

            // Marker setzen
            photos.forEach((p, idx) => {
                const m = L.circleMarker([p.lat, p.lon], inactiveStyle).addTo(map);
                m.on('click', () => { currentIndex = idx; updateView(); });
                mapMarkers.push(m);
            });

            // Erstes Foto laden
            updateView();
        })
        .catch(e => console.error("Datenfehler:", e));


    // =========================================================
    // 3. CORE LOGIK (Ansicht aktualisieren)
    // =========================================================

    function updateView() {
        if (!allPhotos.length) return;

        const photo = allPhotos[currentIndex];
        const img = document.getElementById('current-photo');

        // Bild-Übergang
        img.style.opacity = 0;
        setTimeout(() => {
            img.src = `/api/thumb/${photo.filename}?token=${TOKEN}`;
            img.style.display = 'block';
            img.onload = () => { img.style.opacity = 1; };
        }, 150);

        // Texte aktualisieren
        const d = new Date(photo.timestamp * 1000);
        setText('photo-location', photo.location || "Unbekannt");
        setText('photo-date', d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}));

        // Karte bewegen
        map.flyTo([photo.lat, photo.lon], 10, { animate: true, duration: 1.5 });

        // Aktiven Marker hervorheben
        mapMarkers.forEach((m, i) => {
            if (i === currentIndex) {
                m.setStyle(activeStyle); m.bringToFront();
            } else {
                m.setStyle(inactiveStyle);
            }
        });
    }

    // Helper
    function setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.innerText = text;
    }

    function animateValue(id, start, end, duration) {
        const obj = document.getElementById(id);
        if(!obj) return;
        let startTimestamp = null;
        const step = (timestamp) => {
            if (!startTimestamp) startTimestamp = timestamp;
            const progress = Math.min((timestamp - startTimestamp) / duration, 1);
            obj.innerHTML = Math.floor(progress * (end - start) + start).toLocaleString('de-DE');
            if (progress < 1) window.requestAnimationFrame(step);
        };
        window.requestAnimationFrame(step);
    }

    function getCountryCode(p) {
        if (!p || !p.location) return "UNK";
        const parts = p.location.split(',');
        return parts.length > 1 ? parts[parts.length - 1].trim() : "UNK";
    }

    // =========================================================
    // 4. NAVIGATION
    // =========================================================

    // Foto wechseln
    window.changePhoto = (dir) => {
        if(!allPhotos.length) return;
        currentIndex = (currentIndex + dir + allPhotos.length) % allPhotos.length;
        updateView();
    };

    // Land wechseln
    window.changeLocation = (dir) => {
        if(!allPhotos.length) return;
        const currentCC = getCountryCode(allPhotos[currentIndex]);
        let idx = currentIndex;
        let steps = 0;

        if (dir === 1) { // Vorwärts suchen
            while(steps < allPhotos.length) {
                idx = (idx + 1) % allPhotos.length;
                if(getCountryCode(allPhotos[idx]) !== currentCC) { currentIndex = idx; break; }
                steps++;
            }
        } else { // Rückwärts suchen (komplexer um zum Anfang des Landes zu kommen)
            while(steps < allPhotos.length) {
                let prev = (idx - 1 + allPhotos.length) % allPhotos.length;
                if(getCountryCode(allPhotos[prev]) !== currentCC) break;
                idx = prev; steps++;
            }
            idx = (idx - 1 + allPhotos.length) % allPhotos.length;
            const targetCC = getCountryCode(allPhotos[idx]);
            steps = 0;
            while(steps < allPhotos.length) {
                let prev = (idx - 1 + allPhotos.length) % allPhotos.length;
                if(getCountryCode(allPhotos[prev]) !== targetCC) break;
                idx = prev; steps++;
            }
            currentIndex = idx;
        }
        updateView();
    };

    // =========================================================
    // 5. INPUT (Tastatur & Touch)
    // =========================================================

    // Tastatur
    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') window.changePhoto(-1);
        if (e.key === 'ArrowRight') window.changePhoto(1);
        if (e.key === 'ArrowUp') { e.preventDefault(); window.changeLocation(-1); }
        if (e.key === 'ArrowDown') { e.preventDefault(); window.changeLocation(1); }
    });

    // Touch Swipe
    const touchZone = document.querySelector('.gallery-panel');
    let tsX = 0, tsY = 0;

    if (touchZone) {
        touchZone.addEventListener('touchstart', (e) => {
            tsX = e.changedTouches[0].screenX;
            tsY = e.changedTouches[0].screenY;
        }, {passive:false});

        touchZone.addEventListener('touchend', (e) => {
            const xDiff = e.changedTouches[0].screenX - tsX;
            const yDiff = e.changedTouches[0].screenY - tsY;
            const threshold = 50;

            if(Math.abs(xDiff) > Math.abs(yDiff)) {
                // Horizontal: Fotos
                if(Math.abs(xDiff) > threshold) {
                    window.changePhoto(xDiff < 0 ? 1 : -1);
                }
            } else {
                // Vertikal: Länder
                if(Math.abs(yDiff) > threshold) {
                    window.changeLocation(yDiff < 0 ? 1 : -1);
                }
            }
        }, {passive:false});
    }

    // =========================================================
    // 6. UI MODALS & BUTTONS
    // =========================================================

    // Statistik Modal
    const statsModal = document.getElementById('stats-modal');
    const btnOpenStats = document.getElementById('open-stats');
    const btnCloseStats = document.getElementById('close-stats');

    if(btnOpenStats && statsModal) {
        btnOpenStats.addEventListener('click', () => statsModal.classList.add('show'));
        btnCloseStats.addEventListener('click', () => statsModal.classList.remove('show'));
        statsModal.addEventListener('click', (e) => { if(e.target === statsModal) statsModal.classList.remove('show'); });
    }

    // Tutorial Modal
    const tutorialModal = document.getElementById('tutorial-modal');
    const btnCloseTutorial = document.getElementById('close-tutorial');
    const btnOpenHelp = document.getElementById('open-help'); // Der Button oben links

    // Auto-Show Check
    const hasSeenTutorial = localStorage.getItem('tutorial_seen');
    if (!hasSeenTutorial && tutorialModal) {
        setTimeout(() => { tutorialModal.classList.add('show'); }, 1000);
    }

    // Schließen Button im Tutorial
    if (btnCloseTutorial) {
        btnCloseTutorial.addEventListener('click', () => {
            if(tutorialModal) tutorialModal.classList.remove('show');
            localStorage.setItem('tutorial_seen', 'true');
        });
    }

    // Öffnen Button (Hilfe Fragezeichen oben links)
    if (btnOpenHelp && tutorialModal) {
        btnOpenHelp.addEventListener('click', () => {
            if(statsModal) statsModal.classList.remove('show'); // Statistik zu, falls offen
            tutorialModal.classList.add('show');
        });
    }
});