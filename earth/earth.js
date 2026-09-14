/**
 * Earth Viewer - 3D Earth with day/night cycle, clouds, and zoom animation
 * Based on Franky Hung's threejs-earth implementation
 * Adapted for HEARTS project scroll-driven animation
 */

/**
 * Texture sets, sized per texture rather than one resolution per device.
 *
 * Albedo carries the terrain the scroll zooms into, so it runs at the full
 * 8192 source on BOTH tiers - a whole-Earth equirectangular map gives Hawaii
 * only a few hundred texels even then. NightLights runs at 4096 on both:
 * most of the zoom happens over the night side, so it is the texture actually
 * on screen, and at 1024 it magnified into obvious yellow blocks on a phone.
 * Bump and Clouds sit at 2048 everywhere; only Ocean (a low-frequency
 * roughness/metalness map that is never magnified) is halved on phones.
 *
 * Decoded RGBA + mipmaps incl. the CSS starfield:
 * desktop ~260MB, phone ~241MB. It was ~1378MB when iOS Safari was killing
 * the tab, and the phone budget for this work is 350MB.
 */
const EARTH_TEXTURE_SETS = {
    hd: {
        albedo: 'Albedo-8192.jpg',
        bump:   'Bump-2048.jpg',
        clouds: 'Clouds-2048.jpg',
        ocean:  'Ocean-2048.jpg',
        lights: 'NightLights-4096.jpg'
    },
    mobile: {
        albedo: 'Albedo-8192.jpg',
        bump:   'Bump-2048.jpg',
        clouds: 'Clouds-2048.jpg',
        ocean:  'Ocean-1024.jpg',
        lights: 'NightLights-4096.jpg'
    }
};

/**
 * Opening tilt of the Earth camera, shared with index.html's scroll handler so
 * the start value and the ramp that decays it cannot drift apart.
 */
const EARTH_LOOK_AT_Y_START = 0.55;
const EARTH_LOOK_AT_Y_END = 0.13;

/**
 * Pick a texture tier by device class.
 * Kept deliberately dumb: viewport width OR a mobile UA string.
 */
function pickTextureTier() {
    const isSmallViewport = window.matchMedia('(max-width: 820px)').matches;
    const isMobileUA = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    return (isSmallViewport || isMobileUA) ? 'mobile' : 'hd';
}

class EarthViewer {
    constructor(config = {}) {
        this.textureTier = pickTextureTier();
        this.textureSet = EARTH_TEXTURE_SETS[this.textureTier];
        this.config = {
            canvasId: 'earth-canvas',
            containerId: 'earthScrollContainer',
            texturesPath: 'earth/textures/',
            earthRadius: 1,
            atmosphereRadius: 1.25, // Franky uses 12.5 for Earth radius 10 = 1.25x
            initialCameraZ: 1.0,
            sunIntensity: 1.3,
            // Zoom target: Kīlauea, Hawaii
            targetLat: 19.4069,
            targetLon: -155.2834,
            // Initial rotation to show US (east of Hawaii)
            initialRotationY: Math.PI * 0.15,
            // End rotation to show Hawaii (Math.PI * 0.4 was confirmed working)
            endRotationY: Math.PI * 0.4,
            ...config
        };

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.earth = null;
        this.clouds = null;
        this.atmosphere = null;
        this.earthGroup = null;
        this.dirLight = null;

        this.isVisible = false;
        this.animationId = null;
        this.time = 0;
        this.zoomProgress = 0;

        // Camera animation state - start up and right.
        // cameraStartBase is the authored desktop composition; cameraStart is it
        // scaled for the current aspect ratio (see applyAspectFraming).
        this.cameraStartBase = new THREE.Vector3(1.2, 1.3, this.config.initialCameraZ);
        this.cameraStart = this.cameraStartBase.clone();
        this.cameraEnd = null; // Will be set after calculating Kilauea position
        // Vertical offset of the camera's look target, in world units.
        //
        // This is the opening composition, and it is now a resting frame: the
        // deck's continuous scene starts at zoom progress 0 and the reader sits
        // there. It used to be 1.25, which aims the camera well ABOVE the globe
        // and pushes the planet almost entirely below the bottom of the frame -
        // on a 900px desktop viewport the crown of the Earth landed around
        // y=623, leaving two thirds of the screen as empty space. That was
        // survivable only because the old scroll mapping entered the scene
        // around 44% of the way through the zoom, so nobody ever saw it.
        // 0.55 keeps the same downward tilt and the same settle, but frames the
        // planet filling the lower screen with the limb arcing through the
        // upper third. Because the offset is in world units and the phone
        // camera starts ~3x further back (see applyAspectFraming), its effect
        // scales down there automatically and the globe sits near centred.
        this.lookAtY = EARTH_LOOK_AT_Y_START;
    }

