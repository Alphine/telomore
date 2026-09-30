<?php
// Caching image proxy for IDR idr0010 wells (Foci Lab).
//
//   /api/well.php?w=<Plate_Well>                 coloured composite JPEG (DNA blue, 53BP1 green)
//   /api/well.php?w=<Plate_Well>&ch=dna|foci     one channel, 8-bit grey rendering, PNG
//   /api/well.php?w=<Plate_Well>&info=1          JSON: size, pixel size, channel labels, IDR link
//
// Only wells listed in ../data/well_index.json (IDR screen idr0010) are served,
// so this cannot be used as an open proxy: the only remote host is IDR, the only
// remote paths are fixed templates, and the only variable part is an integer image
// id taken from that index. Each variant is fetched from IDR once (public session
// cookie + the curators' display window per channel) and then served from the cache
// directory. Images: Doil et al. 2009 via IDR idr0010, CC BY 4.0.
// Contract documented in docs/API.md ("well.php").

declare(strict_types=1);
ini_set('display_errors', '0');
set_time_limit(90);

const UA = 'FociLab/1.0 (+https://studylab.id; companion to github.com/Alphine/telomore)';
const MAX_BYTES = 16 * 1024 * 1024;
const STUDY_PIXEL_SIZE_UM = 0.465;   // idr0010 protocol: 'optical resolution of 0.465 um/pixel'

// IDR host. Overridable ONLY for local tests: needs FOCI_ALLOW_TEST_BASE=1 and a
// loopback http(s) base; otherwise the constant is used and the variable ignored.
function idr_base(): string {
    $default = 'https://idr.openmicroscopy.org';
    if (getenv('FOCI_ALLOW_TEST_BASE') === '1') {
        $b = getenv('FOCI_IDR_BASE');
        if (is_string($b) && preg_match('#^https?://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$#', $b)) return $b;
    }
    return $default;
}
$IDR = idr_base();

// Cache lives OUTSIDE the web root (next to public_html) so the IDR cookie jar
// and cached files can never be requested directly, wherever this site is mounted.
$DOCROOT = rtrim(str_replace('\\', '/', (string) ($_SERVER['DOCUMENT_ROOT'] ?? '')), '/');
if ($DOCROOT === '') $DOCROOT = dirname(__DIR__, 2);
$CACHE = dirname($DOCROOT) . '/focilab_cache';

function fail(int $code, string $msg, array $extra = []): void {
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    foreach ($extra as $h) header($h);
    echo $msg;
    exit;
}

$method = (string) ($_SERVER['REQUEST_METHOD'] ?? 'GET');
if ($method !== 'GET' && $method !== 'HEAD') fail(405, 'method not allowed', ['Allow: GET, HEAD']);

// ---- input validation: strict types, documented values only ----------------
$w = $_GET['w'] ?? null;
if (!is_string($w) || !preg_match('/^[0-9A-Za-z-]{1,12}_[A-P][0-9]{1,2}$/D', $w)) fail(400, 'bad well id');

$ch = $_GET['ch'] ?? null;
$info = $_GET['info'] ?? null;
if ($ch !== null && (!is_string($ch) || !in_array($ch, ['dna', 'foci'], true))) fail(400, 'bad ch (use dna or foci)');
if ($info !== null && $info !== '1') fail(400, 'bad info (use 1)');
if ($ch !== null && $info !== null) fail(400, 'use either ch or info, not both');
$variant = $info !== null ? 'info' : ($ch ?? 'composite');

$raw = @file_get_contents(__DIR__ . '/../data/well_index.json');
$index = is_string($raw) ? json_decode($raw, true) : null;
if (!is_array($index)) fail(500, 'index unavailable');
if (!isset($index[$w]) || !is_int($index[$w]) || $index[$w] <= 0) fail(404, 'well not imaged in IDR');
$iid = $index[$w];   // integer from our own index: the only variable in any path or URL below

if (!is_dir($CACHE) && !@mkdir($CACHE, 0755, true) && !is_dir($CACHE)) fail(500, 'cache unavailable');

