// HEARTS Wave Effect Module
class WaveEffect {
    constructor(config = {}) {
        this.config = {
            waveSpeed: config.waveSpeed !== undefined ? config.waveSpeed : 0.49,
            waveDamping: config.waveDamping !== undefined ? config.waveDamping : 0.996,
            waveForce: config.waveForce !== undefined ? config.waveForce : 0.30,
            waveSourceSize: config.waveSourceSize !== undefined ? config.waveSourceSize : 0.065,
            waveGridSize: config.waveGridSize !== undefined ? config.waveGridSize : 1024,
            simSteps: config.simSteps !== undefined ? config.simSteps : 4,
            edgeReflect: config.edgeReflect !== undefined ? config.edgeReflect : 0.1,
            edgeBoundary: config.edgeBoundary !== undefined ? config.edgeBoundary : 0.01,
            opacity: config.opacity !== undefined ? config.opacity : 0.1,
            color: config.color || '#9333ea'
        };

        this.mouseX = window.innerWidth / 2;
        this.mouseY = window.innerHeight / 2;
        this.lastClientX = window.innerWidth / 2;
        this.lastClientY = window.innerHeight / 2;
        this.prevMouseX = null;
        this.prevMouseY = null;
        this.mouseIsActive = false;
        this.initialized = false;
    }

    init() {
        // console.log('Initializing wave effect...');
        this.createCanvas();
        this.initWaveSimulation();
        this.setupEventListeners();
        this.animate();
        this.initialized = true;
        // console.log('Wave effect initialized');
    }

