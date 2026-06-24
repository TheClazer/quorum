@echo off
title Quorum
REM Portable launcher - run from anywhere the repo is cloned.
REM All the logic (free port, first-run install/build, verify, open browser) is in Quorum.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Quorum.ps1"
if errorlevel 1 (
  echo.
  echo   The launcher reported a problem ^(details above^).
  echo.
  pause
)
