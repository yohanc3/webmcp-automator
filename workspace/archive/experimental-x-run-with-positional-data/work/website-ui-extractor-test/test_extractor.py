from pathlib import Path
from xml.etree import ElementTree

from playwright.sync_api import sync_playwright


HERE = Path(__file__).resolve().parent
EXTRACTOR = HERE.parents[1] / "outputs" / "website-ui-extractor" / "extract-ui.js"


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        executable_path="/Applications/Chromium.app/Contents/MacOS/Chromium",
        headless=True,
    )
    page = browser.new_page(viewport={"width": 900, "height": 700})
    page.goto((HERE / "fixture.html").as_uri())
    page.evaluate("window.copy = value => { window.__copiedXml = value; }")
    page.add_script_tag(path=str(EXTRACTOR))
    xml = page.evaluate("extractWebsiteUI({ pointerHeuristic: true })")
    copied_xml = page.evaluate("window.__copiedXml")
    browser.close()

root = ElementTree.fromstring(xml)
actions = root.findall(".//action")
images = root.findall(".//image")

assert root.tag == "page"
assert copied_xml == xml
assert len(actions) == 7, [(node.get("dom-id"), node.get("type")) for node in actions]
assert len(images) == 4
assert all("id" in node.attrib for node in actions)
assert all("dom-id" in node.attrib and "classes" in node.attrib for node in actions)
assert all(node.get("tag") for node in [*actions, *images, *root.findall(".//group")])
assert root.find(".//action[@dom-id='home-link']").get("href").endswith("/home")
assert root.find(".//action[@dom-id='home-link']").get("inner-text") == "Home text is ignored"
assert root.find(".//action[@dom-id='about-link']").get("rel") == "help"
assert root.find(".//action[@dom-id='promo-link']/image[@dom-id='promo-image']") is not None
assert root.find(".//action[@dom-id='save-button']/image[@dom-id='save-image']") is not None
assert root.find(".//image[@dom-id='standalone-image']") is not None
assert root.find(".//action[@dom-id='pointer-card']").get("type") == "pointer"
assert root.find(".//action[@dom-id='pointer-card']").get("inner-text") == "Custom pointer action"
assert root.find(".//action[@dom-id='email']").get("classes") == "field wide"
assert root.find(".//action[@dom-id='email']").get("inner-text") == ""
assert root.find(".//action[@dom-id='shadow-link']/image[@dom-id='shadow-image']") is not None
assert len({node.get("id") for node in actions}) == len(actions)
assert "private@example.com" not in xml
assert "standalone text" not in xml.lower()
assert "Promotion" not in xml
assert not any((node.get("href") or "").endswith("/hidden") for node in actions)

print(f"validated {len(actions)} actions, {len(images)} images, and well-formed XML")
