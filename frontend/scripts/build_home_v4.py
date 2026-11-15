"""Builds public/home-v4.html from scripts/home_v4_template.html plus pieces of public/home-v3.html.

v4 is a restyle of v3, not a rewrite: the sample report, the NC map, the
tape-measure chain, the demo form and the page scripts are copied from v3 so
the two pages can never disagree on content or behaviour. Run it again after
changing either source:

    python3 frontend/scripts/build_home_v4.py
"""
import re
from pathlib import Path

here = Path(__file__).resolve().parent
public = here.parent / "public"
v3 = (public / "home-v3.html").read_text()
tpl = (here / "home_v4_template.html").read_text()


def grab(pattern: str, name: str) -> str:
    m = re.search(pattern, v3, flags=re.S)
    if not m:
        raise SystemExit(f"build_home_v4: could not find {name} in home-v3.html")
    return m.group(0) if m.lastindex is None else m.group(1)


pieces = {
    # <title> .. the gstatic preconnect (v4 brings its own font request)
    "HEAD_META": grab(r"(<title>.*?<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>)", "head metadata"),
    "V3_CSS": grab(r"<style>(.*?)</style>", "v3 stylesheet"),
    "SAMPLE": grab(r"<!-- SAMPLE-REPORT:START.*?<!-- SAMPLE-REPORT:END -->", "sample report"),
    "CHAIN": grab(r"(<div class=\"chain\">.*?</div>\s*)\n\s*<p class=\"fine\">Figures", "after-the-measurement chain"),
    "NCMAP": grab(r"<svg class=\"ncmap\".*?</svg>", "NC map"),
    "DEMO": grab(r"<section class=\"band\" id=\"demo\">.*?</section>", "demo section"),
    "SCRIPTS": grab(r"</footer>\s*(<script>.*</script>)\s*</body>", "page scripts"),
}

out = tpl
for key, val in pieces.items():
    token = "{{" + key + "}}"
    if token not in out:
        raise SystemExit(f"build_home_v4: template is missing {token}")
    out = out.replace(token, val)

left = re.findall(r"\{\{[A-Z0-9_]+\}\}", out)
if left:
    raise SystemExit(f"build_home_v4: unfilled placeholders {left}")

(public / "home-v4.html").write_text(out)
print(f"wrote {public / 'home-v4.html'} ({len(out):,} bytes)")
