@echo off
title Airbnb Scout
cd /d "%~dp0"
rem Pick up changes pushed from other computers (skipped quietly if offline or there are local edits).
where git >nul 2>nul
if %errorlevel%==0 if exist .git (
  echo Checking GitHub for updates...
  git pull --ff-only --quiet || echo Couldn't update from GitHub; starting the version on this PC.
)
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 server.py
) else (
  python server.py
)
if errorlevel 1 (
  echo.
  echo Airbnb Scout stopped with an error. See the message above.
  pause
)
