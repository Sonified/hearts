/**
 * Earth Viewer - 3D Earth with day/night cycle, clouds, and zoom animation
 * Based on Franky Hung's threejs-earth implementation
 * Adapted for HEARTS project scroll-driven animation
 */

class EarthViewer {
    constructor(config = {}) {
        this.config = {
            canvasId: 'earth-canvas',
            containerId: 'earthScrollContainer',
            labelId: 'earthLabel',
            texturesPath: 'earth/textures/',
            earthRadius: 1,
            atmosphereRadius: 1.25, // Franky uses 12.5 for Earth radius 10 = 1.25x
            initialCameraZ: 2.5,
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

        // Camera animation state - start up and right
        this.cameraStart = new THREE.Vector3(1.2, 1.7, this.config.initialCameraZ);
        this.cameraEnd = null; // Will be set after calculating Kilauea position
    }

    init() {
        const canvas = document.getElementById(this.config.canvasId);
        const container = document.getElementById(this.config.containerId);
        if (!canvas || !container) {
            console.error('Earth viewer: canvas or container not found');
            return;
        }

        this.canvas = canvas;
        this.container = container;
        this.label = document.getElementById(this.config.labelId);

        this.setupScene();
        this.setupCamera();
        this.setupRenderer();
        this.setupLighting();
        this.loadTextures();
        this.setupVisibilityObserver();
        this.setupResizeHandler();

        console.log('Earth viewer initialized');
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
        this.camera.position.copy(this.cameraStart);
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
        const loader = new THREE.TextureLoader();
        const path = this.config.texturesPath;

        // Load all textures
        const albedoMap = loader.load(path + 'Albedo.jpg');
        const bumpMap = loader.load(path + 'Bump.jpg');
        const cloudsMap = loader.load(path + 'Clouds.png');
        const oceanMap = loader.load(path + 'Ocean.png');
        const lightsMap = loader.load(path + 'night_lights_modified.png');

        // Set color space for color textures (r128 uses encoding, newer uses colorSpace)
        if (albedoMap.colorSpace !== undefined) {
            albedoMap.colorSpace = THREE.SRGBColorSpace;
        } else {
            albedoMap.encoding = THREE.sRGBEncoding;
        }

        // Set anisotropic filtering for quality
        const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
        albedoMap.anisotropy = maxAniso;
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

        // Show label initially
        if (this.label) {
            this.label.classList.add('visible');
        }
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
        // Start at z=4, end at z=1.2
        this.cameraEnd = new THREE.Vector3(0.15, 0.45, 1.2);
    }

    setZoomProgress(progress) {
        this.zoomProgress = Math.max(0, Math.min(1, progress));

        if (!this.camera || !this.cameraEnd || !this.earthGroup) return;

        // Ease function for smooth camera movement
        const eased = this.easeInOutCubic(progress);

        // Interpolate camera position
        this.camera.position.lerpVectors(this.cameraStart, this.cameraEnd, eased);

        // Interpolate Earth rotation from US to Hawaii
        const startRot = this.config.initialRotationY;
        const endRot = this.config.endRotationY;
        this.earthGroup.rotation.y = startRot + (endRot - startRot) * eased;

        // Look at Earth center (with slight adjustment toward target as we zoom)
        const lookTarget = new THREE.Vector3(0, 0, 0);
        this.camera.lookAt(lookTarget);

        // Label visibility
        if (this.label) {
            if (progress < 0.15) {
                this.label.classList.add('visible');
            } else {
                this.label.classList.remove('visible');
            }
        }

        // Fade canvas at end for transition to video
        if (progress > 0.85) {
            const fadeProgress = (progress - 0.85) / 0.15;
            this.canvas.style.opacity = 1 - fadeProgress;
        } else {
            this.canvas.style.opacity = 1;
        }
    }

    easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
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
        }, { threshold: 0.1 });

        observer.observe(this.container);
    }

    setupResizeHandler() {
        window.addEventListener('resize', () => {
            if (!this.camera || !this.renderer) return;
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
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
