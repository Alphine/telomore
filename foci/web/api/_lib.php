<?php
// Shared helpers for the Foci Lab API (well.php, plate.php, plates.php, cache_gc.php).
//
// Not an endpoint: requesting this file directly does nothing (and .htaccess forbids it).
// Contents: configuration (env > focilab_config.php > defaults), client identification, an
// atomic on-disk token-bucket limiter, the site-wide IDR politeness throttle (request rate +
// concurrent fetches), the cache size guard (LRU by mtime) and small HTTP helpers.
// Everything is documented in docs/API.md ("Plate endpoint (plate.php)") and foci/docs/SCREEN_MODE.md.

declare(strict_types=1);

if (!defined('FOCI_API')) { http_response_code(404); exit; }

/** Thrown when a throttle refuses; the endpoint turns it into 429/503 + Retry-After. */
final class Refused extends RuntimeException {
    public function __construct(public int $status, string $msg, public int $retryAfter) { parent::__construct($msg); }
}

// ---- configuration -----------------------------------------------------------------------------
// name => [env var, default, min, max]. Numbers are clamped so a typo cannot disable a guard by overflow.
const FOCI_CFG = [
    'hit_per_min'     => ['FOCI_HIT_PER_MIN',     1200,        1,    1000000],   // cached responses per IP and minute (burst = same)
    'miss_per_min'    => ['FOCI_MISS_PER_MIN',    60,          1,    100000],    // responses that need IDR, per IP and minute
    'miss_per_day'    => ['FOCI_MISS_PER_DAY',    2000,        1,    10000000],  // same, per IP and day (token bucket, refills continuously)
    'idr_rate'        => ['FOCI_IDR_RATE',        3,           0.1,  1000],      // requests per second to IDR, whole site
    'idr_burst'       => ['FOCI_IDR_BURST',       6,           1,    1000],
    'idr_concurrency' => ['FOCI_IDR_CONCURRENCY', 3,           1,    64],        // simultaneous IDR fetches, whole site
    'idr_wait_ms'     => ['FOCI_IDR_WAIT_MS',     2500,        0,    60000],     // longest a request waits for an IDR rate token before 503
    'cache_max_bytes' => ['FOCI_CACHE_MAX_BYTES', 1500000000,  0,    10000000000000], // 0 = no size guard
    'cleanup_prob'    => ['FOCI_CLEANUP_PROB',    0.02,        0,    1],         // chance that a cache miss triggers the LRU cleanup
    'evict_grace_s'   => ['FOCI_EVICT_GRACE_S',   120,         0,    86400],     // files touched this recently are never evicted
];

function foci_cfg(): array {
    static $cfg = null;
    if ($cfg !== null) return $cfg;
    $file = [];
    $real = dirname(foci_cache_dir()) . '/focilab_config.php';   // next to the cache, outside the web root
    if (is_file($real)) {
        $r = (static function (string $f) { return include $f; })($real);
        if (is_array($r)) $file = $r;
    }
    $cfg = [];
    foreach (FOCI_CFG as $k => [$env, $def, $min, $max]) {
        $v = getenv($env);
        if ($v === false || $v === '') $v = $file[$k] ?? $def;
        $n = is_numeric($v) ? (float) $v : (float) $def;
        if (!is_finite($n)) $n = (float) $def;
        $n = max((float) $min, min((float) $max, $n));
        $cfg[$k] = is_int($def) ? (int) round($n) : $n;
    }
    $tp = getenv('FOCI_TRUSTED_PROXIES');
    if ($tp === false || $tp === '') $tp = (string) ($file['trusted_proxies'] ?? '');
    $cfg['trusted_proxies'] = array_values(array_filter(array_map('trim', explode(',', (string) $tp)), static fn($s) => filter_var($s, FILTER_VALIDATE_IP) !== false));
    return $cfg;
}

