import { MapController } from './map.js';
import { AdminUploadCard } from './admin-upload.js';
import { AdminPhotoManager } from './admin-manage.js';
import { AdminVisitorStats } from './admin-visitors.js';
import { AdminRouteManager } from './admin-routes.js';
import { AdminLog } from './admin-log.js';
import { AdminReelManager } from './admin-reels.js';
import { AdminTabs } from './admin-tabs.js';

new AdminTabs({
    tabButtons: document.querySelectorAll('.admin-tab'),
    panels:     document.querySelectorAll('.admin-tab-panel'),
});

const defaultMapOptions = { center: [50, 10], zoom: 4 };

const uploadMap = new MapController(document.getElementById('admin-map'), defaultMapOptions);

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

const fixMap = new MapController(document.getElementById('admin-fix-map'), defaultMapOptions);

new AdminPhotoManager({
    list:         document.getElementById('admin-photo-list'),
    searchInput:  document.getElementById('admin-photo-search'),
    loadMoreBtn:  document.getElementById('admin-photo-load-more'),
    modal:        document.getElementById('admin-fix-modal'),
    closeBtn:     document.getElementById('admin-fix-close'),
    confirmBtn:   document.getElementById('admin-fix-confirm'),
}, fixMap);

new AdminVisitorStats({
    totalEl:        document.getElementById('admin-visitor-total'),
    activeEl:       document.getElementById('admin-visitor-active'),
    chartContainer: document.getElementById('admin-visitor-chart'),
    tooltip:        document.getElementById('admin-visitor-tooltip'),
});

new AdminRouteManager({
    list:        document.getElementById('admin-route-list'),
    loadMoreBtn: document.getElementById('admin-route-load-more'),
});

new AdminLog({
    list:        document.getElementById('admin-log-list'),
    searchInput: document.getElementById('admin-log-search'),
    countEl:     document.getElementById('admin-log-count'),
    loadMoreBtn: document.getElementById('admin-log-load-more'),
});

new AdminReelManager({
    groupSelect:   document.getElementById('admin-reel-group'),
    durationInput: document.getElementById('admin-reel-duration'),
    createBtn:     document.getElementById('admin-reel-create'),
    list:          document.getElementById('admin-reel-list'),
    loadMoreBtn:   document.getElementById('admin-reel-load-more'),
});

