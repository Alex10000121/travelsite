import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GalleryController } from '../../static/gallery.js';

// Alle DOM-Referenzen auf null setzen.
// _bindTouch und _bindFullscreen prüfen auf null und kehren dann sofort zurück.
// _bindKeyboard fügt einen keydown-Listener auf document hinzu — funktioniert
// problemlos in happy-dom.
const NULL_DOM = {
    currentPhoto: null,
    bgPhoto:      null,
    txtLocation:  null,
    txtDate:      null,
    galleryPanel: null,
};

function makeGallery() {
    return new GalleryController(NULL_DOM, 'test-token');
}

const PHOTOS = [
    { filename: 'a.jpg', location: 'Berlin, DE',  date_str: '01.01.2024', countryCode: 'DE' },
    { filename: 'b.jpg', location: 'Hamburg, DE', date_str: '02.01.2024', countryCode: 'DE' },
    { filename: 'c.jpg', location: 'Paris, FR',   date_str: '03.01.2024', countryCode: 'FR' },
    { filename: 'd.jpg', location: 'Lyon, FR',    date_str: '04.01.2024', countryCode: 'FR' },
    { filename: 'e.jpg', location: 'Madrid, ES',  date_str: '05.01.2024', countryCode: 'ES' },
];

function makeCaptionDom() {
    return {
        currentPhoto:  document.createElement('img'),
        bgPhoto:       document.createElement('img'),
        txtLocation:   document.createElement('h2'),
        txtDate:       document.createElement('p'),
        txtWeather:    document.createElement('p'),
        txtNote:       document.createElement('p'),
        favoriteBadge: document.createElement('span'),
        galleryPanel:  null,
    };
}

function makeCaptionGallery() {
    const dom = makeCaptionDom();
    const g = new GalleryController(dom, 'test-token');
    return { dom, g };
}

describe('optionale Caption-Felder (Notiz/Favorit/Wetter)', () => {
    it('blendet Notiz/Wetter/Favorit standardmaessig aus, wenn nicht vorhanden', () => {
        const { dom, g } = makeCaptionGallery();
        g.loadPhotos([{ ...PHOTOS[0] }], 0);

        expect(dom.txtNote.style.display).toBe('none');
        expect(dom.txtWeather.style.display).toBe('none');
        expect(dom.favoriteBadge.style.display).toBe('none');
    });

    it('zeigt eine vorhandene Notiz an', () => {
        const { dom, g } = makeCaptionGallery();
        g.loadPhotos([{ ...PHOTOS[0], note: 'Bestes Essen der Reise' }], 0);

        expect(dom.txtNote.style.display).toBe('block');
        expect(dom.txtNote.innerText).toBe('Bestes Essen der Reise');
    });

    it('zeigt den Favoriten-Stern, wenn is_favorite gesetzt ist', () => {
        const { dom, g } = makeCaptionGallery();
        g.loadPhotos([{ ...PHOTOS[0], is_favorite: true }], 0);

        expect(dom.favoriteBadge.style.display).toBe('block');
    });

    it('zeigt Wetter-Icon und gerundete Temperatur', () => {
        const { dom, g } = makeCaptionGallery();
        g.loadPhotos([{ ...PHOTOS[0], weather_temp: 23.6, weather_code: 0 }], 0);

        expect(dom.txtWeather.style.display).toBe('block');
        expect(dom.txtWeather.innerText).toBe('☀️ 24°C');
    });

    it('aktualisiert die Felder beim Fotowechsel korrekt (kein Ueberbleibsel vom vorherigen Foto)', () => {
        const { dom, g } = makeCaptionGallery();
        g.loadPhotos([
            { ...PHOTOS[0], note: 'Notiz zu Foto 1' },
            { ...PHOTOS[1] },
        ], 0);
        expect(dom.txtNote.style.display).toBe('block');

        g.changePhoto(1);
        expect(dom.txtNote.style.display).toBe('none');
        expect(dom.txtNote.innerText).toBe('');
    });
});

