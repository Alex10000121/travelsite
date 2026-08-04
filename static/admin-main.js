// Einstiegspunkt für die eingeloggte /admin-Ansicht: instanziiert die Admin-Feature-Karten.

import { MapController } from './map.js';
import { AdminUploadCard } from './admin-upload.js';
import { AdminPhotoManager } from './admin-manage.js';

const uploadMap = new MapController(document.getElementById('admin-map'), { center: [50, 10], zoom: 4 });

new AdminUploadCard({
    fileInput:     document.getElementById('admin-file-input'),
    chooseBtn:     document.getElementById('admin-choose-files'),
    gpsPicker:     document.getElementById('admin-gps-picker'),
    gpsConfirmBtn: document.getElementById('admin-gps-confirm'),
    progressWrap:  document.getElementById('admin-upload-progress'),
    progressFill:  document.getElementById('admin-progress-fill'),
    progressText:  document.getElementById('admin-progress-text'),
    log:           document.getElementById('admin-upload-log'),
}, uploadMap);

const fixMap = new MapController(document.getElementById('admin-fix-map'), { center: [50, 10], zoom: 4 });

new AdminPhotoManager({
    list:       document.getElementById('admin-photo-list'),
    modal:      document.getElementById('admin-fix-modal'),
    closeBtn:   document.getElementById('admin-fix-close'),
    confirmBtn: document.getElementById('admin-fix-confirm'),
}, fixMap);

// Weitere Admin-Feature-Karten werden hier analog instanziiert.
