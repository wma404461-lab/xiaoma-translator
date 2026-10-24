# Third-party notices

Source repository edition: no bundled Node executable, demonstration audio, private QA cache, benchmark transcript, or training experiments are included. References below to the Windows demo ZIP describe the original distribution, not extra files in this source repository. Dependency licenses and font notices remain applicable.

FlowSub application source: Copyright 2026 artist_m, GPL-3.0. AI-assisted development is disclosed in the competition entry. Complete application source and setup scripts accompany the Windows demo.

| Component | Used for | Upstream and license |
|---|---|---|
| PyQt6 | Native global subtitle window | https://www.riverbankcomputing.com/software/pyqt/ — GPL v3 |
| Qt6 | Native widgets and WebSockets | https://www.qt.io/ — upstream LGPL/GPL terms; installed via PyQt6-Qt6 |
| PyAudioWPatch / PortAudio | Owned QA audio playback and output reference recording | https://github.com/s0d3s/PyAudioWPatch — MIT; PortAudio upstream license |
| pycaw 20260927 | Read-only Windows application audio-session discovery | https://github.com/AndreMiras/pycaw — MIT |
| comtypes 1.4.17 | COM interfaces for application audio-session discovery | https://github.com/enthought/comtypes — MIT |
| psutil 7.2.2 | Application ancestry and scoped process supervision/QA | https://github.com/giampaolo/psutil — BSD-3-Clause |
| spaCy 3.8.16 / en_core_web_sm 3.8.0 | CPU syntax veto for incomplete live nominal prefixes | https://github.com/explosion/spaCy and https://spacy.io/models/en — MIT; official model wheel SHA256 1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85; installed separately, weights excluded from ZIP |
| sherpa-onnx | Incremental speech recognition | https://github.com/k2-fsa/sherpa-onnx — Apache-2.0 |
| Zipformer English int8 model | Streaming English drafts | https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-21 — model card declares Apache-2.0; revision 9a65b6ea94c311ca770c2bf895b30f456a22d703 |
| faster-whisper / CTranslate2 | Correction of completed audio segments | https://github.com/SYSTRAN/faster-whisper and https://github.com/OpenNMT/CTranslate2 — MIT |
| Whisper small.en | English final recognition | https://github.com/openai/whisper — MIT; converted weights: https://huggingface.co/Systran/faster-whisper-small.en , revision d1d751a5f8271d482d14ca55d9e2deeebbae577f |
| NVIDIA cuDNN 9.10.2.21 / CUDA vendor libraries | Optional local GPU recognition and translation | https://docs.nvidia.com/deeplearning/cudnn/installation/latest/windows.html — NVIDIA vendor licence terms; installed separately, no NVIDIA binaries in the application ZIP |
| Qwen3-4B-Instruct-2507 Q4_K_M | Contextual English-to-Chinese translation | Original: https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507 — Apache-2.0; GGUF conversion by bartowski: https://huggingface.co/bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF , revision ae44f08e1392f39c0e474af10c3ff8355c8b6688; SHA256 2fde00ce69dd4899c70d020845e2638353015bba0fdf161b3eb965f2bca4464e |
| llama.cpp b11382 | Local GPU/CPU model serving | https://github.com/ggml-org/llama.cpp — MIT |
| Node.js v24.19.0 | Local application server | https://nodejs.org/ — Node.js MIT plus bundled third-party notices |
| ws | WebSocket sessions | https://github.com/websockets/ws — MIT |
| Noto Sans SC | Chinese/English interface and movie subtitles | https://github.com/google/fonts/tree/main/ofl/notosanssc — SIL Open Font License 1.1; unmodified font included |

License texts for the bundled JavaScript runtime, ws and font, and principal installed Python libraries/models are in `licenses/`. The application ZIP does not redistribute Python environments, Qt binaries, CUDA libraries or model weights. Setup obtains those dependencies from their upstream distributions, where the associated licenses continue to apply. Installed Python dependency versions are recorded in `asr/requirements-lock.txt`.

The original English demonstration text was written for FlowSub. The included QA sample at assets/sample.wav was generated locally with Windows Microsoft Zira Desktop (English, United States) speech synthesis. It is not a recording taken from another creator's livestream. The browser workbench and its prewritten demo interface have been removed. Current production capture uses project-authored ctypes WASAPI process-loopback integration; Microsoft's application-loopback documentation informed the API use.

Real-video QA uses the publisher-hosted NASA SDO science seminar (Karin Dissauer, 4 October 2023), https://sdo.gsfc.nasa.gov/mission/talks.php . The publisher recording and meeting transcript are downloaded into a private local QA cache. The release includes test scripts and a summary, not the recording, full reference transcript or captured full-session dialogue. The meeting transcript contains recognition errors and is not an accuracy gold standard.

Additional local QA uses NASA's 28-second archival Kennedy Rice University speech clip, https://www.nasa.gov/history/SP-4225/multimedia/before-video.htm . It is not included in the release. Whisper medium.en (Systran conversion, revision a29b04bd15381511a9af671baec01072039215e3, same Whisper MIT licence) was evaluated offline and was not selected for the default runtime. Historical v0.1.0 benchmarks used the official Qwen3-4B-GGUF and Whisper base.en; those earlier model configurations are identified in the historical benchmark document.

LiveTranslate was reviewed and cloned only for research; no LiveTranslate code is included in the distributed application. Other shortlisted repositories are references, not shipped dependencies. No Tripo-generated 3D assets are used and no Tripo tool track is claimed.
