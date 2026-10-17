/* Tadaa! — shared helpers: utils, crypto (WebCrypto), GitHub client. No dependencies. */

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
export const nowISO = () => new Date().toISOString();
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export const CANDY = ["#ff8fb2", "#b79cff", "#7dd8ff", "#8ff0c8", "#ffe08a", "#ffb38a", "#f9a8ff", "#93e6c4"];
export function colorFor(id) {
  let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CANDY[h % CANDY.length];
}
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- base64 helpers ---------- */
const te = new TextEncoder(), td = new TextDecoder();
export function b64encode(str) {
  const bytes = te.encode(str); let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
export function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s/g, "")); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return td.decode(bytes);
}
export function bytesToB64(bytes) { let bin = ""; bytes.forEach((b) => (bin += String.fromCharCode(b))); return btoa(bin); }
export function b64ToBytes(b64) { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
export const toB64Url = (s) => b64encode(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64Url = (s) => b64decode(s.replace(/-/g, "+").replace(/_/g, "/"));

/* ---------- crypto: PBKDF2 + AES-GCM ---------- */
const subtle = crypto.subtle;
const PBKDF2_ITERATIONS = 210000;
const MIN_PBKDF2_ITERATIONS = 100000;
const MAX_PBKDF2_ITERATIONS = 1000000;
export const randomHex = (n = 16) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomBase64 = (n = 32) => bytesToB64(crypto.getRandomValues(new Uint8Array(n)));

async function deriveKey(passphrase, saltB64, iterations = PBKDF2_ITERATIONS) {
  const base = await subtle.importKey("raw", te.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt: b64ToBytes(saltB64), iterations, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}
/** Encrypt any JSON value with a passphrase. Returns a self-describing envelope object. */
export async function encryptJSON(value, passphrase) {
  const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(value)));
  return { v: 1, kdf: "PBKDF2-SHA256", iter: PBKDF2_ITERATIONS, salt, iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(ct)) };
}
export async function decryptJSON(env, passphrase) {
  try {
    if (!env || typeof env !== "object") return null;
    const iterations = env.iter === undefined ? PBKDF2_ITERATIONS : env.iter;
    if (!Number.isSafeInteger(iterations) || iterations < MIN_PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS) return null;
    if (env.kdf !== undefined && env.kdf !== "PBKDF2-SHA256") return null;
    const salt = b64ToBytes(env.salt), iv = b64ToBytes(env.iv), data = b64ToBytes(env.data);
    if (salt.length !== 16 || iv.length !== 12 || data.length < 16) return null;
    const key = await deriveKey(passphrase, bytesToB64(salt), iterations);
    const pt = await subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return JSON.parse(td.decode(pt));
  } catch { return null; } // wrong passphrase or tampered/invalid data (GCM auth tag)
}
/** Encrypt with a raw device key (used only for "remember this device"). */
export async function encryptWithRawKey(value, rawKeyB64) {
  const key = await subtle.importKey("raw", b64ToBytes(rawKeyB64), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(value)));
  return { iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(ct)) };
}
export async function createRememberedBundle(value) {
  const key = randomBase64(32);
  return { key, envelope: await encryptWithRawKey(value, key) };
}
export async function decryptWithRawKey(env, rawKeyB64) {
  try {
    const key = await subtle.importKey("raw", b64ToBytes(rawKeyB64), "AES-GCM", false, ["decrypt"]);
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(env.iv) }, key, b64ToBytes(env.data));
    return JSON.parse(td.decode(pt));
  } catch { return null; }
}
export async function fingerprint(vaultId) {
  const hash = await subtle.digest("SHA-256", te.encode("tadaa:" + vaultId));
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `TADA-${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

/* ---------- the sync vault (encrypted token bundle) ---------- */
export async function createVault(payload, passphrase) {
  const vaultId = payload.vaultId || randomHex(12);
  const env = await encryptJSON({ ...payload, vaultId }, passphrase);
  return { format: "tadaa-vault", version: 1, vaultId, createdAt: nowISO(), crypto: env };
}
export async function openVault(vault, passphrase) {
  if (!vault || vault.format !== "tadaa-vault" || !vault.crypto) return null;
  const payload = await decryptJSON(vault.crypto, passphrase);
  if (!payload || !payload.token || !payload.repo) return null;
  return payload;
}
export const vaultToShareCode = (vault) => "TD1." + toB64Url(JSON.stringify(vault));
export function shareCodeToVault(code) {
  try {
    const clean = String(code).trim();
    if (!clean.startsWith("TD1.")) return null;
    const v = JSON.parse(fromB64Url(clean.slice(4)));
    return v && v.format === "tadaa-vault" ? v : null;
  } catch { return null; }
}

/* ---------- GitHub token helpers (single-repo scoping) ---------- */
const FINE_GRAINED_TOKEN = /^github_pat_[A-Za-z0-9_]+$/;
const CLASSIC_TOKEN = /^gh[pousr]_[A-Za-z0-9]+$/;
/** Classify a credential. Only fine-grained tokens can be limited to one repository. */
export function tokenKind(token) {
  const value = String(token ?? "").trim();
  if (FINE_GRAINED_TOKEN.test(value)) return "fine-grained";
  if (CLASSIC_TOKEN.test(value)) return "classic";
  return "unknown";
}
function ownerRepo(owner, repo) {
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return `${owner}/${repo}`;
}
/** Accept `owner/repo`, a github.com URL, a Pages URL, an scp-like URL, or a `.git` URL. */
export function parseRepoInput(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  s = s.replace(/^git@([^:/\s]+):/i, "https://$1/").replace(/\.git$/i, "").replace(/\/+$/, "");
  const pages = /^(?:https?:\/\/)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.github\.io\/([^/?#\s]+)/i.exec(s);
  if (pages) return ownerRepo(pages[1], pages[2]);
  const ghUrl = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)\/([^/?#\s]+)/i.exec(s);
  if (ghUrl) return ownerRepo(ghUrl[1], ghUrl[2]);
  const bare = /^([^/?#\s]+)\/([^/?#\s]+)$/.exec(s);
  if (bare) return ownerRepo(bare[1], bare[2]);
  return null;
}
/** `https://<owner>.github.io/<repo>/` → `owner/repo`, so the site knows its own repository. */
export function repoFromLocation(loc) {
  const host = loc?.hostname || "";
  const m = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.github\.io$/i.exec(host);
  if (!m) return null;
  const first = String(loc.pathname || "/").split("/").filter(Boolean)[0];
  if (!first) return null;
  let repo = first;
  try { repo = decodeURIComponent(first); } catch {}
  return ownerRepo(m[1], repo);
}
/**
 * Link to GitHub's fine-grained token form with everything we can pre-fill already set:
 * name, description, resource owner, expiration and `contents: write` (metadata read is implied).
 * GitHub has no parameter for repository selection, so the user still has to pick
 * "Only select repositories" → the repo, which the UI states explicitly.
 */
export function tokenCreateUrl({ owner, repo, days = 366 } = {}) {
  if (!owner || !repo) return "https://github.com/settings/personal-access-tokens/new";
  const query = new URLSearchParams({
    name: `Tadaa! sync · ${repo}`.slice(0, 40),
    description: `Tadaa! todo-list sync token. Repository access: "Only select repositories" → ${owner}/${repo}. Permission: Contents = Read and write. Nothing else.`,
    target_name: owner,
    expires_in: String(days),
    contents: "write",
  });
  return `https://github.com/settings/personal-access-tokens/new?${query.toString()}`;
}

/* ---------- GitHub REST client (Contents API) ---------- */
export class GhError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export class GitHub {
  constructor(token) { this.token = token; }
  async req(path, opts = {}) {
    let res;
    try {
      res = await fetch("https://api.github.com" + path, {
        ...opts,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(this.token ? { Authorization: "Bearer " + this.token } : {}),
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
          ...(opts.headers || {}),
        },
      });
    } catch { throw new GhError(0, "network"); }
    if (res.status === 401) throw new GhError(401, "bad-token");
    if (res.status === 403 || res.status === 429) throw new GhError(res.status, "forbidden");
    if (res.status === 404) throw new GhError(404, "not-found");
    if (!res.ok) throw new GhError(res.status, "http-" + res.status);
    return res.status === 204 ? null : res.json();
  }
  repoInfo(repo) { return this.req(`/repos/${repo}`); }
  /** HEAD-style call used only to read response headers (CORS exposes `X-OAuth-Scopes`). */
  async head(path) {
    let res;
    try {
      res = await fetch("https://api.github.com" + path, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(this.token ? { Authorization: "Bearer " + this.token } : {}),
        },
      });
    } catch { throw new GhError(0, "network"); }
    return { status: res.status, headers: res.headers };
  }
  /** Scopes of a classic/OAuth token; empty for fine-grained tokens and anonymous calls. */
  async oauthScopes() {
    const { headers } = await this.head("/user");
    return (headers.get("x-oauth-scopes") || "").split(",").map((s) => s.trim()).filter(Boolean);
  }
  /**
   * Every repository this credential can actually reach, or null when the endpoint
   * is unavailable to it. A token limited to one repo returns just that repo, which is
   * how we prove the credential is scoped to this list and nothing else.
   */
  async accessibleRepos(limit = 100) {
    try {
      const list = await this.req(`/user/repos?per_page=${limit}&sort=full_name&direction=asc`);
      if (!Array.isArray(list)) return null;
      return list.map((r) => r.full_name).filter(Boolean);
    } catch (e) {
      if (e.status === 403 || e.status === 404) return null; // endpoint not granted to this token
      throw e;
    }
  }
  async getFile(repo, path, ref) {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    try {
      const data = await this.req(`/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${q}`);
      return { sha: data.sha, text: b64decode(data.content || "") };
    } catch (e) { if (e.status === 404) return null; throw e; }
  }
  async putFile(repo, path, text, { branch, sha, message }) {
    const body = { message, content: b64encode(text), branch };
    if (sha) body.sha = sha;
    const data = await this.req(`/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, {
      method: "PUT", body: JSON.stringify(body),
    });
    return data.content.sha;
  }
  async ensureBranch(repo, branch, fromBranch) {
    try { await this.req(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`); return; }
    catch (e) { if (e.status !== 404) throw e; }
    const src = await this.req(`/repos/${repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`);
    await this.req(`/repos/${repo}/git/refs`, {
      method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: src.object.sha }),
    });
  }
}

