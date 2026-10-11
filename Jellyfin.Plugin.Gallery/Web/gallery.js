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
            '.gallery-section { margin-top: 1.5em; padding: 0 0.5em 0 0; animation: galleryFade .25s ease; }',
            '@keyframes galleryFade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }',
            '.gallery-section .sectionTitle { margin-bottom: 0.75em; }',
            '.gallery-grid { display: block; min-height: 120px; }',
            '.gallery-sizer, .gallery-item { width: calc((100% - 16px) / 3); }',
            '.gallery-item { margin-bottom: 8px; overflow: hidden; border-radius: 4px; background: rgba(0,0,0,0.2); break-inside: avoid; }',
            '.gallery-grid.gallery-fallback { column-gap: 8px; column-count: 3; }',
            '.gallery-grid.gallery-fallback .gallery-sizer { display: none; }',
            '.gallery-grid.gallery-fallback .gallery-item { width: 100%; display: inline-block; }',
            '@media (max-width: 1199px) { .gallery-grid.gallery-fallback { column-count: 2; } }',
            '@media (max-width: 768px) { .gallery-grid.gallery-fallback { column-count: 1; } }',
            '.gallery-item img { opacity: 0; transition: opacity .3s ease; }',
            '.gallery-item img.loaded { opacity: 1; }',
            '.gallery-thumb { width: 100%; height: auto; display: block; }',
            '.gallery-skeleton { display: flex; gap: 0.5em; min-height: 180px; }',
            '.gallery-skeleton-col { flex: 1; display: flex; flex-direction: column; gap: 0.5em; }',
            '.gallery-skeleton-block { border-radius: 4px; background: linear-gradient(100deg, rgba(255,255,255,0.04) 40%, rgba(255,255,255,0.10) 50%, rgba(255,255,255,0.04) 60%); background-size: 200% 100%; animation: galleryShimmer 1.2s infinite linear; }',
            '@keyframes galleryShimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }',
            '@media (max-width: 1199px) { .gallery-sizer, .gallery-item { width: calc((100% - 8px) / 2); } }',
            '@media (max-width: 768px) { .gallery-sizer, .gallery-item { width: 100%; } }'
        ].join(' ');
        document.head.appendChild(style);
    })();

    var SECTION_CLASS = 'gallery-section';
    var _currentItemId = null;
    var _observer = null;
    var _observerTimeout = null;
    var _rafPending = false;
    var _isInitialLoad = true;
    var _fetchItemId = null;
    var _resizeTimer = null;
    var _lastImages = null;
    var _renderedColumnCount = 0;
    var _msnry = null;
    var _masonryFailed = false;
    var _masonryCallbacks = null;
    var _layoutQueued = false;
    var MASONRY_CDN = 'https://unpkg.com/masonry-layout@4/dist/masonry.pkgd.min.js';

    /* ------------------------------------------------------------------------
     * Entry point. Called whenever the page might have changed.
     *
     * SPA-safe: on SPA navigation the OLD details DOM is still in the
     * document, so a synchronous anchor check would find the STALE anchor
     * and render the gallery into a DOM subtree that is about to be torn
     * down (gallery flashes in the wrong place / at the end, then
     * disappears).  For SPA navigations we therefore skip the sync check
     * entirely and let the MutationObserver wait for the NEW anchor.
     * Only the very first (full page) load does a fast sync check.
     * ------------------------------------------------------------------------ */
    function init() {
        var itemId = getItemIdFromUrl();
        if (!itemId) {
            stopWatching();
            return;
        }

        if (itemId === _currentItemId) {
            // Same movie — just make sure a visible gallery is correctly
            // positioned (late-loading sections may have pushed it down).
            ensureGalleryPosition();
            return;
        }

        _currentItemId = itemId;
        _lastImages = null;
        _renderedColumnCount = 0;
        _fetchItemId = null;
        stopWatching();
        destroyMasonry();
        // Remove any gallery left in stale SPA subtrees, not just the
        // currently visible container.
        document.querySelectorAll('.' + SECTION_CLASS).forEach(function (el) {
            if (el.parentNode) el.parentNode.removeChild(el);
        });

        // Kick off the data fetch immediately, in parallel with the DOM
        // building — don't wait for the anchor before hitting the network.
        fetchGallery(itemId);

        var isSpaNav = !_isInitialLoad;
        _isInitialLoad = false;

        if (!isSpaNav) {
            // Full page load: DOM is already complete, try sync placement
            // first for instant paint. Fall through to the observer either
            // way so late-loading Scenes/Similar still re-seat us.
            tryPlaceGallery();
        }
        // SPA navigation (or sync miss): wait for the NEW anchor via observer.
        watchForAnchor(itemId);
    }

    /* ------------------------------------------------------------------------
     * URL / page detection
     * ------------------------------------------------------------------------ */
    function getItemIdFromUrl() {
        // Jellyfin 12 uses hash-based SPA routes (#/details?id=xxx), but
        // also support plain query strings and path-embedded GUIDs.
        var guidRe = /[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

        function extractGuid(value) {
            if (!value) return null;
            var m = String(value).match(guidRe);
            return m ? m[0] : null;
        }

        // Try query string first (non-SPA URLs)
        var id = extractGuid(new URLSearchParams(window.location.search).get('id'));
        if (id) return id;

        // Hash-based SPA URL (#/details?id=xxx)
        var hash = window.location.hash || '';
        id = extractGuid(new URLSearchParams(hash.split('?')[1] || '').get('id'));
        if (id) return id;

        // Path-embedded GUID (Jellyfin 12 react-router routes)
        id = extractGuid(window.location.pathname);
        if (id) return id;

        // Last resort: any GUID in the hash fragment
        return extractGuid(hash);
    }

    /* ------------------------------------------------------------------------
     * Anchor watching — MutationObserver waits for the NEW details DOM.
     * Batches callbacks via requestAnimationFrame so insertion happens in
     * the same frame the anchor appears (no 1s poll delay, no end-of-page
     * flash). Stays alive through the page build so late-loading
     * Scenes/Similar sections re-seat the gallery; 15s safety timeout
     * disconnects the observer.
     * ------------------------------------------------------------------------ */
    function watchForAnchor(itemId) {
        stopWatching();

        // Fast path: data + anchor may already be ready. Keep watching
        // anyway — late sections can still arrive and need a re-seat.
        tryPlaceGallery();

        if (!('MutationObserver' in window)) {
            return;
        }

        _observer = new MutationObserver(function () {
            if (_rafPending) return;
            _rafPending = true;
            var cb = function () {
                _rafPending = false;
                if (itemId !== _currentItemId || getItemIdFromUrl() !== itemId) {
                    stopWatching();
                    return;
                }
                if (!_lastImages) {
                    return; // fetch still in flight — keep waiting
                }
                var container = getVisibleContainer();
                var existing = container && container.querySelector('.' + SECTION_CLASS);
                if (!existing) {
                    tryPlaceGallery();
                } else {
                    ensureGalleryPosition();
                }
                // Don't disconnect here — the timeout does that. Page
                // sections keep streaming in after first paint.
            };
            if ('requestAnimationFrame' in window) {
                requestAnimationFrame(cb);
            } else {
                cb();
            }
        });

        if (document.body) {
            _observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        }

        _observerTimeout = setTimeout(stopWatching, 15000);
    }

    function stopWatching() {
        if (_observer) {
            _observer.disconnect();
            _observer = null;
        }
        if (_observerTimeout) {
            clearTimeout(_observerTimeout);
            _observerTimeout = null;
        }
        _rafPending = false;
    }

    // Data is ready AND anchor exists -> render now. Returns true when
    // placement is settled (rendered, or definitively nothing to render).
    function tryPlaceGallery() {
        if (!_lastImages) {
            return false; // fetch still in flight
        }
        if (_lastImages.length === 0) {
            removeExistingSection();
            return true;
        }
        var anchor = findGalleryAnchor();
        if (!anchor) {
            return false;
        }
        // Already correctly positioned?
        var container = getVisibleContainer();
        var existing = container && container.querySelector('.' + SECTION_CLASS);
        if (existing && isCorrectlyPlaced(existing, anchor)) {
            return true;
        }
        renderGallery(_lastImages);
        return true;
    }

    // If the same movie's page keeps building (Scenes/Similar load late),
    // nudge the already-rendered gallery back to its slot instead of
    // leaving it stranded at the end.
    function ensureGalleryPosition() {
        if (!_lastImages || _lastImages.length === 0) return;
        var container = getVisibleContainer();
        if (!container) return;
        var existing = container.querySelector('.' + SECTION_CLASS);
        if (!existing) {
            tryPlaceGallery();
            return;
        }
        var anchor = findGalleryAnchor();
        if (anchor && !isCorrectlyPlaced(existing, anchor)) {
            placeSection(existing, anchor);
        }
        // Re-seating changes container width — re-flow Masonry tiles.
        queueMasonryLayout();
    }

    function isCorrectlyPlaced(section, anchor) {
        if (anchor.position === 'after') {
            return section.previousElementSibling === anchor.node;
        }
        return section.nextElementSibling === anchor.node;
    }

    function placeSection(section, anchor) {
        if (anchor.position === 'after') {
            anchor.node.parentNode.insertBefore(section, anchor.node.nextSibling);
        } else {
            anchor.node.parentNode.insertBefore(section, anchor.node);
        }
    }

    /* ------------------------------------------------------------------------
     * DOM anchor detection
     *
     * Desired slot: right after Scenes, right before "More Like This".
     * Returns { node, position } where position is 'after' or 'before'.
     *  - visible #scenesCollapsible  -> insert AFTER it (stable home)
     *  - otherwise #similarCollapsible (visible preferred, hidden ok) ->
     *    insert BEFORE it, so we never land after Similar at page end
     *  - otherwise hidden #scenesCollapsible as a temporary slot while
     *    the page is still building; the observer re-seats us before
     *    Similar as soon as it appears
     *  - null when neither section exists yet (observer keeps waiting)
     * ------------------------------------------------------------------------ */

    /**
     * Find the visible details-page container.
     * Jellyfin 12 renders the details page as #itemDetailPage containing
     * .detailPageWrapperContainer, which splits into .detailPagePrimaryContainer
     * (header/info) and .detailPageSecondaryContainer (sections — this is where
     * #scenesCollapsible and #similarCollapsible live).
     * (.detailPageContent was removed — kept as a legacy fallback).
     * Jellyfin's SPA leaves stale containers in the DOM from previous pages,
     * so we must operate on the visible one.
     */
    var CONTAINER_SELECTORS = [
        '#itemDetailPage .detailPageSecondaryContainer',
        '#itemDetailPage .detailPageWrapperContainer',
        '#itemDetailPage .detailPagePrimaryContainer',
        '#itemDetailPage',
        '.detailPageContent'
    ];

    function isVisibleElement(el) {
        if (!el || !(el instanceof Element)) {
            return false;
        }
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function getVisibleContainer() {
        var i, j, candidates, best;
        // Prefer the NEWEST visible container: Jellyfin's SPA keeps the
        // old page's DOM around while building the new one, so first-match
        // can resolve to the stale subtree. Last visible wins.
        best = null;
        for (i = 0; i < CONTAINER_SELECTORS.length; i++) {
            candidates = document.querySelectorAll(CONTAINER_SELECTORS[i]);
            for (j = 0; j < candidates.length; j++) {
                if (isVisibleElement(candidates[j])) {
                    best = candidates[j];
                }
            }
            if (best) {
                return best;
            }
        }
        // Fallback: newest match even if not yet laid out (SPA still loading)
        for (i = 0; i < CONTAINER_SELECTORS.length; i++) {
            candidates = document.querySelectorAll(CONTAINER_SELECTORS[i]);
            if (candidates.length > 0) {
                return candidates[candidates.length - 1];
            }
        }
        return null;
    }

    function findGalleryAnchor() {
        var container = getVisibleContainer();
        if (!container) return null;

        // #scenesCollapsible carries the `hide` class (display:none) when
        // the movie has no scenes. #similarCollapsible likewise when there
        // is no "More Like This".
        var scenes = container.querySelector('#scenesCollapsible');
        var similar = container.querySelector('#similarCollapsible');

        // Ideal slot: after a VISIBLE Scenes section.
        if (scenes && isVisibleElement(scenes)) {
            return { node: scenes, position: 'after' };
        }

        // No visible Scenes: park BEFORE Similar (visible or still-hidden
        // placeholder) so we never end up stranded after it at page end.
        if (similar) {
            return { node: similar, position: 'before' };
        }

        // Similar not in the DOM yet — use hidden Scenes as a temporary
        // slot while the page is still building. The observer re-seats us
        // before Similar as soon as it appears.
        if (scenes) {
            return { node: scenes, position: 'after' };
        }

        return null;
    }

    /* ------------------------------------------------------------------------
     * Data loading — fetch runs in parallel with DOM building.
     * Result is cached in _lastImages; placement happens via tryPlaceGallery
     * so the section appears in the same frame the anchor does.
     * ------------------------------------------------------------------------ */
    function fetchGallery(itemId) {
        if (!window.ApiClient) {
            console.warn('Gallery Plugin: ApiClient not available.');
            _lastImages = [];
            return;
        }

        _fetchItemId = itemId;
        var url = ApiClient.getUrl('Gallery/' + itemId);

        ApiClient.getJSON(url).then(function (images) {
            // Stale response after navigation — discard.
            if (itemId !== _currentItemId || itemId !== _fetchItemId) return;
            if (getItemIdFromUrl() !== itemId) return;

            images = images || [];
            if (images.length > 0) {
                // Append auth token so <img> tags can load them
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
            }
            _lastImages = images;
            if (images.length === 0) {
                removeExistingSection();
            } else {
                tryPlaceGallery();
            }
        }).catch(function (err) {
            console.error('Gallery Plugin: Failed to load gallery data.', err);
            if (itemId !== _currentItemId) return;
            _lastImages = [];
            removeExistingSection();
        });
    }

    /* ------------------------------------------------------------------------
     * Rendering — Masonry.js (https://masonry.desandro.com/)
     *
     * Column widths are CSS-driven (.gallery-sizer / .gallery-item):
     * 3 columns >= 1200px, 2 columns >= 769px, 1 column below that.
     * Masonry handles the Pinterest-style positioning + animation.
     * If the CDN is unreachable (offline / CSP), we fall back to plain
     * CSS columns so the gallery still renders.
     * ------------------------------------------------------------------------ */
    function getColumnCount() {
        var w = window.innerWidth || document.documentElement.clientWidth || 0;
        if (w >= 1200) return 3;
        if (w >= 769) return 2;
        return 1;
    }

    function ensureMasonryReady(callback) {
        if (window.Masonry) {
            callback(true);
            return;
        }
        if (_masonryFailed) {
            callback(false);
            return;
        }
        // Queue callbacks while the CDN script is in flight
        if (_masonryCallbacks) {
            _masonryCallbacks.push(callback);
            return;
        }
        _masonryCallbacks = [callback];
        var script = document.querySelector('script[data-gallery-masonry], script[src*="masonry.pkgd"], script[src*="masonry-layout"]');
        if (!script) {
            script = document.createElement('script');
            script.src = MASONRY_CDN;
            script.async = true;
            script.setAttribute('data-gallery-masonry', 'true');
            script.onload = function () {
                var cbs = _masonryCallbacks || [];
                _masonryCallbacks = null;
                for (var i = 0; i < cbs.length; i++) {
                    try { cbs[i](!!window.Masonry); } catch (e) { /* ignore */ }
                }
            };
            script.onerror = function () {
                _masonryFailed = true;
                var cbs = _masonryCallbacks || [];
                _masonryCallbacks = null;
                console.warn('Gallery Plugin: Masonry CDN failed, using CSS fallback.');
                for (var i = 0; i < cbs.length; i++) {
                    try { cbs[i](false); } catch (e) { /* ignore */ }
                }
            };
            document.head.appendChild(script);
        } else {
            // Tag exists (injected by install.sh) but not loaded yet — poll briefly
            var tries = 0;
            var timer = setInterval(function () {
                tries++;
                if (window.Masonry || tries > 50) {
                    clearInterval(timer);
                    var cbs = _masonryCallbacks || [];
                    _masonryCallbacks = null;
                    if (!window.Masonry) _masonryFailed = true;
                    for (var i = 0; i < cbs.length; i++) {
                        try { cbs[i](!!window.Masonry); } catch (e) { /* ignore */ }
                    }
                }
            }, 100);
        }
    }

    function destroyMasonry() {
        if (_msnry) {
            try { _msnry.destroy(); } catch (e) { /* ignore */ }
            _msnry = null;
        }
    }

    function initMasonryGrid(grid, useMasonry) {
        destroyMasonry();
        if (!useMasonry || !window.Masonry) {
            // CSS fallback: native multi-column flow, no JS layout needed
            grid.classList.add('gallery-fallback');
            return null;
        }
        grid.classList.remove('gallery-fallback');
        try {
            _msnry = new window.Masonry(grid, {
                itemSelector: '.gallery-item',
                columnWidth: '.gallery-sizer',
                percentPosition: true,
                gutter: 8,
                transitionDuration: '0.25s'
            });
        } catch (e) {
            console.warn('Gallery Plugin: Masonry init failed, using CSS fallback.', e);
            grid.classList.add('gallery-fallback');
            _msnry = null;
        }
        return _msnry;
    }

    function renderGallery(images) {
        var anchor = findGalleryAnchor();
        if (!anchor) {
            return;
        }

        var columnCount = getColumnCount();
        _renderedColumnCount = columnCount;

        // Reuse the existing section if it's already in the right container
        // (avoids flicker); otherwise create it fresh.
        var container = getVisibleContainer();
        var section = container && container.querySelector('.' + SECTION_CLASS);
        if (!section) {
            destroyMasonry();
            removeExistingSection();
            section = document.createElement('div');
            section.className = SECTION_CLASS + ' verticalSection detailVerticalSection verticalSection-extrabottompadding';
            section.setAttribute('data-gallery', 'true');

            var heading = document.createElement('h2');
            heading.className = 'sectionTitle sectionTitle-cards padded-right';
            heading.textContent = 'Gallery';
            section.appendChild(heading);
        } else {
            destroyMasonry();
        }

        // (Re)build the grid with a skeleton so the slot reserves space
        // immediately — no layout jump when photos arrive.
        var oldGrid = section.querySelector('.gallery-grid');
        if (oldGrid) {
            section.removeChild(oldGrid);
        }
        // Remove any stale skeleton from a previous attempt
        var oldSkel = section.querySelector('.gallery-skeleton');
        if (oldSkel) {
            section.removeChild(oldSkel);
        }

        var grid = document.createElement('div');
        grid.className = 'gallery-grid';
        // Sizer element drives Masonry's columnWidth (CSS controls its width)
        var sizer = document.createElement('div');
        sizer.className = 'gallery-sizer';
        grid.appendChild(sizer);
        section.appendChild(grid);

        var skeleton = buildSkeleton(columnCount);
        section.appendChild(skeleton);

        // Build all items synchronously — no preload gate, so the section
        // paints immediately. Masonry positions them; each photo triggers
        // a smooth re-layout as it decodes.
        var items = [];
        for (var i = 0; i < images.length; i++) {
            (function (idx) {
                var item = document.createElement('div');
                item.className = 'gallery-item';
                item.dataset.index = idx;

                var img = document.createElement('img');
                img.className = 'gallery-thumb';
                img.src = images[idx].Url || images[idx].ThumbnailUrl || images[idx].url;
                img.alt = images[idx].Name || images[idx].name || ('Gallery image ' + (idx + 1));
                img.loading = 'lazy';
                img.decoding = 'async';
                img.onload = function () {
                    img.classList.add('loaded');
                    queueMasonryLayout();
                };
                img.onerror = function () {
                    // Broken image: drop the tile and re-flow
                    if (item.parentNode === grid) {
                        if (_msnry) {
                            try { _msnry.remove(item); } catch (e) { grid.removeChild(item); }
                        } else if (item.parentNode) {
                            item.parentNode.removeChild(item);
                        }
                        queueMasonryLayout();
                    }
                };
                // Cached images may already be complete before onload binds
                if (img.complete && img.naturalWidth > 0) {
                    img.classList.add('loaded');
                }
                item.appendChild(img);
                items.push(item);
            })(i);
        }
        for (var a = 0; a < items.length; a++) {
            grid.appendChild(items[a]);
        }
        grid.style.display = 'none';

        // Insert / re-seat in the correct slot (after Scenes / before Similar)
        placeSection(section, anchor);

        if (images.length === 0) return;

        // Wait for Masonry (CDN or pre-injected tag), then swap skeleton
        // for the live grid in one frame.
        ensureMasonryReady(function (useMasonry) {
            // Guard against navigating away while the CDN was loading
            if (!document.contains(section)) return;
            if (itemIdChanged(section)) return;

            if (skeleton.parentNode === section) {
                section.removeChild(skeleton);
            }
            grid.style.display = '';
            initMasonryGrid(grid, useMasonry);
            queueMasonryLayout();
        });
    }

    function itemIdChanged(section) {
        // If the section was moved into a stale SPA subtree, bail out —
        // the observer will re-place it for the current movie.
        var container = getVisibleContainer();
        return !(container && container.contains(section));
    }

    function queueMasonryLayout() {
        if (_layoutQueued) return;
        _layoutQueued = true;
        var run = function () {
            _layoutQueued = false;
            if (_msnry) {
                try { _msnry.layout(); } catch (e) { /* ignore */ }
            }
        };
        if ('requestAnimationFrame' in window) {
            requestAnimationFrame(run);
        } else {
            setTimeout(run, 16);
        }
    }

    // Lightweight shimmer placeholder so the gallery slot has stable height
    // while photos preload — prevents the page-end jump / layout shift.
    function buildSkeleton(columnCount) {
        var skel = document.createElement('div');
        skel.className = 'gallery-skeleton';
        var heights = [220, 160, 260, 180, 240, 170];
        for (var c = 0; c < columnCount; c++) {
            var colEl = document.createElement('div');
            colEl.className = 'gallery-skeleton-col';
            for (var r = 0; r < 2; r++) {
                var block = document.createElement('div');
                block.className = 'gallery-skeleton-block';
                block.style.height = heights[(c * 2 + r) % heights.length] + 'px';
                colEl.appendChild(block);
            }
            skel.appendChild(colEl);
        }
        return skel;
    }

    // Masonry re-flows automatically on resize (isResizeBound). Just nudge
    // a layout; column widths are CSS-driven so no re-render is needed.
    // The CSS fallback uses native columns and needs no JS at all.
    window.addEventListener('resize', function () {
        if (_resizeTimer) {
            clearTimeout(_resizeTimer);
        }
        _resizeTimer = setTimeout(function () {
            _renderedColumnCount = getColumnCount();
            queueMasonryLayout();
        }, 150);
    });

    function removeExistingSection() {
        destroyMasonry();
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