    init() {
        const canvas = document.getElementById(this.config.canvasId);
        const container = document.getElementById(this.config.containerId);
        if (!canvas || !container) {
            console.error('Earth viewer: canvas or container not found');
            return;
        }

        this.canvas = canvas;
        this.canvas.style.opacity = '0'; // Hidden until textures loaded
        this.container = container;
        this.videoFixed = document.getElementById('videoFixed');
        this.texturesReady = false;

        this.setupScene();
        this.setupCamera();
        this.setupRenderer();
        this.setupLighting();
        this.loadTextures();
        this.setupVisibilityObserver();
        this.setupResizeHandler();

        console.log('Earth viewer initialized (texture tier: ' + this.textureTier + ')');
    }

    setupScene() {
        this.scene = new THREE.Scene();
    }

    setupCamera() {
        this.camera = new THREE.PerspectiveCamera(
            45,
            window.innerWidth / window.innerHeight,
            0.01,
            100
        );
        this.applyAspectFraming();
        this.camera.position.copy(this.cameraStart);
    }

    /**
     * Widen the opening shot on narrow viewports.
     *
     * A perspective camera with a fixed VERTICAL fov shows less and less
     * horizontally as the viewport narrows, so on a phone the globe overflowed
     * the frame badly at the start of the zoom - you could not tell what you
     * were approaching. This pulls the START camera back until the globe
     * subtends the same fraction of the frame width that it does at the
     * authored desktop aspect. The END of the zoom is untouched, so the
     * destination is identical - the journey is just longer on a phone.
     *
     * At the reference aspect the scale is exactly 1, so desktop is unchanged.
     */
    applyAspectFraming() {
        const REFERENCE_ASPECT = 1.6; // the desktop composition this was tuned at
        const aspect = window.innerWidth / window.innerHeight;
        const vHalf = (this.camera.fov / 2) * Math.PI / 180;

        const halfWidthAngle = Math.atan(Math.tan(vHalf) * aspect);
        const refHalfWidthAngle = Math.atan(Math.tan(vHalf) * REFERENCE_ASPECT);

        const baseDist = this.cameraStartBase.length();
        const r = this.config.earthRadius;
        // How much of the frame half-width the globe fills at the reference aspect
        const refFraction = Math.asin(Math.min(1, r / baseDist)) / refHalfWidthAngle;

        const targetAngle = Math.min(refFraction * halfWidthAngle, Math.PI / 2 - 1e-3);
        const targetDist = r / Math.sin(targetAngle);

        // Never move closer than the authored start - only ever pull back.
        const scale = Math.max(1, targetDist / baseDist);
        this.startFramingScale = scale;
        this.cameraStart.copy(this.cameraStartBase).multiplyScalar(scale);
    }

    setupRenderer() {
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            alpha: true,
            powerPreference: 'high-performance'
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        this.renderer.setClearColor(0x000000, 0);
        // Critical: Set output encoding for proper color rendering
        // r128 uses outputEncoding, newer versions use outputColorSpace
        if (this.renderer.outputColorSpace !== undefined) {
            this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        } else {
            this.renderer.outputEncoding = THREE.sRGBEncoding;
        }
        // Enable color management (if available in this Three.js version)
        if (THREE.ColorManagement) {
            THREE.ColorManagement.enabled = true;
        }
    }

    setupLighting() {
        // Directional light (sun) - no ambient light, matches Franky's implementation
        this.dirLight = new THREE.DirectionalLight(0xffffff, this.config.sunIntensity);
        this.dirLight.position.set(-50, 0, 30);
        this.scene.add(this.dirLight);
    }

