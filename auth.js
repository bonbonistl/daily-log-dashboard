const ALLOWED_EMAIL = "jthorp@gmail.com";

const authGate = document.getElementById("authGate");
const appShell = document.getElementById("appShell");
const authStatus = document.getElementById("authStatus");
const signInBtn = document.getElementById("signInBtn");
const signOutBtn = document.getElementById("signOutBtn");
const userEmailLabel = document.getElementById("userEmailLabel");

window.isAuthed = false;

function showApp(email) {
  window.isAuthed = true;
  authGate.classList.add("hidden");
  appShell.classList.remove("hidden");
  userEmailLabel.textContent = email;
  loadData(); // kick off the initial data load now that we're authenticated
}

function showGate(message) {
  window.isAuthed = false;
  appShell.classList.add("hidden");
  authGate.classList.remove("hidden");
  authStatus.textContent = message || "";
}

async function checkSession() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    showGate();
    return;
  }
  if (session.user.email !== ALLOWED_EMAIL) {
    await sb.auth.signOut();
    showGate(`Signed in as ${session.user.email}, but this dashboard is restricted to ${ALLOWED_EMAIL}.`);
    return;
  }
  showApp(session.user.email);
}

signInBtn.addEventListener("click", async () => {
  authStatus.textContent = "Redirecting to Google…";
  await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
});

signOutBtn.addEventListener("click", async () => {
  await sb.auth.signOut();
  showGate();
});

sb.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") checkSession();
  if (event === "SIGNED_OUT") showGate();
});

checkSession();