/** Cache directory: OUTSIDE the web root (next to public_html). */
function foci_cache_dir(): string {
    static $dir = null;
    if ($dir !== null) return $dir;
    $env = getenv('FOCI_CACHE_DIR');            // explicit location (cron / CLI, where there is no DOCUMENT_ROOT)
    if (is_string($env) && preg_match('#^(/|[A-Za-z]:[\\\\/])#', $env)) return $dir = rtrim(str_replace('\\', '/', $env), '/');
    $docroot = rtrim(str_replace('\\', '/', (string) ($_SERVER['DOCUMENT_ROOT'] ?? '')), '/');
    if ($docroot === '') $docroot = dirname(__DIR__, 2);
    return $dir = dirname($docroot) . '/focilab_cache';
}

// ---- tiny HTTP helpers -------------------------------------------------------------------------
function fail(int $code, string $msg, array $extra = []): void {
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    foreach ($extra as $h) header($h);
    echo $msg;
    exit;
}

function fail_refused(Refused $r, array $extra = []): void {
    $extra[] = 'Retry-After: ' . max(1, min(86400, $r->retryAfter));
    fail($r->status, $r->getMessage(), $extra);
}

/** Only GET and HEAD are served. */
function require_get_head(): void {
    $m = (string) ($_SERVER['REQUEST_METHOD'] ?? 'GET');
    if ($m !== 'GET' && $m !== 'HEAD') fail(405, 'method not allowed', ['Allow: GET, HEAD']);
}

/** True when If-None-Match matches the strong or weak form of $etag (quoted). */
function etag_matches(string $etag): bool {
    $h = $_SERVER['HTTP_IF_NONE_MATCH'] ?? '';
    if (!is_string($h) || $h === '') return false;
    if (trim($h) === '*') return true;
    foreach (explode(',', $h) as $t) {
        $t = trim($t);
        if (strncmp($t, 'W/', 2) === 0) $t = substr($t, 2);
        if ($t === $etag) return true;
    }
    return false;
}

function finish_response(): void {
    if (function_exists('fastcgi_finish_request')) @fastcgi_finish_request();
    elseif (function_exists('litespeed_finish_request')) @litespeed_finish_request();
}

// ---- client identity ---------------------------------------------------------------------------
/** Hashed client key. Only REMOTE_ADDR is trusted, unless it is one of FOCI_TRUSTED_PROXIES (then X-Forwarded-For, right to left). */
function foci_client_key(array $cfg): string {
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    if (filter_var($ip, FILTER_VALIDATE_IP) === false) return 'unknown';
    if ($cfg['trusted_proxies'] && in_array($ip, $cfg['trusted_proxies'], true)) {
        $xff = (string) ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '');
        $hops = array_reverse(array_map('trim', explode(',', $xff)));
        foreach ($hops as $h) {
            if (filter_var($h, FILTER_VALIDATE_IP) === false) break;       // garbage: stop, keep the proxy's own address
            $ip = $h;
            if (!in_array($h, $cfg['trusted_proxies'], true)) break;       // first untrusted hop from the right = the client
        }
    }
    $bin = @inet_pton($ip);
    if ($bin === false) return 'unknown';
    if (strlen($bin) === 16) $bin = substr($bin, 0, 8);                     // IPv6: one /64 is one client
    return substr(hash('sha256', 'foci1|' . bin2hex($bin)), 0, 24);
}

// ---- atomic token buckets ------------------------------------------------------------------------
/**
 * All-or-nothing take from several buckets that share one file (one line: "<ts> <tokens...>"); with $only, from that bucket alone.
 * $specs: list of [capacity, refill_per_second]. $cost: tokens per bucket. $consume=false only looks.
 * Returns ['ok'=>bool, 'retry'=>seconds until it would succeed, 'left'=>[tokens per bucket], 'error'=>bool].
 * Clock skew: a stored timestamp in the future is treated as "now"; negative elapsed time never adds tokens.
 */
