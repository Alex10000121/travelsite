# Travelsite – Private Reise-Galerie

**Travelsite** ist eine selbst gehostete Webanwendung, um Reisefotos auf einer interaktiven 3D-Karte zu visualisieren. Die App liest GPS- und EXIF-Daten direkt aus den Bildern, berechnet daraus eine Reiseroute über die OSRM-API und präsentiert alles in einer modernen Galerie mit filmischen Kameraanimationen.

Konzipiert für den Betrieb auf einem NAS (z. B. Synology) oder einem kleinen VPS – leichtgewichtig, privat, ohne externe Dienste außer Kartendarstellung, Routing und optionalem Wetter (alle drei kostenlos und ohne eigenen Account nutzbar, MapTiler ausgenommen).

---

## Features

### 3D-Karte mit MapLibre GL JS
- Interaktive Karte mit 3D-Terrain und extrudierten Gebäuden (via MapTiler)
- Filmische Kameraflüge zu jedem Foto-Standort mit automatischem Orbit-Effekt nach der Landung
- Fotos erscheinen als runde Vorschaubild-Pins (à la Polarsteps) statt schlichter Punkte; nah beieinanderliegende Fotos clustern beim Rauszoomen zu einem Pin mit Vorschaubild + Anzahl-Badge und expandieren per Klick
- Ein-/Ausblenden-Button unten links auf der Karte, um nur die Route ohne Foto-Pins zu sehen
- Fallback auf OpenStreetMap-Raster, wenn kein MapTiler-Key konfiguriert ist

### Backend-Routing via OSRM
- Straßenrouten werden serverseitig über die öffentliche OSRM Driving API berechnet
- Ergebnisse werden dauerhaft in SQLite gecacht – kein erneuter API-Aufruf bei jedem Seitenbesuch
- Fehlende Routen werden automatisch im Hintergrund nachgeladen
- Strecken über 500 km bzw. ohne Straßenverbindung werden automatisch als Flug erkannt, als Luftlinie dargestellt und auf der Karte gestrichelt/blau statt durchgezogen/orange eingefärbt

### Zusätzliche Foto-Details
- Optionale Notiz pro Foto (z. B. "Bestes Restaurant der Reise") – rein optional, keine Pflichtangabe
- Fotos als Favorit markieren, sichtbar als Stern in der Galerie-Beschriftung
- Automatisches Wetter (Tages-Höchsttemperatur + Symbol) über die kostenlose Open-Meteo-Archiv-API, ohne API-Key. Gilt nur für neu gescannte/hochgeladene Fotos ab Einführung dieses Features, kein rückwirkendes Nachladen für Bestandsfotos; ganz frisch hochgeladene Fotos bleiben zunächst ohne Wetter, da die Archiv-API ein paar Tage Verzögerung hat

### Browser-Upload
- Fotos direkt über den Browser hochladen, auch vom Smartphone
- Kein FTP oder SSH erforderlich
- Unterstützt nachträgliches Setzen von GPS-Koordinaten für Fotos ohne EXIF-Standort (Auswahl auf einer eingebetteten Karte)

### Admin-Verwaltung
- Bestehende Fotos durchsuchen (Ort oder Dateiname), paginiert auch bei mehreren hundert Fotos
- Fotos löschen (inkl. Thumbnails und zugehöriger Routen-Cache-Einträge)
- GPS-Position nachträglich korrigieren, falls ein Ort falsch erkannt wurde
- Notiz hinzufügen/bearbeiten und Favoriten-Markierung setzen
- Besucher-Dashboard: Gesamtzahl, aktuell aktive Besucher, Verlauf der letzten 30 Tage als Chart

### Automatischer Foto-Scanner
- Überwacht den Foto-Ordner kontinuierlich und indiziert neue Bilder automatisch
- Extrahiert GPS-Koordinaten und Aufnahmedatum aus EXIF-Daten (PIL + piexif als Fallback)
- Fotos ohne GPS-Daten werden in einen separaten Ordner verschoben

### Live-Statistiken
- Zurückgelegte Distanz in km
- Anzahl besuchter Länder
- Reisedauer in Tagen
- Besucherzähler (sessionbasiert, 1-Stunden-Fenster)