    loadTextures() {
        const path = this.config.texturesPath;

        // Use LoadingManager to know when all textures are GPU-ready
        const manager = new THREE.LoadingManager();
        manager.onLoad = () => {
            console.log('Earth textures loaded');
            this.texturesReady = true;

            // Pre-warm before the first visible frame. The scene is built and
            // rendered while the canvas is still at opacity 0, and the page is
            // asked to push the CURRENT scroll-derived state in first, so the
            // very first frame the reader sees already matches where they are.
            // Without this the first paint used a stale zoomProgress and the
            // Earth visibly jumped on the next scroll event.
            if (typeof window.updateEarthZoomFromScroll === 'function') {
                window.updateEarthZoomFromScroll();
            }
            this.setZoomProgress(this.zoomProgress);

            // Render offscreen, then reveal on the next frame so the compositor
            // never shows a half-built or mispositioned Earth.
            //
            // setZoomProgress owns the canvas opacity - it fades the Earth out
            // past 0.83 to hand over to the video. Do NOT force opacity to 1
            // here: on a mid-page reload at, say, progress 0.95 that pinned the
            // fully-zoomed Earth opaque over the video, which is the washed-out
            // white screen on refresh.
            this.renderer.render(this.scene, this.camera);
            requestAnimationFrame(() => {
                this.setZoomProgress(this.zoomProgress);
                this.renderer.render(this.scene, this.camera);
            });
        };

        const loader = new THREE.TextureLoader(manager);

        // Load all textures (all JPEG - none of these need an alpha channel:
        // Clouds/Ocean are sampled via .g/.b, night lights is grayscale)
        const set = this.textureSet;
        const albedoMap = loader.load(path + set.albedo);
        const bumpMap = loader.load(path + set.bump);
        const cloudsMap = loader.load(path + set.clouds);
        const oceanMap = loader.load(path + set.ocean);
        const lightsMap = loader.load(path + set.lights);

        // Set color space for color textures (r128 uses encoding, newer uses colorSpace)
        if (albedoMap.colorSpace !== undefined) {
            albedoMap.colorSpace = THREE.SRGBColorSpace;
        } else {
            albedoMap.encoding = THREE.sRGBEncoding;
        }

        // Anisotropic filtering. The zoom-down views the surface at a very
        // oblique angle, where isotropic mip selection blurs along the
        // direction of greatest compression - this is usually the visible
        // difference at the island keyframe, more than raw resolution.
        const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
        albedoMap.anisotropy = maxAniso;
        bumpMap.anisotropy = maxAniso;
        lightsMap.anisotropy = maxAniso;

        this.createEarth(albedoMap, bumpMap, cloudsMap, oceanMap, lightsMap);
    }

