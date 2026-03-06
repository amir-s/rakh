use crate::utils::{home_dir, tool_log};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde_json::{json, Value};
use std::fs;
use std::io::{self, Cursor};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub const DEFAULT_WHISPER_MODEL_FILENAME: &str = "ggml-base.en.bin";
pub const DEFAULT_WHISPER_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

static WHISPER_MODEL_DOWNLOAD_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn whisper_model_download_lock() -> &'static Mutex<()> {
    WHISPER_MODEL_DOWNLOAD_LOCK.get_or_init(|| Mutex::new(()))
}

fn default_whisper_model_path() -> Option<PathBuf> {
    home_dir().map(|home| {
        home.join(".rakh")
            .join("whisper")
            .join(DEFAULT_WHISPER_MODEL_FILENAME)
    })
}

fn ensure_existing_model_file(path: &PathBuf) -> Result<(), String> {
    if !path.exists() {
        return Err(format!(
            "Whisper model was not found at {}.",
            path.to_string_lossy()
        ));
    }
    if !path.is_file() {
        return Err(format!(
            "Whisper model path is not a file: {}",
            path.to_string_lossy()
        ));
    }
    Ok(())
}

fn download_default_whisper_model(target_path: &PathBuf) -> Result<(), String> {
    let _guard = whisper_model_download_lock().lock().unwrap();
    if target_path.exists() {
        return Ok(());
    }

    let start = Instant::now();
    tool_log(
        "whisper_model_download",
        "start",
        json!({
            "targetPath": target_path.to_string_lossy(),
            "url": DEFAULT_WHISPER_MODEL_URL
        }),
    );

    let result: Result<(), String> = (|| {
        let parent = target_path.parent().ok_or_else(|| {
            format!(
                "Invalid Whisper model target path: {}",
                target_path.to_string_lossy()
            )
        })?;
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Cannot create Whisper model directory {}: {}",
                parent.to_string_lossy(),
                e
            )
        })?;

        let temp_path = target_path.with_extension("download.part");

        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(60 * 30))
            .build()
            .map_err(|e| format!("Cannot initialize HTTP client: {}", e))?;

        let mut response = client
            .get(DEFAULT_WHISPER_MODEL_URL)
            .send()
            .map_err(|e| format!("Failed to download default Whisper model: {}", e))?;

        if !response.status().is_success() {
            return Err(format!(
                "Failed to download default Whisper model: HTTP {}",
                response.status()
            ));
        }

        let mut temp_file = fs::File::create(&temp_path).map_err(|e| {
            format!(
                "Cannot create temporary model file {}: {}",
                temp_path.to_string_lossy(),
                e
            )
        })?;
        let bytes_written = io::copy(&mut response, &mut temp_file)
            .map_err(|e| format!("Failed writing Whisper model file: {}", e))?;
        use std::io::Write;
        temp_file
            .flush()
            .map_err(|e| format!("Failed flushing Whisper model file: {}", e))?;

        if bytes_written == 0 {
            let _ = fs::remove_file(&temp_path);
            return Err("Downloaded Whisper model file was empty.".to_string());
        }

        if let Err(rename_err) = fs::rename(&temp_path, target_path) {
            if target_path.exists() {
                let _ = fs::remove_file(&temp_path);
            } else {
                let _ = fs::remove_file(&temp_path);
                return Err(format!(
                    "Failed to move Whisper model into place ({} -> {}): {}",
                    temp_path.to_string_lossy(),
                    target_path.to_string_lossy(),
                    rename_err
                ));
            }
        }

        Ok(())
    })();

    match &result {
        Ok(()) => tool_log(
            "whisper_model_download",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "targetPath": target_path.to_string_lossy()
            }),
        ),
        Err(error) => tool_log(
            "whisper_model_download",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "targetPath": target_path.to_string_lossy(),
                "error": error
            }),
        ),
    }

    result
}

fn resolve_whisper_model_path() -> Result<PathBuf, String> {
    let default_path = default_whisper_model_path().ok_or_else(|| {
        "Cannot determine home directory for default Whisper model storage.".to_string()
    })?;

    let existed_before = default_path.exists();
    if !existed_before {
        download_default_whisper_model(&default_path)?;
    }

    ensure_existing_model_file(&default_path)?;
    Ok(default_path)
}

pub fn decode_wav_to_mono_f32(wav_bytes: &[u8]) -> Result<(Vec<f32>, u32), String> {
    let mut reader = hound::WavReader::new(Cursor::new(wav_bytes))
        .map_err(|e| format!("Invalid WAV audio payload: {}", e))?;
    let spec = reader.spec();

    if spec.channels == 0 {
        return Err("WAV file has zero channels.".to_string());
    }
    if spec.sample_format != hound::SampleFormat::Int || spec.bits_per_sample != 16 {
        return Err(format!(
            "Unsupported WAV format (expected 16-bit PCM): sampleFormat={:?}, bitsPerSample={}",
            spec.sample_format, spec.bits_per_sample
        ));
    }

    let channels = spec.channels as usize;
    let mut mono = Vec::new();
    let mut acc = 0.0f32;
    let mut channel_idx = 0usize;

    for sample in reader.samples::<i16>() {
        let value = sample.map_err(|e| format!("Failed reading WAV sample: {}", e))? as f32
            / i16::MAX as f32;
        acc += value;
        channel_idx += 1;

        if channel_idx == channels {
            mono.push(acc / channels as f32);
            acc = 0.0;
            channel_idx = 0;
        }
    }

    if channel_idx > 0 {
        mono.push(acc / channel_idx as f32);
    }

    if mono.is_empty() {
        return Err("The recorded WAV file contained no audio samples.".to_string());
    }

    Ok((mono, spec.sample_rate))
}

