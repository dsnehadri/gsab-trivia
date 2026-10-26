// Your Firebase project's web config, from Project settings -> "Your apps".
//
// These values are not secrets: every Firebase web app ships them in plain sight.
// What protects the game is database.rules.json (only a signed-in trivia master
// can move the game or mark answers; each team can only write its own answers,
// and only until its round is locked) plus the trivia master code.
window.GSAB_FIREBASE = {
  apiKey: "PASTE_YOUR_API_KEY",
  authDomain: "PASTE_YOUR_PROJECT.firebaseapp.com",
  projectId: "PASTE_YOUR_PROJECT",
  appId: "PASTE_YOUR_APP_ID",
  databaseURL: "https://PASTE_YOUR_PROJECT-default-rtdb.firebaseio.com",
};
