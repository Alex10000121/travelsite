document.addEventListener("DOMContentLoaded", () => {

    // 1. SETUP (Kein Token-Reading mehr nötig)
    const map = L.map('map', { zoomControl: false }).setView([50, 10], 6);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19
    }).addTo(map);

    let allPhotos = [];
    let currentIndex = 0;
    let mapMarkers = [];

    const activeStyle = { radius: 10, fillColor: '#3b82f6', color: '#fff', weight: 4, fillOpacity: 1 };
    const inactiveStyle = { radius: 6, fillColor: '#64748b', color: '#fff', weight: 1, fillOpacity: 0.6 };

    // 2. DATEN LADEN (Ohne URL Token, Cookie wird automatisch gesendet)
    fetch('/api/route')
        .then(r => {
            // SICHERHEIT: Wenn Session abgelaufen (403), Seite neu laden (führt zum Login)
            if (r.status === 403) {
                window.location.reload();
                throw new Error("Session expired");
            }
            return r.json();
        })
        .then(response => {
            const photos = response.photos;
            const stats = response.stats;

            if (stats) {
                animateValue("stat-km", 0, stats.total_km, 1500);
                setText("stat-countries", stats.countries);
                setText("stat-days", stats.days);
                setText("stat-photos", stats.photo_count);
            }

            if (!photos || photos.length === 0) return;
            allPhotos = photos;

            const coords = photos.map(p => [p.lat, p.lon]);
            if(coords.length > 0) {
                 L.polyline(coords, { color: '#3b82f6', weight: 3, opacity: 0.5, dashArray: '5, 10' }).addTo(map);
            }

            photos.forEach((p, idx) => {
                const m = L.circleMarker([p.lat, p.lon], inactiveStyle).addTo(map);
                m.on('click', () => { currentIndex = idx; updateView(); });
                mapMarkers.push(m);
            });

            updateView();
        })
        .catch(e => console.error("Datenfehler oder nicht eingeloggt:", e));

    // 3. ANSICHT AKTUALISIEREN
    function updateView() {
        if (!allPhotos.length) return;

        const photo = allPhotos[currentIndex];
        const img = document.getElementById('current-photo');
        const bgImg = document.getElementById('bg-photo');

        // Sauberer Fade-Effekt
        img.style.opacity = 0;
        if(bgImg) bgImg.style.opacity = 0;

        setTimeout(() => {
            // URL ohne Token (Cookie regelt Auth)
            // encodeURIComponent ist wichtig falls Dateinamen Sonderzeichen haben
            const srcUrl = `/api/thumb/${encodeURIComponent(photo.filename)}`;

            img.src = srcUrl;
            img.style.display = 'block';

            if(bgImg) {
                bgImg.src = srcUrl;
                bgImg.style.display = 'block';
            }

            img.onload = () => {
                img.style.opacity = 1;
                if(bgImg) bgImg.style.opacity = 1;
            };

            // Fehler beim Bildladen (z.B. Session abgelaufen während Nutzung)
            img.onerror = () => {
                // Optional: Prüfen ob man noch eingeloggt ist, wenn Bild nicht lädt
                fetch(srcUrl).then(r => { if(r.status === 403) window.location.reload(); });
            }
        }, 150);

        const d = new Date(photo.timestamp * 1000);
        setText('photo-location', photo.location || "Unbekannt");
        setText('photo-date', d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}));

        map.flyTo([photo.lat, photo.lon], 10, { animate: true, duration: 1.5 });

        mapMarkers.forEach((m, i) => {
            if (i === currentIndex) { m.setStyle(activeStyle); m.bringToFront(); }
            else { m.setStyle(inactiveStyle); }
        });
    }

    // HELFER
    function setText(id, text) { const el = document.getElementById(id); if (el) el.innerText = text; }
    function getCountryCode(p) {
        if (!p || !p.location) return "UNK";
        const parts = p.location.split(',');
        return parts.length > 1 ? parts[parts.length - 1].trim() : "UNK";
    }
    function animateValue(id, start, end, duration) {
        const obj = document.getElementById(id); if(!obj) return;
        let startTimestamp = null;
        const step = (timestamp) => {
            if (!startTimestamp) startTimestamp = timestamp;
            const progress = Math.min((timestamp - startTimestamp) / duration, 1);
            obj.innerHTML = Math.floor(progress * (end - start) + start).toLocaleString('de-DE');
            if (progress < 1) window.requestAnimationFrame(step);
        };
        window.requestAnimationFrame(step);
    }

    // 4. NAVIGATION
    window.changePhoto = (dir) => {
        if(!allPhotos.length) return;
        currentIndex = (currentIndex + dir + allPhotos.length) % allPhotos.length;
        updateView();
    };

    window.changeLocation = (dir) => {
        if(!allPhotos.length) return;
        const currentCC = getCountryCode(allPhotos[currentIndex]);
        let idx = currentIndex;
        let steps = 0;

        if (dir === 1) {
            while(steps < allPhotos.length) {
                idx = (idx + 1) % allPhotos.length;
                if(getCountryCode(allPhotos[idx]) !== currentCC) { currentIndex = idx; break; }
                steps++;
            }
        } else {
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

    // 5. INPUT
    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') window.changePhoto(-1);
        if (e.key === 'ArrowRight') window.changePhoto(1);
        if (e.key === 'ArrowUp') { e.preventDefault(); window.changeLocation(-1); }
        if (e.key === 'ArrowDown') { e.preventDefault(); window.changeLocation(1); }
    });

    const touchZone = document.querySelector('.gallery-panel');
    let tsX = 0, tsY = 0;
    if (touchZone) {
        touchZone.addEventListener('touchstart', (e) => {
            tsX = e.changedTouches[0].screenX; tsY = e.changedTouches[0].screenY;
        }, {passive:false});

        touchZone.addEventListener('touchend', (e) => {
            const xDiff = e.changedTouches[0].screenX - tsX;
            const yDiff = e.changedTouches[0].screenY - tsY;
            const threshold = 50;
            if(Math.abs(xDiff) > Math.abs(yDiff)) {
                if(Math.abs(xDiff) > threshold) window.changePhoto(xDiff < 0 ? 1 : -1);
            } else {
                if(Math.abs(yDiff) > threshold) window.changeLocation(yDiff < 0 ? 1 : -1);
            }
        }, {passive:false});
    }

    // 6. MODALS
    const statsModal = document.getElementById('stats-modal');
    const btnOpenStats = document.getElementById('open-stats');
    const btnCloseStats = document.getElementById('close-stats');

    if(btnOpenStats && statsModal) {
        btnOpenStats.addEventListener('click', () => statsModal.classList.add('show'));
        btnCloseStats.addEventListener('click', () => statsModal.classList.remove('show'));
        statsModal.addEventListener('click', (e) => { if(e.target === statsModal) statsModal.classList.remove('show'); });
    }

    const tutorialModal = document.getElementById('tutorial-modal');
    const btnCloseTutorial = document.getElementById('close-tutorial');
    const btnOpenHelp = document.getElementById('open-help');

    const hasSeenTutorial = localStorage.getItem('tutorial_seen');
    if (!hasSeenTutorial && tutorialModal) {
        setTimeout(() => { tutorialModal.classList.add('show'); }, 1000);
    }

    if (btnCloseTutorial) {
        btnCloseTutorial.addEventListener('click', () => {
            if(tutorialModal) tutorialModal.classList.remove('show');
            localStorage.setItem('tutorial_seen', 'true');
        });
    }

    if (btnOpenHelp && tutorialModal) {
        btnOpenHelp.addEventListener('click', () => {
            if(statsModal) statsModal.classList.remove('show');
            tutorialModal.classList.add('show');
        });
    }
});