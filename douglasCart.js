(async () => {
  /******** cfg ********/
  const PRODUCT_CODE = "1236490";
  const TARGET_QTY   = 1;

  // Optional: Overrides (nur setzen, wenn du manuell erzwingen willst)
  const FORCE_CC_UID  = "";                   // z.B. "00000050098v7s43"
  const FORCE_CDCAUTH = "";                   // kompletter JWT
  const FORCE_CDCREG  = "";                   // kompletter st2.s...
  const FORCE_CART_ID = "";                   // bekannte Cart-ID

  /******** utils ********/
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const getCookie = (n) => {
    const hit = document.cookie.split(";").map(s=>s.trim()).find(c=>c.startsWith(n+"="));
    return hit ? decodeURIComponent(hit.split("=").slice(1).join("=")) : null;
  };
  const csrf = () => getCookie("ncx");
  const mask = (s) => s ? (String(s).slice(0,8)+"…"+String(s).slice(-6)) : "";

  const read = async (res) => {
    const ct = res.headers.get("content-type") || "";
    try { return ct.includes("application/json") ? await res.json() : await res.text(); }
    catch { return "<unreadable>"; }
  };

  function normalizeToken(v) {
    if (!v) return "";
    try {
      if (v[0] === "{" || v[0] === "[") {
        const obj = JSON.parse(v);
        if (typeof obj === "string") return obj;
        if (obj?.token) return obj.token;
        if (obj?.value) return obj.value;
      }
    } catch {}
    return String(v).replace(/^"(.*)"$/,"$1").trim();
  }
  function b64urlJson(s) {
    try {
      s = String(s).replace(/-/g, "+").replace(/_/g, "/");
      s += "=".repeat((4 - (s.length % 4)) % 4);
      return JSON.parse(atob(s));
    } catch { return null; }
  }

  // tiefer & breit nach ccUID suchen
  function collectStringsDeep(obj, depth=0, out=[]) {
    if (!obj || typeof obj !== "object" || depth > 10) return out;
    for (const v of (Array.isArray(obj) ? obj : Object.values(obj))) {
      if (typeof v === "string") out.push(v);
      else if (v && typeof v === "object") collectStringsDeep(v, depth+1, out);
    }
    return out;
  }
  const isCcUidLike = (s) =>
    typeof s === "string"
    && /^[0-9a-z]{12,24}$/i.test(s)
    && /[a-z]/i.test(s) && /\d/.test(s);

  function findCcUIDEverywhere(jwt) {
    const hits = new Set();

    // 1) JWT-Payload: bekannte Keys + Deep-Scan + Plain-String-Scan
    if (jwt) {
      const parts = String(jwt).split(".");
      if (parts.length >= 2) {
        const payload = b64urlJson(parts[1]);
        if (payload) {
          const directKeys = [
            "ccUID","ccUid","ccUserId","cc_user_id",
            "uid","userId","customerId","customerNo"
          ];
          for (const k of directKeys) {
            const val = payload?.[k] || payload?.data?.[k];
            if (isCcUidLike(val)) hits.add(val);
          }
          // Deep object
          collectStringsDeep(payload).filter(isCcUidLike).forEach(h => hits.add(h));
          // Raw string scan
          try {
            const raw = atob(parts[1].replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(parts[1].length/4)*4,"="));
            (raw.match(/[0-9a-z]{12,24}/gi) || []).filter(isCcUidLike).forEach(h => hits.add(h));
          } catch {}
        }
      }
    }

    // 2) localStorage/sessionStorage
    const scanStore = (store) => {
      try {
        for (let i=0;i<store.length;i++) {
          const k = store.key(i), v = store.getItem(k);
          if (isCcUidLike(v)) hits.add(v);
          if (v && (v[0]==="{" || v[0]==="[")) {
            try { collectStringsDeep(JSON.parse(v)).filter(isCcUidLike).forEach(h => hits.add(h)); } catch {}
          }
        }
      } catch {}
    };
    scanStore(localStorage); scanStore(sessionStorage);

    // 3) Cookies
    (document.cookie.match(/[0-9a-z]{12,24}/gi) || [])
      .filter(isCcUidLike).forEach(h => hits.add(h));

    // 4) dataLayer & gängige Globals
    try { if (Array.isArray(window.dataLayer)) window.dataLayer.forEach(x => collectStringsDeep(x).filter(isCcUidLike).forEach(h=>hits.add(h))); } catch {}
    for (const g of ["__APP_CONFIG__","AppConfig","ENV","__NUXT__","__NEXT_DATA__","__INITIAL_STATE__"]) {
      try { if (window[g]) collectStringsDeep(window[g]).filter(isCcUidLike).forEach(h=>hits.add(h)); } catch {}
    }

    return Array.from(hits);
  }

  function getTokensFromLocalStorage() {
    const rawJwt = localStorage.getItem("gjwt") || "";
    const rawReg = localStorage.getItem("grt")  || "";
    const jwt = normalizeToken(rawJwt);
    const reg = normalizeToken(rawReg);
    return { jwt, reg };
  }

  function baseHeaders(extra={}) {
    const tok = csrf();
    if (!tok) throw new Error("Kein CSRF (ncx) Cookie gefunden.");
    return {
      "Accept":"application/json",
      "Content-Type":"application/json",
      "X-Requested-With":"XMLHttpRequest",
      "x-csrf-token": tok,
      ...extra
    };
  }

  async function resolveCartId(auth, uid, hint) {
    if (hint) return hint;
    const r = await fetch(`/jsapi/v2/users/carts?fields=DEFAULT&merge=true&validate=true`, {
      credentials: "include",
      headers: baseHeaders({
        ...(uid ? { "x-cc-user-id": uid } : {}),
        ...(auth.jwt ? { "cdcauthorization": auth.jwt } : {}),
        ...(auth.reg ? { "cdcregtoken": auth.reg } : {})
      })
    });
    if (!r.ok) return "";
    const b = await read(r);
    return b?.code || b?.guid || b?.cartId || "";
  }

  function flattenEntriesFromCart(cart) {
    const es = Array.isArray(cart?.entries) ? cart.entries : [];
    return es.map((e,i) => ({
      index: i,
      code: e?.product?.code || "",
      baseProduct: e?.product?.baseProduct || "",
      variants: (e?.product?.baseOptions || []).map(o => o?.selected?.code).filter(Boolean),
      name: e?.product?.name || "",
      qty: e?.quantity,
      total: e?.totalPrice?.formattedValue || e?.totalPrice?.value
    }));
  }
  function matchesTargetRow(row, target) {
    const t = String(target).toLowerCase();
    return row.code.toLowerCase() === t
        || (row.baseProduct || "").toLowerCase() === t
        || row.code.toLowerCase().startsWith(t + "-")
        || (row.variants || []).some(v => String(v).toLowerCase() === t || String(v).toLowerCase().startsWith(t+"-"));
  }

  async function fetchCartFull(cartId, auth, uid) {
    // Nur /users/carts?fields=FULL (der /current/cart/{id} redirectet/404ed bei dir)
    const r1 = await fetch(`/jsapi/v2/users/carts?fields=FULL&merge=true&validate=true`, {
      credentials: "include",
      headers: baseHeaders({
        ...(uid ? { "x-cc-user-id": uid } : {}),
        ...(auth.jwt ? { "cdcauthorization": auth.jwt } : {}),
        ...(auth.reg ? { "cdcregtoken": auth.reg } : {}),
        ...(cartId ? { "x-cart-id": cartId } : {})
      })
    });
    if (r1.ok) return r1.json();

    const r2 = await fetch(`/jsapi/v2/users/carts?fields=FULL&merge=true&validate=true`, {
      credentials: "include",
      headers: baseHeaders({
        ...(uid ? { "x-cc-user-id": uid } : {}),
        ...(auth.jwt ? { "cdcauthorization": auth.jwt } : {}),
        ...(auth.reg ? { "cdcregtoken": auth.reg } : {})
      })
    });
    return r2.ok ? r2.json() : null;
  }

  /******** flow ********/
  try {
    if (location.hostname !== "www.douglas.de") {
      console.warn("Bitte auf https://www.douglas.de (mit www.) ausführen. Aktuell:", location.hostname);
      return;
    }

    // Tokens laden
    const ls = getTokensFromLocalStorage();
    const JWT = FORCE_CDCAUTH || ls.jwt || "";
    const REG = FORCE_CDCREG  || ls.reg || "";

    // ccUID finden
    const ccFromJwt = JWT ? findCcUIDEverywhere(JWT)[0] || "" : "";
    const ccFromEverywhere = findCcUIDEverywhere(""); // ohne JWT → Storage/Cookies/Globals
    let UID = FORCE_CC_UID || ccFromJwt || ccFromEverywhere[0] || "";

    console.log("[tokens] gjwt:", mask(JWT), "| grt:", mask(REG), "| ccUID:", UID || "(leer)");

    // Cart ermitteln
    let cartId = await resolveCartId({ jwt: JWT, reg: REG }, UID, FORCE_CART_ID);
    console.log("[ctx] cartId:", cartId || "(leer)");

    // 1) addEntry – probiere zuerst mit UID, dann ohne UID, jeweils mit/ohne cartId
    async function tryAdd(useUid, useCartId) {
      const hdr = baseHeaders({
        ...(useUid && UID ? { "x-cc-user-id": UID } : {}),
        ...(JWT ? { "cdcauthorization": JWT } : {}),
        ...(REG ? { "cdcregtoken": REG } : {}),
        ...(useCartId && cartId ? { "x-cart-id": cartId } : {})
      });
      const res = await fetch(`/jsapi/v2/users/carts/entries`, {
        method: "POST",
        credentials: "include",
        headers: hdr,
        body: JSON.stringify({ code: PRODUCT_CODE, vendor: null, quantity: TARGET_QTY })
      });
      const body = await read(res);
      console.log(`[addEntry uid=${!!useUid} cart=${!!useCartId}]`, res.status, res.statusText, body);
      return { res, body };
    }

    let add = await tryAdd(true,  true);
    if (!add.res.ok) add = await tryAdd(true,  false);
    if (!add.res.ok) add = await tryAdd(false, true);
    if (!add.res.ok) add = await tryAdd(false, false);
    if (!add.res.ok) { console.warn("addEntry fehlgeschlagen (alle Varianten)."); return; }

    // cartId ggf. aus Add-Body/Header ziehen
    if (!cartId) cartId = add.res.headers.get("x-cart-id") || add.body?.code || add.body?.cartId || "";

    // 2) direkt im Add-Body nachsehen
    let rows = flattenEntriesFromCart(add.body);
    let found = rows.find(r => matchesTargetRow(r, PRODUCT_CODE));

    // 3) falls nicht gefunden → kurz pollen über users/carts (mit x-cart-id, falls vorhanden)
    if (!found) {
      for (let i=0;i<4;i++) {
        await wait(200 + i*150);
        const cartFull = await fetchCartFull(cartId, { jwt: JWT, reg: REG }, UID);
        rows = flattenEntriesFromCart(cartFull);
        found = rows.find(r => matchesTargetRow(r, PRODUCT_CODE));
        if (found) break;
      }
    }

    if (found) {
      console.log("✅ Artikel im Warenkorb gefunden:");
      console.table([found]);
    } else {
      console.warn("⚠️ Nach dem Hinzufügen kein passender Eintrag gefunden.");
      console.table(rows);
    }
  } catch (e) {
    console.error("[final cart-check] Fehler:", e);
  }
})();