    createEarth(albedoMap, bumpMap, cloudsMap, oceanMap, lightsMap) {
        // Create group for Earth + clouds + atmosphere
        this.earthGroup = new THREE.Group();
        // No axial tilt for this visualization (cleaner look)
        this.earthGroup.rotation.z = 0;

        const r = this.config.earthRadius;

        // Earth sphere with MeshStandardMaterial + onBeforeCompile
        const earthGeo = new THREE.SphereGeometry(r, 64, 64);
        const earthMat = new THREE.MeshStandardMaterial({
            map: albedoMap,
            bumpMap: bumpMap,
            bumpScale: 0.03,
            roughnessMap: oceanMap,
            metalness: 0.1,
            metalnessMap: oceanMap,
            emissiveMap: lightsMap,
            emissive: new THREE.Color(0xffff88)
        });

        // TEMPORARILY DISABLED: Shader modifications for r128 compatibility testing
        // The onBeforeCompile uses variable names that may differ in r128
        /*
        earthMat.onBeforeCompile = (shader) => {
            shader.uniforms.tClouds = { value: cloudsMap };
            shader.uniforms.tClouds.value.wrapS = THREE.RepeatWrapping;
            shader.uniforms.uv_xOffset = { value: 0 };

            // Add uniforms
            shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `
                #include <common>
                uniform sampler2D tClouds;
                uniform float uv_xOffset;
            `);

            // Reverse roughness map (ocean map is inverted)
            shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `
                float roughnessFactor = roughness;
                #ifdef USE_ROUGHNESSMAP
                    vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
                    texelRoughness = vec4(1.0) - texelRoughness;
                    roughnessFactor *= clamp(texelRoughness.g, 0.5, 1.0);
                #endif
            `);

            // Night lights only on dark side + cloud shadows + atmospheric tint
            shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `
                #ifdef USE_EMISSIVEMAP
                    vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
                    // Night lights only on dark side
                    emissiveColor *= 1.0 - smoothstep(-0.02, 0.0, dot(geometryNormal, directionalLights[0].direction));
                    totalEmissiveRadiance *= emissiveColor.rgb;
                #endif

                // Cloud shadows
                float cloudsMapValue = texture2D(tClouds, vec2(vMapUv.x - uv_xOffset, vMapUv.y)).r;
                diffuseColor.rgb *= max(1.0 - cloudsMapValue, 0.2);

                // Atmospheric blue tint at edges (fresnel)
                float intensity = 1.4 - dot( geometryNormal, vec3( 0.0, 0.0, 1.0 ) );
                vec3 atmosphere = vec3( 0.3, 0.6, 1.0 ) * pow(intensity, 5.0);
                diffuseColor.rgb += atmosphere;
            `);

            earthMat.userData.shader = shader;
        };
        */

        this.earth = new THREE.Mesh(earthGeo, earthMat);
        this.earthGroup.add(this.earth);

        // Cloud layer
        const cloudGeo = new THREE.SphereGeometry(r * 1.005, 64, 64);
        const cloudMat = new THREE.MeshStandardMaterial({
            alphaMap: cloudsMap,
            transparent: true
        });
        this.clouds = new THREE.Mesh(cloudGeo, cloudMat);
        this.earthGroup.add(this.clouds);

        // Atmosphere glow (BackSide rendering)
        const atmosGeo = new THREE.SphereGeometry(this.config.atmosphereRadius, 64, 64);
        const atmosMat = new THREE.ShaderMaterial({
            vertexShader: `
                varying vec3 vNormal;
                varying vec3 eyeVector;
                void main() {
                    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                    vNormal = normalize(normalMatrix * normal);
                    eyeVector = normalize(mvPos.xyz);
                    gl_Position = projectionMatrix * mvPos;
                }
            `,
            fragmentShader: `
                varying vec3 vNormal;
                varying vec3 eyeVector;
                uniform float atmOpacity;
                uniform float atmPowFactor;
                uniform float atmMultiplier;
                void main() {
                    float dotP = dot(vNormal, eyeVector);
                    float factor = pow(dotP, atmPowFactor) * atmMultiplier;
                    vec3 atmColor = vec3(0.35 + dotP/4.5, 0.35 + dotP/4.5, 1.0);
                    gl_FragColor = vec4(atmColor, atmOpacity) * factor;
                }
            `,
            uniforms: {
                atmOpacity: { value: 0.7 },
                atmPowFactor: { value: 4.1 },
                atmMultiplier: { value: 9.5 }
            },
            blending: THREE.AdditiveBlending,
            side: THREE.BackSide
        });
        this.atmosphere = new THREE.Mesh(atmosGeo, atmosMat);
        this.earthGroup.add(this.atmosphere);

        // Set initial rotation - apply to the whole group for consistency
        this.earthGroup.rotation.y = this.config.initialRotationY;

        this.scene.add(this.earthGroup);

        // Calculate camera end position (toward Kilauea)
        this.calculateCameraEndPosition();
    }

    latLonToVector3(lat, lon, radius) {
        const phi = (90 - lat) * (Math.PI / 180);
        const theta = (lon + 180) * (Math.PI / 180);
        return new THREE.Vector3(
            -radius * Math.sin(phi) * Math.cos(theta),
            radius * Math.cos(phi),
            radius * Math.sin(phi) * Math.sin(theta)
        );
    }

    calculateCameraEndPosition() {
        // Zoom toward Hawaii: up (positive Y) to hit the islands not the ocean below
        this.cameraEnd = new THREE.Vector3(0.15, 0.45, 1.2);
        // Final position: zoom straight down toward surface during crossfade
        this.cameraFinal = new THREE.Vector3(0.11, 0.32, 0.9);
    }

