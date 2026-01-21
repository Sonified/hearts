// Audio Visualizer for Kilauea Video
class AudioVisualizer {
    constructor(videoElement, volumeBars) {
        this.video = videoElement;
        this.bars = volumeBars;
        this.audioContext = null;
        this.analyser = null;
        this.gainNode = null;
        this.source = null;
        this.dataArray = null;
        this.animationId = null;
        this.initialized = false;
        this.isMuted = true;
    }

    init() {
        if (this.initialized) return;

        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.8;

            // Create gain node for muting output while keeping analysis
            this.gainNode = this.audioContext.createGain();
            this.gainNode.gain.value = 0; // Start muted

            this.source = this.audioContext.createMediaElementSource(this.video);
            // Audio flows: source -> analyser -> gain -> output
            this.source.connect(this.analyser);
            this.analyser.connect(this.gainNode);
            this.gainNode.connect(this.audioContext.destination);

            this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
            this.initialized = true;

            // Unmute the video element (we control volume via gainNode)
            this.video.muted = false;
        } catch (e) {
            console.warn('AudioVisualizer: Could not initialize Web Audio API', e);
        }
    }

    start() {
        if (!this.initialized) this.init();
        if (!this.initialized) return;

        // Resume audio context if suspended (browser autoplay policy)
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }

        this.animate();
    }

    stop() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    setMuted(muted) {
        this.isMuted = muted;
        // Resume AudioContext on user interaction (required by browser autoplay policy)
        if (this.audioContext && this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
        if (this.gainNode) {
            this.gainNode.gain.value = muted ? 0 : 0.4;
        }
    }

    animate() {
        this.animationId = requestAnimationFrame(() => this.animate());

        if (!this.analyser || !this.dataArray) return;

        this.analyser.getByteTimeDomainData(this.dataArray);

        // Calculate RMS (root mean square) for actual loudness
        let sumSquares = 0;
        for (let i = 0; i < this.dataArray.length; i++) {
            const normalized = (this.dataArray[i] - 128) / 128; // Center around 0
            sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / this.dataArray.length);

        // Map RMS to number of active bars (2-5)
        // Minimum 2 bars always active for more visible motion
        // Quiet=2, loud=3, very loud=4, REALLY loud=5
        const activeBars = rms < 0.08 ? 2 :
                          rms < 0.18 ? 3 :
                          rms < 0.35 ? 4 : 5;

        // Update bar states
        this.bars.forEach((bar, index) => {
            if (index < activeBars) {
                bar.classList.add('active');
            } else {
                bar.classList.remove('active');
            }
        });
    }

    destroy() {
        this.stop();
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        this.initialized = false;
    }
}

if (typeof window !== 'undefined') {
    window.AudioVisualizer = AudioVisualizer;
}