describe('changePhoto', () => {
    it('geht zum nächsten Foto', () => {
        const g = makeGallery();
        g.loadPhotos(PHOTOS, 0);
        g.changePhoto(1);
        expect(g.currentIndex).toBe(1);
    });

    it('geht zum vorherigen Foto', () => {
        const g = makeGallery();
        g.loadPhotos(PHOTOS, 2);
        g.changePhoto(-1);
        expect(g.currentIndex).toBe(1);
    });

    it('springt am Ende zurück zum Anfang (wrap-around vorwärts)', () => {
        const g = makeGallery();
        g.loadPhotos(PHOTOS, PHOTOS.length - 1);
        g.changePhoto(1);
        expect(g.currentIndex).toBe(0);
    });

    it('springt am Anfang ans Ende (wrap-around rückwärts)', () => {
        const g = makeGallery();
        g.loadPhotos(PHOTOS, 0);
        g.changePhoto(-1);
        expect(g.currentIndex).toBe(PHOTOS.length - 1);
    });

    it('macht nichts bei leerer Fotoliste', () => {
        const g = makeGallery();
        g.changePhoto(1);
        expect(g.currentIndex).toBe(0);
    });
});

describe('changeLocation vorwärts (+1)', () => {
    it('springt vom ersten Foto eines Landes zum ersten des nächsten', () => {
        const g = makeGallery();
        g.loadPhotos(PHOTOS, 0);
        g.changeLocation(1);
        expect(g.currentIndex).toBe(2);
        expect(g.currentPhoto.countryCode).toBe('FR');
    });

    it('springt auch aus der Mitte eines Landes heraus korrekt', () => {
        const g = makeGallery();
        g.loadPhotos(PHOTOS, 1);
        g.changeLocation(1);
        expect(g.currentIndex).toBe(2);
    });

    it('springt von FR zu ES', () => {
        const g = makeGallery();
        g.loadPhotos(PHOTOS, 2);
        g.changeLocation(1);
        expect(g.currentIndex).toBe(4);
    });

    it('springt vom letzten Land wieder zum ersten (wrap-around)', () => {
        const g = makeGallery();
        g.loadPhotos(PHOTOS, 4);
        g.changeLocation(1);
        expect(g.currentIndex).toBe(0);
    });
});

describe('changeLocation rückwärts (-1)', () => {
    it('springt zum ersten Foto des vorherigen Landes', () => {
        const g = makeGallery();
        g.loadPhotos(PHOTOS, 2);
        g.changeLocation(-1);
        expect(g.currentIndex).toBe(0);
        expect(g.currentPhoto.countryCode).toBe('DE');
    });

    it('landet immer beim ERSTEN Foto des Ziel-Landes, nicht beim letzten', () => {
        const g = makeGallery();
        g.loadPhotos(PHOTOS, 3);
        g.changeLocation(-1);
        expect(g.currentIndex).toBe(0);
    });

    it('springt von ES zu FR', () => {
        const g = makeGallery();
        g.loadPhotos(PHOTOS, 4);
        g.changeLocation(-1);
        expect(g.currentIndex).toBe(2);
    });

    it('springt vom ersten Land zum letzten (wrap-around)', () => {
        const g = makeGallery();
        g.loadPhotos(PHOTOS, 0);
        g.changeLocation(-1);
        expect(g.currentIndex).toBe(4);
    });

});

describe('setIndex', () => {
    it('setzt den Index direkt', () => {
        const g = makeGallery();
        g.loadPhotos(PHOTOS, 0);
        g.setIndex(3);
        expect(g.currentIndex).toBe(3);
    });

});

describe('loadPhotos', () => {
    it('startet am angegebenen Index', () => {
        const g = makeGallery();
        g.loadPhotos(PHOTOS, 3);
        expect(g.currentIndex).toBe(3);
        expect(g.currentPhoto).toBe(PHOTOS[3]);
    });

    it('fällt zurück auf Index 0 ohne Argument', () => {
        const g = makeGallery();
        g.loadPhotos(PHOTOS);
        expect(g.currentIndex).toBe(0);
    });
});

describe('onPhotoChange Callback', () => {
    it('wird bei loadPhotos ausgelöst', () => {
        const g = makeGallery();
        const cb = vi.fn();
        g.onPhotoChange = cb;
        g.loadPhotos(PHOTOS, 0);
        expect(cb).toHaveBeenCalledWith(0, PHOTOS[0]);
    });

    it('wird bei changePhoto mit korrektem Index aufgerufen', () => {
        const g = makeGallery();
        g.loadPhotos(PHOTOS, 0);
        const cb = vi.fn();
        g.onPhotoChange = cb;
        g.changePhoto(1);
        expect(cb).toHaveBeenCalledWith(1, PHOTOS[1]);
    });

    it('wird bei changeLocation mit dem Ziel-Foto aufgerufen', () => {
        const g = makeGallery();
        g.loadPhotos(PHOTOS, 0);
        const cb = vi.fn();
        g.onPhotoChange = cb;
        g.changeLocation(1);
        expect(cb).toHaveBeenCalledWith(2, PHOTOS[2]);
    });

});
