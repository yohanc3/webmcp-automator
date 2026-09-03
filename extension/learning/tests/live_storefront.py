#!/usr/bin/env python3
"""Exercise the production learning modules against the owned storefront."""

import json
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[3]
MODULES = [
    ROOT / "extension/learning/privacy.js",
    ROOT / "extension/learning/semantic.js",
    ROOT / "extension/learning/recorder-core.js",
    ROOT / "extension/learning/session.js",
    ROOT / "extension/learning/harness.js",
]
TRACE_PATH = Path("/tmp/g6-owned-trace.json")
DEBUG_PATH = Path("/tmp/g6-owned-debug.json")
START_URL = "http://127.0.0.1:4317/demo/"
SECRETS = {
    "attribute": "canary-live-attribute-secret-c8419a",
    "mutation": "canary-live-mutation-secret-c8419a",
    "query": "audio",
    "visible": "canary-live-visible-secret-c8419a",
}


def load_modules() -> str:
    return "\n".join(path.read_text(encoding="utf-8") for path in MODULES)


def assert_private_data_absent(serialized: str) -> None:
    for name, secret in SECRETS.items():
        if secret in serialized:
            raise AssertionError(f"{name} secret leaked into a serialized artifact")


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            headless=True,
        )
        context = browser.new_context(viewport={"width": 1280, "height": 800})
        context.add_init_script(script=load_modules())
        page = context.new_page()
        page.goto(START_URL, wait_until="domcontentloaded")
        page.wait_for_function("typeof DemoLearningHarness !== 'undefined'")
        page.evaluate("DemoLearningHarness.reset()")
        page.evaluate(
            """(secrets) => {
              const visible = document.createElement('p');
              visible.textContent = secrets.visible;
              visible.setAttribute('role', 'status');
              document.querySelector('#storefront').prepend(visible);
              document.querySelector('button[type="submit"]')
                .setAttribute('data-private', secrets.attribute);
            }""",
            SECRETS,
        )
        started = page.evaluate("DemoLearningHarness.start()")
        if started["status"]["indicator"] != "recording":
            raise AssertionError("the visible recording indicator did not enter recording state")

        page.get_by_label("Search the catalog").fill(SECRETS["query"])
        page.get_by_role("button", name="Search", exact=True).click()
        page.wait_for_url("**/demo/search?q=audio")
        page.get_by_role("heading", name="Search results").wait_for()
        page.get_by_role("link", name="Field H1", exact=True).click()
        page.wait_for_url("**/demo/product/field-h1")
        page.get_by_role("button", name="Add to basket").wait_for()
        page.evaluate(
            """(secret) => {
              document.addEventListener('click', (event) => {
                if (!event.target.closest('[data-add-to-basket]')) return;
                const status = document.querySelector('[data-basket-status]');
                status.textContent = secret;
                status.setAttribute('data-private', secret);
              });
            }""",
            SECRETS["mutation"],
        )
        page.get_by_role("button", name="Add to basket").click()
        page.wait_for_timeout(400)

        trace = page.evaluate("DemoLearningHarness.stop()")
        debug = page.evaluate("DemoLearningHarness.debug()")
        stored = page.evaluate("Object.values(sessionStorage).join('\\n')")
        trace_text = json.dumps(trace, sort_keys=True)
        debug_text = json.dumps(debug, sort_keys=True)
        TRACE_PATH.write_text(json.dumps(trace, indent=2) + "\n", encoding="utf-8")
        DEBUG_PATH.write_text(json.dumps(debug, indent=2) + "\n", encoding="utf-8")
        assert_private_data_absent(trace_text)
        assert_private_data_absent(debug_text)
        assert_private_data_absent(stored)
        if "{{arg.query}}" not in trace_text:
            raise AssertionError("the demonstrated search value was not replaced by {{arg.query}}")
        frame_types = [frame["type"] for frame in trace["frames"]]
        expected = ["page"] + ["action", "update", "page"] * 4
        if frame_types != expected:
            raise AssertionError(f"unexpected causal chronology: {frame_types}")
        action_kinds = [
            frame["action"]["kind"]
            for frame in trace["frames"]
            if frame["type"] == "action"
        ]
        if action_kinds != ["fill", "click", "click", "click"]:
            raise AssertionError(f"unexpected actions: {action_kinds}")
        if len(trace["actionTree"]["transitions"]) != 4:
            raise AssertionError("the action tree did not retain all four observed transitions")
        if debug["redactions"]["total"] < 1:
            raise AssertionError("the debug artifact has no redaction-ledger evidence")

        print(json.dumps({
            "actions": action_kinds,
            "debug": str(DEBUG_PATH),
            "frames": len(trace["frames"]),
            "pages": len(trace["actionTree"]["pages"]),
            "redactions": debug["redactions"],
            "trace": str(TRACE_PATH),
            "transitions": len(trace["actionTree"]["transitions"]),
        }, sort_keys=True))
        browser.close()


if __name__ == "__main__":
    main()
