import { createContext, useContext, type PropsWithChildren } from "react";
import { formatDuration } from "@/utils/audio";
import type { VoiceInputController } from "./useVoiceInputController";

type VoiceUiStatus =
  | {
      kind: "loading";
      icon: "download" | "hourglass_top";
      label: string;
    }
  | {
      kind: "error";
      icon: "error";
      label: string;
    };

const VoiceInputStateContext = createContext<VoiceInputController | null>(null);

function getVoiceUiStatus({
  error,
  isPreparingModel,
  isTranscribing,
}: Pick<VoiceInputController, "error" | "isPreparingModel" | "isTranscribing">): VoiceUiStatus | null {
  if (error) {
    return {
      kind: "error",
      icon: "error",
      label: error,
    };
  }
  if (isPreparingModel) {
    return {
      kind: "loading",
      icon: "download",
      label: "Downloading Whisper model (first run)…",
    };
  }
  if (isTranscribing) {
    return {
      kind: "loading",
      icon: "hourglass_top",
      label: "Transcribing voice into the input…",
    };
  }
  return null;
}

export function VoiceInputStateProvider({
  value,
  children,
}: PropsWithChildren<{ value: VoiceInputController }>) {
  return (
    <VoiceInputStateContext.Provider value={value}>
      {children}
    </VoiceInputStateContext.Provider>
  );
}

export function useVoiceInputState(): VoiceInputController {
  const state = useContext(VoiceInputStateContext);
  if (!state) {
    throw new Error(
      "useVoiceInputState must be used inside VoiceInputStateProvider",
    );
  }
  return state;
}

export function VoiceInputStatusSlot() {
  const { enabled, error, isPreparingModel, isTranscribing } =
    useVoiceInputState();
  if (!enabled) return null;

  const status = getVoiceUiStatus({ error, isPreparingModel, isTranscribing });
  if (!status) return null;
  const kindClass = `chat-voice-state-slot--${status.kind}`;
  const showSpinner = status?.kind === "loading";

  return (
    <div
      className={`chat-voice-state-slot ${kindClass}`}
      title={status?.kind === "error" ? status.label : undefined}
      aria-live={status ? "polite" : undefined}
    >
      <span
        className={`material-symbols-outlined text-sm ${showSpinner ? "chat-voice-state-spin" : ""}`}
      >
        {status.icon}
      </span>
      <span className="chat-voice-state-text">{status.label}</span>
    </div>
  );
}

export function VoiceInputRecordingRow() {
  const { enabled, isRecording, recordingElapsedMs, waveformCanvasRef } =
    useVoiceInputState();
  if (!enabled || !isRecording) return null;

  return (
    <div className="chat-voice-recording">
      <div className="chat-voice-recording-meta">
        <span className="chat-voice-live-dot" />
        <span>{formatDuration(recordingElapsedMs)}</span>
      </div>
      <canvas
        ref={waveformCanvasRef}
        className="chat-voice-waveform"
        aria-label="Live microphone waveform"
      />
    </div>
  );
}

export function VoiceInputToggleButton() {
  const { enabled, isRecording, toggleRecording, busy } = useVoiceInputState();
  if (!enabled) return null;

  return (
    <button
      title={isRecording ? "Stop voice recording" : "Record voice message"}
      aria-label={isRecording ? "Stop voice recording" : "Record voice message"}
      className={isRecording ? "chat-voice-btn--recording" : ""}
      onClick={toggleRecording}
      disabled={busy}
    >
      <span className="material-symbols-outlined text-lg">
        {isRecording ? "stop_circle" : "mic"}
      </span>
    </button>
  );
}
