import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  encodePcm16Wav,
  mergeFloat32Chunks,
  resampleLinearPcm,
  uint8ToBase64,
} from "@/utils/audio";

const WHISPER_SAMPLE_RATE = 16_000;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface VoiceInputController {
  enabled: boolean;
  isRecording: boolean;
  recordingElapsedMs: number;
  isPreparingModel: boolean;
  isTranscribing: boolean;
  busy: boolean;
  error: string | null;
  waveformCanvasRef: RefObject<HTMLCanvasElement | null>;
  toggleRecording: () => void;
  stopRecording: () => Promise<void>;
  clearError: () => void;
}

interface UseVoiceInputControllerOptions {
  enabled: boolean;
  scopeKey: string;
  onTranscript: (transcript: string) => void;
}

export function useVoiceInputController({
  enabled,
  scopeKey,
  onTranscript,
}: UseVoiceInputControllerOptions): VoiceInputController {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const [isPreparingModel, setIsPreparingModel] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const silenceGainRef = useRef<GainNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef(WHISPER_SAMPLE_RATE);
  const startedAtMsRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const waveformRafRef = useRef<number | null>(null);
  const isRecordingRef = useRef(false);
  const previousScopeKeyRef = useRef(scopeKey);

  const teardown = useCallback(() => {
    if (waveformRafRef.current != null) {
      window.cancelAnimationFrame(waveformRafRef.current);
      waveformRafRef.current = null;
    }
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }

    processorRef.current?.disconnect();
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
    }
    silenceGainRef.current?.disconnect();
    analyserRef.current?.disconnect();
    sourceRef.current?.disconnect();

    const stream = mediaStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }

    const context = audioContextRef.current;
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }

    mediaStreamRef.current = null;
    audioContextRef.current = null;
    sourceRef.current = null;
    analyserRef.current = null;
    processorRef.current = null;
    silenceGainRef.current = null;
  }, []);

  const drawLiveWaveform = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser || !isRecordingRef.current) return;

    const canvas = waveformCanvasRef.current;
    if (!canvas) {
      waveformRafRef.current = window.requestAnimationFrame(drawLiveWaveform);
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      waveformRafRef.current = window.requestAnimationFrame(drawLiveWaveform);
      return;
    }

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) {
      waveformRafRef.current = window.requestAnimationFrame(drawLiveWaveform);
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.floor(width * dpr));
    const pixelHeight = Math.max(1, Math.floor(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(255, 255, 255, 0.025)";
    ctx.fillRect(0, 0, width, height);
    ctx.lineWidth = 1.75;
    ctx.strokeStyle = "rgba(236, 149, 19, 0.95)";
    ctx.beginPath();

    const sliceWidth = width / data.length;
    let x = 0;
    for (let i = 0; i < data.length; i += 1) {
      const normalized = data[i] / 128.0;
      const y = (normalized * height) / 2;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth;
    }
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    waveformRafRef.current = window.requestAnimationFrame(drawLiveWaveform);
  }, []);

  const transcribeToInput = useCallback(
    async (audioBase64: string) => {
      if (!isTauriRuntime()) {
        setError(
          "Local Whisper transcription is only available in the desktop app runtime.",
        );
        return;
      }

      setError(null);
      setIsPreparingModel(true);
      try {
        await invoke("whisper_prepare_model");
      } catch (nextError) {
        const message =
          nextError instanceof Error
            ? nextError.message
            : String(nextError ?? "Unknown");
        setError(`Whisper model download failed: ${message}`);
        return;
      } finally {
        setIsPreparingModel(false);
      }

      setIsTranscribing(true);
      try {
        const result = await invoke<{ text: string }>("whisper_transcribe_wav", {
          audioBase64,
        });
        const transcript = result.text.trim();
        if (transcript.toUpperCase() === "[BLANK_AUDIO]") {
          return;
        }
        if (!transcript) {
          setError("Whisper returned an empty transcript. Please try again.");
          return;
        }
        onTranscript(transcript);
      } catch (nextError) {
        const message =
          nextError instanceof Error
            ? nextError.message
            : String(nextError ?? "Unknown");
        setError(`Whisper transcription failed: ${message}`);
      } finally {
        setIsTranscribing(false);
      }
    },
    [onTranscript],
  );

  const startRecording = useCallback(async () => {
    if (!enabled) return;
    if (isRecordingRef.current || isPreparingModel || isTranscribing) return;

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia
    ) {
      setError("Microphone access is unavailable in this runtime.");
      return;
    }

    setError(null);

    const AudioContextCtor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextCtor) {
      setError("AudioContext is not supported on this system.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.85;

      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const silence = audioContext.createGain();
      silence.gain.value = 0;

      chunksRef.current = [];
      sampleRateRef.current = audioContext.sampleRate;
      processor.onaudioprocess = (event) => {
        if (!isRecordingRef.current) return;
        const channelData = event.inputBuffer.getChannelData(0);
        chunksRef.current.push(new Float32Array(channelData));
      };

      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(silence);
      silence.connect(audioContext.destination);

      mediaStreamRef.current = stream;
      audioContextRef.current = audioContext;
      sourceRef.current = source;
      analyserRef.current = analyser;
      processorRef.current = processor;
      silenceGainRef.current = silence;

      isRecordingRef.current = true;
      setIsRecording(true);
      startedAtMsRef.current = Date.now();
      setRecordingElapsedMs(0);

      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
      }
      timerRef.current = window.setInterval(() => {
        setRecordingElapsedMs(Date.now() - startedAtMsRef.current);
      }, 100);

      if (waveformRafRef.current != null) {
        window.cancelAnimationFrame(waveformRafRef.current);
      }
      waveformRafRef.current = window.requestAnimationFrame(drawLiveWaveform);
    } catch (nextError) {
      teardown();
      isRecordingRef.current = false;
      setIsRecording(false);
      const message =
        nextError instanceof Error
          ? nextError.message
          : "Unable to access microphone.";
      setError(`Microphone access failed: ${message}`);
    }
  }, [drawLiveWaveform, enabled, isPreparingModel, isTranscribing, teardown]);

  const stopRecording = useCallback(async () => {
    if (!isRecordingRef.current) return;
    isRecordingRef.current = false;
    setIsRecording(false);

    const elapsed = Date.now() - startedAtMsRef.current;
    setRecordingElapsedMs(Math.max(0, elapsed));
    teardown();

    try {
      const merged = mergeFloat32Chunks(chunksRef.current);
      chunksRef.current = [];
      if (merged.length === 0) {
        setError("No audio was captured. Please try again.");
        return;
      }

      const resampled = resampleLinearPcm(
        merged,
        sampleRateRef.current,
        WHISPER_SAMPLE_RATE,
      );
      const wavBytes = encodePcm16Wav(resampled, WHISPER_SAMPLE_RATE);
      await transcribeToInput(uint8ToBase64(wavBytes));
    } catch (nextError) {
      const message =
        nextError instanceof Error
          ? nextError.message
          : "Failed to finalize voice recording.";
      setError(message);
    }
  }, [teardown, transcribeToInput]);

  const toggleRecording = useCallback(() => {
    if (isRecordingRef.current) {
      void stopRecording();
      return;
    }
    void startRecording();
  }, [startRecording, stopRecording]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  useEffect(() => {
    return () => {
      isRecordingRef.current = false;
      teardown();
    };
  }, [teardown]);

  useEffect(() => {
    if (previousScopeKeyRef.current !== scopeKey && isRecordingRef.current) {
      isRecordingRef.current = false;
      setIsRecording(false);
      setRecordingElapsedMs(0);
      chunksRef.current = [];
      teardown();
    }
    previousScopeKeyRef.current = scopeKey;
  }, [scopeKey, teardown]);

  useEffect(() => {
    if (enabled) return;
    if (isRecordingRef.current) {
      isRecordingRef.current = false;
      setIsRecording(false);
      setRecordingElapsedMs(0);
      chunksRef.current = [];
      teardown();
    }
  }, [enabled, teardown]);

  const busy = enabled && (isPreparingModel || isTranscribing);

  return {
    enabled,
    isRecording,
    recordingElapsedMs,
    isPreparingModel,
    isTranscribing,
    busy,
    error,
    waveformCanvasRef,
    toggleRecording,
    stopRecording,
    clearError,
  };
}