// file name from an integer and a fixed suffix only; never from user input
$files = ['composite' => "$CACHE/$iid.jpg", 'dna' => "$CACHE/$iid.dna.png", 'foci' => "$CACHE/$iid.foci.png", 'info' => "$CACHE/$iid.info.json"];
$file = $files[$variant];

function serve(string $file, string $type, string $cache): void {
    $size = @filesize($file);
    header('Content-Type: ' . $type);
    header('Cache-Control: ' . $cache);
    header('X-Content-Type-Options: nosniff');
    if ($size !== false) header('Content-Length: ' . $size);
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') readfile($file);
    exit;
}

const IMMUTABLE = 'public, max-age=2592000, immutable';
const DAY = 'public, max-age=86400';

function looks_ok(string $variant, string $file): bool {
    if (!is_file($file)) return false;
    $n = (int) filesize($file);
    if ($variant === 'info') return $n > 20;
    return $n > 1000;
}
function serve_variant(string $variant, string $file): void {
    if ($variant === 'info') serve_info($file);
    if ($variant === 'composite') serve($file, 'image/jpeg', IMMUTABLE);
    serve($file, 'image/png', IMMUTABLE);
}

/** Public subset of the cached metadata record. */
function serve_info(string $file): void {
    $rec = json_decode((string) @file_get_contents($file), true);
    if (!is_array($rec)) fail(502, 'cached metadata unreadable');
    $out = [
        'well' => $GLOBALS['w'],
        'image_id' => $rec['image_id'],
        'size_x' => $rec['size_x'],
        'size_y' => $rec['size_y'],
        'pixel_size_um' => $rec['pixel_size_um'],
        'pixel_size_source' => $rec['pixel_size_source'] ?? null,
        'channels' => $rec['channels'],
        'idr_url' => 'https://idr.openmicroscopy.org/webclient/?show=image-' . (int) $rec['image_id'],
    ];
    $body = json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: ' . DAY);
    header('X-Content-Type-Options: nosniff');
    header('Content-Length: ' . strlen((string) $body));
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') echo $body;
    exit;
}

if (looks_ok($variant, $file)) serve_variant($variant, $file);

// ---- fetch from IDR --------------------------------------------------------
function http_get(string $url, ?string $cookieRead, ?string $cookieWrite = null): string {
    $ch = curl_init($url);
    $opts = [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 3,
        CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => 25, CURLOPT_USERAGENT => UA,
        CURLOPT_MAXFILESIZE => MAX_BYTES, CURLOPT_FAILONERROR => false,
    ];
    if (getenv('FOCI_ALLOW_TEST_BASE') !== '1') {   // production: HTTPS only, also across redirects
        $opts[CURLOPT_PROTOCOLS] = CURLPROTO_HTTPS;
        $opts[CURLOPT_REDIR_PROTOCOLS] = CURLPROTO_HTTPS;
    }
    if ($cookieRead !== null && is_file($cookieRead)) $opts[CURLOPT_COOKIEFILE] = $cookieRead;
    if ($cookieWrite !== null) $opts[CURLOPT_COOKIEJAR] = $cookieWrite;
    curl_setopt_array($ch, $opts);
    $body = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($body === false || $code !== 200) throw new RuntimeException("IDR HTTP $code");
    if (strlen($body) > MAX_BYTES) throw new RuntimeException('IDR response too large');
    return $body;
}

/** Atomic publish: write a private temp file, then rename over the target. */
function store(string $file, string $data): void {
    $tmp = $file . '.tmp' . bin2hex(random_bytes(6));
    if (@file_put_contents($tmp, $data, LOCK_EX) !== strlen($data)) { @unlink($tmp); throw new RuntimeException('cache write failed'); }
    if (!@rename($tmp, $file)) { @unlink($tmp); throw new RuntimeException('cache rename failed'); }
}