    /**
     * Scrub the whole scene from a single 0..1 scroll position.
     *
     * The scene owns exactly two viewports of scroll, so every part of that
     * budget has to show movement. One clock (`e`) drives the entire camera
     * path and the Earth's rotation; the path is piecewise between three
     * waypoints, so the reader never sees the motion stop and restart.
     */
    setZoomProgress(progress) {
        progress = Math.max(0, Math.min(1, progress));
        this.zoomProgress = progress;

        if (!this.camera || !this.cameraEnd || !this.earthGroup) return;

        // Where along the camera path the mid waypoint (Hawaii centred) sits.
        const PATH_SPLIT = 0.72;
        const e = this.easeZoom(progress);

        if (e <= PATH_SPLIT) {
            // Leg 1: out of space, down onto Hawaii.
            const q = e / PATH_SPLIT;
            this.camera.position.lerpVectors(this.cameraStart, this.cameraEnd, q);

            // Interpolate Earth rotation from US to Hawaii on the same clock.
            const startRot = this.config.initialRotationY;
            const endRot = this.config.endRotationY;
            this.earthGroup.rotation.y = startRot + (endRot - startRot) * q;

            // Look at Earth center with tilt offset (levels out as we zoom in)
            this.camera.lookAt(new THREE.Vector3(0, this.lookAtY * (1 - q), 0));
        } else {
            // Leg 2: straight down toward the surface.
            const q = (e - PATH_SPLIT) / (1 - PATH_SPLIT);
            this.camera.position.lerpVectors(this.cameraEnd, this.cameraFinal, q);
            this.earthGroup.rotation.y = this.config.endRotationY;
            this.camera.lookAt(new THREE.Vector3(0, 0, 0));
        }

        // Crossfade to the video.
        //
        // The window ends at 0.82, not at 1.0, and that is deliberate: the deck
        // takes the last 0.35 of a viewport of this scene back as snap runway
        // so the video beat can actually be landed on (see SCENE_EXIT_LEAD in
        // index.html, which arms at progress 0.825). The handover therefore has
        // to be COMPLETE before that point - the reader must arrive at the
        // video beat with the crossfade already finished, not be carried
        // through the middle of it by a snap animation.
        //
        // setZoomProgress is the sole owner of this canvas's opacity. Nothing
        // else may write it: a direct opacity = '1' anywhere else is what pinned
        // a washed-out fully-zoomed Earth over the video on a mid-page reload.
        if (this.texturesReady) {
            const FADE_FROM = 0.58;
            const FADE_TO = 0.82;
            if (progress > FADE_FROM) {
                const f = Math.min(1, (progress - FADE_FROM) / (FADE_TO - FADE_FROM));
                this.canvas.style.opacity = 1 - f;
            } else {
                this.canvas.style.opacity = 1;
            }
        }

        // Show video behind Earth as it fades.
        const reveal = (typeof window.HEARTS_VIDEO_REVEAL === 'number')
            ? window.HEARTS_VIDEO_REVEAL : 0.70;
        if (this.videoFixed) {
            if (progress > reveal) {
                this.videoFixed.classList.add('visible');
                if (!this.videoOverlayTriggered) {
                    this.videoOverlayTriggered = true;
                    window.dispatchEvent(new CustomEvent('earthVideoRevealed'));
                }
            } else {
                this.videoFixed.classList.remove('visible');
                this.videoOverlayTriggered = false;
            }
        }
    }

    /**
     * Zoom easing.
     *
     * The old curve spent its first third moving 5% of the way - across this
     * scene's budget that is two thirds of a viewport of scrolling for almost
     * no visible change, which is dead scroll by any honest measure. This is a
     * blend of linear and smoothstep: eased at both ends so the entry and the
     * arrival still feel weighted, but its slope never drops below 0.45 of the
     * average, so the planet is always visibly moving under the reader's
     * finger. Monotonic, so scrolling back up retraces it exactly.
     */
    easeZoom(t) {
        const s = t * t * (3 - 2 * t);
        return 0.45 * t + 0.55 * s;
    }

    setupVisibilityObserver() {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                this.isVisible = entry.isIntersecting;
                if (this.isVisible && !this.animationId) {
                    this.animate();
                } else if (!this.isVisible && this.animationId) {
                    cancelAnimationFrame(this.animationId);
                    this.animationId = null;
                }
            });
        }, { threshold: 0 });
        // threshold 0, not 0.1: the container is three viewports tall, so 0.1
        // meant "30vh of it is on screen" - a third of the descent would have
        // played against a frozen last-rendered frame before the loop woke up.

        observer.observe(this.container);
    }

    setupResizeHandler() {
        window.addEventListener('resize', () => {
            if (!this.camera || !this.renderer) return;
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            // Re-frame for the new aspect (phone rotation) and re-apply progress
            // so the camera does not stay at a position computed for the old one.
            this.applyAspectFraming();
            this.setZoomProgress(this.zoomProgress);
        });
    }

    animate() {
        if (!this.isVisible) {
            this.animationId = null;
            return;
        }

        this.animationId = requestAnimationFrame(() => this.animate());

        this.renderer.render(this.scene, this.camera);
    }

    // Toggle layer visibility
    toggleEarth(visible) {
        if (this.earth) this.earth.visible = visible;
    }

    toggleClouds(visible) {
        if (this.clouds) this.clouds.visible = visible;
    }

    toggleAtmosphere(visible) {
        if (this.atmosphere) this.atmosphere.visible = visible;
    }
}

// Export to window for global access
window.EarthViewer = EarthViewer;
window.EARTH_LOOK_AT_Y_START = EARTH_LOOK_AT_Y_START;
window.EARTH_LOOK_AT_Y_END = EARTH_LOOK_AT_Y_END;
