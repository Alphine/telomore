<?php
// Wells of one idr0010 plate, from data/well_index.json only (no IDR access).
//
//   /api/plate.php?plate=7-14  ->  {"plate","wells":[{"well":"A1","plate_well":"7-14_A1","image_id":N},...],"n","rows","cols","quota":{...}}
//
// The plate name is validated strictly and then looked up in the index: unknown plates are 404, nothing user-supplied
// reaches a file name or URL. Wells are ordered column by column (A1, B1, ... L1, A2, ...), the order in which the
// image grid is numbered. rows/cols are the extent of this plate's wells (A-L x 1-32 for idr0010).
// Contract: docs/API.md ("Plate endpoint (plate.php)").

declare(strict_types=1);
ini_set('display_errors', '0');
define('FOCI_API', 1);
require __DIR__ . '/_lib.php';

require_get_head();
$plate = $_GET['plate'] ?? null;
if (!valid_plate_name($plate)) fail(400, 'bad plate');
$idx = load_well_index();
if ($idx === null) fail(500, 'index unavailable');

$prefix = $plate . '_';
$wells = [];
$rows = 0; $cols = 0;
foreach ($idx as $k => $iid) {
    $k = (string) $k;
    if (strncmp($k, $prefix, strlen($prefix)) !== 0 || !is_int($iid) || $iid <= 0) continue;
    $sp = split_plate_well($k);
    if ($sp === null || $sp[0] !== $plate) continue;
    [, $well, $r, $c] = $sp;
    $wells[] = [$c, $r, $well, $k, $iid];
    if ($r + 1 > $rows) $rows = $r + 1;
    if ($c + 1 > $cols) $cols = $c + 1;
}
if (!$wells) fail(404, 'plate not imaged in IDR', ['Cache-Control: public, max-age=3600']);
usort($wells, static fn($a, $b) => [$a[0], $a[1]] <=> [$b[0], $b[1]]);

$cfg = foci_cfg();
$out = [
    'plate' => $plate,
    'wells' => array_map(static fn($w) => ['well' => $w[2], 'plate_well' => $w[3], 'image_id' => $w[4]], $wells),
    'n' => count($wells),
    'rows' => $rows,
    'cols' => $cols,
    'quota' => [
        'requests_per_plate' => 2 * count($wells),         // dna + foci channel of every well
        'cached_responses_per_min' => $cfg['hit_per_min'],
        'uncached_responses_per_min' => $cfg['miss_per_min'],
        'uncached_responses_per_day' => $cfg['miss_per_day'],
        'note' => 'per client address; an image is fetched from IDR once and then served from our cache',
    ],
];
$body = (string) json_encode($out, JSON_UNESCAPED_SLASHES);
$etag = '"p' . substr(sha1($plate . '|' . (string) @filemtime(__DIR__ . '/../data/well_index.json') . '|' . $body), 0, 20) . '"';
header('ETag: ' . $etag);
header('Cache-Control: public, max-age=3600');
header('X-Content-Type-Options: nosniff');
if (etag_matches($etag)) { http_response_code(304); exit; }
header('Content-Type: application/json; charset=utf-8');
header('Content-Length: ' . strlen($body));
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') echo $body;
