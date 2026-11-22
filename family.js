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
    sb.from("family_members").select("id, family_id, kind, email, display_name, role, status, invited_at, joined_at").order("invited_at"),
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
        const inFam = familyData.members.filter((m) => m.family_id === f.id);
        const members = [...inFam.filter((m) => m.kind !== "kid"), ...inFam.filter((m) => m.kind === "kid")];
        return `
        <div class="family-card">
          <div class="family-card-name">👪 ${escHtml(f.name)}</div>
          ${members.map((m) => m.kind === "kid" ? `
            <div class="calendar-item">
              <span>${escHtml(m.display_name)}</span>
              <span class="family-member-actions">
                <span class="family-badge kid">Kid</span>
                <button type="button" class="family-rename" data-id="${escHtml(m.id)}">Rename</button>
                <button type="button" class="calendar-remove family-remove" data-id="${escHtml(m.id)}">Remove</button>
              </span>
            </div>` : `
            <div class="calendar-item">
              <span>
                ${escHtml(m.display_name || m.email)}${m.email === me ? " (you)" : ""}
                <span class="muted family-email">${escHtml(m.email)}</span>
              </span>
              <span class="family-member-actions">
                <span class="family-badge ${m.status === "invited" ? "invited" : ""}">${m.status === "invited" ? "Invited" : m.role === "admin" ? "Admin" : "Adult"}</span>
                ${admin && m.status === "invited" ? `<button type="button" class="family-resend" data-id="${escHtml(m.id)}">Resend</button>` : ""}
                ${admin && m.email !== me ? `<button type="button" class="calendar-remove family-remove" data-id="${escHtml(m.id)}">Remove</button>` : ""}
              </span>
            </div>`).join("")}
        </div>`;
      }).join("")
    : `<div class="journal-empty">${admin ? "No families yet — create one below." : "You're not in a family yet."}</div>`;

  // Kids can be added by anyone in the family (RLS allows kind='kid' rows in your own families).
  const myFams = familyData.families.filter((f) => familyData.members.some((m) => m.family_id === f.id && m.email === me && m.status === "active"));
  const kidFamily = document.getElementById("kidFamily");
  kidFamily.innerHTML = myFams.map((f) => `<option value="${escHtml(f.id)}">${escHtml(f.name)}</option>`).join("");
  kidFamily.classList.toggle("hidden", myFams.length < 2);
  // Meals shows a star row per family member, so refresh it when people change.
function familyPeopleChanged() {
  if (!document.getElementById("mealsContent")?.classList.contains("hidden")) loadMealsData();
}

document.getElementById("kidForm").classList.toggle("hidden", !myFams.length);

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

document.getElementById("kidForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("kidName");
  const display_name = input.value.trim();
  const family_id = document.getElementById("kidFamily").value;
  if (!display_name || !family_id) return;
  setFamilyStatus("Adding…");
  const { error } = await sb.from("family_members").insert({ family_id, kind: "kid", display_name, role: "member", status: "active" });
  if (error) { setFamilyStatus("Couldn't add: " + error.message); return; }
  input.value = "";
  setFamilyStatus(`Added ${display_name}.`);
  await renderFamilySection();
  familyPeopleChanged();
});

document.getElementById("familyList").addEventListener("click", async (e) => {
  const resend = e.target.closest(".family-resend");
  const remove = e.target.closest(".family-remove");
  const rename = e.target.closest(".family-rename");
  const btn = resend || remove || rename;
  if (!btn) return;
  const member = familyData.members.find((m) => m.id === btn.dataset.id);
  const family = member && familyData.families.find((f) => f.id === member.family_id);
  if (!family || !member) return;

  if (resend) { openInviteEmail(family, member); setFamilyStatus("Gmail draft opened in a new tab."); return; }

  if (rename) {
    const name = (prompt("Name", member.display_name) || "").trim();
    if (!name || name === member.display_name) return;
    const { error } = await sb.from("family_members").update({ display_name: name }).eq("id", member.id);
    if (error) { setFamilyStatus("Couldn't rename: " + error.message); return; }
    renderFamilySection();
    familyPeopleChanged();
    return;
  }

  if (member.kind === "kid") {
    if (!confirm(`Remove ${member.display_name} from ${family.name}? Their meal ratings will be deleted too.`)) return;
    const { error } = await sb.from("family_members").delete().eq("id", member.id);
    if (error) { setFamilyStatus("Couldn't remove: " + error.message); return; }
    setFamilyStatus(`Removed ${member.display_name}.`);
    renderFamilySection();
    familyPeopleChanged();
    return;
  }

  if (!confirm(`Remove ${member.display_name || member.email} from ${family.name}? They'll immediately lose access to its Paper and House (and to the app, if this is their only family), and their meal ratings are deleted. Their private data is kept.`)) return;
  setFamilyStatus("Removing…");
  const { error } = await sb.from("family_members").delete().eq("id", member.id);
  if (error) { setFamilyStatus("Couldn't remove: " + error.message); return; }
  setFamilyStatus(`Removed ${member.email}.`);
  renderFamilySection();
  familyPeopleChanged();
});

document.getElementById("settingsBtn").addEventListener("click", () => { setFamilyStatus(""); renderFamilySection(); });
