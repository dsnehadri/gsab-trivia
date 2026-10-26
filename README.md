# Maroon Trivia Night

A trivia night for the UChicago Graduate Student Advisory Board, on one static
page. Teams join on their phones with a team name, see each question there and
type their answers. The trivia master logs in with a code, moves the game along,
and judges answers from any device, including a phone.

**Live: https://dsnehadri.github.io/gsab-trivia/**

Four rounds of eight free-response questions: History, Politics, Pop Culture
and Art.

## Running the night

No projector needed: every team plays on a phone.

1. **Before people arrive:** print the QR code sheet and put it on the tables.
   It points to the site.
2. **Teams:** each team opens the site on one phone and types a team name.
3. **Trivia master:** open the site on your phone or laptop, tap **Trivia
   master** at the top right, enter the code, and press **Next** (or →, Space,
   or a clicker's Page Down) to move along. You may want to read each question
   aloud too.

If you do have a TV or big screen, **Big-screen view** (or the address with
`#audience` on the end) shows the current question and the standings in large
type. It's optional.

Each round goes: title, eight questions with a 45-second timer each, then
**Lock answers** (teams can no longer change that round's answers), the eight
answers, and the standings. Players see every question asked so far and can
scroll back to change an answer until the round is locked.

**Judge answers** works well on a phone: pick a question and you'll see each
team's answer next to the correct one, with ✓ and ✗ buttons. **Mark exact
matches right** ticks the answers that match the key word for word. Scores and
standings add up by themselves and appear on players' phones.

Other trivia master tools:

- **Peek at answer** shows the answer on your screen only.
- **Print question sheet** prints a one-page handout with every question (no
  answers) in four quadrants, one per round.
- **Judge answers → Teams** removes a team. **Reset the game** clears all teams,
  answers and scores.

Keys while logged in: → / Space / Page Down next, ← / Page Up back, T pause or
resume the timer.

## Setting up Firebase

Phones share the game through a free Firebase Realtime Database, the same way
komancala does. Firebase's free Spark plan needs no credit card, and its limits
(100 devices connected at once, 1 GB stored) are far beyond a trivia night.

Until this is done, phones can't join. The site still runs on a single computer
(trivia master and big-screen view) so you can try it out.

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and
   create a project, for example `gsab-trivia`. Turn off Google Analytics.
2. **Build → Authentication → Get started → Sign-in method → Anonymous →
   Enable → Save.** Every device signs in anonymously so the database can tell
   teams apart. Nobody types a password or email.
3. **Build → Realtime Database → Create Database.** Pick the closest location
   and start in **locked mode**.
4. Still in Realtime Database, open **Rules**, replace everything with the
   contents of [database.rules.json](database.rules.json), and click
   **Publish**.
5. Click the gear icon → **Project settings → General**. Under *Your apps*,
   click the web icon (`</>`), give it any nickname, and skip Firebase Hosting.
   Copy the `apiKey`, `authDomain`, `projectId`, `appId` and `databaseURL`
   values into [firebase-config.js](firebase-config.js). If `databaseURL` isn't
   shown, copy the address at the top of the Realtime Database page.
6. Commit and push `firebase-config.js`.

The config values aren't secrets; every Firebase web app publishes them. The
rules are what protect the game: only a signed-in trivia master can move the
game, see everyone's answers or mark them; each team can write only its own
answers, and only until its round is locked; and nobody can see another team's
answers.

## Trivia master codes and the questions

The questions are in `questions.json`, which is **not** in git. The published
page only has `locked.js`, an encrypted copy, so reading the public repo doesn't
give away the answers. The codes aren't written anywhere in the repo either.

To set or change the codes (one or more, for several trivia masters), or after
editing `questions.json`:

```bash
python3 set-host-codes.py "first code" "second code"
```

Then commit the new `locked.js` and `index.html`. Codes ignore capitals and
surrounding spaces. Every run replaces all codes, so list every code you want to
keep. Every run also opens a **fresh game room**, so do it before the event, not
during it. Keep a copy of `questions.json` somewhere safe: it's the only
readable copy of the questions.

How the lock works: a random key encrypts the questions (AES-256-CBC). For each
code, `locked.js` stores that key XORed with the code's PBKDF2 key (200,000
rounds) and a short checksum, so a right code recovers the key and a wrong one
doesn't. The first trivia master to log in registers a token derived from that
key with the database, and the rules only let devices that present the same
token act as trivia master. It's the same idea as komancala's room key. It keeps
answers out of casual view; it is not bank security, so pick a code that isn't
easy to guess.

After editing `app.js` (but not the questions), run
`python3 set-host-codes.py --stamp` so browsers load the new version instead of
a cached one.

## Rehearsal mode and working locally

There's no build step. Serve the folder and open it:

```bash
python3 -m http.server 8000
```

Add `?local` to the address (http://localhost:8000/?local) for rehearsal mode:
the game lives in this browser instead of Firebase, and every tab on this
computer shares it. Open one tab as trivia master and a few more as teams
(and `?local#audience` for the big-screen view). The stand-in is
[tests/local-backend.js](tests/local-backend.js). Unlocking needs the
browser's Web Crypto, which works on https and localhost.
