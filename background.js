// Background service worker

const BLOCKLIST_URLS = [
  "https://cdn.jsdelivr.net/gh/yuleshow/weibo-one-blocker@main/blocklist.js",
  "https://raw.githubusercontent.com/yuleshow/weibo-one-blocker/main/blocklist.js",
  "https://fastly.jsdelivr.net/gh/yuleshow/weibo-one-blocker@main/blocklist.js",
];
const SYNC_ALARM = "syncBlocklist";
const SYNC_INTERVAL_MINUTES = 60; // sync every hour

// --- Blocklist sync ---

function parseBlocklistText(text) {
  const match = text.match(/const\s+BLOCKLIST\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) return null;
  const arr = (0, eval)("(" + match[1] + ")");
  if (!Array.isArray(arr)) return null;
  const names = [];
  arr.forEach((entry) => {
    if (entry.name) names.push(entry.name);
    if (entry.alts) entry.alts.forEach((a) => names.push(a));
  });
  return { entries: arr, names, fetchedAt: Date.now() };
}

async function fetchRemoteBlocklist() {
  for (const url of BLOCKLIST_URLS) {
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) continue;
      const text = await res.text();
      const data = parseBlocklistText(text);
      if (data) {
        data.source = url;
        return data;
      }
    } catch (e) {
      console.warn("[weibo-blocker] fetch failed:", url, e.message);
    }
  }
  console.error("[weibo-blocker] all sync sources failed");
  return null;
}

async function syncBlocklist() {
  const data = await fetchRemoteBlocklist();
  if (data) {
    await chrome.storage.local.set({ remoteBlocklist: data });
    console.log("[weibo-blocker] synced", data.names.length, "names from remote");
  }
}

// On install / update: sync immediately + set up alarm
chrome.runtime.onInstalled.addListener(() => {
  syncBlocklist();
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_INTERVAL_MINUTES });
});

// On startup: sync
chrome.runtime.onStartup.addListener(() => {
  syncBlocklist();
});

// Periodic alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncBlocklist();
});

// --- Message handling ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "blockUser" || message.action === "resolveScreenName") {
    handleMessage(message).then(sendResponse, (e) =>
      sendResponse({ ok: false, msg: "bg-error: " + String(e) })
    );
    return true;
  }
  if (message.action === "syncBlocklist") {
    syncBlocklist().then(() => {
      chrome.storage.local.get("remoteBlocklist", (d) => {
        sendResponse(d.remoteBlocklist || null);
      });
    });
    return true;
  }
  if (message.action === "getRemoteBlocklist") {
    chrome.storage.local.get("remoteBlocklist", (d) => {
      sendResponse(d.remoteBlocklist || null);
    });
    return true;
  }
});

async function handleMessage(message) {
  const tabs = await chrome.tabs.query({
    url: ["https://weibo.com/*", "https://www.weibo.com/*", "https://*.weibo.com/*"],
  });
  if (!tabs.length) return { ok: false, msg: "请先打开一个 weibo.com 页面" };
  const tabId = tabs[0].id;
  const key = "__wbb_" + Date.now() + "_" + Math.random().toString(36).slice(2);

  // Step 1: Fire async work in MAIN world (function must be sync, async inside via .then)
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: fireAndForget,
      args: [key, message],
    });
  } catch (err) {
    return { ok: false, msg: "exec失败: " + err.message };
  }

  // Step 2: Poll window[key] from MAIN world
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    try {
      const poll = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: function (k) { var v = window[k]; return v === undefined ? null : v; },
        args: [key],
      });
      const val = poll && poll[0] && poll[0].result;
      if (val !== null && val !== undefined) {
        // Cleanup
        chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN",
          func: function (k) { delete window[k]; }, args: [key],
        }).catch(function () {});
        return val;
      }
    } catch (err) {
      return { ok: false, msg: "poll失败: " + err.message };
    }
  }
  return { ok: false, msg: "超时(15s)" };
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Runs in MAIN world. MUST be synchronous (Chrome won't await promises).
// Async work happens inside .then() chains; result stored on window[key].
function fireAndForget(key, msg) {
  var xm = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
  if (!xm) { window[key] = { ok: false, msg: "no XSRF-TOKEN cookie" }; return; }
  var xsrf = decodeURIComponent(xm[1]);

  var origin = location.origin; // use page's actual origin (www.weibo.com, weibo.com, etc.)

  if (msg.action === "resolveScreenName") {
    var name = msg.screenName;
    var url1 = origin + "/ajax/profile/info?screen_name=" + encodeURIComponent(name);

    fetch(url1, { headers: { "X-XSRF-TOKEN": xsrf }, credentials: "same-origin" })
      .then(function (r) { return r.text().then(function (t) { return { status: r.status, text: t }; }); })
      .then(function (res) {
        if (res.status === 200 && res.text.charAt(0) === "{") {
          var d = JSON.parse(res.text);
          var u = (d.data && d.data.user) || d.user;
          if (u && (u.id || u.idstr)) {
            window[key] = { ok: true, uid: String(u.idstr || u.id), screenName: u.screen_name };
            return;
          }
        }
        // Try second API
        var url2 = origin + "/ajax/user/profile?screen_name=" + encodeURIComponent(name);
        return fetch(url2, { headers: { "X-XSRF-TOKEN": xsrf }, credentials: "same-origin" })
          .then(function (r2) { return r2.text().then(function (t2) { return { status: r2.status, text: t2, prev: res }; }); });
      })
      .then(function (res2) {
        if (!res2) return; // already resolved
        if (res2.status === 200 && res2.text.charAt(0) === "{") {
          var d2 = JSON.parse(res2.text);
          var u2 = (d2.data && d2.data.user) || d2.user;
          if (u2 && (u2.id || u2.idstr)) {
            window[key] = { ok: true, uid: String(u2.idstr || u2.id), screenName: u2.screen_name };
            return;
          }
        }
        // Both failed - show debug
        var dbg = "api0[" + (res2.prev ? res2.prev.status : "?") + "]:" + (res2.prev ? res2.prev.text.substring(0, 100) : "?");
        dbg += " | api1[" + res2.status + "]:" + res2.text.substring(0, 100);
        window[key] = { ok: false, msg: dbg };
      })
      .catch(function (e) { window[key] = { ok: false, msg: "fetch-err: " + e.message }; });

  } else if (msg.action === "blockUser") {
    fetch(origin + "/ajax/statuses/filterUser", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-XSRF-TOKEN": xsrf,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify({ uid: Number(msg.uid), status: 1, interact: 1, follow: 1 }),
      credentials: "same-origin",
    })
      .then(function (r) { return r.text().then(function (t) { return { status: r.status, text: t }; }); })
      .then(function (res) {
        if (res.text.charAt(0) === "{") {
          var d = JSON.parse(res.text);
          if (d.ok === 1) { window[key] = { ok: true }; return; }
          window[key] = { ok: false, msg: d.msg || d.message || JSON.stringify(d).substring(0, 100) };
        } else {
          window[key] = { ok: false, msg: "HTTP" + res.status + ": " + res.text.substring(0, 120) };
        }
      })
      .catch(function (e) { window[key] = { ok: false, msg: "block-err: " + e.message }; });

  } else {
    window[key] = { ok: false, msg: "unknown action" };
  }
}
