// The gsab-trivia Firebase project's web config, from Project settings -> "Your apps".
//
// These values are not secrets: every Firebase web app ships them in plain sight.
// What protects the game is database.rules.json (only a signed-in trivia master
// can move the game or mark answers; each team can only write its own answers,
// and only until its round is locked) plus the trivia master code.
window.GSAB_FIREBASE = {
  apiKey: "AIzaSyAxHTefNnxenxnfrdNkRVmzjADer7gBWgU",
  authDomain: "gsab-trivia.firebaseapp.com",
  projectId: "gsab-trivia",
  appId: "1:700291398133:web:38f56f1a3ef1417d3bc8bc",
  databaseURL: "https://gsab-trivia-default-rtdb.firebaseio.com",
};
