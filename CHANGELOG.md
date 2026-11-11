# Changelog

All notable changes to **Inksight** (*Project Inksight*) are documented in this file.

## [v1.0.0] — Initial Public Open-Source Release

### Added
- **1-Click Windows `Setup.exe` Installer:** Self-contained 64-bit Windows installer bundling portable Node.js, `go2rtc`, `FFmpeg`, `SQLite`, `WinSW` pre-login 24/7 Windows Service (`InksightService`), and native C# System Tray agent (`Inksight.exe`).
- **Adaptive Dual-Stream 4K Live Matrix:** Unobstructed dedicated camera tile headers (`0%` video/OSD cover), sub-stream multi-camera grid streaming, and instant hot-swap to native 4K (`3840x2160`) on solo or fullscreen.
- **Direct-to-Disk 24/7 Recording & Forensic Timeline:** Zero-transcode MP4 segment recording (`0%` background GPU), circular disk quota & retention cleanup, segment locking, and HTTP 206 byte-range timeline scrubbing.
- **Bundled Multi-Model Offline YOLO11 AI Engine:** Ships with `YOLO11 Nano` (`yolo11n.onnx`), `YOLO11 Small` (`yolo11s.onnx`, default), and `YOLO11 Medium` (`yolo11m.onnx`) plus live switching between **CPU** and **Windows DirectML GPU** (NVIDIA, AMD, Intel).
- **High-Recall Object Tracking & Stationary Vehicle Suppression:** Frame-1 instant confirmation for people, pets, and moving vehicles; spatial-median night-IR/cloud illumination leveling; corner OSD timestamp mask; and smart parked-car suppression with `< 0.5s` departure alerts.
- **Visual Polygon Zone Studio & Instant Alerts:** Inclusion/exclusion polygon drawing over live camera feeds and instant snapshot/MP4 alerts via Telegram, Ntfy.sh, Pushover, SMTP Email, Webhooks, and local scripts.
- **Camera Auto-Discovery & Brand Presets:** 1-click LAN subnet scanner and built-in RTSP presets for Dahua/EmpireTech, Hikvision/Annke, Reolink, Amcrest/Lorex, TP-Link Tapo, and Generic ONVIF.
