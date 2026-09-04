// noinspection ES6ConvertVarToLetConst,BadExpressionStatementJS

/**
 * Gumlet Image Optimization Loader — de-obfuscated / human-readable version
 *
 * Rewrites <img>, <picture><source>, <iframe>, and [data-bg] elements to
 * point at a Gumlet-hosted CDN, adding resize (w/h), DPR, WebP, quality, and
 * srcset params, plus optional lazy-loading via IntersectionObserver and a
 * MutationObserver that keeps watching the DOM for newly added elements.
 *
 * Behavior is unchanged from the original minified build — only names, and
 * a couple of comma-expressions/ternaries were unrolled into normal
 * if/else for readability.
 */
var gumlet = (
    function () {

        // Predefined "breakpoint" widths used to build responsive srcsets.
        // Spaced ~20-25% apart — closer steps than that are visually
        // indistinguishable but still bloat srcset string size and parse
        // cost, so this trims the old 70-entry table down to ~30 entries
        // while keeping small steps at thumbnail/icon sizes.
        const BREAKPOINT_WIDTHS = [
            16, 32, 48, 64, 96, 128, 160, 200, 256, 320, 384, 480, 576, 640,
            750, 828, 960, 1080, 1200, 1366, 1536, 1920, 2048, 2560, 3200,
            3840, 4480, 5120, 6400, 7680, 8192
        ];

        // Fallback "max" width used when running outside a browser (SSR, etc.)
        const FALLBACK_MAX_WIDTH = 8192;

        /**
         * Builds the list of widths this device/screen can actually use:
         * every breakpoint width up to the device's real max width, plus
         * the device's own (unscaled) screen size as a final catch-all entry.
         */
        function getAvailableWidths() {
            const isBrowser        = typeof window !== "undefined";
            const devicePixelRatio = isBrowser && window.devicePixelRatio ? window.devicePixelRatio : 1;
            const screenSize       = isBrowser
                                     ? Math.max( window.screen.availWidth, window.screen.availHeight )
                                     : FALLBACK_MAX_WIDTH;
            const maxPhysicalWidth = isBrowser ? Math.floor( screenSize * devicePixelRatio ) : FALLBACK_MAX_WIDTH;

            const widths = BREAKPOINT_WIDTHS.filter( w => w <= maxPhysicalWidth );
            widths.push( screenSize );

            return widths;
        }

        // Computed once at load time and reused everywhere below.
        var availableWidths = getAvailableWidths();

        // Caches computeTargetWidth() results keyed by element, so a batch
        // measure pass (prefetchSizes) can front-load every clientWidth /
        // getComputedStyle read before any element gets written to —
        // avoids forcing a synchronous layout once per element when a
        // read/write pair interleaves across many images in a loop.
        var sizeCache = new WeakMap();

        /**
         * Figures out the rendered (CSS) width an element should be
         * requested at, by walking up the DOM tree until it finds an
         * ancestor with real width. Pulled out of getSizes() so it can run
         * standalone in a measure-only batch pass (see prefetchSizes).
         */
        function computeTargetWidth( el, settings ) {
            const widthAttr = el.getAttribute( "width" );

            if (
                widthAttr &&
                settings.width_from_img &&
                widthAttr.indexOf( "%" ) < 0
            ) {
                let w = widthAttr;

                if ( w.indexOf( "px" ) >= 0 ) {
                    w = w.replace( "px", "" );
                }

                return parseInt( w, 10 );
            }

            let ancestor = el.parentElement;

            if (
                el.nextSibling &&
                el.nextSibling.nodeName === "FIGCAPTION" &&
                ancestor
            ) {
                ancestor = ancestor.parentElement;
            }

            if ( settings.width_from_flex ) {
                while ( ancestor && ancestor.clientWidth <= 20 ) {
                    ancestor = ancestor.parentElement;
                }
            } else {
                while ( ancestor && ancestor.clientWidth <= 30 ) {
                    ancestor = ancestor.parentElement;
                }
            }

            if ( !ancestor ) {
                return window.innerWidth;
            }

            let computedStyle = null;
            if ( settings.width_from_flex ) {
                computedStyle = window.getComputedStyle( ancestor );
            }

            if (
                settings.width_from_flex &&
                computedStyle?.getPropertyValue( "flex-basis" ) &&
                computedStyle?.getPropertyValue( "flex-basis" ).includes( "px" )
            ) {
                return parseInt( computedStyle?.getPropertyValue( "flex-basis" ).replace( "px", "" ), 10 );
            }

            let targetWidth = ( el.width && ancestor.clientWidth < el.width ) ? el.width : ancestor.clientWidth;

            if ( targetWidth > window.innerWidth ) {
                targetWidth = window.innerWidth;
            }

            return targetWidth;
        }

        var utils = {
            /**
             * Detects WebP support once and caches the result in localStorage
             * (key: "gumlet-webp") so the later page loads skip the test image.
             */
            hasWebP: async () => {
                let cached;

                try {
                    cached = window.localStorage.getItem( "gumlet-webp" );
                } catch {
                    return Promise.resolve( false );
                }

                if ( window.localStorage ) {
                    if ( cached !== null ) {
                        return Promise.resolve( cached === "yes" );
                    }

                    const testImg = document.createElement( "img" );

                    return new Promise(
                        resolve => {
                            testImg.onload = () => {
                                if ( testImg.width === 2 && testImg.height === 1 ) {
                                    try {
                                        window.localStorage.setItem( "gumlet-webp", "yes" );
                                    } catch ( e ) {
                                        console.warn( e );
                                    }

                                    resolve( true );
                                } else {
                                    try {
                                        window.localStorage.setItem( "gumlet-webp", "no" );
                                    } catch ( e ) {
                                        console.warn( e );
                                    }

                                    resolve( false );
                                }
                            };

                            testImg.src    = "data:image/webp;base64,UklGRjIAAABXRUJQVlA4ICYAAACyAgCdASoCAAEALmk0mk0iIiIiIgBoSygABc6zbAAA/v56QAAAAA==";
                        }
                    );
                } else {
                    return Promise.resolve( false );
                }
            },

            /**
             * Normalizes width/height query params: accepts either `w`/`h`
             * or `width`/`height` and always outputs `w`/`h`.
             */
            filterQuery: ( query ) => {
                query.w = query.w ?? query.width;
                query.h = query.h ?? query.height;
                query.w ?? delete query.w;
                query.h ?? delete query.h;
                delete query.width;
                delete query.height;
                return query;
            },

            /**
             * Figures out the rendered (CSS) width an element should be
             * requested at, plus a `sizes` attribute value. Uses a cached
             * measurement from prefetchSizes() when one is available,
             * falling back to a live (single-element) measurement otherwise.
             */
            getSizes: ( el, settings ) => {
                let targetWidth;
                if ( sizeCache.has( el ) ) {
                    targetWidth = sizeCache.get( el );
                    sizeCache.delete( el );
                } else {
                    targetWidth = computeTargetWidth( el, settings );
                }

                // Pick the smallest available breakpoint that's >= targetWidth.
                let chosenWidth;
                for ( let i = 0; i < availableWidths.length; i++ ) {
                    if ( availableWidths[ i ] - targetWidth >= 0 ) {
                        chosenWidth = availableWidths[ i ];
                        break;
                    }
                }
                chosenWidth ||= availableWidths[ availableWidths.length - 1 ];

                if ( settings.min_width && chosenWidth < settings.min_width ) {
                    chosenWidth = settings.min_width;
                }

                return {
                    sizes: `${ targetWidth * 100 / window.innerWidth }vw`,
                    width: chosenWidth
                };
            },

            /**
             * Builds a full `srcset` string: one URL per available width,
             * each requesting that width (and, if a ratio is known, a
             * proportional height) from Gumlet.
             */
            getSrcsets: ( gumletUrl, hostname, ratio, useProxy ) => {
                const entries = [];

                // Build the shared param set once, then mutate only w/h per
                // iteration instead of rebuilding+reserializing every key on
                // every width (was O(n * keys) allocations for n widths).
                const params = new window.URLSearchParams();
                for ( const key in gumletUrl.query ) {
                    params.set( key, gumletUrl.query[ key ] );
                }

                for ( let i = 0, len = availableWidths.length; i < len; i++ ) {
                    const width = availableWidths[ i ];
                    params.set( "w", width );

                    if ( ratio ) {
                        params.set( "h", Math.round( width * ratio ) );
                    }

                    gumletUrl.url.search = params.toString();
                    let urlString = gumletUrl.url.toString();
                    if ( urlString.indexOf( " " ) >= 0 ) {
                        urlString = encodeURI( urlString );
                    }

                    entries.push(
                        useProxy ?
                        `https://${ hostname }/fetch/${ urlString } ${ width }w` :
                        `${ urlString } ${ width }w`
                    );
                }

                return entries.join( "," );
            },

            /**
             * Measure pass: computes and caches every element's target
             * width up front, before any of them get written to. Call this
             * over a whole batch of elements right before looping to load
             * them, so all the layout-forcing reads (clientWidth,
             * getComputedStyle) happen back-to-back instead of interleaved
             * with each element's writes (src/srcset/classList/style).
             */
            prefetchSizes: ( elements, settings ) => {
                for ( let i = 0, len = elements.length; i < len; i++ ) {
                    sizeCache.set( elements[ i ], computeTargetWidth( elements[ i ], settings ) );
                }
            },

            /** Resolves once the DOM is ready to be queried/mutated. */
            domReady: async () => (
                document.readyState === "complete" || document.readyState === "interactive" ?
                Promise.resolve() :
                new Promise(
                    resolve => {
                        document.addEventListener( "DOMContentLoaded", resolve, false );
                    }
                )
            )
        };

        /**
         * Small wrapper around the native URL class that keeps query params
         * as a plain object (this.query) instead of URLSearchParams, for
         * easier reading/writing, and rebuilds the search string on toString().
         */
        class GumletURL {
            constructor( input ) {
                this.url = ( input.indexOf( "http" ) === 0 || input.indexOf( "ftp" ) === 0 ) ?
                           new window.URL( input ) :
                           new window.URL( input, window.location.href );

                this.query_obj = {};
                this
                    .url
                    .searchParams
                    .forEach(
                        ( value, key ) => {
                            this.query_obj[ key ] = value;
                        }
                    );
            }

            set protocol( value ) { this.url.protocol = value; }

            get protocol() { return this.url.protocol; }

            get hostname() { return this.url.hostname; }

            set hostname( value ) { this.url.hostname = value; }

            set port( value ) { this.url.port = value; }

            get port() { return this.url.port; }

            get query() { return this.query_obj; }

            set query( value ) { this.query_obj = value; }

            get hash() { return this.url.hash; }

            get pathname() { return this.url.pathname; }

            toString() {
                const params = new window.URLSearchParams();
                for ( const key in this.query_obj ) {
                    params.set( key, this.query_obj[ key ] );
                }
                this.url.search = params.toString();
                return this.url.toString();
            }
        }

        const isBrowserEnv = typeof window !== "undefined";

        var browserFeatures = {
            runningOnBrowser            : isBrowserEnv,
            webp_support                : false,
            supportsIntersectionObserver:
                isBrowserEnv &&
                "IntersectionObserver" in window &&
                Object.hasOwn( window.IntersectionObserverEntry, "isIntersecting" ),
            supportsMutationObserver    : isBrowserEnv && "MutationObserver" in window
        };

        /** Merges user-supplied config with defaults into a normalized settings object. */
        function buildSettings( options ) {
            const settings = {
                auto_webp                : options.auto_webp || false,
                auto_dpr                 : options.auto_dpr === undefined || options.auto_dpr,
                max_dpr                  : options.max_dpr === undefined ? 5 : parseFloat( String( options.max_dpr ) ),
                srcset                   : options.srcset || false,
                auto_quality             : options.auto_quality === undefined || options.auto_quality,
                use_native_lazy_load     : options.use_native_lazy_load !== undefined && options.use_native_lazy_load,
                lazy_load                : options.lazy_load || false,
                async_decode             : options.async_decode || false,
                proxy                    : options.proxy || false,
                width_from_img           : options.width_from_img || false,
                width_from_flex          : options.width_from_flex || false,
                class_loaded             : options.class_loaded || "gm-loaded",
                class_added              : options.class_added || "gm-added",
                class_lazy               : options.class_lazy || "gm-lazy",
                class_observing          : options.class_observing || "gm-observing",
                class_observing_cb       : options.class_observing_cb || "gm-observing-cb",
                elements_selector_img    : options.elements_selector || options.elements_selector_img || "img",
                elements_selector_bg     : options.elements_selector_bg || "[data-bg]",
                elements_selector_iframe : options.elements_selector_iframe === undefined ? "iframe" : options.elements_selector_iframe,
                elements_selector_picture: options.elements_selector_picture || "picture > source",
                data_src                 : options.data_src || "src",
                data_bg                  : options.data_bg || "bg",
                default_params           : options.default_params || null,
                hosts                    : options.hosts,
                threshold                : options.threshold || 500,
                min_width                : options.min_width ? parseInt( String( options.min_width ), 10 ) : undefined
            };

            // On small/mobile viewports, optionally read the src from a different data attribute.
            if ( window.innerWidth <= 640 && options.data_mobile_src ) {
                settings.data_src = options.data_mobile_src;
            }

            return settings;
        }

        /**
         * Creates an IntersectionObserver that fires `callback(target)` once
         * per element as soon as it enters the viewport (or the given margin),
         * then stops observing that element.
         */
        function createIntersectionObserver( callback, rootMarginPx = 100 ) {
            return new window.IntersectionObserver(
                ( entries, observer ) => {
                    for ( let i = 0, len = entries.length; i < len; i++ ) {
                        if ( entries[ i ].isIntersecting || entries[ i ].intersectionRatio > 0 ) {
                            observer.unobserve( entries[ i ].target );
                            callback( entries[ i ].target );
                        }
                    }
                },
                {
                    rootMargin: `${ rootMarginPx }px`
                }
            );
        }

        /**
         * Runs `callback` when the browser has spare idle time, capped by
         * `timeout` so it still fires promptly under load. Falls back to a
         * plain setTimeout on browsers without requestIdleCallback
         * (Safari) — same worst-case wait as before, but elsewhere the
         * work no longer blocks a fixed delay on an otherwise-idle page.
         */
        function scheduleWork( callback, timeout ) {
            if ( isBrowserEnv && "requestIdleCallback" in window ) {
                window.requestIdleCallback( callback, { timeout } );
            } else {
                setTimeout( callback, timeout );
            }
        }

        // Holds observer instances and another runtime state.
        var state = {};

        var Gumlet = {
            currentHosts: [],
            gumletHosts : [],
            settings    : {},
            initDone    : false,

            /** Entry point — validates config, sets up observers, and kicks off the first pass. */
            init: config => {
                if ( Gumlet.initDone ) {
                    return;
                }

                if ( !config ) {
                    throw new Error( "You must provide config while initializing Gumlet." );
                }

                if ( !config.hosts ) {
                    throw new Error( "You must provide config.hosts while initializing Gumlet." );
                }

                Gumlet.settings = buildSettings( config );
                Gumlet.initDone = true;

                // Both of these were previously recomputed inside
                // get_element_params/load_img/load_bg/load_pic on every
                // single element — neither navigator.connection nor
                // devicePixelRatio changes mid-pageload in practice, so
                // compute them once here instead of once per element.
                if ( Gumlet.settings.auto_quality && isBrowserEnv && navigator.connection ) {
                    if ( navigator.connection.saveData ) {
                        state.connectionQuality = { dpr: "1.0", q: 50 };
                    } else if ( navigator.connection.effectiveType === "3g" ) {
                        state.connectionQuality = { dpr: "1.0", q: 70 };
                    } else if ( navigator.connection.effectiveType === "2g" ) {
                        state.connectionQuality = { dpr: "1.0", q: 60 };
                    } else if ( navigator.connection.effectiveType === "slow-2g" ) {
                        state.connectionQuality = { dpr: "1.0", q: 50 };
                    }
                }

                if ( Gumlet.settings.auto_dpr && isBrowserEnv ) {
                    state.dpr = Math.min( Number( window.devicePixelRatio.toFixed( 1 ) ), Gumlet.settings.max_dpr );
                }

                if ( Gumlet.settings.auto_webp ) {
                    utils
                        .hasWebP()
                        .then(
                            supported => {
                                browserFeatures.webp_support = supported;
                            }
                        );
                }

                if ( Gumlet.settings.lazy_load && browserFeatures.supportsIntersectionObserver ) {
                    state._lazyload_observer_pic    = createIntersectionObserver( el => Gumlet.load_pic( el ), Gumlet.settings.threshold );
                    state._lazyload_observer_img    = createIntersectionObserver( el => Gumlet.load_img( el ), Gumlet.settings.threshold );
                    state._lazyload_observer_bg     = createIntersectionObserver( el => Gumlet.load_bg( el ), Gumlet.settings.threshold );
                    state._lazyload_observer_iframe = createIntersectionObserver( el => Gumlet.load_iframe( el ), Gumlet.settings.threshold );
                }

                if ( browserFeatures.supportsMutationObserver ) {
                    state._mutation_observer = new window.MutationObserver( Gumlet.mutatedCallback );
                }

                // Build parallel arrays of "current site hostname" -> "gumlet hostname".
                Gumlet
                    .settings
                    .hosts
                    .forEach(
                        hostPair => {
                            if ( hostPair.current ) {
                                if ( hostPair.current.startsWith( "http" ) ) {
                                    hostPair.current = new GumletURL( hostPair.current ).hostname;
                                }

                                Gumlet.currentHosts.push( hostPair.current );
                            }

                            if ( hostPair.gumlet.startsWith( "http" ) ) {
                                hostPair.gumlet = new GumletURL( hostPair.gumlet ).hostname;
                            }

                            Gumlet.gumletHosts.push( hostPair.gumlet );
                        }
                    );

                utils
                    .domReady()
                    .then(
                        () => {
                            Gumlet.init_dom_observer();
                            Gumlet.load_all();
                        }
                    );
            },

            /** Watches <body> for added/changed nodes so new images get processed automatically. */
            init_dom_observer: () => {
                if (
                    !state._entireDomObserver &&
                    browserFeatures.supportsMutationObserver
                ) {
                    state._entireDomObserver = new window.MutationObserver( Gumlet.dom_mutation_cb );
                    state
                        ._entireDomObserver
                        .observe(
                            // Scoped to <body> instead of the whole document —
                            // this only ever cares about img/source/iframe/
                            // [data-bg] nodes, which can't legally live in
                            // <head>, so watching it too just adds noise
                            // (style/script tag churn from other plugins) for
                            // every mutation callback to filter through.
                            document.body,
                            {
                                childList: true,
                                subtree  : true
                            }
                        );
                }
            },

            /** Handles nodes added anywhere in the document after the initial load. */
            dom_mutation_cb: mutations => {
                mutations
                    .forEach(
                        mutation => {
                            if ( mutation.target.nodeName === "HEAD" ) {
                                return;
                            }

                            setTimeout(
                                () => {
                                    mutation
                                        .addedNodes
                                        .forEach(
                                            node => {
                                                if (
                                                    (
                                                        node.nodeName === "SOURCE" ||
                                                        node.nodeName === "IMG" ||
                                                        node.nodeName === "IFRAME"
                                                    ) &&
                                                    node.nodeType === Node.ELEMENT_NODE
                                                ) {
                                                    Gumlet.load_if_needed( node );
                                                } else if ( node.nodeType === Node.ELEMENT_NODE ) {
                                                    node.querySelectorAll( Gumlet.settings.elements_selector_img ).forEach( Gumlet.load_if_needed );
                                                    node.querySelectorAll( Gumlet.settings.elements_selector_picture ).forEach( Gumlet.load_if_needed );
                                                    node.querySelectorAll( Gumlet.settings.elements_selector_bg ).forEach( Gumlet.load_if_needed );
                                                }
                                            }
                                        );
                                },
                                300
                            );
                        }
                    );
            },

            /** Loads an element only if it hasn't already been processed. */
            load_if_needed: ( el ) => {
                if ( el.classList.contains( Gumlet.settings.class_loaded ) ) {
                    return;
                }

                el.classList.add( Gumlet.settings.class_added );
                Gumlet.load( el );
            },

            /** First, pass over the whole document: process every matching element. */
            load_all: () => {
                scheduleWork(
                    () => {
                        const elements = document.querySelectorAll( `${ Gumlet.settings.elements_selector_img }, ${ Gumlet.settings.elements_selector_picture }, ${ Gumlet.settings.elements_selector_bg }, ${ Gumlet.settings.elements_selector_iframe }` );

                        // Measure pass before the write pass below — see
                        // utils.prefetchSizes for why.
                        utils.prefetchSizes( elements, Gumlet.settings );

                        elements.forEach( el => Gumlet.load( el ) );
                    },
                    300
                );
            },

            /** Starts watching a single element's src/data attributes for later changes. */
            initMutationObserver: el => {
                if ( el.classList.contains( Gumlet.settings.class_observing ) || !state._mutation_observer ) {
                    return;
                }

                el.classList.add( Gumlet.settings.class_observing );
                el.classList.add( Gumlet.settings.class_observing_cb );

                state._mutation_observer.observe( el, {
                    attributes     : true,
                    attributeFilter: [ "src", `data-${ Gumlet.settings.data_src }`, `data-${ Gumlet.settings.data_bg }` ]
                } );
            },

            /** Reacts to attribute changes on elements being watched via initMutationObserver. */
            mutatedCallback: mutations => {
                for ( const mutation of mutations ) {
                    if ( !mutation.target.classList.contains( Gumlet.settings.class_observing_cb ) ) {
                        // Ignore the very first (self-triggered) mutation, then start reacting.
                        mutation.target.classList.add( Gumlet.settings.class_observing_cb );
                        continue;
                    }

                    if ( mutation.attributeName === "src" ) {
                        mutation.target.dataset[ Gumlet.settings.data_src ] = mutation.target.src;
                    }

                    if ( mutation.target.nodeName === "IMG" && mutation.attributeName === `data-${ Gumlet.settings.data_src }` ) {
                        mutation.target.classList.remove( Gumlet.settings.class_observing_cb );
                        Gumlet.load_img( mutation.target );
                    }

                    if ( mutation.attributeName === `data-${ Gumlet.settings.data_bg }` ) {
                        mutation.target.classList.remove( Gumlet.settings.class_observing_cb );
                        Gumlet.load_bg( mutation.target );
                    }
                }
            },

            /** Maps a page's own hostname to its paired Gumlet hostname (or vice versa). */
            get_hostname: url => {
                if ( !Gumlet.currentHosts.length ) {
                    return Gumlet.gumletHosts[ 0 ];
                }

                if ( Gumlet.currentHosts.includes( url.hostname ) ) {
                    const index = Gumlet.currentHosts.indexOf( url.hostname );

                    return Gumlet.gumletHosts[ index ];
                } else if ( Gumlet.gumletHosts.includes( url.hostname ) ) {
                    return url.hostname;
                }
            },

            /**
             * Parses a raw src string into a GumletURL plus derived info
             * (file extension, resolved Gumlet hostname, width/height ratio),
             * applying webp/quality/default query params along the way.
             * Returns null for data URIs or hosts Gumlet doesn't manage.
             */
            get_element_params: src => {
                if ( src.indexOf( ";base64," ) > -1 ) {
                    return null;
                }

                let gumletUrl;

                try {
                    gumletUrl = new GumletURL( src );
                } catch {
                    return null;
                }

                // Support a `#gumleturl=...` hash override.
                if ( gumletUrl.hash.indexOf( "#gumleturl=" ) > -1 ) {
                    const parts = src.split( "#gumleturl=" );

                    if ( parts.length > 1 && parts[ 1 ] ) {
                        gumletUrl = new GumletURL( parts[ 1 ] );
                    }
                }

                const extension = gumletUrl.pathname ? gumletUrl.pathname.split( "." ).pop()?.toLowerCase() : undefined;
                const hostname  = Gumlet.get_hostname( gumletUrl );

                if ( !hostname ) {
                    return null;
                }

                if ( !Gumlet.settings.proxy ) {
                    gumletUrl.protocol = "https";
                    gumletUrl.hostname = hostname;
                    gumletUrl.port     = "443";
                }

                gumletUrl.query = utils.filterQuery( gumletUrl.query );

                if ( Gumlet.settings.auto_webp && browserFeatures.webp_support ) {
                    gumletUrl.query.format = "webp";
                }

                if ( state.connectionQuality ) {
                    gumletUrl.query.dpr = state.connectionQuality.dpr;
                    gumletUrl.query.q   = state.connectionQuality.q;
                }

                if ( Gumlet.settings.default_params ) {
                    for ( const key in Gumlet.settings.default_params ) {
                        gumletUrl.query[ key ] = Gumlet.settings.default_params[ key ];
                    }
                }

                let ratio;
                if ( gumletUrl.query.w && gumletUrl.query.h ) {
                    if ( typeof gumletUrl.query.w === "string" ) {
                        gumletUrl.query.w = parseInt( gumletUrl.query.w, 10 );
                    }
                    if ( typeof gumletUrl.query.h === "string" ) {
                        gumletUrl.query.h = parseInt( gumletUrl.query.h, 10 );
                    }
                    ratio = gumletUrl.query.h / gumletUrl.query.w;
                }

                return { url: gumletUrl, extension, hostname, ratio };
            },

            /** Routes an element to the right loader (picture/img/iframe, then bg independently), lazy or eager. */
            load: ( el ) => {
                const isLazy = Gumlet.settings.lazy_load && browserFeatures.supportsIntersectionObserver;

                if ( el.matches( Gumlet.settings.elements_selector_picture ) ) {
                    Gumlet.load_pic( el );
                } else if ( el.matches( Gumlet.settings.elements_selector_img ) ) {
                    if ( Gumlet.settings.async_decode ) {
                        el.setAttribute( "decoding", "async" );
                    }

                    const shouldUseObserver =
                              isLazy &&
                              el.dataset.gmlazy !== "false" &&
                              (
                                  !(
                                      "loading" in window.HTMLImageElement.prototype
                                  ) || Gumlet.settings.use_native_lazy_load === false
                              );

                    if ( shouldUseObserver ) {
                        state._lazyload_observer_img.unobserve( el );
                        el.classList.add( Gumlet.settings.class_lazy );
                        state._lazyload_observer_img.observe( el );
                    } else {
                        if (
                            isLazy &&
                            el.dataset.gmlazy !== "false" &&
                            "loading" in window.HTMLImageElement.prototype &&
                            el.getAttribute( "loading" ) !== "eager"
                        ) {
                            el.setAttribute( "loading", "lazy" );
                        }
                        Gumlet.load_img( el );
                    }
                } else if ( el.matches( Gumlet.settings.elements_selector_iframe ) ) {
                    if ( isLazy && el.dataset.gmlazy !== "false" ) {
                        state._lazyload_observer_iframe.unobserve( el );
                        el.classList.add( Gumlet.settings.class_lazy );
                        state._lazyload_observer_iframe.observe( el );
                    } else {
                        Gumlet.load_iframe( el );
                    }
                }

                // NOTE: independent of the picture/img/iframe branch above — an element
                // can match a bg selector in addition to one of those (comma-expression
                // in the original minified source).
                if ( el.matches( Gumlet.settings.elements_selector_bg ) ) {
                    if ( isLazy && el.dataset.gmlazy !== "false" ) {
                        state._lazyload_observer_bg.unobserve( el );
                        el.classList.add( Gumlet.settings.class_lazy );
                        state._lazyload_observer_bg.observe( el );
                    } else {
                        Gumlet.load_bg( el );
                    }
                }
            },

            /** Sets a CSS background-image URL from data-bg, rewritten through Gumlet. */
            load_bg: ( el ) => {
                if ( el.dataset.gumlet === "false" || !el.dataset[ Gumlet.settings.data_bg ] ) {
                    return;
                }

                const params = Gumlet.get_element_params( el.dataset[ Gumlet.settings.data_bg ] );
                if ( !params ) {
                    el.style.backgroundImage = `url('${ el.dataset[ Gumlet.settings.data_bg ] }')`;
                    return;
                }

                const sizes        = utils.getSizes( el, Gumlet.settings );
                params.url.query.w = params.url.query.w || sizes.width;

                if ( Gumlet.settings.auto_dpr ) {
                    params.url.query.dpr = params.url.query.dpr || state.dpr;
                }

                let urlString = params.url.toString();
                if ( urlString.indexOf( " " ) >= 0 ) {
                    urlString = encodeURI( urlString );
                }

                el.style.backgroundImage = Gumlet.settings.proxy
                                           ? `url("https://${ params.hostname }/fetch/${ urlString }")`
                                           : `url("${ urlString }")`;

                el.removeAttribute( "data-bsrjs" );
                el.classList.add( Gumlet.settings.class_loaded );
                Gumlet.initMutationObserver( el );
            },

            /** Swaps a lazy iframe's real src in from its data attribute. */
            load_iframe: ( el ) => {
                if ( el.dataset[ Gumlet.settings.data_src ] ) {
                    el.src = el.dataset[ Gumlet.settings.data_src ];
                }
            },

            /** Rewrites a <source> element inside a <picture> to a Gumlet srcset. */
            load_pic: ( el ) => {
                if ( el.dataset.gumlet === "false" || !(
                     el.dataset[ Gumlet.settings.data_src ] || el.dataset.srcset || el.srcset
                ) ) {
                    return;
                }

                const firstSrc = (
                    el.dataset[ Gumlet.settings.data_src ] || el.dataset.srcset || el.srcset
                )
                    .split( "," )[ 0 ]
                    .split( /\s+/ )[ 0 ];

                const params = Gumlet.get_element_params( firstSrc );
                if ( !params ) {
                    if ( el.dataset[ Gumlet.settings.data_src ] || el.dataset.srcset ) {
                        el.srcset = el.dataset[ Gumlet.settings.data_src ] || el.dataset.srcset;
                    }
                    return;
                }

                const sizes = utils.getSizes( el, Gumlet.settings );
                if ( !el.sizes || el.sizes === "100vw" ) {
                    el.sizes = sizes.sizes;
                }

                if ( el.media ) {
                    params.url.query.w = params.url.query.w || sizes.width;
                    if ( Gumlet.settings.auto_dpr ) {
                        params.url.query.dpr = params.url.query.dpr || state.dpr;
                    }
                    el.srcset = Gumlet.settings.proxy
                                ? `https://${ params.hostname }/fetch/${ params.url.toString() }`
                                : params.url.toString();
                } else {
                    el.srcset = utils.getSrcsets( params.url, params.hostname, params.ratio, Gumlet.settings.proxy );
                }

                el.classList.add( Gumlet.settings.class_loaded );
            },

            /** Rewrites an <img>'s src (and optionally srcset) to a Gumlet-optimized URL. */
            load_img: ( el ) => {
                if ( el.dataset.gumlet === "false" ) {
                    return;
                }

                if ( !(
                    el.dataset[ Gumlet.settings.data_src ] || el.src
                ) && el.src === window.location.href ) {
                    Gumlet.initMutationObserver( el );
                    return;
                }

                const params = Gumlet.get_element_params( el.dataset[ Gumlet.settings.data_src ] || el.src );
                if ( !params ) {
                    if ( el.dataset[ Gumlet.settings.data_src ] ) {
                        el.src = el.dataset[ Gumlet.settings.data_src ];
                    }
                    Gumlet.initMutationObserver( el );
                    return;
                }

                const sizes = utils.getSizes( el, Gumlet.settings );

                if ( Gumlet.settings.srcset ) {
                    if ( !el.sizes || el.sizes === "100vw" ) {
                        el.sizes = sizes.sizes;
                    }
                    el.srcset = utils.getSrcsets( params.url, params.hostname, params.ratio, Gumlet.settings.proxy );
                    el.src    = Gumlet.settings.proxy
                                ? `https://${ params.hostname }/fetch/${ params.url.toString() }`
                                : params.url.toString();
                } else {
                    el.removeAttribute( "srcset" );
                    params.url.query.w = params.url.query.w || sizes.width;
                    if ( Gumlet.settings.auto_dpr ) {
                        params.url.query.dpr = params.url.query.dpr || state.dpr;
                    }

                    let urlString = params.url.toString();
                    if ( urlString.indexOf( " " ) >= 0 ) {
                        urlString = encodeURI( urlString );
                    }

                    el.src = Gumlet.settings.proxy
                             ? `https://${ params.hostname }/fetch/${ urlString }`
                             : urlString;
                }

                el.classList.add( Gumlet.settings.class_loaded );
                Gumlet.initMutationObserver( el );
            }
        };

        // Auto-initialize: either from window.GUMLET_CONFIG directly or (for the
        // WordPress plugin build) from window.gumlet_wp_config once it appears.
        if ( window.gumlet_wp_config === undefined ) {
            if ( window.GUMLET_CONFIG ) {
                Gumlet.init( window.GUMLET_CONFIG );
            } else {
                utils.domReady().then( () => {
                    if ( window.gumlet_wp_config !== undefined ) {
                        initFromWordPressConfig();
                    }
                } );
            }
        } else {
            initFromWordPressConfig();
        }

        /** Builds a Gumlet config object from the WordPress plugin's localized settings and initializes. */
        function initFromWordPressConfig() {
            Gumlet.init( {
                             data_src       : 'gmsrc',
                             auto_webp      : !!parseInt( window.gumlet_wp_config.auto_webp, 10 ),
                             min_width      : window.gumlet_wp_config.min_width,
                             lazy_load      : !!parseInt( window.gumlet_wp_config.lazy_load, 10 ),
                             width_from_img : !!parseInt( window.gumlet_wp_config.width_from_img, 10 ),
                             width_from_flex: !!parseInt( window.gumlet_wp_config.width_from_flex, 10 ),
                             default_params : {
                                 compress: !!parseInt( window.gumlet_wp_config.auto_compress, 10 ),
                                 quality : parseInt( window.gumlet_wp_config.quality, 10 )
                             },
                             hosts          : [
                                 {
                                     current: window.gumlet_wp_config.current_host,
                                     gumlet : window.gumlet_wp_config.gumlet_host
                                 }
                             ]
                         } );
        }

        return Gumlet;
    }
)();