function buckets_take(string $file, array $specs, float $cost = 1.0, bool $consume = true, ?int $only = null): array {
    $n = count($specs);
    $fh = @fopen($file, 'c+');
    if ($fh === false) return ['ok' => true, 'retry' => 0, 'left' => array_fill(0, $n, 0.0), 'error' => true];
    try {
        if (!flock($fh, $consume ? LOCK_EX : LOCK_SH)) return ['ok' => true, 'retry' => 0, 'left' => array_fill(0, $n, 0.0), 'error' => true];
        $now = microtime(true);
        $parts = preg_split('/\s+/', trim((string) stream_get_contents($fh))) ?: [];
        $ts = isset($parts[0]) && is_numeric($parts[0]) ? (float) $parts[0] : null;
        $tok = [];
        foreach ($specs as $i => [$cap, $rate]) {
            $t = ($ts !== null && isset($parts[$i + 1]) && is_numeric($parts[$i + 1])) ? (float) $parts[$i + 1] : (float) $cap;
            if ($ts !== null) {
                $el = $ts > $now ? 0.0 : $now - $ts;
                $t += $el * $rate;
            }
            $tok[$i] = is_finite($t) ? max(0.0, min((float) $cap, $t)) : (float) $cap;
        }
        $ok = true; $retry = 0.0;
        foreach ($specs as $i => [$cap, $rate]) {
            if ($only !== null && $i !== $only) continue;       // untouched buckets still get their refill
            if ($tok[$i] + 1e-9 < $cost) { $ok = false; $retry = max($retry, ($cost - $tok[$i]) / max($rate, 1e-9)); }
        }
        if ($ok && $consume) foreach ($tok as $i => $_) if ($only === null || $i === $only) $tok[$i] = min((float) $specs[$i][0], $tok[$i] - $cost);   // a negative cost refunds
        if ($consume) {     // persist also on refusal (refill is accounted for), so ts always advances
            ftruncate($fh, 0); rewind($fh);
            fwrite($fh, sprintf('%.4f', $now) . ' ' . implode(' ', array_map(static fn($t) => sprintf('%.4f', $t), $tok)));
            fflush($fh);
        }
        return ['ok' => $ok, 'retry' => $retry, 'left' => $tok, 'error' => false];
    } finally {
        @flock($fh, LOCK_UN);
        fclose($fh);
    }
}

function foci_dir(string $sub): string {
    $d = foci_cache_dir() . '/' . $sub;
    if (!is_dir($d) && !@mkdir($d, 0755, true) && !is_dir($d)) throw new RuntimeException("cannot create $sub");
    return $d;
}

/** Per-client limiter bucket specs: [0] = all responses, [1] = per-minute misses, [2] = per-day misses. */
function client_specs(array $cfg): array {
    return [
        [$cfg['hit_per_min'],  $cfg['hit_per_min'] / 60.0],
        [$cfg['miss_per_min'], $cfg['miss_per_min'] / 60.0],
        [$cfg['miss_per_day'], $cfg['miss_per_day'] / 86400.0],
    ];
}

/**
 * Charge one request to this client. A hit costs one "response" token; a miss also costs one minute-miss
 * and one day-miss token (all-or-nothing). Throws Refused(429). Fails open if the limiter files are unusable
 * for a hit (hits cost nothing upstream) and closed for a miss.
 */
function charge_client(array $cfg, bool $miss): array {
    $specs = client_specs($cfg);
    try {
        $file = foci_dir('_rl') . '/c_' . foci_client_key($cfg);
    } catch (Throwable $e) {
        if ($miss) throw new Refused(503, 'rate limiter unavailable', 10);
        return [];
    }
    // a hit spends only the response bucket; a miss spends all three (all-or-nothing)
    $r = buckets_take($file, $specs, 1.0, true, $miss ? null : 0);
    if ($r['error'] && $miss) throw new Refused(503, 'rate limiter unavailable', 10);
    if (!$r['ok']) throw new Refused(429, $miss ? 'too many uncached images requested; slow down' : 'too many requests; slow down', (int) ceil($r['retry']));
    return $r['left'];
}

