document.addEventListener("DOMContentLoaded", () => {
    console.log("--- SCRIPT GESTARTET ---");

    // 1. Token aus dem HTML Body holen (Die "Brücke" zwischen Python und JS)
    const TOKEN = document.body.dataset.token;
    
    if (!TOKEN) {
        console.error("FATAL: Kein Token gefunden! Hat der <body> Tag das Attribut data-token?");
        alert("Fehler: Sicherheitstoken fehlt.");
        return;
    }
    console.log("Token erfolgreich geladen.");

    // 2. Karte initialisieren
    const map = L.map('map', {zoomControl: false}).setView([0,0], 2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 19
    }).addTo(map);

    // Globale Variablen (im Scope dieser Funktion)
    let allPhotos = [];
    let currentIndex = 0;
    let mapMarkers = [];

    // 3. Daten laden
    const apiUrl = `/api/route?token=${TOKEN}`;
    
    fetch(apiUrl)
    .then(response => {
        if (!response.ok) throw new Error("HTTP Fehler: " + response.status);
        return response.json();
    })
    .then(data => {
        if (data.length === 0) {
            console.warn("API meldet: Keine Fotos in der Datenbank.");
            document.getElementById('photo-caption').innerText = "Keine Fotos gefunden.";
            return;
        }

        allPhotos = data;

        // Route zeichnen
        const routeCoords = data.map(p => [p.lat, p.lon]);
        L.polyline(routeCoords, {color: '#e63946', weight: 4, opacity: 0.6}).addTo(map);

        // Marker setzen
        data.forEach((point, index) => {
            const marker = L.circleMarker([point.lat, point.lon], {
                radius: 5, fillColor: '#e63946', color: '#fff', weight: 1, fillOpacity: 0.8
            });
            
            marker.on('click', () => {
                currentIndex = index;
                updateView();
            });

            marker.addTo(map);
            mapMarkers.push(marker);
        });

        // Erstes Bild anzeigen
        currentIndex = 0;
        updateView();
    })
    .catch(err => {
        console.error("Fehler beim Laden der Daten:", err);
    });

    // --- INTERNE FUNKTIONEN ---

    function updateView() {
        const photo = allPhotos[currentIndex];
        if(!photo) return;

        // Bild URL
        const imgUrl = `/api/thumb/${photo.filename}?token=${TOKEN}`;
        const imgEl = document.getElementById('current-photo');
        
        // Nur neu setzen, wenn anders (verhindert Flackern)
        if(imgEl && imgEl.src.indexOf(imgUrl) === -1) {
            imgEl.src = imgUrl;
        }

        // Text Update
        const dateStr = new Date(photo.timestamp * 1000).toLocaleDateString('de-DE');
        const locationStr = photo.location ? photo.location : "Unbekannt";
        const capEl = document.getElementById('photo-caption');
        if(capEl) capEl.innerText = `${dateStr} | ${locationStr} (${currentIndex + 1}/${allPhotos.length})`;

        // Map Update
        map.flyTo([photo.lat, photo.lon], 12);

        // Marker Styling
        mapMarkers.forEach((m, idx) => {
            if (idx === currentIndex) {
                m.setStyle({ radius: 9, color: '#fff', weight: 3, fillColor: '#e63946', fillOpacity: 1 });
                m.bringToFront();
            } else {
                m.setStyle({ radius: 5, color: '#fff', weight: 1, fillColor: '#e63946', fillOpacity: 0.6 });
            }
        });
    }

    // --- NAVIGATION ---
    
    // Damit die Buttons im HTML funktionieren (onclick="changePhoto(...)"),
    // müssen wir diese Funktion global verfügbar machen (window):
    window.changePhoto = function(dir) {
        if (allPhotos.length === 0) return;
        currentIndex += dir;
        if (currentIndex >= allPhotos.length) currentIndex = 0;
        if (currentIndex < 0) currentIndex = allPhotos.length - 1;
        updateView();
    };

    // Tastatur
    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') window.changePhoto(-1);
        if (e.key === 'ArrowRight') window.changePhoto(1);
    });
});