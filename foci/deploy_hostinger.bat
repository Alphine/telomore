@echo off
REM Deploy Foci Lab (foci\web) to https://studylab.id on Hostinger.
REM Password SSH diminta 2 kali (upload, pasang).
REM Rebuild data dulu kalau perlu:  python scripts\build_foci_dataset.py

setlocal
cd /d "%~dp0"
set HOST=u808021404@153.92.10.184
set PORT=65002
set PKG=%TEMP%\focilab.tar.gz

if not exist "%~dp0web\index.html" (echo web\index.html tidak ditemukan & goto gagal)

echo === 1/3  Mengemas foci\web ...
del "%PKG%" 2>nul
tar -czf "%PKG%" -C "%~dp0web" .
if errorlevel 1 goto gagal

echo === 2/3  Upload ke Hostinger ...
scp -P %PORT% "%PKG%" %HOST%:focilab.tar.gz
if errorlevel 1 goto gagal

echo === 3/3  Memasang di public_html studylab.id dan cek ...
ssh -p %PORT% %HOST% "set -e; mkdir -p ~/domains/studylab.id/focilab_cache ~/domains/studylab.id/public_html; cd ~/domains/studylab.id/public_html; tar xzf ~/focilab.tar.gz; rm -f ~/focilab.tar.gz; find . -type d -exec chmod 755 {} +; find . -type f -exec chmod 644 {} +; echo; echo 'Halaman   :' $(curl -s -o /dev/null -w '%%{http_code}' https://studylab.id/); echo 'Data      :' $(curl -s -o /dev/null -w '%%{http_code}' https://studylab.id/data/summary.json); echo 'Proxy IDR :' $(curl -s -o /dev/null -w '%%{http_code} %%{content_type}' 'https://studylab.id/api/well.php?w=99_D14')"
if errorlevel 1 goto gagal

echo.
echo Selesai: https://studylab.id
echo (Proxy IDR harus 200 image/jpeg. Kalau 502, kirim outputnya ke Claude.)
pause
exit /b 0

:gagal
echo.
echo GAGAL - cek pesan di atas.
pause
exit /b 1