/** Give back a miss charge when the request was then refused before it could use IDR (503): the client is not billed for our saturation. */
function refund_client(array $cfg): void {
    try { $file = foci_dir('_rl') . '/c_' . foci_client_key($cfg); } catch (Throwable $e) { return; }
    buckets_take($file, client_specs($cfg), -1.0);
}

/** Remaining tokens for this client without charging (for plate.php / headers). */
function peek_client(array $cfg): ?array {
    try { $file = foci_dir('_rl') . '/c_' . foci_client_key($cfg); } catch (Throwable $e) { return null; }
    $r = buckets_take($file, client_specs($cfg), 1.0, false);
    return $r['error'] ? null : $r['left'];
}

// ---- site-wide politeness to IDR -------------------------------------------------------------------
/** Hold one of the K concurrent-fetch slots for the rest of the request (released when the process ends, even on a crash). */
function idr_slot_acquire(array $cfg): void {
    static $held = [];
    try { $dir = foci_dir('_idr'); } catch (Throwable $e) { throw new Refused(503, 'throttle unavailable', 10); }
    for ($i = 0; $i < $cfg['idr_concurrency']; $i++) {
        $fh = @fopen("$dir/slot$i", 'c');
        if ($fh !== false && flock($fh, LOCK_EX | LOCK_NB)) { $held[] = $fh; return; }
        if ($fh !== false) fclose($fh);
    }
    throw new Refused(503, 'IDR is being asked for as much as we allow; try again shortly', 3);
}

/** Wait for a global IDR request token (rate R/s, burst B). Gives up with Refused(503) after idr_wait_ms. */
function idr_pace(array $cfg, float $deadline): void {
    try { $file = foci_dir('_idr') . '/rate'; } catch (Throwable $e) { throw new Refused(503, 'throttle unavailable', 10); }
    $spec = [[$cfg['idr_burst'], $cfg['idr_rate']]];
    while (true) {
        $r = buckets_take($file, $spec);
        if ($r['error']) throw new Refused(503, 'throttle unavailable', 10);
        if ($r['ok']) return;
        $wait = $r['retry'];
        if (microtime(true) + $wait > $deadline) throw new Refused(503, 'IDR is being asked for as much as we allow; try again shortly', (int) ceil($wait) + 1);
        usleep((int) max(1000, $wait * 1e6));
    }
}

/** Serialise concurrent misses for the same image (they would fetch the same thing); 64 lock files, no growth. */
function single_flight(int $iid, float $maxWait = 25.0): mixed {
    $fh = @fopen(foci_dir('_locks') . '/' . ($iid % 64), 'c');
    if ($fh === false) return null;
    $end = microtime(true) + $maxWait;
    while (!flock($fh, LOCK_EX | LOCK_NB)) {
        if (microtime(true) > $end) { fclose($fh); throw new Refused(503, 'busy; try again shortly', 2); }
        usleep(40000);
    }
    return $fh;   // released at process end
}

// ---- cache size guard (LRU by mtime) ----------------------------------------------------------------
const MANAGED_RE = '/^[0-9]{1,12}\.(?:jpg|dna\.png|foci\.png|info\.json)$/D';

/**
 * Keep the managed cache files under $cfg['cache_max_bytes']: when over, delete least-recently-used files
 * (mtime; hits touch it) until 90% of the cap. Never touches the cookie jar, sub-directories, or anything that
 * is not "<imageid>.<variant>"; never deletes a file touched within evict_grace_s (may be serving now).
 * Also removes orphaned temp files older than 15 min and limiter files older than 2 days. One cleaner at a time.
 * Returns stats (for the CLI / tests).
 */
