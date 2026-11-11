// Who may use the app is decided server-side by the my_access() RPC: the admin, or anyone
// whose Google email was invited to a family (their first sign-in activates the invite).
window.appAccess = null; // { email, is_admin, allowed, families: [{ id, name, role }] }

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
  loadData(); // kick off the initial Health data load now that we're authenticated
  applyRouteFromHash(); // activate whichever tab/subtab the URL points to (defaults to Today)
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
  if (window.isAuthed && window.appAccess?.email === session.user.email.toLowerCase()) return; // token refresh
  const { data: access, error } = await sb.rpc("my_access");
  if (error) {
    showGate("Couldn't check your access: " + error.message);
    return;
  }
  if (!access?.allowed) {
    await sb.auth.signOut();
    showGate(`${session.user.email} hasn't been invited yet. Ask for an invite, then sign in with that same Google account.`);
    return;
  }
  window.appAccess = access;
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
  window.appAccess = null;
  await sb.auth.signOut();
  showGate();
});

sb.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") checkSession();
  if (event === "SIGNED_OUT") showGate();
});

checkSession();
