// The Worker: handles /api/menu, /admin/api/*, and serves static files for everything else
import { menu as defaultMenu } from "../menu-data.js";

const MENU_KEY = "menu:data";
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
const COOKIE_NAME = "admin_session";

async function getMenu(env) {
  const stored = await env.MENU_KV.get(MENU_KEY, "json");
  return stored || defaultMenu;
}

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function constantTimeEqual(a, b) {
  // Hash both first so comparison time doesn't leak input length either.
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

async function requireAuth(request, env) {
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return false;
  const session = await env.MENU_KV.get(`session:${token}`);
  return session !== null;
}

function sessionCookie(token, maxAge, secure) {
  const secureAttr = secure ? " Secure;" : "";
  return `${COOKIE_NAME}=${token}; HttpOnly;${secureAttr} SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function validateMenu(data) {
  if (!data || typeof data !== "object") return "Menu must be an object";
  if (!Array.isArray(data.categories)) return "categories must be an array";
  for (const cat of data.categories) {
    if (typeof cat.name !== "string" || !cat.name.trim()) return "Every category needs a name";
    if (!Array.isArray(cat.items)) return "Every category needs an items array";
    for (const item of cat.items) {
      if (typeof item.name !== "string" || !item.name.trim()) return "Every item needs a name";
      if (typeof item.price !== "number" || !Number.isFinite(item.price) || item.price < 0) {
        return `Invalid price for "${item.name || "item"}"`;
      }
      if (item.desc != null && typeof item.desc !== "string") return "desc must be a string";
      if (item.image != null && typeof item.image !== "string") return "image must be a string";
    }
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/menu" && request.method === "GET") {
      const menu = await getMenu(env);
      return jsonResponse(menu, { headers: { "Cache-Control": "public, max-age=60" } });
    }

    if (pathname === "/admin/api/login" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const password = body && typeof body.password === "string" ? body.password : "";
      if (!env.ADMIN_PASSWORD) {
        return jsonResponse({ error: "Admin login is not configured" }, { status: 500 });
      }
      const ok = password.length > 0 && (await constantTimeEqual(password, env.ADMIN_PASSWORD));
      if (!ok) return jsonResponse({ error: "Wrong password" }, { status: 401 });

      const token = crypto.randomUUID();
      await env.MENU_KV.put(`session:${token}`, "1", { expirationTtl: SESSION_TTL });
      const secure = url.protocol === "https:";
      return jsonResponse({ ok: true }, { headers: { "Set-Cookie": sessionCookie(token, SESSION_TTL, secure) } });
    }

    if (pathname === "/admin/api/logout" && request.method === "POST") {
      const token = getCookie(request, COOKIE_NAME);
      if (token) await env.MENU_KV.delete(`session:${token}`);
      const secure = url.protocol === "https:";
      return jsonResponse({ ok: true }, { headers: { "Set-Cookie": sessionCookie("", 0, secure) } });
    }

    if (pathname === "/admin/api/menu") {
      if (!(await requireAuth(request, env))) {
        return jsonResponse({ error: "Not authenticated" }, { status: 401 });
      }

      if (request.method === "GET") {
        return jsonResponse(await getMenu(env));
      }

      if (request.method === "PUT") {
        const body = await request.json().catch(() => null);
        const error = validateMenu(body);
        if (error) return jsonResponse({ error }, { status: 400 });
        await env.MENU_KV.put(MENU_KEY, JSON.stringify(body));
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: "Method not allowed" }, { status: 405 });
    }

    // Everything else: serve files from /public (the menu page, the admin page)
    return env.ASSETS.fetch(request);
  },
};
