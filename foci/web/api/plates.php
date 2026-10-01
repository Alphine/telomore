<?php
// List of imaged idr0010 plates with their well counts, from data/well_index_byname.json only (the IDR image grid; no IDR access).
//   /api/plates.php -> {"plates":[{"plate":"7-14","wells":384},...],"n":148}
// Sorted by plate name in natural order (5-12 before 100-27). Contract: docs/API.md ("Plate endpoint (plate.php)").

declare(strict_types=1);
ini_set('display_errors', '0');
define('FOCI_API', 1);
require __DIR__ . '/_lib.php';

require_get_head();
$idx = load_well_index('name');
if ($idx === null) fail(500, 'index unavailable');
$counts = [];
foreach ($idx as $k => $iid) {
    $sp = split_plate_well((string) $k);
    if ($sp === null || !is_int($iid) || $iid <= 0) continue;
    $counts[$sp[0]] = ($counts[$sp[0]] ?? 0) + 1;
}
uksort($counts, 'strnatcmp');
$plates = [];
foreach ($counts as $p => $n) $plates[] = ['plate' => (string) $p, 'wells' => $n];
$body = (string) json_encode(['plates' => $plates, 'n' => count($plates)], JSON_UNESCAPED_SLASHES);
$etag = '"l' . substr(sha1((string) @filemtime(__DIR__ . '/../data/well_index_byname.json') . $body), 0, 20) . '"';
header('ETag: ' . $etag);
header('Cache-Control: public, max-age=86400');
header('X-Content-Type-Options: nosniff');
if (etag_matches($etag)) { http_response_code(304); exit; }
header('Content-Type: application/json; charset=utf-8');
header('Content-Length: ' . strlen($body));
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') echo $body;
