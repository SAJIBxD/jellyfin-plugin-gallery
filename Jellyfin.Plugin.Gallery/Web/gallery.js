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
            '.gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.5em; }',
            '.gallery-item { position: relative; aspect-ratio: 1 / 1; overflow: hidden; border-radius: 4px; cursor: pointer; background: rgba(0,0,0,0.2); transition: transform 0.2s ease, box-shadow 0.2s ease; }',
            '.gallery-item:hover { transform: scale(1.03); box-shadow: 0 4px 16px rgba(0,0,0,0.4); }',
            '.gallery-thumb { width: 100%; height: 100%; object-fit: cover; display: block; }',
            '.gallery-lightbox-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.92); z-index: 9999; display: flex; align-items: center; justify-content: center; opacity: 0; animation: galleryFadeIn 0.25s ease forwards; }',
            '@keyframes galleryFadeIn { from { opacity: 0; } to { opacity: 1; } }',
            '.gallery-lightbox-content { position: relative; max-width: 94vw; max-height: 94vh; display: flex; align-items: center; justify-content: center; }',
            '.gallery-lightbox-image { max-width: 94vw; max-height: 94vh; object-fit: contain; border-radius: 4px; box-shadow: 0 8px 40px rgba(0,0,0,0.6); }',
            '.gallery-lightbox-close { position: absolute; top: -2.5em; right: -0.5em; background: none; border: none; color: rgba(255,255,255,0.7); font-size: 2em; cursor: pointer; padding: 0.25em 0.5em; line-height: 1; transition: color 0.2s ease; }',
            '.gallery-lightbox-close:hover { color: #fff; }',
            '.gallery-lightbox-nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(0,0,0,0.5); border: none; color: rgba(255,255,255,0.7); font-size: 2.5em; cursor: pointer; padding: 0.3em 0.4em; border-radius: 4px; line-height: 1; transition: background 0.2s ease, color 0.2s ease; z-index: 10; }',
            '.gallery-lightbox-nav:hover { background: rgba(0,0,0,0.8); color: #fff; }',
            '.gallery-lightbox-nav-prev { left: -1.2em; }',
            '.gallery-lightbox-nav-next { right: -1.2em; }',
            '.gallery-lightbox-counter { position: absolute; bottom: -2em; left: 50%; transform: translateX(-50%); color: rgba(255,255,255,0.6); font-size: 0.9em; white-space: nowrap; }',
            '@media (max-width: 600px) { .gallery-grid { grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 0.35em; } .gallery-lightbox-nav { font-size: 1.8em; } .gallery-lightbox-nav-prev { left: 0.3em; } .gallery-lightbox-nav-next { right: 0.3em; } .gallery-lightbox-close { top: 0.3em; right: 0.3em; } }'
        ].join(' ');
        document.head.appendChild(style);
    })();

    var SECTION_CLASS = 'gallery-section';
    var LIGHTBOX_CLASS = 'gallery-lightbox-overlay';
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
        section.className = SECTION_CLASS + ' detailSection';
        section.setAttribute('data-gallery', 'true');

        var heading = document.createElement('h2');
        heading.className = 'sectionTitle';
        heading.textContent = 'Gallery';
        section.appendChild(heading);

        var grid = document.createElement('div');
        grid.className = 'gallery-grid';
        section.appendChild(grid);

        for (var i = 0; i < images.length; i++) {
            var item = document.createElement('div');
            item.className = 'gallery-item';
            item.dataset.index = i;

            var img = document.createElement('img');
            img.className = 'gallery-thumb';
            img.src = images[i].ThumbnailUrl || images[i].Url || images[i].url;
            img.alt = images[i].Name || images[i].name;
            img.loading = 'lazy';

            item.appendChild(img);
            grid.appendChild(item);

            // Attach click handler
            (function (index) {
                item.addEventListener('click', function () {
                    openLightbox(images, index);
                });
            })(i);
        }

        anchor.parentNode.insertBefore(section, anchor.nextSibling);
    }

    function removeExistingSection() {
        var existing = document.querySelector('.' + SECTION_CLASS);
        if (existing) {
            existing.parentNode.removeChild(existing);
        }
    }

    /* ------------------------------------------------------------------------
     * Lightbox
     * ------------------------------------------------------------------------ */

    var _lightboxImages = null;
    var _lightboxIndex = -1;
    var _lightboxOverlay = null;
    var _lightboxKeyHandler = null;

    function openLightbox(images, index) {
        _lightboxImages = images;
        _lightboxIndex = index;

        closeLightbox(); // Clean up any existing lightbox

        var overlay = document.createElement('div');
        overlay.className = LIGHTBOX_CLASS;
        _lightboxOverlay = overlay;

        // Close button
        var closeBtn = document.createElement('button');
        closeBtn.className = 'gallery-lightbox-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.addEventListener('click', closeLightbox);
        overlay.appendChild(closeBtn);

        // Previous button
        var prevBtn = document.createElement('button');
        prevBtn.className = 'gallery-lightbox-nav gallery-lightbox-nav-prev';
        prevBtn.innerHTML = '&#8249;';
        prevBtn.setAttribute('aria-label', 'Previous');
        prevBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            navigateLightbox(-1);
        });
        overlay.appendChild(prevBtn);

        // Next button
        var nextBtn = document.createElement('button');
        nextBtn.className = 'gallery-lightbox-nav gallery-lightbox-nav-next';
        nextBtn.innerHTML = '&#8250;';
        nextBtn.setAttribute('aria-label', 'Next');
        nextBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            navigateLightbox(1);
        });
        overlay.appendChild(nextBtn);

        // Content container
        var content = document.createElement('div');
        content.className = 'gallery-lightbox-content';
        overlay.appendChild(content);

        // Counter
        var counter = document.createElement('div');
        counter.className = 'gallery-lightbox-counter';
        content.appendChild(counter);

        // Image
        var img = document.createElement('img');
        img.className = 'gallery-lightbox-image';
        content.appendChild(img);

        // Click on overlay background to close
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) {
                closeLightbox();
            }
        });

        document.body.appendChild(overlay);
        updateLightboxImage();

        // Keyboard navigation
        _lightboxKeyHandler = function (e) {
            if (e.key === 'Escape') {
                closeLightbox();
            } else if (e.key === 'ArrowLeft') {
                navigateLightbox(-1);
            } else if (e.key === 'ArrowRight') {
                navigateLightbox(1);
            }
        };
        document.addEventListener('keydown', _lightboxKeyHandler);
    }

    function closeLightbox() {
        if (_lightboxOverlay) {
            if (_lightboxOverlay.parentNode) {
                _lightboxOverlay.parentNode.removeChild(_lightboxOverlay);
            }
            _lightboxOverlay = null;
        }

        if (_lightboxKeyHandler) {
            document.removeEventListener('keydown', _lightboxKeyHandler);
            _lightboxKeyHandler = null;
        }

        _lightboxImages = null;
        _lightboxIndex = -1;
    }

    function navigateLightbox(direction) {
        if (!_lightboxImages || _lightboxImages.length === 0) {
            return;
        }

        var newIndex = _lightboxIndex + direction;
        if (newIndex < 0) {
            newIndex = _lightboxImages.length - 1;
        } else if (newIndex >= _lightboxImages.length) {
            newIndex = 0;
        }

        _lightboxIndex = newIndex;
        updateLightboxImage();
    }

    function updateLightboxImage() {
        if (!_lightboxOverlay || !_lightboxImages || _lightboxIndex < 0) {
            return;
        }

        var img = _lightboxOverlay.querySelector('.gallery-lightbox-image');
        var counter = _lightboxOverlay.querySelector('.gallery-lightbox-counter');
        var prevBtn = _lightboxOverlay.querySelector('.gallery-lightbox-nav-prev');
        var nextBtn = _lightboxOverlay.querySelector('.gallery-lightbox-nav-next');

        if (img) {
            img.src = _lightboxImages[_lightboxIndex].Url || _lightboxImages[_lightboxIndex].url;
            img.alt = _lightboxImages[_lightboxIndex].Name || _lightboxImages[_lightboxIndex].name;
        }

        if (counter) {
            counter.textContent = (_lightboxIndex + 1) + ' / ' + _lightboxImages.length;
        }

        // Hide navigation buttons when there's only one image
        if (_lightboxImages.length <= 1) {
            if (prevBtn) prevBtn.style.display = 'none';
            if (nextBtn) nextBtn.style.display = 'none';
        } else {
            if (prevBtn) prevBtn.style.display = '';
            if (nextBtn) nextBtn.style.display = '';
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
