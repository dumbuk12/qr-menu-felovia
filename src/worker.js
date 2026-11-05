// The Worker: handles /api/menu, /admin/api/*, image upload/serve, and serves static files for everything else
import { franchises as defaultFranchises } from "../menu-data.js";

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
const COOKIE_NAME = "admin_session";
const IMAGE_KV_PREFIX = "image:";
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

const FRANCHISES = ["sahil", "aktif", "plus"];
const DEFAULT_FRANCHISE = "sahil";

function getMenuKey(franchise) {
  return `menu:data:${franchise}`;
}

async function getMenu(env, franchise) {
  const key = getMenuKey(franchise);
  const stored = await env.MENU_KV.get(key, "json");
  return stored || defaultFranchises[franchise] || defaultFranchises[DEFAULT_FRANCHISE];
}

async function getAllMenus(env) {
  const result = {};
  for (const f of FRANCHISES) {
    result[f] = await getMenu(env, f);
  }
  return result;
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

function getFranchiseFromRequest(request, url) {
  // Check query param first
  const queryFranchise = url.searchParams.get("franchise");
  if (queryFranchise && FRANCHISES.includes(queryFranchise)) {
    return queryFranchise;
  }
  // Check path: /api/menu/sahil
  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts[1] === "api" && pathParts[2] === "menu" && pathParts[3] && FRANCHISES.includes(pathParts[3])) {
    return pathParts[3];
  }
  return DEFAULT_FRANCHISE;
}

// --- Image handling ---

function sanitizeFilename(name) {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 120);
}

function getContentType(filename) {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

async function uploadImage(request, env) {
  if (!(await requireAuth(request, env))) {
    return jsonResponse({ error: "Not authenticated" }, { status: 401 });
  }

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return jsonResponse({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return jsonResponse({ error: "No file uploaded" }, { status: 400 });
  }

  if (file.size > MAX_IMAGE_SIZE) {
    return jsonResponse({ error: "File too large (max 5MB)" }, { status: 400 });
  }

  const originalName = sanitizeFilename(file.name || "image");
  const ext = originalName.slice(originalName.lastIndexOf(".")).toLowerCase();
  const allowedExts = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"];
  if (!allowedExts.includes(ext)) {
    return jsonResponse({ error: "Invalid file type (jpg, png, webp, gif, svg)" }, { status: 400 });
  }

  const timestamp = Date.now();
  const random = crypto.randomUUID().slice(0, 8);
  const filename = `${timestamp}-${random}${ext}`;
  const key = IMAGE_KV_PREFIX + filename;

  const arrayBuffer = await file.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

  const imageData = JSON.stringify({
    value: base64,
    contentType: getContentType(filename),
    originalName,
  });
  await env.MENU_KV.put(key, imageData);

  return jsonResponse({
    ok: true,
    filename,
    url: `/images/${filename}`,
    size: file.size,
  });
}

async function deleteImage(request, env, filename) {
  if (!(await requireAuth(request, env))) {
    return jsonResponse({ error: "Not authenticated" }, { status: 401 });
  }

  const safeFilename = sanitizeFilename(filename);
  const key = IMAGE_KV_PREFIX + safeFilename;
  await env.MENU_KV.delete(key);

  return jsonResponse({ ok: true });
}

async function serveImage(request, env, filename) {
  const safeFilename = sanitizeFilename(filename);
  const key = IMAGE_KV_PREFIX + safeFilename;

  const stored = await env.MENU_KV.get(key, { type: "json" });
  if (stored) {
    const { value, contentType } = stored;
    const binary = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    return new Response(binary, {
      headers: {
        "Content-Type": contentType || getContentType(safeFilename),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  const assetRequest = new Request(new URL(`/images/${safeFilename}`, request.url).toString(), request);
  return env.ASSETS.fetch(assetRequest);
}

async function listImages(env) {
  const manifest = await env.MENU_KV.get(IMAGE_KV_PREFIX + "manifest", "json");
  return manifest?.files || [];
}

async function addToManifest(env, filename) {
  const manifest = await env.MENU_KV.get(IMAGE_KV_PREFIX + "manifest", "json") || { files: [] };
  if (!manifest.files.includes(filename)) {
    manifest.files.push(filename);
    await env.MENU_KV.put(IMAGE_KV_PREFIX + "manifest", JSON.stringify(manifest));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // --- Public API: Menu (with franchise support) ---
    if (pathname.startsWith("/api/menu") && request.method === "GET") {
      const franchise = getFranchiseFromRequest(request, url);
      const menu = await getMenu(env, franchise);
      return jsonResponse(menu, { headers: { "Cache-Control": "public, max-age=60" } });
    }

    // --- Admin: Auth ---
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

    // --- Admin: Menu CRUD (per franchise) ---
    if (pathname === "/admin/api/menu") {
      if (!(await requireAuth(request, env))) {
        return jsonResponse({ error: "Not authenticated" }, { status: 401 });
      }

      const franchise = url.searchParams.get("franchise") || DEFAULT_FRANCHISE;
      if (!FRANCHISES.includes(franchise)) {
        return jsonResponse({ error: "Invalid franchise" }, { status: 400 });
      }

      if (request.method === "GET") {
        return jsonResponse(await getMenu(env, franchise));
      }

      if (request.method === "PUT") {
        const body = await request.json().catch(() => null);
        const error = validateMenu(body);
        if (error) return jsonResponse({ error }, { status: 400 });
        await env.MENU_KV.put(getMenuKey(franchise), JSON.stringify(body));
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: "Method not allowed" }, { status: 405 });
    }

    // --- Admin: All franchises menu (for overview) ---
    if (pathname === "/admin/api/menus" && request.method === "GET") {
      if (!(await requireAuth(request, env))) {
        return jsonResponse({ error: "Not authenticated" }, { status: 401 });
      }
      return jsonResponse(await getAllMenus(env));
    }

    // --- Admin: Image upload ---
    if (pathname === "/admin/api/images" && request.method === "POST") {
      const result = await uploadImage(request, env);
      const data = await result.clone().json().catch(() => ({}));
      if (data.ok && data.filename) {
        await addToManifest(env, data.filename);
      }
      return result;
    }

    // --- Admin: Image list ---
    if (pathname === "/admin/api/images" && request.method === "GET") {
      if (!(await requireAuth(request, env))) {
        return jsonResponse({ error: "Not authenticated" }, { status: 401 });
      }
      const files = await listImages(env);
      return jsonResponse({ files });
    }

    // --- Admin: Image delete ---
    if (pathname.startsWith("/admin/api/images/") && request.method === "DELETE") {
      const filename = pathname.slice("/admin/api/images/".length);
      return deleteImage(request, env, filename);
    }

    // --- Public: Image serving (from KV or static assets) ---
    if (pathname.startsWith("/images/")) {
      const filename = pathname.slice("/images/".length);
      if (filename) {
        return serveImage(request, env, filename);
      }
    }

    // --- Everything else: serve files from /public ---
    return env.ASSETS.fetch(request);
  },
};