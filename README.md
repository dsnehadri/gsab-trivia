# Maroon Trivia Night

A trivia night for the UChicago Graduate Student Advisory Board, on one static
page. The trivia master logs in with a code and moves the game along; the
questions go up on a projector and teams write their answers on paper.

Four rounds of eight multiple-choice questions: History, Politics, Pop Culture
and Art.

## Running the night

1. Open the site on the laptop connected to the projector and click
   **Trivia master login**. Enter your code.
2. Click **Open audience screen**, drag the new window onto the projector, and
   make it full screen. It follows your controls. Your own window keeps the
   controls and can peek at the answer; the audience window never can.
   (One screen works too: just run it full screen on the projector.)
3. Add teams under **Teams & scores**.
4. Press **Next** (or →, Space, or a clicker's Page Down) to move along.

Each round goes: title, eight questions with a 45-second timer each, "pencils
down", the eight answers with a fun fact each, then the standings. Teams swap
sheets to mark them, and you type each team's round score into **Teams &
scores**. The final screen names the winners.

Keys while logged in: → / Space / Page Down next, ← / Page Up back, T pause or
resume the timer. Progress and scores are saved in the browser, so a refresh
picks up where you left off. **Reset the game** (under Teams & scores) starts
over.

## Trivia master codes and the questions

The questions are in `questions.json`, which is **not** in git. The published
page only has `locked.js`, an encrypted copy, so reading the public repo doesn't
give away the answers. The codes aren't written anywhere in the repo either.

To set or change the codes (one or more, for several trivia masters), or after
editing `questions.json`:

```bash
python3 set-host-codes.py "first code" "second code"
```

Then commit the new `locked.js`. Codes ignore capitals and surrounding spaces.
Every run replaces all codes, so list every code you want to keep. Keep a copy
of `questions.json` somewhere safe: it's the only readable copy of the questions.

How the lock works: a random key encrypts the questions (AES-256-CBC). For each
code, `locked.js` stores that key XORed with the code's PBKDF2 key (200,000
rounds) and a short checksum, so a right code recovers the key and a wrong one
doesn't. It's the same idea as komancala's room key. It keeps answers out of
casual view; it is not bank security, so pick a code that isn't easy to guess.

## Hosting

GitHub Pages: **Settings → Pages → Deploy from a branch**, `main`, `/ (root)`.
No build step.

## Working on it locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Unlocking needs the browser's Web Crypto,
which works on https and localhost.
