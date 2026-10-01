"""Static checks of deploy/studylab.htaccess (no Apache here): cache policy and 404 behaviour."""

from pathlib import Path

HT = (Path(__file__).resolve().parents[1] / "deploy" / "studylab.htaccess").read_text(encoding="utf-8")
BAT = (Path(__file__).resolve().parents[1] / "deploy_studylab.bat").read_text(encoding="utf-8")


def test_demo_cache_and_assets_cache_policy():
    assert 'SetEnvIf Request_URI "^/telomore/assets/" HASHED_ASSET' in HT
    assert 'Header set Cache-Control "public, max-age=31536000, immutable" env=HASHED_ASSET' in HT
    assert 'Header set Cache-Control "public, max-age=31536000, immutable" env=DEMO_SCENARIO' in HT
    assert 'Header set Cache-Control "no-cache" env=DEMO_INDEX' in HT
    assert r'^/telomore/demo-cache/index\.json$" DEMO_INDEX' in HT
    assert r'!DEMO_SCENARIO' in HT  # index.json is excluded from the immutable class


def test_missing_demo_cache_is_404_not_spa_shell():
    ht = HT.replace("\r\n", "\n")
    notfound = ht.index("RewriteRule ^ - [R=404,L]")
    spa = ht.index("RewriteRule ^ /telomore/index.html [L]")
    assert notfound < spa
    assert "demo-cache" in ht[:spa][ht.rindex("RewriteCond", 0, notfound) - 60:notfound]


def test_existing_rules_are_kept():
    assert "RewriteRule ^(telomore|foci)$ /$1/ [R=301,L]" in HT
    assert r"RewriteRule \.(py|sh|md|log|tmp|bat)$ - [F,L]" in HT
    assert 'Header set X-Content-Type-Options "nosniff"' in HT
    assert r'<FilesMatch "^index\.html$">' in HT


def test_deploy_script_ships_dist_including_demo_cache():
    assert r'xcopy /e /i /q /y "frontend\dist\*" "%STAGE%\telomore"' in BAT
    assert r"demo-cache\index.json" in BAT
