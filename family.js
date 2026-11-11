// Family section of the Settings drawer.
// A family shares Paper and House; everything else in the app is private to each person.
// Only the admin can create families and invite or remove people — enforced by RLS on
// families/family_members, so these controls are just a UI for what the database allows.

const PUBLIC_APP_URL = "https://bonbonistl.github.io/daily-log-dashboard/";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let familyData = { families: [], members: [] };

const isAdmin = () => !!window.appAccess?.is_admin;
const appUrl = () => (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? PUBLIC_APP_URL : location.origin + location.pathname);
const familyTitle = (name) => `${name} LifeOS`;

function setFamilyStatus(msg) {
  document.getElementById("familyStatus").textContent = msg;
}

async function loadFamilyData() {
  const [fams, mems] = await Promise.all([
    sb.from("families").select("id, name, created_at").order("created_at"),
    sb.from("family_members").select("family_id, email, display_name, role, status, invited_at, joined_at").order("invited_at"),
  ]);
  if (fams.error) throw fams.error;
  if (mems.error) throw mems.error;
  familyData = { families: fams.data || [], members: mems.data || [] };
}

async function renderFamilySection() {
  const listEl = document.getElementById("familyList");
  listEl.innerHTML = `<div class="journal-empty">Loading…</div>`;
  try {
    await loadFamilyData();
  } catch (err) {
    listEl.innerHTML = "";
    setFamilyStatus("Couldn't load family: " + err.message);
    return;
  }
  const me = window.appAccess?.email;
  const admin = isAdmin();
  document.getElementById("familyAdminForms").classList.toggle("hidden", !admin);

  listEl.innerHTML = familyData.families.length
    ? familyData.families.map((f) => {
        const members = familyData.members.filter((m) => m.family_id === f.id);
        return `
        <div class="family-card">
          <div class="family-card-name">👪 ${escHtml(f.name)}</div>
          ${members.map((m) => `
            <div class="calendar-item">
              <span>
                ${escHtml(m.display_name || m.email)}${m.email === me ? " (you)" : ""}
                <span class="muted family-email">${escHtml(m.email)}</span>
              </span>
              <span class="family-member-actions">
                <span class="family-badge ${m.status === "invited" ? "invited" : ""}">${m.status === "invited" ? "Invited" : m.role === "admin" ? "Admin" : "Member"}</span>
                ${admin && m.status === "invited" ? `<button type="button" class="family-resend" data-family="${escHtml(f.id)}" data-email="${escHtml(m.email)}">Resend</button>` : ""}
                ${admin && m.email !== me ? `<button type="button" class="calendar-remove family-remove" data-family="${escHtml(f.id)}" data-email="${escHtml(m.email)}">Remove</button>` : ""}
              </span>
            </div>`).join("")}
        </div>`;
      }).join("")
    : `<div class="journal-empty">${admin ? "No families yet — create one below." : "You're not in a family yet."}</div>`;

  if (admin) {
    document.getElementById("inviteFamily").innerHTML = familyData.families
      .map((f) => `<option value="${escHtml(f.id)}">${escHtml(f.name)}</option>`).join("");
    document.getElementById("inviteForm").classList.toggle("hidden", !familyData.families.length);
  }
}

// Opens a pre-filled Gmail compose window from the admin's own account. Sending from
// your own address (rather than a no-reply service) means it won't land in spam and
// she knows it's really you. The email itself carries no secret — access is granted
// only to the invited Google account when it signs in.
function openInviteEmail(family, member) {
  const first = (member.display_name || "").split(" ")[0];
  const title = familyTitle(family.name);
  const body = [
    first ? `Hi ${first},` : "Hi,",
    "",
    `You've been invited to the ${title}.`,
    "",
    `1. Open ${appUrl()}`,
    `2. Click "Sign in with Google" and choose this Google account: ${member.email}`,
    "",
    "It has to be that exact Google account — the invite only works for it.",
    "",
    "Paper and House are shared with the family. Everything else in the app (health, habits, connections, settings) is private to you.",
  ].join("\n");
  const params = new URLSearchParams({ view: "cm", fs: "1", to: member.email, su: `You're invited to the ${title}`, body });
  if (window.appAccess?.email) params.set("authuser", window.appAccess.email);
  window.open(`https://mail.google.com/mail/?${params}`, "_blank", "noopener");
}

document.getElementById("familyCreateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("newFamilyName");
  const name = input.value.trim();
  if (!name) return;
  setFamilyStatus("Creating…");
  const { data: fam, error } = await sb.from("families").insert({ name }).select().single();
  if (error) { setFamilyStatus("Couldn't create: " + error.message); return; }
  // The admin is always a member of families they create, so they share its Paper/House.
  const { error: mErr } = await sb.from("family_members").insert({
    family_id: fam.id, email: window.appAccess.email, role: "admin", status: "active", joined_at: new Date().toISOString(),
  });
  if (mErr) { setFamilyStatus("Created, but couldn't add you: " + mErr.message); }
  else setFamilyStatus(`Created ${name}.`);
  input.value = "";
  renderFamilySection();
});

document.getElementById("inviteForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const familyId = document.getElementById("inviteFamily").value;
  const email = document.getElementById("inviteEmail").value.trim().toLowerCase();
  const display_name = document.getElementById("inviteName").value.trim() || null;
  const family = familyData.families.find((f) => f.id === familyId);
  if (!family) { setFamilyStatus("Pick a family."); return; }
  if (!EMAIL_RE.test(email)) { setFamilyStatus("That doesn't look like an email address."); return; }
  if (familyData.members.some((m) => m.family_id === familyId && m.email === email)) {
    setFamilyStatus(`${email} is already in ${family.name}.`);
    return;
  }
  setFamilyStatus("Inviting…");
  const { error } = await sb.from("family_members").insert({ family_id: familyId, email, display_name, role: "member", status: "invited" });
  if (error) { setFamilyStatus("Couldn't invite: " + error.message); return; }
  openInviteEmail(family, { email, display_name });
  document.getElementById("inviteEmail").value = "";
  document.getElementById("inviteName").value = "";
  setFamilyStatus(`Invited ${email}. A Gmail draft opened in a new tab — hit Send there.`);
  renderFamilySection();
});

document.getElementById("familyList").addEventListener("click", async (e) => {
  const resend = e.target.closest(".family-resend");
  const remove = e.target.closest(".family-remove");
  const btn = resend || remove;
  if (!btn) return;
  const family = familyData.families.find((f) => f.id === btn.dataset.family);
  const member = familyData.members.find((m) => m.family_id === btn.dataset.family && m.email === btn.dataset.email);
  if (!family || !member) return;

  if (resend) { openInviteEmail(family, member); setFamilyStatus("Gmail draft opened in a new tab."); return; }

  if (!confirm(`Remove ${member.display_name || member.email} from ${family.name}? They'll immediately lose access to its Paper and House (and to the app, if this is their only family). Their private data is kept.`)) return;
  setFamilyStatus("Removing…");
  const { error } = await sb.from("family_members").delete().eq("family_id", family.id).eq("email", member.email);
  if (error) { setFamilyStatus("Couldn't remove: " + error.message); return; }
  setFamilyStatus(`Removed ${member.email}.`);
  renderFamilySection();
});

document.getElementById("settingsBtn").addEventListener("click", () => { setFamilyStatus(""); renderFamilySection(); });
