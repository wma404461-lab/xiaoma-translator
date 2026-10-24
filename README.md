# Xiaoma Translator - FlowSub

A Windows tool for live English-audio transcription and Chinese subtitles, with an English application interface. Package version: 0.2.0. The subtitle target remains Chinese; interface localization does not silently change the translation model's purpose.

## Run from source

Requires Windows 10/11, Node.js 22+ and Python 3.12. Install JavaScript dependencies, run `setup-local.ps1` to prepare Python and local models, then use `Start-FlowSub.cmd`. Model downloads need several GB of storage. Read the setup scripts before running them; weights and Python environments are not included.

`npm test` runs the Node regression suite. `npm run check` checks server module syntax. The source edition passed 114 Node regressions before interface localization. GPU performance, models, system-audio capture and the desktop subtitle window require separate device-level verification.

WASAPI process-loopback capture follows the selected audio-producing application. Browser tabs may share a process; this is not per-tab isolation. Configure your own update service before distributing a fork. Only the public verification key is included, with no signing keys, private audio, subtitle history or test videos.

## Licensing and scope

Application source retains GPL-3.0. Speech/translation models and dependencies are not original work of this project; see `THIRD_PARTY_NOTICES.md` and `licenses/`. Noto Sans SC is included under SIL OFL in `assets/fonts/OFL.txt` for the subtitle content.

Deployment scripts, logs, upstream research clones, model weights, historical backups and private training experiments are excluded. Synthetic test tokens and example domains are fixtures. The optional model mirror certificate is not included, so preparation falls back to official upstream sources. Interface language is English; imported/user-generated subtitle text retains its original language.