/**
 * Prove a credential can reach this repository — and nothing else.
 * Classic tokens always cover every repository the user owns, so they are refused.
 * For fine-grained tokens we ask GitHub which repositories the credential reaches,
 * then confirm the target repository itself is visible.
 * @returns {{ok:boolean, reason?:string, others:string[]}} reason: classic | unknown | broad | no-repo
 */
export async function auditTokenScope(client, token, repo) {
  const kind = tokenKind(token);
  if (kind === "classic") return { ok: false, reason: "classic", others: [] };
  if (kind === "unknown") return { ok: false, reason: "unknown", others: [] };
  try {
    if ((await client.oauthScopes()).includes("repo")) return { ok: false, reason: "classic", others: [] };
  } catch { /* no scope header (fine-grained token) — the repository check below still applies */ }
  let others = null;
  try {
    const repos = await client.accessibleRepos();
    if (Array.isArray(repos)) others = repos.filter((r) => String(r).toLowerCase() !== String(repo).toLowerCase());
  } catch { /* listing unavailable — the repository check below still applies */ }
  // the repository itself comes first: "your token is not for this repo" is more useful
  // (and not overridable) than "your token is wider than it needs to be"
  let info = null;
  try {
    info = await client.repoInfo(repo);
  } catch (e) {
    if (e.status === 404) return { ok: false, reason: "no-repo", others: others || [] };
    throw e;
  }
  if (others && others.length) return { ok: false, reason: "broad", others, info };
  return { ok: true, others: others || [], info };
}