### Sicherheit & Datenschutz
- Lesezugriff nur über einen geheimen Token-Link (optional abschaltbar via `PUBLIC_MODE`, siehe [Konfiguration](#konfiguration))
- Upload und Verwaltung über eine separate Admin-Anmeldung geschützt (serverseitige Session statt Query-Token)
- `ADMIN_TOKEN` und `SECRET_KEY` sind immer Pflicht-Umgebungsvariablen ohne unsicheren Standardwert – die App startet ohne sie bewusst nicht. `ACCESS_TOKEN` ebenso, außer `PUBLIC_MODE=1` ist gesetzt
- Datei-Endungs-Whitelist und Größenlimit beim Upload
- Rate-Limiting gegen Brute-Force auf Login- und Token-geschützten Endpunkten
- Keine Nutzerkonten, keine Datenbank außer SQLite

### Performance
- Thumbnails werden im Hintergrund generiert (max. 800×800 px)
- Route-GeoJSON wird einmalig vom Backend berechnet und gecacht
- WAL-Modus für die SQLite-Datenbank verhindert Lese-/Schreibkonflikte

---

## Installation

### Docker (empfohlen)

```bash
docker run -d \
  --name travelsite \
  -p 5050:5000 \
  -v /pfad/zu/deinen/fotos:/photos \
  -v /pfad/fuer/daten:/data \
  -e ACCESS_TOKEN="dein-geheimes-passwort" \
  -e ADMIN_TOKEN="admin-upload-passwort" \
  -e SECRET_KEY="$(openssl rand -hex 32)" \
  -e CONTACT_EMAIL="deine@email.de" \
  -e MAPTILER_API_KEY="dein-maptiler-key" \
  --restart always \
  ghcr.io/alex10000121/travelsite:latest
```

`ACCESS_TOKEN`, `ADMIN_TOKEN` und `SECRET_KEY` sind Pflicht — ohne sie startet der Container nicht (bewusst kein unsicherer Standardwert). Läuft die App nur im eigenen LAN/VPN, kann `ACCESS_TOKEN` mit `-e PUBLIC_MODE=1` entfallen (siehe [Konfiguration](#konfiguration)).

Anschließend die Seite im Browser öffnen:

```
http://DEINE-IP:5050/?token=dein-geheimes-passwort
```

Mit `PUBLIC_MODE=1` reicht `http://DEINE-IP:5050/` ohne Token.

### Lokal ohne Docker

```bash
git clone https://github.com/alex10000121/travelsite.git
cd travelsite
pip install -r requirements.txt
cp .env.example .env   # ACCESS_TOKEN, ADMIN_TOKEN, SECRET_KEY eintragen
python app.py
```

`.env` wird automatisch geladen (python-dotenv). Die App ist dann erreichbar unter:

```
http://127.0.0.1:5000/?token=<dein ACCESS_TOKEN>
```

---

## Konfiguration

Alle Einstellungen werden über Umgebungsvariablen gesetzt. Für den lokalen Betrieb kann eine `.env`-Datei verwendet werden, siehe [`.env.example`](.env.example) als Vorlage:

```env
PUBLIC_MODE=0
ACCESS_TOKEN=dein-geheimes-passwort
ADMIN_TOKEN=admin-upload-passwort
SECRET_KEY=
PHOTO_DIR=./photos
THUMB_DIR=./data/thumbs
DB_PATH=./data/trips.db
CONTACT_EMAIL=deine@email.de
MAPTILER_API_KEY=dein-maptiler-key
FLASK_DEBUG=0
```

| Variable         | Standardwert            | Beschreibung                                                          |
|------------------|-------------------------|-----------------------------------------------------------------------|
| `PUBLIC_MODE`    | `0`                      | `1` macht die Galerie/Karte ohne `ACCESS_TOKEN` erreichbar und deaktiviert das Secure-Cookie-Flag der Admin-Session (nötig für Zugriff per HTTP) – nur für vertrauenswürdige Netze ohne TLS (LAN/VPN) gedacht |
| `ACCESS_TOKEN`   | **Pflicht, außer `PUBLIC_MODE=1`** | Token für den Lesezugriff – wird an die URL angehängt      |
| `ADMIN_TOKEN`    | **Pflicht, kein Standard** | Passwort für Upload, Verwaltung und GPS-Korrekturen                |
| `SECRET_KEY`     | **Pflicht, kein Standard** | Signiert die Admin-Session. Zufällig generieren, z.B. `python -c "import secrets; print(secrets.token_hex(32))"` |
| `MAPTILER_API_KEY` | *(leer)*              | API-Key für MapTiler (3D-Terrain, Gebäude). Ohne Key: OSM-Fallback    |
| `CONTACT_EMAIL`  | `deine.email@beispiel.de` | Wird auf der Login-Seite angezeigt                                  |
| `PHOTO_DIR`      | `/photos`               | Ordner mit den Original-Fotos                                         |
| `THUMB_DIR`      | `/data/thumbs`          | Speicherort für generierte Vorschaubilder                             |
| `DB_PATH`        | `/data/trips.db`        | Pfad zur SQLite-Datenbank                                             |
| `FLASK_DEBUG`    | `0`                     | `1` aktiviert Werkzeug-Debugger/Reloader **und** deaktiviert das Secure-Cookie-Flag – nur für lokale Entwicklung |

> **MapTiler API-Key**: Einen kostenlosen Key gibt es unter [maptiler.com](https://www.maptiler.com/). Ohne Key läuft die Karte als 2D-OpenStreetMap ohne Terrain und 3D-Gebäude.

---

## Bedienung

### Galerie-Navigation

| Aktion | PC | Mobil |
|---|---|---|
| Nächstes / Vorheriges Foto | `→` / `←` | Wischen links / rechts |
| Nächstes / Vorheriges Land | `↑` / `↓` | Wischen hoch / runter |
| Vollbild | Klick auf Foto | Tippen auf Foto |
| Foto-Pins auf der Karte ein-/ausblenden | Klick auf das Augen-Symbol unten links auf der Karte | dito |
| Statistik-Übersicht öffnen | Einzelklick auf das Balken-Symbol oben rechts | dito |
| Admin-Bereich öffnen | Doppelklick auf dasselbe Balken-Symbol | dito |

Notiz, Favoriten-Stern und Wetter erscheinen automatisch in der Foto-Beschriftung, sofern für das jeweilige Foto vorhanden – keine eigene Aktion nötig.

### Admin-Funktionen

Der Admin-Bereich liegt unter `/admin` und ist durch eine eigene Anmeldung mit dem `ADMIN_TOKEN` geschützt (serverseitige Session, kein Query-Token wie bei der Galerie):

- **Fotos hochladen** – direkt über den Browser, auch mehrere gleichzeitig; fehlt einem Foto das EXIF-GPS, kann der Ort über eine eingebettete Karte gesetzt werden
- **Fotos verwalten** – bestehende Fotos durchsuchen (Ort/Dateiname), löschen, deren GPS-Position korrigieren, eine Notiz hinterlegen oder als Favorit markieren
- **Besucher** – Gesamtzahl, aktuell aktive Besucher und ein 30-Tage-Verlauf als Chart

---

## Entwicklung

```bash
# Backend-Tests (pytest)
pip install -r requirements-test.txt
pytest tests/ -v

# Frontend-Tests (vitest)
npm ci
npm run test:js
```

CI (GitHub Actions) führt beide Suiten bei jedem Push auf `main` aus.

---

## Projektstruktur

```
travelsite/
├── app.py                   # Flask-Backend, EXIF-Parser, OSRM-Routing, API
├── requirements.txt         # Python-Abhängigkeiten
├── requirements-test.txt    # Zusätzliche Test-Abhängigkeiten (pytest)
├── package.json             # JS-Test-Abhängigkeiten (vitest)
├── vitest.config.js
├── pytest.ini
├── Dockerfile               # Container-Bauplan mit Gunicorn
├── .env.example             # Vorlage für die lokale .env
├── templates/
│   ├── base.html            # HTML-Grundgerüst
│   ├── index.html           # Hauptanwendung
│   ├── login.html           # Token-Eingabeseite
│   └── admin.html           # /admin: Login-Formular bzw. Feature-Dashboard
├── static/
│   ├── main.js              # Einstiegspunkt der Galerie, verdrahtet alle Module
│   ├── map.js               # MapLibre-Kartencontroller (3D, Foto-Pins, Cluster, Routing)
│   ├── gallery.js           # Galerie- und Swipe-Logik
│   ├── api.js               # Alle fetch-Aufrufe zum Backend
│   ├── filename-utils.js    # URL-Encoding für Dateinamen (Thumb-/Delete-Requests)
│   ├── click-timer.js       # Einzel- vs. Doppelklick-Unterscheidung
│   ├── admin-login.js       # Login-Formular auf /admin
│   ├── admin-main.js        # Einstiegspunkt der /admin-Ansicht
│   ├── admin-upload.js      # Upload-Feature (Karte für /admin)
│   ├── admin-manage.js      # Fotos durchsuchen/löschen/GPS korrigieren, Notiz & Favorit
│   ├── admin-visitors.js    # Besucher-Dashboard mit SVG-Chart
│   └── style.css            # Dark-Mode Design
└── tests/
    ├── test_api.py          # Flask-Integrationstests
    ├── test_helpers.py      # Unit-Tests für Hilfsfunktionen
    ├── conftest.py
    └── js/                  # Vitest-Unit-Tests für die static/*.js-Module
```

---

## Lizenz & Credits

Erstellt von Alex.
Verwendet [MapLibre GL JS](https://maplibre.org/) für die Karte, [MapTiler](https://www.maptiler.com/) für Terrain und Kartenstil, [OpenStreetMap](https://www.openstreetmap.org/) und [OSRM](https://project-osrm.org/) für Geodaten und Routing, [Open-Meteo](https://open-meteo.com/) für historische Wetterdaten sowie [exifr](https://github.com/MikeKovarik/exifr) zum clientseitigen Auslesen von GPS-Daten beim Upload.
