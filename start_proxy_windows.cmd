@echo off
setlocal
set "BUNDLED_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%BUNDLED_PYTHON%" goto bundled
where py >nul 2>nul
if not errorlevel 1 goto launcher
where python >nul 2>nul
if not errorlevel 1 goto pathpython
echo Python 3 was not found. Install Python 3 and run this file again.
exit /b 1
:bundled
"%BUNDLED_PYTHON%" "%~dp0hls_proxy.py"
exit /b %errorlevel%
:launcher
py "%~dp0hls_proxy.py"
exit /b %errorlevel%
:pathpython
python "%~dp0hls_proxy.py"
exit /b %errorlevel%