function cache_cleanup(array $cfg): array {
    $dir = foci_cache_dir();
    $stats = ['scanned' => 0, 'bytes' => 0, 'deleted' => 0, 'freed' => 0, 'ran' => false];
    if (!is_dir($dir)) return $stats;
    $lk = @fopen("$dir/_cleanup.lock", 'c');
    if ($lk === false || !flock($lk, LOCK_EX | LOCK_NB)) { if ($lk) fclose($lk); return $stats; }
    try {
        $stats['ran'] = true;
        $now = time();
        $files = []; $total = 0;
        $dh = @opendir($dir);
        if ($dh === false) return $stats;
        while (($name = readdir($dh)) !== false) {
            if ($name === '.' || $name === '..') continue;
            $p = "$dir/$name";
            if (preg_match(MANAGED_RE, $name)) {
                $st = @stat($p);
                if ($st === false || !is_file($p)) continue;
                $files[] = [$st['mtime'], $st['size'], $p];
                $total += $st['size'];
            } elseif (preg_match('/\.tmp[0-9a-f]{12}$/D', $name)) {
                $mt = @filemtime($p);
                if ($mt !== false && $now - $mt > 900) @unlink($p);
            }
        }
        closedir($dh);
        $stats['scanned'] = count($files);
        $stats['bytes'] = $total;
        $cap = (int) $cfg['cache_max_bytes'];
        if ($cap > 0 && $total > $cap) {
            $grace = (int) $cfg['evict_grace_s'];
            // files stamped far in the future (clock jump) are treated as "just touched" for ordering, but stay evictable
            usort($files, static fn($a, $b) => min($a[0], $now) <=> min($b[0], $now));
            $target = (int) ($cap * 0.9);
            foreach ($files as [$mt, $size, $p]) {
                if ($total <= $target) break;
                if (abs($now - $mt) < $grace) continue;       // possibly being served right now
                if (@unlink($p)) { $total -= $size; $stats['deleted']++; $stats['freed'] += $size; }
            }
            $stats['bytes'] = $total;
        }
        $rl = "$dir/_rl";
        if (is_dir($rl) && ($dh = @opendir($rl))) {
            while (($name = readdir($dh)) !== false) {
                if ($name[0] === '.') continue;
                $mt = @filemtime("$rl/$name");
                if ($mt !== false && $now - $mt > 2 * 86400) @unlink("$rl/$name");   // fully refilled long ago
            }
            closedir($dh);
        }
        return $stats;
    } finally {
        @flock($lk, LOCK_UN);
        fclose($lk);
    }
}

/** After a miss: with probability cleanup_prob, run the cleanup once the response has been sent. */
function maybe_cleanup(array $cfg): void {
    if ($cfg['cleanup_prob'] <= 0 || mt_rand() / mt_getrandmax() >= $cfg['cleanup_prob']) return;
    finish_response();
    try { cache_cleanup($cfg); } catch (Throwable $e) { error_log('foci cleanup: ' . $e->getMessage()); }
}

// ---- the plate index (whitelist) --------------------------------------------------------------------
/** @return array<string,int>|null plate_well => image id, from data/well_index.json only */
function load_well_index(): ?array {
    $raw = @file_get_contents(__DIR__ . '/../data/well_index.json');
    $idx = is_string($raw) ? json_decode($raw, true) : null;
    return is_array($idx) ? $idx : null;
}

/** Plate names are digits with one optional "-digits" part (e.g. 102, 10-34, 100-27); nothing else is ever looked up. */
function valid_plate_name(mixed $p): bool {
    return is_string($p) && preg_match('/^[0-9]{1,4}(?:-[0-9]{1,4})?$/D', $p) === 1;
}

/** Split "7-14_A1" -> ['7-14', 'A1', row(0-based), col(0-based)], or null. Rows A-P, columns 1-48. */
function split_plate_well(string $k): ?array {
    $p = strrpos($k, '_');
    if ($p === false) return null;
    $plate = substr($k, 0, $p);
    $well = substr($k, $p + 1);
    if (!valid_plate_name($plate) || !preg_match('/^([A-P])([1-9][0-9]?)$/D', $well, $m)) return null;
    $col = (int) $m[2];
    if ($col < 1 || $col > 48) return null;
    return [$plate, $well, ord($m[1]) - 65, $col - 1];
}
