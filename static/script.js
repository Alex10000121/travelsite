document.addEventListener("DOMContentLoaded", () => {
    // 1. Token Prüfung
    const TOKEN = document.body.dataset.token;
    if (!TOKEN) {
        console.error("Token fehlt!");
        return alert("Fehler: Sicherheits-Token fehlt.");
    }

    // 2. Karte Setup
    const map = L.map('map', { zoomControl: false }).setView([51.1657, 10.4515], 6);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19
    }).addTo(map);

    // Globale Variablen
    let allPhotos = [];
    let currentIndex = 0;
    let mapMarkers = [];

    const activeMarkerStyle = { radius: 10, fillColor: '#3b82f6', color: '#fff', weight: 4, fillOpacity: 1 };
    const inactiveMarkerStyle = { radius: 6, fillColor: '#64748b', color: '#fff', weight: 1, fillOpacity: 0.6 };

    // 3. Daten laden
    fetch(`/api/route?token=${TOKEN}`)
    .then(res => res.json())
    .then(data => {
        if (data.length === 0) return document.getElementById('photo-location').innerText = "Keine Fotos gefunden";

        allPhotos = data;

        // Route zeichnen
        const routeCoords = data.map(p => [p.lat, p.lon]);
        L.polyline(routeCoords, {color: '#3b82f6', weight: 3, opacity: 0.5, dashArray: '5, 10'}).addTo(map);

        // Marker setzen
        data.forEach((point, index) => {
            const marker = L.circleMarker([point.lat, point.lon], inactiveMarkerStyle);
            marker.on('click', () => { currentIndex = index; updateView(); });
            marker.addTo(map);
            mapMarkers.push(marker);
        });

        updateView();
    })
    .catch(err => console.error("API Fehler:", err));

    // --- VIEW UPDATE FUNKTION ---
    function updateView() {
        const photo = allPhotos[currentIndex];
        if(!photo) return;

        const imgEl = document.getElementById('current-photo');

        // Sanftes Einblenden
        imgEl.style.opacity = 0;
        setTimeout(() => {
            imgEl.src = `/api/thumb/${photo.filename}?token=${TOKEN}`;
            imgEl.style.display = 'block';
            imgEl.onload = () => { imgEl.style.opacity = 1; };
        }, 150);

        // Text Infos
        const d = new Date(photo.timestamp * 1000);
        document.getElementById('photo-location').innerText = photo.location || "Unbekannt";
        document.getElementById('photo-date').innerText = d.toLocaleDateString('de-DE') + ' ' + d.toLocaleTimeString('de-DE', {hour:'2-digit', minute:'2-digit'});

        // KARTE: Zoom Level 10 setzen
        map.flyTo([photo.lat, photo.lon], 10, { animate: true, duration: 1.5 });

        // Marker Highlight
        mapMarkers.forEach((m, idx) => {
            if (idx === currentIndex) { m.setStyle(activeMarkerStyle); m.bringToFront(); }
            else { m.setStyle(inactiveMarkerStyle); }
        });
    }

    // --- HELPER: LÄNDERCODE ---
    function getCountryCode(photo) {
        if (!photo || !photo.location) return "UNK";
        // Erwartet "Stadt, CC". Nimmt den letzten Teil nach dem Komma.
        const parts = photo.location.split(',');
        if (parts.length > 1) {
            return parts[parts.length - 1].trim();
        }
        return "UNK"; // Fallback, falls kein Komma da ist
    }

    // --- NAVIGATION: FOTOS ---
    window.changePhoto = function(dir) {
        if (allPhotos.length === 0) return;
        currentIndex = (currentIndex + dir + allPhotos.length) % allPhotos.length;
        updateView();
    };

    // --- NAVIGATION: LÄNDER ---
    window.changeLocation = function(dir) {
        if (allPhotos.length === 0) return;

        const currentCC = getCountryCode(allPhotos[currentIndex]);
        let searchIdx = currentIndex;
        let steps = 0;
        const total = allPhotos.length;

        if (dir === 1) {
            // Vorwärts (Pfeil Runter): Suche erstes Foto mit ANDEREM Ländercode
            while (steps < total) {
                searchIdx = (searchIdx + 1) % total;
                if (getCountryCode(allPhotos[searchIdx]) !== currentCC) {
                    currentIndex = searchIdx;
                    break;
                }
                steps++;
            }
        } else {
            // Rückwärts (Pfeil Hoch):
            // 1. Spule zurück zum Anfang des aktuellen Landes
            while (steps < total) {
                let prevIdx = (searchIdx - 1 + total) % total;
                if (getCountryCode(allPhotos[prevIdx]) !== currentCC) break;
                searchIdx = prevIdx;
                steps++;
            }
            // 2. Springe ins Land davor
            searchIdx = (searchIdx - 1 + total) % total;
            const prevCountryCC = getCountryCode(allPhotos[searchIdx]);

            // 3. Spule auch dieses Land zum Anfang zurück
            steps = 0;
            while (steps < total) {
                let prevIdx = (searchIdx - 1 + total) % total;
                if (getCountryCode(allPhotos[prevIdx]) !== prevCountryCC) break;
                searchIdx = prevIdx;
                steps++;
            }
            currentIndex = searchIdx;
        }
        updateView();
    };

    // --- EINGABE: TASTATUR ---
    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') window.changePhoto(-1);
        if (e.key === 'ArrowRight') window.changePhoto(1);
        if (e.key === 'ArrowUp') { e.preventDefault(); window.changeLocation(-1); }
        if (e.key === 'ArrowDown') { e.preventDefault(); window.changeLocation(1); }
    });

    // --- EINGABE: TOUCH SWIPE (FÜR HANDY) ---
    const touchZone = document.querySelector('.gallery-panel');
    let touchStartX = 0;
    let touchStartY = 0;

    // Startpunkt merken
    touchZone.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
        touchStartY = e.changedTouches[0].screenY;
    }, {passive: false});

    // Endpunkt auswerten
    touchZone.addEventListener('touchend', (e) => {
        const touchEndX = e.changedTouches[0].screenX;
        const touchEndY = e.changedTouches[0].screenY;

        const xDiff = touchEndX - touchStartX;
        const yDiff = touchEndY - touchStartY;
        const threshold = 50; // Mindeststrecke in Pixeln

        // Horizontal oder Vertikal?
        if (Math.abs(xDiff) > Math.abs(yDiff)) {
            // ---> HORIZONTAL (FOTOS)
            if (Math.abs(xDiff) > threshold) {
                // Wisch nach Links (Finger bewegt sich nach links) -> Nächstes Foto
                if (xDiff < 0) window.changePhoto(1);
                // Wisch nach Rechts -> Vorheriges Foto
                else window.changePhoto(-1);
            }
        } else {
            // ---> VERTIKAL (LÄNDER)
            if (Math.abs(yDiff) > threshold) {
                // Wisch nach Oben (Inhalt kommt von unten) -> Nächstes Land
                if (yDiff < 0) window.changeLocation(1);
                // Wisch nach Unten -> Vorheriges Land
                else window.changeLocation(-1);
            }
        }
    }, {passive: false});
});