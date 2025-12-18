document.addEventListener("DOMContentLoaded", () => {

    // 1. Token aus dem HTML-Body Attribut lesen
    const TOKEN = document.body.dataset.token;
    if (!TOKEN) {
        console.error("Token fehlt im HTML body tag!");
        alert("Sicherheits-Token fehlt!");
        return;
    }

    // 2. Karte initialisieren
    const map = L.map('map', { zoomControl: false }).setView([51.1657, 10.4515], 6);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        maxZoom: 19
    }).addTo(map);

    // Globale Variablen
    let allPhotos = [];
    let currentIndex = 0;
    let mapMarkers = [];

    const activeMarkerStyle = {
        radius: 10, fillColor: '#3b82f6', color: '#fff', weight: 4, fillOpacity: 1
    };
    const inactiveMarkerStyle = {
        radius: 6, fillColor: '#64748b', color: '#fff', weight: 1, fillOpacity: 0.6
    };

    // 3. Daten vom Server holen
    fetch(`/api/route?token=${TOKEN}`)
    .then(res => res.json())
    .then(data => {
        if (data.length === 0) {
            document.getElementById('photo-location').innerText = "Keine Fotos gefunden";
            return;
        }

        allPhotos = data;

        // Route zeichnen
        const routeCoords = data.map(p => [p.lat, p.lon]);
        L.polyline(routeCoords, {color: '#3b82f6', weight: 3, opacity: 0.5, dashArray: '5, 10'}).addTo(map);

        // Marker erstellen
        data.forEach((point, index) => {
            const marker = L.circleMarker([point.lat, point.lon], inactiveMarkerStyle);

            marker.on('click', () => {
                currentIndex = index;
                updateView();
            });

            marker.addTo(map);
            mapMarkers.push(marker);
        });

        // Starten
        updateView();
    })
    .catch(err => console.error("API Fehler:", err));

    // --- VIEW UPDATE ---
    function updateView() {
        const photo = allPhotos[currentIndex];
        if(!photo) return;

        // Bild laden
        const imgUrl = `/api/thumb/${photo.filename}?token=${TOKEN}`;
        const imgEl = document.getElementById('current-photo');

        // Fade-Effekt
        imgEl.style.opacity = 0;
        setTimeout(() => {
            imgEl.src = imgUrl;
            imgEl.style.display = 'block';
            imgEl.onload = () => { imgEl.style.opacity = 1; };
        }, 150);

        // Text Infos
        const dateObj = new Date(photo.timestamp * 1000);
        const dateStr = dateObj.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
        const timeStr = dateObj.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

        document.getElementById('photo-location').innerText = photo.location || `Foto #${currentIndex + 1}`;
        document.getElementById('photo-date').innerText = `${dateStr} um ${timeStr}`;

        // Karte Update (Hier ist der Zoom 10)
        map.flyTo([photo.lat, photo.lon], 10, {
            animate: true,
            duration: 1.5
        });

        // Marker Highlight
        mapMarkers.forEach((m, idx) => {
            if (idx === currentIndex) {
                m.setStyle(activeMarkerStyle);
                m.bringToFront();
            } else {
                m.setStyle(inactiveMarkerStyle);
            }
        });
    }

    // --- NAVIGATION ---
    window.changePhoto = function(dir) {
        if (allPhotos.length === 0) return;
        currentIndex += dir;
        if (currentIndex >= allPhotos.length) currentIndex = 0;
        if (currentIndex < 0) currentIndex = allPhotos.length - 1;
        updateView();
    };

    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') window.changePhoto(-1);
        if (e.key === 'ArrowRight') window.changePhoto(1);
    });
});