<?php
// Command-line cache trim (for cron): php api/cache_gc.php  -> prints JSON stats. Refuses web requests.
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
define('FOCI_API', 1);
require __DIR__ . '/_lib.php';
echo json_encode(cache_cleanup(foci_cfg())), "\n";
