@echo off
REM Deploy ke https://studylab.id (Hostinger):
REM   /        Telomere Evolution Lab (build React statis, backend Python tetap di Railway)
REM   /foci/   Foci Lab (foci\web)
REM Password SSH diminta 2 kali (upload, pasang).

setlocal
cd /d "%~dp0"
set HOST=u808021404@153.92.10.184
set PORT=65002
set API=https://telomore-production.up.railway.app/api
set STAGE=%TEMP%\studylab_site
set PKG=%TEMP%\studylab_site.tar.gz

echo === 1/4  Build frontend Telomere Lab (API -> Railway) ...
pushd frontend
if not exist node_modules (call npm ci || (popd & goto gagal))
set VITE_API_BASE=%API%
call npm run build || (popd & goto gagal)
set VITE_API_BASE=
popd

echo === 2/4  Menyusun paket ...
if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%\foci"
xcopy /e /i /q /y "frontend\dist\*" "%STAGE%\" >nul || goto gagal
xcopy /e /i /q /y "foci\web\*" "%STAGE%\foci\" >nul || goto gagal
copy /y "deploy\studylab.htaccess" "%STAGE%\.htaccess" >nul || goto gagal
del "%PKG%" 2>nul
tar -czf "%PKG%" -C "%STAGE%" . || goto gagal

echo === 3/4  Upload ...
scp -P %PORT% "%PKG%" %HOST%:studylab_site.tar.gz || goto gagal

echo === 4/4  Pasang dan cek ...
ssh -p %PORT% %HOST% "set -e; D=~/domains/studylab.id; mkdir -p $D/focilab_cache; cd $D/public_html; find . -mindepth 1 -maxdepth 1 ! -name .well-known -exec rm -rf {} +; tar xzf ~/studylab_site.tar.gz; rm -f ~/studylab_site.tar.gz; find . -type d -exec chmod 755 {} +; find . -type f -exec chmod 644 {} +; echo; for p in / /simulate /demo.html /foci/ /foci/data/summary.json '/foci/api/well.php?w=99_D14'; do echo \"$p -> $(curl -s -o /dev/null -w '%%{http_code} %%{content_type}' https://studylab.id$p)\"; done"
if errorlevel 1 goto gagal

echo.
echo Selesai:  https://studylab.id   dan   https://studylab.id/foci/
pause
exit /b 0

:gagal
echo.
echo GAGAL - cek pesan di atas.
pause
exit /b 1