    createCanvas() {
        // Find the content section to attach waves to
        const contentSection = document.querySelector('.content');
        if (!contentSection) {
            console.error('Content section not found!');
            return;
        }

        this.canvas = document.createElement('canvas');
        this.canvas.id = 'wave-canvas';
        this.canvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 0;
            mix-blend-mode: screen;
        `;
        contentSection.style.position = 'relative'; // Ensure section is positioned
        contentSection.insertBefore(this.canvas, contentSection.firstChild);

        const rect = contentSection.getBoundingClientRect();
        this.displayRenderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            alpha: true,
            antialias: false
        });
        this.displayRenderer.setSize(rect.width, rect.height);
        this.displayRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        this.displayScene = new THREE.Scene();
        this.displayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

        window.addEventListener('resize', () => this.handleResize());
    }

    handleResize() {
        const contentSection = document.querySelector('.content');
        if (this.displayRenderer && contentSection) {
            const rect = contentSection.getBoundingClientRect();
            this.displayRenderer.setSize(rect.width, rect.height);
        }
    }

    initWaveSimulation() {
        const gridSize = this.config.waveGridSize;

        // Use the display renderer for simulation too - can't share textures across contexts
        this.waveScene = new THREE.Scene();
        this.waveCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

        // Use FloatType directly - WebGL2 has built-in float texture support
        const rtOptions = {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            type: THREE.FloatType
        };

        this.waveRenderTargets = [];
        for (let i = 0; i < 2; i++) {
            this.waveRenderTargets.push(
                new THREE.WebGLRenderTarget(gridSize, gridSize, rtOptions)
            );
        }
        this.currentWaveTarget = 0;

        // Initialize render targets to 0.0 (FloatType supports negative values)
        const clearMat = new THREE.ShaderMaterial({
            vertexShader: this.getSimVertexShader(),
            fragmentShader: `
                precision highp float;
                void main() {
                    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
                }
            `
        });
        const clearQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), clearMat);
        const clearScene = new THREE.Scene();
        clearScene.add(clearQuad);
        this.waveRenderTargets.forEach(rt => {
            this.displayRenderer.setRenderTarget(rt);
            this.displayRenderer.render(clearScene, this.waveCamera);
        });
        this.displayRenderer.setRenderTarget(null);
        clearMat.dispose();
        clearQuad.geometry.dispose();

        // Simulation shader - using config values
        this.waveSimMaterial = new THREE.ShaderMaterial({
            vertexShader: this.getSimVertexShader(),
            fragmentShader: this.getSimFragmentShader(),
            uniforms: {
                uPrevState: { value: null },
                uResolution: { value: new THREE.Vector2(gridSize, gridSize) },
                uWaveSpeed: { value: this.config.waveSpeed },
                uDamping: { value: this.config.waveDamping },
                uEdgeReflect: { value: this.config.edgeReflect },
                uEdgeBoundary: { value: this.config.edgeBoundary },
                uUserWavePos: { value: new THREE.Vector2(-9999, -9999) },
                uUserWaveStrength: { value: 0.0 },
                uUserWaveRadius: { value: this.config.waveSourceSize }
            }
        });

        const simQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.waveSimMaterial);
        this.waveScene.add(simQuad);

        // Display shader - using config values
        const rgb = this.hexToRgb(this.config.color);
        this.waveDisplayMaterial = new THREE.ShaderMaterial({
            vertexShader: this.getDisplayVertexShader(),
            fragmentShader: this.getDisplayFragmentShader(),
            uniforms: {
                uWaveState: { value: null },
                uColor: { value: new THREE.Vector3(rgb.r / 255, rgb.g / 255, rgb.b / 255) },
                uOpacity: { value: this.config.opacity },
                uResolution: { value: new THREE.Vector2(gridSize, gridSize) }
            },
            transparent: true,
            depthTest: false
        });

        const displayQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.waveDisplayMaterial);
        this.displayScene.add(displayQuad);

        // console.log('Wave simulation initialized with', gridSize, 'x', gridSize, 'grid');
    }

    setupEventListeners() {
        const updateMousePosition = () => {
            if (!this.canvas) return;
            const rect = this.canvas.getBoundingClientRect();
            this.mouseX = this.lastClientX - rect.left;
            this.mouseY = this.lastClientY - rect.top;
        };

        document.addEventListener('mousemove', (e) => {
            this.lastClientX = e.clientX;
            this.lastClientY = e.clientY;
            updateMousePosition();
            this.mouseIsActive = true;
        });

        // Update mouse position on scroll (canvas moves, mouse stays)
        document.addEventListener('scroll', () => {
            updateMousePosition();
        }, { passive: true });

        document.addEventListener('mouseenter', (e) => {
            this.mouseIsActive = true;
        });

        document.addEventListener('mouseleave', () => {
            this.mouseIsActive = false;
        });

        document.addEventListener('touchstart', (e) => {
            if (!this.canvas) return;
            const touch = e.touches[0];
            this.lastClientX = touch.clientX;
            this.lastClientY = touch.clientY;
            updateMousePosition();
            this.mouseIsActive = true;
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            if (!this.canvas) return;
            const touch = e.touches[0];
            this.lastClientX = touch.clientX;
            this.lastClientY = touch.clientY;
            updateMousePosition();
        }, { passive: true });

        document.addEventListener('touchend', () => {
            this.mouseIsActive = false;
        });
    }

    updateSimulation() {
        if (!this.initialized || !this.waveSimMaterial || !this.canvas) return;

        const rect = this.canvas.getBoundingClientRect();
        const canvasWidth = rect.width;
        const canvasHeight = rect.height;

        // Calculate velocity-based wave forcing (like EMDR)
        let forceStrength = 0;
        if (this.prevMouseX !== null && this.prevMouseY !== null) {
            const dx = this.mouseX - this.prevMouseX;
            const dy = this.mouseY - this.prevMouseY;
            const velocity = Math.sqrt(dx * dx + dy * dy);

            // Scale force by velocity - faster movement = stronger waves
            const normalizedVelocity = velocity / canvasWidth;
            forceStrength = normalizedVelocity * this.config.waveForce * 50;
        }
        this.prevMouseX = this.mouseX;
        this.prevMouseY = this.mouseY;

        if (forceStrength > 0) {
            const uvX = this.mouseX / canvasWidth;
            const uvY = 1.0 - (this.mouseY / canvasHeight);
            this.waveSimMaterial.uniforms.uUserWavePos.value.set(uvX, uvY);
            this.waveSimMaterial.uniforms.uUserWaveStrength.value = forceStrength;
        } else {
            this.waveSimMaterial.uniforms.uUserWaveStrength.value = 0.0;
        }

        for (let step = 0; step < this.config.simSteps; step++) {
            const readTarget = this.waveRenderTargets[this.currentWaveTarget];
            const writeTarget = this.waveRenderTargets[1 - this.currentWaveTarget];

            this.waveSimMaterial.uniforms.uPrevState.value = readTarget.texture;
            this.displayRenderer.setRenderTarget(writeTarget);
            this.displayRenderer.render(this.waveScene, this.waveCamera);

            // // DEBUG: Check what was written
            // if (this.mouseIsActive && Math.random() < 0.02) {
            //     const pixels = new Float32Array(4);
            //     this.displayRenderer.readRenderTargetPixels(writeTarget, 128, 128, 1, 1, pixels);
            //     console.log('After sim step', step, '- written values:',
            //         pixels[0].toFixed(3), pixels[1].toFixed(3));
            // }

            this.currentWaveTarget = 1 - this.currentWaveTarget;
        }

        this.displayRenderer.setRenderTarget(null);
    }

    render() {
        if (!this.initialized) return;

        this.updateSimulation();

        const currentState = this.waveRenderTargets[this.currentWaveTarget];
        this.waveDisplayMaterial.uniforms.uWaveState.value = currentState.texture;

        // // DEBUG: Sample wave texture
        // if (Math.random() < 0.02) {
        //     const pixels = new Float32Array(4);
        //     this.displayRenderer.readRenderTargetPixels(currentState, 128, 128, 1, 1, pixels);
        //     console.log('Wave values at center:', pixels[0].toFixed(3), pixels[1].toFixed(3), 'mouse active:', this.mouseIsActive);
        // }

        this.displayRenderer.render(this.displayScene, this.displayCamera);
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        this.render();
    }

    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : { r: 147, g: 51, b: 234 };
    }

    getSimVertexShader() {
        return `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `;
    }

    getSimFragmentShader() {
        return `
            precision highp float;
            varying vec2 vUv;

            uniform sampler2D uPrevState;
            uniform vec2 uResolution;
            uniform float uWaveSpeed;
            uniform float uDamping;
            uniform float uEdgeReflect;
            uniform float uEdgeBoundary;
            uniform vec2 uUserWavePos;
            uniform float uUserWaveStrength;
            uniform float uUserWaveRadius;

            void main() {
                vec2 texel = 1.0 / uResolution;

                vec4 state = texture2D(uPrevState, vUv);
                float current = state.r;
                float previous = state.g;

                float left = texture2D(uPrevState, vUv + vec2(-texel.x, 0.0)).r;
                float right = texture2D(uPrevState, vUv + vec2(texel.x, 0.0)).r;
                float up = texture2D(uPrevState, vUv + vec2(0.0, texel.y)).r;
                float down = texture2D(uPrevState, vUv + vec2(0.0, -texel.y)).r;

                float laplacian = left + right + up + down - 4.0 * current;
                float velocity = current - previous;
                float acceleration = uWaveSpeed * laplacian;
                float next = current + velocity * uDamping + acceleration;

                if (uUserWaveStrength > 0.0) {
                    float userDist = length(vUv - uUserWavePos);
                    if (userDist < uUserWaveRadius) {
                        float userFalloff = 1.0 - (userDist / uUserWaveRadius);
                        userFalloff = userFalloff * userFalloff;
                        next += uUserWaveStrength * userFalloff;
                    }
                }

                float edgeDist = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
                float edgeDamp = smoothstep(0.0, uEdgeBoundary, edgeDist);
                next = mix(next * edgeDamp, next, uEdgeReflect);

                next = clamp(next, -1.0, 1.0);

                gl_FragColor = vec4(next, current, 0.0, 1.0);
            }
        `;
    }

    getDisplayVertexShader() {
        return `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `;
    }

    getDisplayFragmentShader() {
        return `
            precision highp float;
            varying vec2 vUv;

            uniform sampler2D uWaveState;
            uniform vec3 uColor;
            uniform float uOpacity;
            uniform vec2 uResolution;

            void main() {
                vec2 texel = 1.0 / uResolution;

                float left = texture2D(uWaveState, vUv + vec2(-texel.x, 0.0)).r;
                float right = texture2D(uWaveState, vUv + vec2(texel.x, 0.0)).r;
                float up = texture2D(uWaveState, vUv + vec2(0.0, texel.y)).r;
                float down = texture2D(uWaveState, vUv + vec2(0.0, -texel.y)).r;

                // Gradient shows wave fronts
                vec2 gradient = vec2(right - left, up - down);
                float steepness = length(gradient) * 15.0;

                // Add highlights
                float highlight = smoothstep(0.3, 0.8, steepness);
                vec3 color = mix(uColor, vec3(1.0), highlight * 0.3);

                float alpha = min(steepness * uOpacity, 1.0);

                gl_FragColor = vec4(color, alpha);
            }
        `;
    }

    destroy() {
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
        if (this.displayRenderer) this.displayRenderer.dispose();
        this.waveRenderTargets.forEach(target => target.dispose());
    }
}

if (typeof window !== 'undefined') {
    window.WaveEffect = WaveEffect;
}
