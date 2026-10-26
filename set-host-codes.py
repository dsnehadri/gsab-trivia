#!/usr/bin/env python3
"""Lock the trivia questions behind one or more trivia master codes.

The questions and answers live in questions.json, which is never committed.
This script encrypts that file and writes locked.js, which is committed and
published. Only someone who types a valid code on the page can read the
questions, so a public repository does not give the answers away.

How the lock works (the same idea as komancala's room key): a random 32-byte
content key encrypts the questions with AES-256-CBC. For each code, locked.js
stores that key XORed with the code's PBKDF2 key, plus a short checksum of the
content key. A right code recovers the key and the checksum matches; a wrong
one does not. The codes themselves are never written anywhere.

    python3 set-host-codes.py "first code" ["second code" ...]

Codes ignore case and surrounding spaces. Run this again after editing
questions.json, passing the codes you want to keep.
"""

import base64
import hashlib
import json
import os
import pathlib
import secrets
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
SALT = "gsab-trivia-host"
ITERATIONS = 200000
CHECK_LABEL = b"gsab-check"


def norm(code):
    return code.strip().lower()


def load_questions():
    path = ROOT / "questions.json"
    if not path.is_file():
        sys.exit("No questions.json next to this script. It holds the questions in the clear and is not in git.")
    data = json.loads(path.read_text(encoding="utf-8"))
    rounds = data.get("rounds")
    if not rounds:
        sys.exit("questions.json needs a non-empty \"rounds\" list.")
    for ri, r in enumerate(rounds, 1):
        if not r.get("name") or not r.get("questions"):
            sys.exit(f"Round {ri} needs a name and at least one question.")
        for qi, q in enumerate(r["questions"], 1):
            where = f"Round {ri} ({r['name']}), question {qi}"
            if not q.get("q"):
                sys.exit(f"{where}: the question text is empty.")
            if len(q.get("options", [])) != 4:
                sys.exit(f"{where}: needs exactly 4 options.")
            if q.get("answer") not in ("A", "B", "C", "D"):
                sys.exit(f"{where}: answer must be one of A, B, C or D.")
    return data


def main():
    codes = sys.argv[1:]
    if not codes or any(not norm(c) for c in codes):
        sys.exit(__doc__)
    if len({norm(c) for c in codes}) != len(codes):
        sys.exit("Two of those codes are the same once case and spaces are ignored.")

    data = load_questions()
    plain = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    content_key = secrets.token_bytes(32)
    keys = []
    for code in codes:
        derived = hashlib.pbkdf2_hmac("sha256", norm(code).encode("utf-8"), SALT.encode(), ITERATIONS, 32)
        keys.append(bytes(a ^ b for a, b in zip(content_key, derived)).hex())
    check = hashlib.sha256(content_key + CHECK_LABEL).hexdigest()[:16]

    iv = os.urandom(16)
    result = subprocess.run(
        ["openssl", "enc", "-aes-256-cbc", "-K", content_key.hex(), "-iv", iv.hex()],
        input=plain, capture_output=True, check=True)

    locked = {
        "salt": SALT,
        "iterations": ITERATIONS,
        "keys": keys,
        "check": check,
        "rounds": [{"name": r["name"], "blurb": r.get("blurb", ""), "count": len(r["questions"])} for r in data["rounds"]],
        "data": base64.b64encode(iv + result.stdout).decode("ascii"),
    }
    (ROOT / "locked.js").write_text(
        "// Written by set-host-codes.py. Do not edit by hand: change questions.json and run the script again.\n"
        "window.GSAB_LOCKED = " + json.dumps(locked, indent=1) + ";\n",
        encoding="utf-8")
    total = sum(r["count"] for r in locked["rounds"])
    print(f"Wrote locked.js: {len(locked['rounds'])} rounds, {total} questions, {len(codes)} trivia master code(s).")


if __name__ == "__main__":
    main()
