(function () {
    'use strict';

    /* ========================================================================
     * Jellyfin Gallery Plugin — Frontend
     *
     * Injects a "Gallery" section into the movie details page when gallery
     * images exist for the currently viewed movie.
     * ======================================================================== */

    /* ------------------------------------------------------------------------
     * Inject CSS — ensures gallery styles are available on any page
     * ------------------------------------------------------------------------ */
    (function injectStyles() {
        var styleId = 'gallery-plugin-styles';
        if (document.getElementById(styleId)) {
            return;
        }
        var style = document.createElement('style');
        style.id = styleId;
        style.textContent = [
            '.gallery-section { margin-top: 1.5em; padding: 0 0.5em; }',
            '.gallery-section .sectionTitle { margin-bottom: 0.75em; }',
            '.gallery-grid { display: flex; flex-direction: row; gap: 0.5em; align-items: flex-start; }',
            '.gallery-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.5em; }',
            '.gallery-item { overflow: hidden; border-radius: 4px; background: rgba(0,0,0,0.2); }',
            '.gallery-thumb { width: 100%; height: auto; display: block; }',
            '@media (max-width: 768px) { .gallery-grid { flex-direction: column; } }'
        ].join(' ');
        document.head.appendChild(style);
    })();

    var SECTION_CLASS = 'gallery-section';
    var POLL_INTERVAL_MS = 1000;
    var MAX_POLL_ATTEMPTS = 3;
    var _currentItemId = null;
    var _pollCount = 0;
    var _pollTimer = null;

    /* ------------------------------------------------------------------------
     * Public API — called from the plugin's registered JS asset
     * ------------------------------------------------------------------------ */

    /**
     * Entry point. Called whenever the page might have changed.
     */
    function init() {
        var itemId = getItemIdFromUrl();
        if (!itemId || itemId === _currentItemId) {
            return;
        }

        _currentItemId = itemId;
        _pollCount = 0;
        removeExistingSection();
        startPolling(itemId);
    }

    /* ------------------------------------------------------------------------
     * URL / page detection
     * ------------------------------------------------------------------------ */

    function getItemIdFromUrl() {
        // Try query string first (non-SPA URLs)
        var params = new URLSearchParams(window.location.search);
        var id = params.get('id');
        if (id) return id;

        // Fallback: parse hash-based SPA URL (#/details?id=xxx)
        var hash = window.location.hash;
        if (hash) {
            var hashParams = new URLSearchParams(hash.split('?')[1] || '');
            return hashParams.get('id');
        }

        return null;
    }

    function isMovieDetailPage() {
        var path = window.location.pathname;
        var hash = window.location.hash;
        // Jellyfin 10.10+ uses /details or /web/details
        return path.indexOf('/details') !== -1
            || hash.indexOf('/details') !== -1;
    }

    /* ------------------------------------------------------------------------
     * Polling — wait for the detail page DOM to be ready
     * ------------------------------------------------------------------------ */

    function startPolling(itemId) {
        if (_pollTimer) {
            clearTimeout(_pollTimer);
            _pollTimer = null;
        }

        function poll() {
            _pollCount++;

            if (!isMovieDetailPage()) {
                // User navigated away
                _currentItemId = null;
                return;
            }

            var anchor = findGalleryAnchor();
            if (anchor) {
                loadGallery(itemId);
                return;
            }

            if (_pollCount < MAX_POLL_ATTEMPTS) {
                _pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
            }
        }

        _pollTimer = setTimeout(poll, 500);
    }

    /* ------------------------------------------------------------------------
     * DOM anchor detection
     *
     * Returns the element after which the gallery section should be inserted.
     * Prefers #scenesCollapsible, then #similarCollapsible.
     * Returns null if neither is found — the caller will poll and retry.
     * ------------------------------------------------------------------------ */

    function findGalleryAnchor() {
        // Prefer #scenesCollapsible — gallery goes right after Scenes
        var el = document.getElementById('scenesCollapsible');
        if (el) return el;

        // Fallback: #similarCollapsible — gallery goes before More Like This
        el = document.getElementById('similarCollapsible');
        if (el) return el;

        return null;
    }

    /* ------------------------------------------------------------------------
     * Data loading
     * ------------------------------------------------------------------------ */

    function loadGallery(itemId) {
        if (!window.ApiClient) {
            console.warn('Gallery Plugin: ApiClient not available.');
            return;
        }

        var url = ApiClient.getUrl('Gallery/' + itemId);

        ApiClient.getJSON(url).then(function (images) {
            if (images && images.length > 0) {
                // Append auth token to image URLs so <img> tags can load them
                var authToken = ApiClient.accessToken ? ApiClient.accessToken() : '';
                if (authToken) {
                    for (var i = 0; i < images.length; i++) {
                        if (images[i].Url) {
                            images[i].Url = images[i].Url + (images[i].Url.indexOf('?') === -1 ? '?' : '&') + 'ApiKey=' + encodeURIComponent(authToken);
                        }
                        if (images[i].ThumbnailUrl) {
                            images[i].ThumbnailUrl = images[i].ThumbnailUrl + (images[i].ThumbnailUrl.indexOf('?') === -1 ? '?' : '&') + 'ApiKey=' + encodeURIComponent(authToken);
                        }
                    }
                }
                renderGallery(images);
            } else {
                removeExistingSection();
            }
        }).catch(function (err) {
            console.error('Gallery Plugin: Failed to load gallery data.', err);
            removeExistingSection();
        });
    }

    /* ------------------------------------------------------------------------
     * Rendering
     * ------------------------------------------------------------------------ */

    function renderGallery(images) {
        removeExistingSection();

        var anchor = findGalleryAnchor();
        if (!anchor) {
            return;
        }

        var section = document.createElement('div');
        section.className = SECTION_CLASS + ' detailSection verticalSection-extrabottompadding';
        section.setAttribute('data-gallery', 'true');

        var heading = document.createElement('h2');
        heading.className = 'sectionTitle';
        heading.textContent = 'Gallery';
        section.appendChild(heading);

        var grid = document.createElement('div');
        grid.className = 'gallery-grid';
        section.appendChild(grid);

        // Create two columns for Pinterest-style masonry
        var col0 = document.createElement('div');
        col0.className = 'gallery-col';
        var col1 = document.createElement('div');
        col1.className = 'gallery-col';
        grid.appendChild(col0);
        grid.appendChild(col1);

        // Insert into DOM so we can measure column width
        anchor.parentNode.insertBefore(section, anchor.nextSibling);
        var colWidth = col0.offsetWidth;

        if (images.length === 0) return;

        // Preload all images in parallel to get natural dimensions,
        // then place each in the shortest column (true bin-packing masonry)
        var preloaded = [];
        var pending = images.length;

        for (var i = 0; i < images.length; i++) {
            (function (idx) {
                var loader = new Image();
                loader.onload = function () {
                    preloaded[idx] = {
                        w: loader.naturalWidth,
                        h: loader.naturalHeight
                    };
                    checkDone();
                };
                loader.onerror = function () {
                    // If an image fails, assume 1:1 so it still gets placed
                    preloaded[idx] = { w: 1, h: 1 };
                    checkDone();
                };
                loader.src = images[idx].Url || images[idx].ThumbnailUrl || images[idx].url;
            })(i);
        }

        function checkDone() {
            pending--;
            if (pending > 0) return;

            // All images measured — do true masonry bin-packing.
            // Process in original order so the gallery respects the
            // natural image sequence (0, 1, 2, …).
            var colHeights = [0, 0];
            var cols = [col0, col1];

            for (var idx = 0; idx < images.length; idx++) {
                var item = document.createElement('div');
                item.className = 'gallery-item';
                item.dataset.index = idx;

                var img = document.createElement('img');
                img.className = 'gallery-thumb';
                img.src = images[idx].Url || images[idx].ThumbnailUrl || images[idx].url;
                img.alt = images[idx].Name || images[idx].name;
                img.loading = 'eager';
                item.appendChild(img);

                var p = preloaded[idx];
                var renderedH = (p.h / p.w) * colWidth;

                // Place in the currently shorter column
                var shortCol = colHeights[0] <= colHeights[1] ? 0 : 1;
                colHeights[shortCol] += renderedH;
                cols[shortCol].appendChild(item);
            }
        }
    }

    function removeExistingSection() {
        var existing = document.querySelector('.' + SECTION_CLASS);
        if (existing) {
            existing.parentNode.removeChild(existing);
        }
    }

    /* ------------------------------------------------------------------------
     * Event binding
     * ------------------------------------------------------------------------ */

    // Listen for Jellyfin view navigation events
    document.addEventListener('viewshow', function () {
        init();
    });

    // Listen for URL hash changes (fallback)
    window.addEventListener('hashchange', function () {
        _currentItemId = null;
        init();
    });

    // Listen for popstate (browser back/forward)
    window.addEventListener('popstate', function () {
        _currentItemId = null;
        setTimeout(init, 100);
    });

    // Initial check in case the page is already loaded
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(init, 500);
    } else {
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(init, 500);
        });
    }
})();
