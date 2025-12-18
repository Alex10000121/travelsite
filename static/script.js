document.addEventListener("DOMContentLoaded", () => {
    // 1. Setup
    const TOKEN = document.body.dataset.token;
    if (!TOKEN) return alert("Token fehlt.");

    // Karte
    const map = L.map('map', { zoomControl: false }).setView([50, 10], 6);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19
    }).addTo(map);

    // Globals
    let allPhotos = [];
    let currentIndex = 0;
    let mapMarkers = [];
    const activeStyle = { radius: 10, fillColor: '#3b82f6', color: '#fff', weight: 4, fillOpacity: 1 };
    const inactiveStyle = { radius: 6, fillColor: '#64748b', color: '#fff', weight: 1, fillOpacity: 0.6 };

    // 2. Daten laden (Jetzt mit STATS!)
    fetch(`/api/route?token=${TOKEN}`)
    .then(r => r.json())
    .then(response => {
        // --- NEUE LOGIK FÜR DAS STATISTIK FORMAT ---
        const photos = response.photos;
        const stats = response.stats;

        // Statistik in das HTML schreiben (mit Animation)
        if (stats) {
            animateValue("stat-km", 0, stats.total_km, 1500);
            document.getElementById("stat-countries").innerText = stats.countries;
            document.getElementById("stat-days").innerText = stats.days;
            document.getElementById("stat-photos").innerText = stats.photo_count;
        }

        if (!photos || photos.length === 0) return;

        allPhotos = photos;

        // Route & Marker
        const coords = photos.map(p => [p.lat, p.lon]);
        L.polyline(coords, {color: '#3b82f6', weight: 3, opacity: 0.5, dashArray: '5, 10'}).addTo(map);

        photos.forEach((p, idx) => {
            const m = L.circleMarker([p.lat, p.lon], inactiveStyle).addTo(map);
            m.on('click', () => { currentIndex = idx; updateView(); });
            mapMarkers.push(m);
        });

        updateView();
    })
    .catch(e => console.error(e));

    // 3. View Logic
    function updateView() {
        const photo = allPhotos[currentIndex];
        const img = document.getElementById('current-photo');
        img.style.opacity = 0;
        setTimeout(() => {
            img.src = `/api/thumb/${photo.filename}?token=${TOKEN}`;
            img.style.display = 'block';
            img.onload = () => img.style.opacity = 1;
        }, 150);

        const d = new Date(photo.timestamp * 1000);
        document.getElementById('photo-location').innerText = photo.location || "Unbekannt";
        document.getElementById('photo-date').innerText = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});

        map.flyTo([photo.lat, photo.lon], 10, { animate: true, duration: 1.5 });

        mapMarkers.forEach((m, i) => {
            if (i === currentIndex) { m.setStyle(activeStyle); m.bringToFront(); }
            else m.setStyle(inactiveStyle);
        });
    }

    // --- HELPER: Zahlen hochzählen (Animation) ---
    function animateValue(id, start, end, duration) {
        const obj = document.getElementById(id);
        if(!obj) return;
        let startTimestamp = null;
        const step = (timestamp) => {
            if (!startTimestamp) startTimestamp = timestamp;
            const progress = Math.min((timestamp - startTimestamp) / duration, 1);
            obj.innerHTML = Math.floor(progress * (end - start) + start).toLocaleString('de-DE'); // Mit Tausenderpunkt
            if (progress < 1) window.requestAnimationFrame(step);
        };
        window.requestAnimationFrame(step);
    }

    // --- HELPER: Country Code ---
    function getCountryCode(p) {
        if (!p || !p.location) return "UNK";
        const parts = p.location.split(',');
        return parts.length > 1 ? parts[parts.length - 1].trim() : "UNK";
    }

    // --- NAVIGATION ---
    window.changePhoto = (dir) => {
        if(!allPhotos.length) return;
        currentIndex = (currentIndex + dir + allPhotos.length) % allPhotos.length;
        updateView();
    };

    window.changeLocation = (dir) => {
        if(!allPhotos.length) return;
        const cc = getCountryCode(allPhotos[currentIndex]);
        let idx = currentIndex;
        let steps = 0;

        if (dir === 1) {
            while(steps < allPhotos.length) {
                idx = (idx + 1) % allPhotos.length;
                if(getCountryCode(allPhotos[idx]) !== cc) { currentIndex = idx; break; }
                steps++;
            }
        } else {
            // Rückwärts Logik
            while(steps < allPhotos.length) {
                let prev = (idx - 1 + allPhotos.length) % allPhotos.length;
                if(getCountryCode(allPhotos[prev]) !== cc) break;
                idx = prev; steps++;
            }
            idx = (idx - 1 + allPhotos.length) % allPhotos.length;
            const prevCC = getCountryCode(allPhotos[idx]);
            steps = 0;
            while(steps < allPhotos.length) {
                let prev = (idx - 1 + allPhotos.length) % allPhotos.length;
                if(getCountryCode(allPhotos[prev]) !== prevCC) break;
                idx = prev; steps++;
            }
            currentIndex = idx;
        }
        updateView();
    };

    // --- TASTATUR ---
    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') window.changePhoto(-1);
        if (e.key === 'ArrowRight') window.changePhoto(1);
        if (e.key === 'ArrowUp') { e.preventDefault(); window.changeLocation(-1); }
        if (e.key === 'ArrowDown') { e.preventDefault(); window.changeLocation(1); }
    });

    // --- SWIPE ---
    const touchZone = document.querySelector('.gallery-panel');
    let tsX = 0, tsY = 0;
    touchZone.addEventListener('touchstart', (e) => { tsX = e.changedTouches[0].screenX; tsY = e.changedTouches[0].screenY; }, {passive:false});
    touchZone.addEventListener('touchend', (e) => {
        const xDiff = e.changedTouches[0].screenX - tsX;
        const yDiff = e.changedTouches[0].screenY - tsY;
        if(Math.abs(xDiff) > Math.abs(yDiff)) {
            if(Math.abs(xDiff) > 50) window.changePhoto(xDiff < 0 ? 1 : -1);
        } else {
            if(Math.abs(yDiff) > 50) window.changeLocation(yDiff < 0 ? 1 : -1);
        }
    }, {passive:false});

    // --- STATISTIK MODAL STEUERUNG ---
    const modal = document.getElementById('stats-modal');
    document.getElementById('open-stats').addEventListener('click', () => {
        modal.classList.add('show');
    });
    document.getElementById('close-stats').addEventListener('click', () => {
        modal.classList.remove('show');
    });
    // Schließen bei Klick auf Hintergrund
    modal.addEventListener('click', (e) => {
        if(e.target === modal) modal.classList.remove('show');
    });
});