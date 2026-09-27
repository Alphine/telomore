<?php
// Caching image proxy: /api/well.php?w=<Plate_Well>  ->  JPEG composite from IDR.
//
// Only wells listed in ../data/well_index.json (IDR screen idr0010) are served,
// so this cannot be used as an open proxy. Each image is fetched from IDR once
// (public session cookie + the curators' display window per channel) and then
// served from the cache directory below. Images: Doil et al. 2009 via IDR idr0010, CC BY 4.0.

declare(strict_types=1);
ini_set('display_errors', '0');

const IDR = 'https://idr.openmicroscopy.org';
const UA = 'FociLab/1.0 (+https://studylab.id; companion to github.com/Alphine/telomore)';
// Cache lives OUTSIDE the web root (public_html/api -> ../../focilab_cache) so the
// IDR cookie jar and cached files can never be requested directly.
$CACHE = dirname(__DIR__, 2) . '/focilab_cache';

function fail(int $code, string $msg): void {
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    echo $msg;
    exit;
}

$w = $_GET['w'] ?? '';
if (!preg_match('/^[0-9A-Za-z-]{1,12}_[A-P][0-9]{1,2}$/', $w)) fail(400, 'bad well id');

$index = json_decode((string) @file_get_contents(__DIR__ . '/../data/well_index.json'), true);
if (!is_array($index)) fail(500, 'index unavailable');
if (!isset($index[$w])) fail(404, 'well not imaged in IDR');
$iid = (int) $index[$w];

if (!is_dir($CACHE)) @mkdir($CACHE, 0755, true);
$file = "$CACHE/$iid.jpg";

function serve(string $file): void {
    header('Content-Type: image/jpeg');
    header('Cache-Control: public, max-age=2592000, immutable');
    header('Content-Length: ' . filesize($file));
    readfile($file);
    exit;
}
if (is_file($file) && filesize($file) > 1000) serve($file);

function get(string $url, string $jar): string {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 25,
        CURLOPT_USERAGENT => UA, CURLOPT_COOKIEJAR => $jar, CURLOPT_COOKIEFILE => $jar,
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    if ($body === false || $code !== 200) throw new RuntimeException("IDR HTTP $code");
    return (string) $body;
}

try {
    $jar = "$CACHE/idr_cookies.txt";
    if (!is_file($jar) || time() - filemtime($jar) > 3600) {
        get(IDR . '/webclient/?experimenter=-1', $jar);
    }
    $meta = json_decode(get(IDR . "/webgateway/imgData/$iid/", $jar), true);
    $ch = $meta['channels'] ?? [];
    if (count($ch) < 2) fail(502, 'unexpected image metadata');
    $colors = ['0000FF', '00FF00'];
    $parts = [];
    for ($i = 0; $i < 2; $i++) {
        $win = $ch[$i]['window'];
        $parts[] = ($i + 1) . '|' . (int) $win['start'] . ':' . (int) $win['end'] . '$' . $colors[$i];
    }
    $jpg = get(IDR . "/webgateway/render_image/$iid/0/0/?c=" . rawurlencode(implode(',', $parts)) . '&m=c&q=0.9', $jar);
    if (strlen($jpg) < 1000) fail(502, 'empty image from IDR');
    $tmp = "$file.tmp" . getmypid();
    file_put_contents($tmp, $jpg);
    rename($tmp, $file);
    serve($file);
} catch (Throwable $e) {
    fail(502, 'IDR unavailable: ' . $e->getMessage());
}
