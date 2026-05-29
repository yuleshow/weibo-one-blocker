// Content script — runs on weibo.com pages
// Handles API calls using the page's cookies (session auth)

(() => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "resolveScreenName") {
      resolveScreenName(message.screenName)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, msg: e.message }));
      return true;
    }

    if (message.action === "blockUser") {
      blockUser(message.uid)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, msg: e.message }));
      return true;
    }

    if (message.action === "ping") {
      sendResponse({ ok: true });
      return;
    }
  });

  function getXsrfToken() {
    const match = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  async function resolveScreenName(screenName) {
    const xsrf = getXsrfToken();
    if (!xsrf) return { ok: false, msg: "未登录 weibo.com" };

    const debug = [];

    // Endpoint 1: /ajax/profile/info
    try {
      const resp = await fetch(
        `https://weibo.com/ajax/profile/info?screen_name=${encodeURIComponent(screenName)}`,
        { headers: { "X-XSRF-TOKEN": xsrf }, credentials: "same-origin" }
      );
      const text = await resp.text();
      debug.push(`profile/info: ${resp.status} ${text.substring(0, 120)}`);
      if (resp.ok) {
        try {
          const data = JSON.parse(text);
          const user = data.data?.user || data.user;
          if (user && (user.id || user.idstr)) {
            return {
              ok: true,
              uid: String(user.idstr || user.id),
              screenName: user.screen_name,
            };
          }
        } catch (e) { /* not json */ }
      }
    } catch (e) { debug.push(`profile/info error: ${e.message}`); }

    // Endpoint 2: /ajax/user/profile
    try {
      const resp = await fetch(
        `https://weibo.com/ajax/user/profile?screen_name=${encodeURIComponent(screenName)}`,
        { headers: { "X-XSRF-TOKEN": xsrf }, credentials: "same-origin" }
      );
      const text = await resp.text();
      debug.push(`user/profile: ${resp.status} ${text.substring(0, 120)}`);
      if (resp.ok) {
        try {
          const data = JSON.parse(text);
          const user = data.data?.user || data.user;
          if (user && (user.id || user.idstr)) {
            return {
              ok: true,
              uid: String(user.idstr || user.id),
              screenName: user.screen_name,
            };
          }
        } catch (e) { /* not json */ }
      }
    } catch (e) { debug.push(`user/profile error: ${e.message}`); }

    // Endpoint 3: side search
    try {
      const resp = await fetch(
        `https://weibo.com/ajax/side/search?q=${encodeURIComponent(screenName)}`,
        { headers: { "X-XSRF-TOKEN": xsrf }, credentials: "same-origin" }
      );
      const text = await resp.text();
      debug.push(`side/search: ${resp.status} ${text.substring(0, 200)}`);
      if (resp.ok) {
        try {
          const data = JSON.parse(text);
          const users = data.data?.users || [];
          const match = users.find(
            (u) => u.screen_name === screenName || u.nick_name === screenName
          );
          if (match) {
            return {
              ok: true,
              uid: String(match.idstr || match.id || match.uid),
              screenName: match.screen_name,
            };
          }
        } catch (e) { /* not json */ }
      }
    } catch (e) { debug.push(`side/search error: ${e.message}`); }

    return { ok: false, msg: "无法找到: " + debug.join(" | ") };
  }

  async function blockUser(uid) {
    const xsrf = getXsrfToken();
    if (!xsrf) return { ok: false, msg: "未登录 weibo.com" };

    try {
      const resp = await fetch("https://weibo.com/ajax/statuses/filterUser", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-XSRF-TOKEN": xsrf,
        },
        body: `uid=${encodeURIComponent(uid)}`,
        credentials: "same-origin",
      });

      if (!resp.ok) return { ok: false, msg: `HTTP ${resp.status}` };

      const data = await resp.json();
      if (data.ok === 1) return { ok: true };
      return { ok: false, msg: data.msg || data.message || JSON.stringify(data) };
    } catch (e) {
      return { ok: false, msg: e.message };
    }
  }
})();