pub fn resample_linear(samples: &[f32], input_rate: u32, output_rate: u32) -> Vec<f32> {
    if samples.is_empty() || input_rate == 0 || output_rate == 0 || input_rate == output_rate {
        return samples.to_vec();
    }

    let ratio = input_rate as f64 / output_rate as f64;
    let output_len = ((samples.len() as f64) / ratio).round().max(1.0) as usize;
    let mut out = vec![0.0f32; output_len];

    for (i, out_sample) in out.iter_mut().enumerate() {
        let source_index = i as f64 * ratio;
        let left = source_index.floor() as usize;
        let right = (left + 1).min(samples.len() - 1);
        let frac = (source_index - left as f64) as f32;
        *out_sample = samples[left] * (1.0 - frac) + samples[right] * frac;
    }

    out
}

#[tauri::command]
pub fn whisper_prepare_model() -> Result<Value, String> {
    let start = Instant::now();
    tool_log("whisper_prepare_model", "start", json!({}));

    let result: Result<Value, String> = (|| {
        let resolved_model = resolve_whisper_model_path()?;
        Ok(json!({
            "ready": true,
            "modelPath": resolved_model.to_string_lossy()
        }))
    })();

    match &result {
        Ok(_) => tool_log(
            "whisper_prepare_model",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64
            }),
        ),
        Err(e) => tool_log(
            "whisper_prepare_model",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
        ),
    }

    result
}

#[tauri::command]
pub fn whisper_transcribe_wav(audio_base64: String) -> Result<Value, String> {
    let start = Instant::now();
    tool_log(
        "whisper_transcribe_wav",
        "start",
        json!({
            "audioBase64Bytes": audio_base64.as_bytes().len(),
        }),
    );

    let result: Result<Value, String> = (|| {
        let resolved_model = resolve_whisper_model_path()?;
        let wav_bytes = BASE64_STANDARD
            .decode(audio_base64.as_bytes())
            .map_err(|e| format!("Failed to decode audio payload: {}", e))?;
        let (samples, input_rate) = decode_wav_to_mono_f32(&wav_bytes)?;
        let audio = if input_rate == 16_000 {
            samples
        } else {
            resample_linear(&samples, input_rate, 16_000)
        };

        let mut context_params = WhisperContextParameters::default();
        context_params.use_gpu(false);

        let context = WhisperContext::new_with_params(
            resolved_model.to_string_lossy().as_ref(),
            context_params,
        )
        .map_err(|e| format!("Failed to load Whisper model: {}", e))?;
        let mut state = context
            .create_state()
            .map_err(|e| format!("Failed to create Whisper state: {}", e))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        let thread_count = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(2)
            .clamp(1, 8) as i32;
        params.set_n_threads(thread_count);
        params.set_translate(false);
        params.set_no_context(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_language(None);

        state
            .full(params, &audio)
            .map_err(|e| format!("Whisper transcription failed: {}", e))?;

        let mut transcript = String::new();
        for segment in state.as_iter() {
            let text = segment
                .to_str_lossy()
                .map_err(|e| format!("Failed to decode Whisper segment: {}", e))?;
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }
            if !transcript.is_empty() {
                transcript.push(' ');
            }
            transcript.push_str(trimmed);
        }

        if transcript.trim().is_empty() {
            return Err("Whisper did not detect any spoken text in the recording.".to_string());
        }

        Ok(json!({
            "text": transcript.trim(),
            "sampleRate": 16_000,
            "modelPath": resolved_model.to_string_lossy(),
            "durationMs": ((audio.len() as f64 / 16_000.0) * 1000.0).round() as u64
        }))
    })();

    match &result {
        Ok(v) => tool_log(
            "whisper_transcribe_wav",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "textBytes": v["text"].as_str().map(|s| s.as_bytes().len()).unwrap_or(0),
                "sampleRate": v["sampleRate"],
            }),
        ),
        Err(e) => tool_log(
            "whisper_transcribe_wav",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
        ),
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_resample_linear_output_length() {
        let input = vec![0.0f32; 44_100];
        let output = resample_linear(&input, 44_100, 16_000);
        assert!((15_900..=16_100).contains(&output.len()));
    }

    #[test]
    fn test_decode_wav_to_mono_f32_reads_pcm16() {
        let dir = tempdir().unwrap();
        let wav_path = dir.path().join("voice.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        {
            let mut writer = hound::WavWriter::create(&wav_path, spec).unwrap();
            writer.write_sample(0i16).unwrap();
            writer.write_sample(i16::MAX / 2).unwrap();
            writer.finalize().unwrap();
        }

        let bytes = fs::read(&wav_path).unwrap();
        let (samples, rate) = decode_wav_to_mono_f32(&bytes).unwrap();
        assert_eq!(rate, 16_000);
        assert_eq!(samples.len(), 2);
        assert!(samples[1] > 0.45);
    }
}
