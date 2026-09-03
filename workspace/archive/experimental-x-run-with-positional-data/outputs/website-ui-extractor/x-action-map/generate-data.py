#!/usr/bin/env python3

import argparse
import json
from pathlib import Path
from xml.etree import ElementTree


def parse_snapshot(source_path):
    root = ElementTree.parse(source_path).getroot()
    actions = []
    groups = []
    images = []

    def visit(node, parent_group=None, owner_action=None):
        next_parent = parent_group
        next_owner = owner_action

        if node.tag == "group":
            record = {"attributes": dict(node.attrib), "parentGroup": parent_group}
            groups.append(record)
            next_parent = node.get("id")
        elif node.tag == "action":
            record = {
                "attributes": dict(node.attrib),
                "parentGroup": parent_group,
                "imageIds": [image.get("id") for image in node.findall("./image")],
            }
            actions.append(record)
            next_owner = node.get("id")
        elif node.tag == "image":
            images.append({
                "attributes": dict(node.attrib),
                "parentGroup": parent_group,
                "ownerAction": owner_action,
            })

        for child in node:
            visit(child, next_parent, next_owner)

    visit(root)
    return {
        "meta": dict(root.attrib),
        "actions": actions,
        "groups": groups,
        "images": images,
    }


def main():
    parser = argparse.ArgumentParser(description="Build browser data from extracted UI XML.")
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()

    snapshot = parse_snapshot(args.source)
    payload = json.dumps(snapshot, ensure_ascii=False, indent=2)
    args.destination.write_text(
        f"globalThis.X_ACTION_SNAPSHOT = Object.freeze({payload});\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