try {
    $jar = "$CACHE/idr_cookies.txt";
    if (!is_file($jar) || time() - (int) filemtime($jar) > 3600) {
        $tmpJar = $jar . '.tmp' . bin2hex(random_bytes(6));
        try {
            http_get("$IDR/webclient/?experimenter=-1", null, $tmpJar);   // jar is written only here
            if (!@rename($tmpJar, $jar)) throw new RuntimeException('cookie jar rename failed');
        } finally {
            if (is_file($tmpJar)) @unlink($tmpJar);
        }
    }

    // metadata: fetched and validated once per image, cached as a small JSON record
    $metaFile = $files['info'];
    $rec = looks_ok('info', $metaFile) ? json_decode((string) @file_get_contents($metaFile), true) : null;
    if (!is_array($rec) || !isset($rec['windows'])) {
        $meta = json_decode(http_get("$IDR/webgateway/imgData/$iid/", $jar), true);
        $chs = is_array($meta) ? ($meta['channels'] ?? null) : null;
        $sx = $meta['size']['width'] ?? null;
        $sy = $meta['size']['height'] ?? null;
        if (!is_array($chs) || count($chs) < 2 || !is_int($sx) || !is_int($sy) || $sx < 1 || $sy < 1) fail(502, 'unexpected image metadata');
        $wins = [];
        $labels = [];
        foreach (array_values($chs) as $i => $c) {
            $win = is_array($c) ? ($c['window'] ?? null) : null;
            if (!is_array($win) || !is_numeric($win['start'] ?? null) || !is_numeric($win['end'] ?? null)) fail(502, 'unexpected image metadata');
            $wins[] = [(int) $win['start'], (int) $win['end']];
            $lab = is_string($c['label'] ?? null) ? trim((string) preg_replace('/[ -]/', '', $c['label'])) : '';
            // at most 80 characters, valid UTF-8 only (no mbstring needed)
            $labels[] = ($lab !== '' && preg_match('/^.{1,80}/us', $lab, $m)) ? $m[0] : 'Channel ' . ($i + 1);
        }
        // Pixel size. IDR reports the OMERO nominal default 1.0 um for every idr0010 image, which is NOT
        // the acquisition scale; the study protocol states an optical resolution of 0.465 um/pixel (Zeiss
        // Axiovert 200, 20x/0.8, CoolSNAP HQ). A calibrated value from IDR (anything other than the
        // default 1.0) still wins; otherwise the documented study value is used and labelled as such.
        $px = $meta['pixel_size']['x'] ?? null;
        $pxOk = (is_int($px) || is_float($px)) && is_finite((float) $px) && $px > 0;
        if ($pxOk && abs((float) $px - 1.0) > 1e-9) { $pxUm = (float) $px; $pxSrc = 'idr'; }
        else { $pxUm = STUDY_PIXEL_SIZE_UM; $pxSrc = 'idr0010 study protocol (IDR reports the nominal default 1.0)'; }
        $rec = [
            'image_id' => $iid, 'size_x' => $sx, 'size_y' => $sy,
            'pixel_size_um' => $pxUm, 'pixel_size_source' => $pxSrc,
            'channels' => $labels, 'windows' => $wins,
        ];
        store($metaFile, (string) json_encode($rec, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    }
    if ($variant === 'info') serve_info($metaFile);

    $win = $rec['windows'];
    $range = static fn(int $i): string => $win[$i][0] . ':' . $win[$i][1];
    if ($variant === 'composite') {
        $c = '1|' . $range(0) . '$0000FF,2|' . $range(1) . '$00FF00';
        $q = 'c=' . rawurlencode($c) . '&m=c&q=0.9';
        $mime = 'image/jpeg'; $sig = "\xFF\xD8\xFF";
    } else {
        $i = $variant === 'dna' ? 0 : 1;
        $c = ($i + 1) . '|' . $range($i) . '$FFFFFF';
        $q = 'c=' . rawurlencode($c) . '&m=g&format=png';
        $mime = 'image/png'; $sig = "\x89PNG";
    }
    $img = http_get("$IDR/webgateway/render_image/$iid/0/0/?$q", $jar);
    if (strlen($img) < 1000 || strncmp($img, $sig, strlen($sig)) !== 0) fail(502, 'empty or invalid image from IDR');
    store($file, $img);
    serve($file, $mime, IMMUTABLE);
} catch (Throwable $e) {
    error_log('well.php: ' . get_class($e) . ': ' . $e->getMessage());   // server log only, never the response
    fail(502, 'IDR unavailable');
}
