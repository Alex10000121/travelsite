# 🌍 Travelsite – Deine private Reise-Galerie

**Travelsite** ist eine selbst gehostete Webanwendung, um deine Reisefotos auf einer interaktiven Karte zu visualisieren.  
Sie erstellt automatisch aus den EXIF-Daten deiner Bilder eine Reiseroute, berechnet Statistiken wie zurückgelegte Kilometer und besuchte Länder und präsentiert alles in einer modernen Galerie.

Das Projekt ist darauf ausgelegt, leichtgewichtig und privat zu sein. Ideal für das Hosting auf einem NAS zum Beispiel Synology oder einem kleinen VPS.

---

## ✨ Features

### 🗺 Interaktive Karte
Zeigt den genauen Aufnahmeort jedes Fotos an und verbindet sie zu einer Route. Klicke auf Marker, um direkt zum Foto zu springen.

### 📸 Browser-Upload (Neu!)
Lade Fotos direkt über den Browser hoch – auch vom Smartphone aus. Kein FTP oder SSH nötig.

### 📊 Live-Statistiken
Berechnet automatisch:
- Zurückgelegte Distanz in km  
- Anzahl der besuchten Länder  
- Dauer der Reise  
- Besucherzähler: Sieh, wie viele Freunde deine Reise verfolgen.

### 🔒 Privat und Sicher
Zugriff für Zuschauer nur über einen geheimen Token-Link möglich. Der Upload ist durch ein separates Admin-Passwort geschützt.

### 📱 Mobile-First
- Swipe Links/Rechts: Nächstes/Vorheriges Foto. 
- Swipe Hoch/Runter: Springt direkt zum nächsten/vorherigen Land.
- Fullscreen: Klick auf das Bild für volle Auflösung.

### 🤖 Automatischer Scanner
Überwacht deinen Foto-Ordner und fügt neue Bilder automatisch hinzu.

### ⚡ Performance
Generiert Thumbnails im Hintergrund für schnelles Laden.

### 🐳 Docker-Ready
Einfaches Deployment als Container.

---

## 🚀 Installation & Start (Docker)

Der einfachste Weg, Travelsite zu nutzen, ist Docker.

### 1. Container starten

Führe folgenden Befehl aus und passe die Pfade sowie den Token an:

```bash
docker run -d \
  --name travelsite \
  -p 5050:5000 \
  -v /pfad/zu/deinen/fotos:/photos \
  -v /pfad/fuer/daten:/data \
  -e ACCESS_TOKEN="dein-geheimes-passwort" \
  -e ADMIN_TOKEN="admin-upload-passwort" \
  -e CONTACT_EMAIL="deine@email.de" \
  --restart always \
  ghcr.io/alex10000121/travelsite:latest
 ```
### Zugriff
Öffne deinen Browser und rufe die Seite mit dem Token auf:
http://DEINE-IP:5000/?token=dein-geheimes-passwort

### 🎮 Bedienung & Tricks
Admin-Upload (Versteckt)
Um Fotos hochzuladen, ohne SSH-Zugriff zu benötigen:
1. Klicke doppelt (schnell) auf den Statistik-Button (oben rechts, das Balkendiagramm-Icon). 
2. Gib das ADMIN_TOKEN ein. 
3. Wähle Bilder aus und lade sie hoch.

Navigation

Pfeiltasten (PC): ⬅️ ➡️ für Fotos, ⬆️ ⬇️ für Länderwechsel.

Touch (Handy): Wischen für Navigation, Tippen für Vollbild.

## ⚙️ Konfiguration (Umgebungsvariablen)
| Variable      | Standardwert   | Beschreibung                                            
|---------------|----------------|---------------------------------------------------------
| PHOTO_DIR     | /photos        | Ordner im Container, in dem die Originalfotos liegen.   
| THUMB_DIR     | /data/thumbs   | Speicherort für generierte Vorschaubilder.              
| DB_PATH       | /data/trips.db | Pfad zur SQLite-Datenbank.                              
| ACCESS_TOKEN  | geheim123      | Besucher-Token: Für den Lesezugriff auf die Seite.                 
| Admin_Token   | admin_geheim   | Upload-Passwort: Für den Datei-Upload via Browser.
| CONTACT_EMAIL | ...            | E-Mail-Adresse, die auf der Login-Seite angezeigt wird.


Um das Projekt lokal ohne Docker zu testen:
1. Repository klonen

```bash
 git clone https://github.com/alex10000121/travelsite.git 
```
2. Abhängigkeiten installieren

```bash 
pip install -r requirements.txt
```
3. App starten

```bash 
python app.py
```

Der Server startet unter:http://127.0.0.1:5000/?token=geheim123
## 📂 Projektstruktur
- app.py: Backend-Logik mit Flask, Foto-Scanner und API.
- templates: 
  - index.html: Die Hauptanwendung.
  - login.html: Vorschaltseite bei fehlendem Token.
  - base.html: Grundgerüst.
- static: 
  - style.css: Modernes Dark-Mode Design.
  - script.js: Frontend-Logik, Leaflet-Karte, Swipe-Erkennung.
- Dockerfile: Bauplan für das Image inklusive Gunicorn und Background-Worker Setup.
## 🛡 Lizenz & Credits
Erstellt von Alex.
Verwendet Leaflet.js für Karten und OpenStreetMap Daten.
