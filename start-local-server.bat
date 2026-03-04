@echo off
setlocal

set PORT=5500
set ROOT=C:\Users\jacob\Downloads\js weather overlay

echo.
echo Starting local web server at http://localhost:%PORT%/index.html
echo Press Ctrl+C to stop the server.
echo.

if not exist "%ROOT%\index.html" (
    echo Could not find index.html at:
    echo %ROOT%
    pause
    exit /b 1
)

cd /d "%ROOT%"
echo Using folder: %CD%
echo.

where node >nul 2>&1
if %errorlevel%==0 (
    if exist "%ROOT%\local-server.js" (
        start "" "http://localhost:%PORT%/index.html"
        node local-server.js
        goto :eof
    )
)

where py >nul 2>&1
if %errorlevel%==0 (
    start "" "http://localhost:%PORT%/index.html"
    py -m http.server %PORT%
    goto :eof
)

where python >nul 2>&1
if %errorlevel%==0 (
    start "" "http://localhost:%PORT%/index.html"
    python -m http.server %PORT%
    goto :eof
)

echo Node.js and Python were not found.
echo Install Node.js or Python and run this file again.
echo.
echo Manual command:
echo cd /d "%ROOT%"
echo node local-server.js
echo or
echo py -m http.server %PORT%
pause
