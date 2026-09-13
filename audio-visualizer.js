// Audio control for the Kilauea video.
//
// Routes the video through Web Audio so volume works on iOS, where the
// HTMLMediaElement.volume property is read-only and silently ignored. All
// level changes go through this gainNode - never video.volume.
//
// The video element MUST carry crossorigin="anonymous": it is served from
// cdn.now.audio, and createMediaElementSource() on a tainted cross-origin
// element outputs silence.
class AudioVisualizer {
    constructor(videoElement) {
        this.video = videoElement;
        this.audioContext = null;
        this.gainNode = null;
        this.source = null;
        this.initialized = false;
        this.isMuted = true;

        // Slider position, 0..1. MAX_GAIN is set so the 0.5 default reproduces
        // the 0.12 gain this control used to apply at its single fixed level.
        this.volume = 0.5;
        this.MAX_GAIN = 0.24;
    }

    init() {
        if (this.initialized) return;

        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

            this.gainNode = this.audioContext.createGain();
            this.gainNode.gain.value = 0; // Start muted

            this.source = this.audioContext.createMediaElementSource(this.video);
            // Audio flows: source -> gain -> output
            this.source.connect(this.gainNode);
            this.gainNode.connect(this.audioContext.destination);

            this.initialized = true;

            // Unmute the element itself; level is controlled by the gain node.
            this.video.muted = false;
        } catch (e) {
            console.warn('AudioVisualizer: Could not initialize Web Audio API', e);
        }
    }

    start() {
        if (!this.initialized) this.init();
        if (!this.initialized) return;
        this.resumeContext();
    }

    stop() {
        // No animation loop to cancel; kept so existing callers stay valid.
    }

    // Browser autoplay policy: the context can only be resumed from a
    // user gesture, so every interaction entry point calls this.
    resumeContext() {
        if (this.audioContext && this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
    }

    get targetGain() {
        return this.isMuted ? 0 : this.volume * this.MAX_GAIN;
    }

    applyGain(rampSeconds = 0.15) {
        if (!this.gainNode || !this.audioContext) return;
        const now = this.audioContext.currentTime;
        this.gainNode.gain.cancelScheduledValues(now);
        this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
        this.gainNode.gain.linearRampToValueAtTime(this.targetGain, now + rampSeconds);
    }

    setMuted(muted) {
        this.isMuted = muted;
        this.resumeContext();
        this.applyGain(0.15);
    }

    // value: 0..1 slider position
    setVolume(value) {
        this.volume = Math.max(0, Math.min(1, value));
        this.resumeContext();
        // Short ramp so dragging the slider stays smooth without lagging.
        this.applyGain(0.05);
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