/* ---------- i18n ---------- */
export const STR = {
  fa: {
    "a11y.skip": "پرش به لیست کارها", "a11y.theme": "تغییر تم", "a11y.settings": "تنظیمات",
    "brand.tagline": "لیست کارهای رنگی", "hero.line1": "امروز چی", "hero.line2": "می‌خوای بسازی؟",
    "hero.sub": "هر تیک، یه جشن کوچیکه.", "stats.doneLabel": "انجام‌شده", "stats.active": "در جریان",
    "stats.today": "امروز", "stats.streak": "روز پیاپی", "stats.week": "هفت روز اخیر",
    "composer.title": "یه کار جدید", "composer.placeholder": "مثلاً: یه قهوه بخور و پروژه رو شروع کن…",
    "composer.tags": "برچسب‌ها با ویرگول: کار، خانه", "composer.enter": "برای اضافه کردن",
    "prio.high": "فوری", "prio.normal": "معمولی", "prio.low": "آروم",
    "sync.demoTitle": "داده‌ها فقط روی این دستگاهه", "sync.demoText": "با یه توکن گیت‌هاب، لیستت رو بین همه دستگاه‌ها همگام کن.",
    "sync.connect": "اتصال به گیت‌هاب", "sync.lockedTitle": "لیستت قفل شده",
    "sync.lockedText": "رمز سینک رو وارد کن تا قفل باز بشه و همگام‌سازی ادامه پیدا کنه.",
    "sync.lockedBtn": "باز کردن قفل", "sync.syncedTitle": "همگام با گیت‌هاب",
    "sync.errorTitle": "همگام‌سازی به مشکل خورد", "sync.retry": "تلاش دوباره",
    "filter.all": "همه", "filter.active": "در جریان", "filter.done": "انجام‌شده", "filter.search": "جستجو…",
    "sort.manual": "دستی", "sort.due": "موعد", "sort.priority": "اولویت", "sort.new": "جدیدترین",
    "list.activeTitle": "کارها", "list.doneTitle": "انجام‌شده", "list.clearDone": "پاک کردن", "list.live": "همیشه با تو",
    "empty.title": "اینجا خالیه، مثل یه بوم سفید", "empty.text": "اولین کارت رو اضافه کن تا جادو شروع بشه.", "empty.cta": "شروع کن",
    "empty.searchTitle": "چیزی پیدا نشد", "empty.searchText": "یه عبارت دیگه امتحان کن.",
    "empty.doneTitle": "هنوز چیزی انجام نشده", "empty.doneText": "اولین تیک رو بزن، منتظریم!",
    "task.editTitle": "ویرایش کار", "task.title": "عنوان", "task.notes": "یادداشت",
    "task.notesPh": "جزئیات، لینک، هر چیزی که کمکت می‌کنه…", "task.priority": "اولویت", "task.due": "موعد",
    "due.today": "امروز", "due.tomorrow": "فردا", "due.week": "یه هفته دیگه", "due.clear": "بدون موعد",
    "task.tags": "برچسب‌ها", "task.tagsPh": "با ویرگول جدا کن", "task.delete": "حذف",
    "common.cancel": "انصراف", "common.save": "ذخیره", "common.copy": "کپی", "common.confirm": "بله، انجام بده",
    "settings.title": "تنظیمات", "settings.look": "ظاهر", "settings.sync": "همگام‌سازی", "settings.about": "درباره",
    "settings.theme": "تم", "settings.themeHint": "روز، شب یا هماهنگ با سیستم",
    "settings.auto": "خودکار", "settings.day": "روز", "settings.night": "شب",
    "settings.lang": "زبان", "settings.langHint": "فارسی یا انگلیسی",
    "settings.motion": "انیمیشن‌ها", "settings.motionHint": "اگر دستگاهت ضعیفه، کمشون کن",
    "settings.sound": "صداهای شیطون", "settings.soundHint": "تیک‌ها و کلیک‌ها صدا داشته باشن",
    "settings.export": "پشتیبان‌گیری", "settings.exportHint": "یه فایل JSON از همه کارها بگیر",
    "settings.exportBtn": "خروجی", "settings.importBtn": "ورود",
    "sync.settingsDemo": "هنوز به گیت‌هاب وصل نیستی. کارها فقط روی همین مرورگر ذخیره می‌شن.",
    "sync.repo": "مخزن", "sync.branch": "شاخه داده", "sync.last": "آخرین همگام‌سازی", "sync.fingerprint": "شناسه سینک",
    "sync.now": "همگام‌سازی الان", "sync.invite": "دعوت دستگاه دیگه", "sync.changePass": "تغییر رمز سینک",
    "sync.securityNote": "توکن و داده‌ها با رمز سینک رمزنگاری می‌شن. رمز رو گم کنی، راهی برای بازیابی نیست؛ ولی می‌تونی از گیت‌هاب توکن جدید بسازی.",
    "sync.disconnect": "قطع اتصال این دستگاه",
    "about.tagline": "تودولیست پاستیلی، سه‌بعدی و بدون سرور. داده‌ها روی گیت‌هابِ خودت زندگی می‌کنن.",
    "about.shortcuts": "میان‌برهای کیبورد", "about.kbdNew": "کار جدید", "about.kbdSearch": "جستجو",
    "about.kbdTheme": "تغییر تم", "about.kbdSync": "همگام‌سازی", "about.kbdHelp": "راهنما", "about.kbdClose": "بستن پنجره",
    "about.links": "لینک‌ها", "about.source": "سورس روی گیت‌هاب", "about.guide": "راهنمای راه‌اندازی",
    "about.fine": "هیچ سروری، هیچ حسابی، هیچ ردیابی‌ای. فقط مرورگر تو + گیت‌هاب خودت. ☁️",
    "connect.title": "همگام‌سازی با گیت‌هاب", "connect.tabOwner": "من صاحب لیستم", "connect.tabJoin": "با رمز سینک وارد می‌شم",
    "connect.ownerIntro": "یه توکن گیت‌هاب بساز، اینجا بذار، و یه رمز سینک انتخاب کن. از این به بعد همه دستگاه‌ها با همون رمز به لیستت می‌رسن.",
    "connect.tokenHelp": "چطور توکن بسازم؟", "connect.repo": "مخزن گیت‌هاب", "connect.device": "اسم این دستگاه",
    "connect.token": "توکن دسترسی (Fine-grained)",
    "token.recipeTitle": "توکن فقط برای همین یک مخزن",
    "token.recipeLead": "با این لینک، گیت‌هاب خودش اسم، انقضا و دسترسی Contents رو پُر می‌کنه؛ تو فقط دو کلیک داری:",
    "token.step1": "در Repository access گزینه «Only select repositories» را انتخاب کن.",
    "token.step2": "فقط همین مخزن را انتخاب کن:",
    "token.step3": "در Repository permissions فقط Contents را روی «Read and write» بگذار.",
    "token.makeBtn": "ساخت توکن در گیت‌هاب (پُرشده)",
    "token.copyRepo": "کپی نام مخزن",
    "token.recipeNote": "توکن کلاسیک (ghp_…) قبول نمی‌شود چون به همهٔ مخزن‌های تو دسترسی می‌دهد.",
    "token.fixBtn": "ساخت توکن درست برای همین مخزن",
    "token.override": "می‌دونم؛ با همین توکن ادامه بده",
    "connect.pass": "رمز سینک", "connect.passHint": "حداقل ۱۰ کاراکتر؛ چند کلمه تصادفی بهترین گزینه‌ست.", "connect.pass2": "تکرار رمز",
    "connect.encrypt": "داده‌ها رمزنگاری بشن", "connect.encryptHint": "پیشنهاد می‌شه؛ حتی اگه مخزن عمومی باشه، متن کارها دیده نمی‌شه.",
    "connect.advanced": "تنظیمات پیشرفته", "connect.branch": "شاخه داده", "connect.path": "مسیر فایل",
    "connect.publish": "انتشار قفل رمزدار روی سایت", "connect.publishHint": "برای اینکه دستگاه‌های دیگه فقط با رمز سینک وصل بشن. فقط متن رمزنگاری‌شده منتشر می‌شه.",
    "connect.advancedNote": "فایل داده در یه شاخه جدا ذخیره می‌شه تا ساخت خودکار سایت گیت‌هاب رو به هم نریزه.",
    "connect.submit": "اتصال و ساخت رمز سینک",
    "connect.fineOwner": "توکن فقط برای درخواست‌های API به گیت‌هاب فرستاده می‌شه و داخل قفل رمزنگاری‌شده نگه داشته می‌شه. با روشن‌کردن «به خاطر بسپار»، یک نسخه‌ی رمزنگاری‌شده هم روی همین مرورگر می‌مونه.",
    "connect.syncPass": "رمز سینک", "connect.joinSubmit": "باز کردن قفل و همگام‌سازی",
    "connect.remember": "این دستگاه رو به خاطر بسپار", "connect.rememberHint": "با روشن‌کردن، دفعه بعد بدون رمز باز می‌شه؛ فقط روی دستگاه شخصی و غیرمشترک.",
    "connect.haveCode": "کد دعوت یا لینک اختصاصی دارم", "connect.codeNote": "اگه قفل روی سایت منتشر نشده، کد رمزنگاری‌شده‌ای که صاحب لیست بهت داده رو اینجا بذار.",
    "connect.useCode": "استفاده از این کد", "connect.demo": "فعلاً با حالت نمایش بازی کن", "connect.footerNote": "بدون سرور · داده روی مخزن خودت",
    "connect.fineJoin": "رمز سینک رو از صاحب لیست بگیر. رمز اشتباه = قفل باز نمی‌شه و هیچ داده‌ای لو نمی‌ره.",
    "invite.title": "دعوت یه دستگاه دیگه", "invite.lead": "لینک سایت رو بفرست و رمز سینک رو جداگانه بگو. همین!",
    "invite.step1": "دستگاه دیگه لینک زیر رو باز کنه.", "invite.step2": "تب «با رمز سینک وارد می‌شم» رو بزنه.",
    "invite.step3": "رمز سینک رو وارد کنه — تمام!", "invite.link": "لینک سایت",
    "invite.fingerprint": "شناسه سینک", "invite.fingerprintHint": "روی هر دو دستگاه باید یکی باشه.",
    "invite.warning": "رمز سینک کلید دسترسی به مخزنه. فقط به آدم‌های مورد اعتماد بده و از پیام‌رسان امن استفاده کن.",
    "invite.copyMsg": "کپی متن دعوت", "invite.copyCode": "کپی کد پشتیبان",
    "invite.fine": "رمز سینک هیچ‌جا ذخیره نمی‌شه؛ خودت باید یادت باشه.",
    "pass.title": "رمز سینک جدید", "pass.lead": "قفل رمزدار با رمز جدید دوباره ساخته می‌شه. دستگاه‌های دیگه باید رمز جدید رو وارد کنن.",
    "pass.submit": "ساختن قفل جدید",
    "celebrate.title": "تمومه! همه‌ش انجام شد.", "celebrate.text": "یه نفس عمیق بکش، به خودت افتخار کن.", "celebrate.cta": "دمت گرم!",
    "foot.made": "ساخته‌شده با", "foot.and": "و کلی انیمیشن", "foot.shortcuts": "کلیدها",
    "greeting.morning": "صبح بخیر!", "greeting.noon": "ظهر بخیر!", "greeting.evening": "عصر بخیر!", "greeting.night": "نیمه‌شب بخیر، جغد شب!",
    "toast.added": "به لیست اضافه شد", "toast.done": "آفرین! انجام شد", "toast.undone": "برگشت به در جریان",
    "toast.deleted": "حذف شد", "toast.undo": "برگردوندن", "toast.saved": "ذخیره شد",
    "toast.synced": "همگام شد", "toast.connected": "متصل شدی! خوش اومدی", "toast.unlocked": "قفل باز شد",
    "toast.copied": "کپی شد", "toast.disconnected": "اتصال این دستگاه قطع شد",
    "toast.passChanged": "رمز سینک عوض شد؛ قفل جدید منتشر شد",
    "toast.imported": "کارها وارد شدن", "toast.clearedDone": "انجام‌شده‌ها پاک شدن",
    "err.repo": "آدرس مخزن رو مثل username/repo بنویس.", "err.token": "توکن رو وارد کن.",
    "err.passShort": "رمز سینک حداقل ۱۰ کاراکتر باشه.", "err.passMatch": "تکرار رمز با رمز یکی نیست.",
    "err.wrongPass": "رمز اشتباهه؛ قفل باز نشد.", "err.noVault": "قفل سینک روی این سایت پیدا نشد. از کد دعوت استفاده کن یا از صاحب لیست بپرس.",
    "err.badCode": "این کد دعوت معتبر نیست.", "err.badToken": "توکن قبول نشد. مطمئن شو Fine-grained ـه و دسترسی Contents داره.",
    "err.forbidden": "توکن به این مخزن دسترسی نوشتن نداره.", "err.network": "به اینترنت یا گیت‌هاب وصل نشد. دوباره تلاش کن.",
    "err.repoAccess": "به این مخزن دسترسی نداری؛ اسم مخزن یا دسترسی توکن رو چک کن.",
    "err.classicToken": "این توکن کلاسیکه و به همهٔ مخزن‌های تو دسترسی داره. توکن Fine-grained فقط برای همین یک مخزن بساز.",
    "err.tokenBroad": "این توکن فقط به همین مخزن محدود نیست؛ به این مخزن‌ها هم دسترسی داره: {repos}",
    "err.tokenNoRepo": "این توکن برای مخزن {repo} ساخته نشده و بهش دسترسی نداره.",
    "err.tokenNoRepoList": "مخزن‌هایی که این توکن الان می‌بینه: {repos}",
    "err.tokenUnknown": "این رشته شبیه توکن گیت‌هاب نیست. توکن‌های Fine-grained با github_pat_ شروع می‌شن.",
    "confirm.clearDone": "همه کارهای انجام‌شده پاک بشن؟", "confirm.disconnect": "اتصال این دستگاه قطع بشه؟ کارها روی گیت‌هاب می‌مونن، فقط این مرورگر جدا می‌شه.",
    "confirm.deleteTask": "این کار برای همیشه حذف بشه؟", "confirm.title": "مطمئنی؟",
    "pill.demo": "حالت نمایش", "pill.syncing": "در حال همگام‌سازی…", "pill.synced": "همگام شد", "pill.locked": "قفل‌شده", "pill.error": "خطای سینک", "pill.offline": "آفلاین",
    "due.today": "امروز", "due.tomorrow": "فردا", "due.overdue": "گذشته!",
    "count.tasks": "کار", "count.task": "کار",
    "vault.searching": "دنبال قفل سینک می‌گردم…", "vault.searchingText": "صبر کن، دارم سایت رو نگاه می‌کنم.",
    "vault.found": "قفل سینک پیدا شد", "vault.foundText": "فقط رمز سینک رو بزن تا به لیست برسی.",
    "vault.missing": "قفل روی سایت نیست", "vault.missingText": "از کد دعوتِ پایین استفاده کن، یا مطمئن شو صاحب لیست قفل رو منتشر کرده.",
    "vault.fromCode": "قفل از کد دعوت لود شد", "vault.fromCodeText": "حالا رمز سینک رو بزن.",
    "device.default": "دستگاه من",
  },
  en: {
    "a11y.skip": "Skip to task list", "a11y.theme": "Toggle theme", "a11y.settings": "Settings",
    "brand.tagline": "your colorful todo list", "hero.line1": "What are we", "hero.line2": "building today?",
    "hero.sub": "Every check is a tiny party.", "stats.doneLabel": "completed", "stats.active": "Active",
    "stats.today": "Today", "stats.streak": "day streak", "stats.week": "Last 7 days",
    "composer.title": "A new task", "composer.placeholder": "e.g. Grab a coffee and start the project…",
    "composer.tags": "Tags, comma separated: work, home", "composer.enter": "to add",
    "prio.high": "Urgent", "prio.normal": "Normal", "prio.low": "Chill",
    "sync.demoTitle": "Data lives only on this device", "sync.demoText": "Add a GitHub token and sync your list across every device.",
    "sync.connect": "Connect GitHub", "sync.lockedTitle": "Your list is locked",
    "sync.lockedText": "Enter the sync password to unlock and keep syncing.",
    "sync.lockedBtn": "Unlock", "sync.syncedTitle": "Synced with GitHub",
    "sync.errorTitle": "Sync hit a snag", "sync.retry": "Retry",
    "filter.all": "All", "filter.active": "Active", "filter.done": "Done", "filter.search": "Search…",
    "sort.manual": "Manual", "sort.due": "Due date", "sort.priority": "Priority", "sort.new": "Newest",
    "list.activeTitle": "Tasks", "list.doneTitle": "Completed", "list.clearDone": "Clear", "list.live": "always with you",
    "empty.title": "Empty here — a blank canvas", "empty.text": "Add your first task and let the magic begin.", "empty.cta": "Start",
    "empty.searchTitle": "Nothing found", "empty.searchText": "Try a different search.",
    "empty.doneTitle": "Nothing completed yet", "empty.doneText": "Tick the first one off — we're waiting!",
    "task.editTitle": "Edit task", "task.title": "Title", "task.notes": "Notes",
    "task.notesPh": "Details, links, anything that helps…", "task.priority": "Priority", "task.due": "Due",
    "due.today": "Today", "due.tomorrow": "Tomorrow", "due.week": "In a week", "due.clear": "No due date",
    "task.tags": "Tags", "task.tagsPh": "Separate with commas", "task.delete": "Delete",
    "common.cancel": "Cancel", "common.save": "Save", "common.copy": "Copy", "common.confirm": "Yes, do it",
    "settings.title": "Settings", "settings.look": "Look", "settings.sync": "Sync", "settings.about": "About",
    "settings.theme": "Theme", "settings.themeHint": "Day, night, or follow the system",
    "settings.auto": "Auto", "settings.day": "Day", "settings.night": "Night",
    "settings.lang": "Language", "settings.langHint": "Persian or English",
    "settings.motion": "Animations", "settings.motionHint": "Tone them down on weaker devices",
    "settings.sound": "Playful sounds", "settings.soundHint": "Little blips for ticks and clicks",
    "settings.export": "Backup", "settings.exportHint": "Download all tasks as JSON",
    "settings.exportBtn": "Export", "settings.importBtn": "Import",
    "sync.settingsDemo": "Not connected to GitHub yet. Tasks are stored only in this browser.",
    "sync.repo": "Repository", "sync.branch": "Data branch", "sync.last": "Last sync", "sync.fingerprint": "Sync ID",
    "sync.now": "Sync now", "sync.invite": "Invite another device", "sync.changePass": "Change sync password",
    "sync.securityNote": "Your token and data are encrypted with the sync password. Lose it and there's no recovery — but you can always mint a fresh token on GitHub.",
    "sync.disconnect": "Disconnect this device",
    "about.tagline": "A pastel, 3D, serverless todo list. Your data lives in your own GitHub.",
    "about.shortcuts": "Keyboard shortcuts", "about.kbdNew": "New task", "about.kbdSearch": "Search",
    "about.kbdTheme": "Toggle theme", "about.kbdSync": "Sync now", "about.kbdHelp": "Help", "about.kbdClose": "Close dialog",
    "about.links": "Links", "about.source": "Source on GitHub", "about.guide": "Setup guide",
    "about.fine": "No server, no account, no tracking. Just your browser + your GitHub. ☁️",
    "connect.title": "Sync with GitHub", "connect.tabOwner": "I own this list", "connect.tabJoin": "Join with sync password",
    "connect.ownerIntro": "Create a GitHub token, paste it here, and pick a sync password. Every other device joins with just that password.",
    "connect.tokenHelp": "How do I make a token?", "connect.repo": "GitHub repository", "connect.device": "This device's name",
    "connect.token": "Access token (Fine-grained)",
    "token.recipeTitle": "A token for this one repository only",
    "token.recipeLead": "This link makes GitHub pre-fill the name, expiration and Contents permission. You only have to make two choices:",
    "token.step1": "Under Repository access pick “Only select repositories”.",
    "token.step2": "Select just this repository:",
    "token.step3": "Under Repository permissions set Contents to “Read and write” — nothing else.",
    "token.makeBtn": "Create the token on GitHub (pre-filled)",
    "token.copyRepo": "Copy repo name",
    "token.recipeNote": "Classic tokens (ghp_…) are rejected: they reach every repository you own.",
    "token.fixBtn": "Create a token scoped to this repo",
    "token.override": "I know — continue with this token anyway",
    "connect.pass": "Sync password", "connect.passHint": "At least 10 characters; a few random words work best.", "connect.pass2": "Repeat password",
    "connect.encrypt": "Encrypt the data", "connect.encryptHint": "Recommended — task text stays hidden even in a public repo.",
    "connect.advanced": "Advanced", "connect.branch": "Data branch", "connect.path": "File path",
    "connect.publish": "Publish the encrypted vault on the site", "connect.publishHint": "Lets other devices join with only the password. Only encrypted text is published.",
    "connect.advancedNote": "Data is stored on a separate branch so it never triggers site rebuilds.",
    "connect.submit": "Connect & create sync password",
    "connect.fineOwner": "The token is sent to GitHub only for API requests and is kept in the encrypted vault. If you opt into Remember this device, an encrypted copy is also saved in this browser.",
    "connect.syncPass": "Sync password", "connect.joinSubmit": "Unlock & sync",
    "connect.remember": "Remember this device", "connect.rememberHint": "If enabled, opens without a password next time. Only enable on a private device.",
    "connect.haveCode": "I have an invite code", "connect.codeNote": "If the vault isn't published on the site, paste the encrypted code the list owner gave you.",
    "connect.useCode": "Use this code", "connect.demo": "Play with demo mode for now", "connect.footerNote": "Serverless · data in your own repo",
    "connect.fineJoin": "Get the sync password from the list owner. Wrong password = the vault simply won't open.",
    "invite.title": "Invite another device", "invite.lead": "Send the site link, then share the sync password separately. That's it!",
    "invite.step1": "Open the link below on the other device.", "invite.step2": "Pick the “Join with sync password” tab.",
    "invite.step3": "Enter the sync password — done!", "invite.link": "Site link",
    "invite.fingerprint": "Sync ID", "invite.fingerprintHint": "Must match on both devices.",
    "invite.warning": "The sync password is the key to the repository. Share it only with people you trust, over a secure channel.",
    "invite.copyMsg": "Copy invite message", "invite.copyCode": "Copy backup code",
    "invite.fine": "The sync password is never stored anywhere — you have to remember it.",
    "pass.title": "New sync password", "pass.lead": "A new encrypted vault will be published. Other devices must enter the new password.",
    "pass.submit": "Publish new vault",
    "celebrate.title": "All done!", "celebrate.text": "Take a deep breath — be proud of yourself.", "celebrate.cta": "You rock!",
    "foot.made": "Made with", "foot.and": "and way too many animations", "foot.shortcuts": "Keys",
    "greeting.morning": "Good morning!", "greeting.noon": "Good afternoon!", "greeting.evening": "Good evening!", "greeting.night": "Burning the midnight oil?",
    "toast.added": "Added to your list", "toast.done": "Nice — done!", "toast.undone": "Back to active",
    "toast.deleted": "Deleted", "toast.undo": "Undo", "toast.saved": "Saved",
    "toast.synced": "Synced", "toast.connected": "Connected — welcome!", "toast.unlocked": "Unlocked",
    "toast.copied": "Copied", "toast.disconnected": "This device was disconnected",
    "toast.passChanged": "Sync password changed; new vault published",
    "toast.imported": "Tasks imported", "toast.clearedDone": "Completed tasks cleared",
    "err.repo": "Write the repo as username/repo.", "err.token": "Paste your token.",
    "err.passShort": "Sync password needs at least 10 characters.", "err.passMatch": "Passwords don't match.",
    "err.wrongPass": "Wrong password — the vault stayed shut.", "err.noVault": "No sync vault found on this site. Use an invite code or ask the list owner.",
    "err.badCode": "That invite code isn't valid.", "err.badToken": "Token rejected. Make sure it's fine-grained with Contents access.",
    "err.forbidden": "This token can't write to that repository.", "err.network": "Couldn't reach the internet or GitHub. Try again.",
    "err.repoAccess": "No access to that repo — check the name or the token's repositories.",
    "err.classicToken": "That's a classic token, so it reaches every repository you own. Create a fine-grained token for this one repo instead.",
    "err.tokenBroad": "This token isn't limited to this repo — it can also reach: {repos}",
    "err.tokenNoRepo": "This token wasn't created for {repo}, so it can't reach it.",
    "err.tokenNoRepoList": "Repositories this token can currently see: {repos}",
    "err.tokenUnknown": "That doesn't look like a GitHub token. Fine-grained tokens start with github_pat_.",
    "confirm.clearDone": "Delete all completed tasks?", "confirm.disconnect": "Disconnect this device? Tasks stay on GitHub; only this browser detaches.",
    "confirm.deleteTask": "Delete this task forever?", "confirm.title": "Are you sure?",
    "pill.demo": "Demo mode", "pill.syncing": "Syncing…", "pill.synced": "Synced", "pill.locked": "Locked", "pill.error": "Sync error", "pill.offline": "Offline",
    "due.today": "Today", "due.tomorrow": "Tomorrow", "due.overdue": "Overdue!",
    "count.tasks": "tasks", "count.task": "task",
    "vault.searching": "Looking for the sync vault…", "vault.searchingText": "Checking this site for an encrypted vault.",
    "vault.found": "Sync vault found", "vault.foundText": "Just enter the sync password to reach the list.",
    "vault.missing": "No vault on this site", "vault.missingText": "Use the invite code below, or make sure the owner published the vault.",
    "vault.fromCode": "Vault loaded from invite code", "vault.fromCodeText": "Now enter the sync password.",
    "device.default": "My device",
  },
};
