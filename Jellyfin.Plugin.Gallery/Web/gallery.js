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
    var _currentItemId = null;
    var _pollTimer = null;

    /* ------------------------------------------------------------------------
     * Entry point. Called whenever the page might have changed.
     * ------------------------------------------------------------------------ */
    function init() {
        var itemId = getItemIdFromUrl();
        if (!itemId) {
            return;
        }

        // If the gallery already exists in the visible container and the item
        // hasn't changed, there's nothing to do.  If the item changed, reload.
        if (itemId === _currentItemId) {
            var container = getVisibleContainer();
            if (container && container.querySelector('.' + SECTION_CLASS)) {
                return;
            }
            // Gallery missing from visible container — fall through to recreate
        }

        // Kill any previous polling interval
        if (_pollTimer) {
            clearInterval(_pollTimer);
            _pollTimer = null;
        }

        _currentItemId = itemId;
        removeExistingSection();

        // Check immediately — anchors may already be in the DOM.
        // Then poll every 1s as a safety net (SPA may replace the DOM later).
        poll(itemId);
        _pollTimer = setInterval(function () { poll(itemId); }, 1000);
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

    /* ------------------------------------------------------------------------
     * Polling — checks for the gallery anchor every second.  Once found the
     * gallery is rendered; if the SPA later tears down and re-creates the
     * page DOM the poll will pick it up on the next tick.
     * ------------------------------------------------------------------------ */
    function poll(itemId) {
        // If the user navigated away, just return.
        // init() handles cleanup of the interval.
        if (getItemIdFromUrl() !== itemId || itemId !== _currentItemId) {
            return;
        }

        // Gallery already exists in the visible container — nothing to do.
        var container = getVisibleContainer();
        if (container && container.querySelector('.' + SECTION_CLASS)) {
            return;
        }

        var anchor = findGalleryAnchor();
        if (anchor) {
            loadGallery(itemId);
        }
    }

    /* ------------------------------------------------------------------------
     * DOM anchor detection
     *
     * Returns the element after which the gallery section should be inserted.
     * Always prefers #scenesCollapsible (even if hidden) — gallery goes right
     * after Scenes, before "More Like This".
     * Falls back to #similarCollapsible if #scenesCollapsible doesn't exist.
     * Returns null if neither is found — the poll keeps trying every second.
     * ------------------------------------------------------------------------ */

    /**
     * Find the visible .detailPageContent container (non-zero width).
     * Jellyfin's SPA leaves stale containers in the DOM from previous pages,
     * each with their own copies of the anchor elements (#scenesCollapsible,
     * #similarCollapsible).  We must operate on the visible one.
     */
    function getVisibleContainer() {
        var containers = document.querySelectorAll('.detailPageContent');
        for (var i = 0; i < containers.length; i++) {
            if (containers[i].offsetWidth > 0) {
                return containers[i];
            }
        }
        // Fallback: return the first one if none have width yet (SPA still loading)
        return containers[0] || null;
    }

    function findGalleryAnchor() {
        var container = getVisibleContainer();
        if (!container) return null;

        // Always prefer #scenesCollapsible — gallery goes right after Scenes,
        // before "More Like This" (#similarCollapsible).
        var el = container.querySelector('#scenesCollapsible');
        if (el) return el;

        // Fallback: #similarCollapsible — gallery goes before More Like This
        el = container.querySelector('#similarCollapsible');
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
            // If the user navigated away during the request, discard
            if (getItemIdFromUrl() !== itemId) return;

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
        var container = getVisibleContainer();
        if (!container) return;
        var existing = container.querySelector('.' + SECTION_CLASS);
        if (existing) {
            existing.parentNode.removeChild(existing);
        }
    }

    /* ------------------------------------------------------------------------
     * Event binding
     *
     * We listen to multiple navigation events to support Jellyfin's SPA:
     *   - 'viewshow' – Jellyfin's custom view-change event
     *   - 'hashchange' – browser hash URL changes
     *   - 'popstate' – browser back/forward
     *   - history.pushState / history.replaceState – Jellyfin's react-router
     *     uses these to navigate without triggering hashchange or popstate.
     * ------------------------------------------------------------------------ */

    // Listen for Jellyfin view navigation events
    document.addEventListener('viewshow', function () {
        init();
    });

    // Listen for URL hash changes (SPA navigation)
    window.addEventListener('hashchange', function () {
        _currentItemId = null;
        init();
    });

    // Listen for popstate (browser back/forward — SPA navigation)
    window.addEventListener('popstate', function () {
        _currentItemId = null;
        setTimeout(init, 100);
    });

    // Intercept pushState – Jellyfin's react-router uses this to navigate
    // without firing hashchange.  Without this, the gallery never re-initialises
    // when the user clicks a "More Like This" link or similar SPA navigation.
    var _origPushState = history.pushState;
    history.pushState = function () {
        _origPushState.apply(this, arguments);
        _currentItemId = null;
        init();
    };

    // Intercept replaceState – Jellyfin also uses this during navigation
    var _origReplaceState = history.replaceState;
    history.replaceState = function () {
        _origReplaceState.apply(this, arguments);
        _currentItemId = null;
        init();
    };

    // Initial check in case the page is already loaded
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', function () {
            init();
        });
    }
})();
