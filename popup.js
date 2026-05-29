document.addEventListener("DOMContentLoaded", () => {
  const uidList = document.getElementById("uidList");
  const blockBtn = document.getElementById("blockBtn");
  const clearBtn = document.getElementById("clearBtn");
  const loadListBtn = document.getElementById("loadListBtn");
  const statusBar = document.getElementById("statusBar");
  const statusText = document.getElementById("statusText");
  const delayInput = document.getElementById("delay");
  const resultArea = document.getElementById("resultArea");
  const resultList = document.getElementById("resultList");

  // Load saved UIDs from storage
  chrome.storage.local.get(["savedUids", "delay"], (data) => {
    if (data.savedUids) uidList.value = data.savedUids;
    if (data.delay) delayInput.value = data.delay;
  });

  uidList.addEventListener("input", () => {
    chrome.storage.local.set({ savedUids: uidList.value });
  });

  delayInput.addEventListener("change", () => {
    chrome.storage.local.set({ delay: delayInput.value });
  });

  // Load pre-defined blocklist
  loadListBtn.addEventListener("click", () => {
    if (typeof BLOCKLIST === "undefined" || BLOCKLIST.length === 0) {
      setStatus("黑名单为空", "error");
      return;
    }
    const names = [];
    BLOCKLIST.forEach((entry) => {
      names.push(entry.name);
      if (entry.alts) {
        entry.alts.forEach((alt) => names.push(alt));
      }
    });
    const existing = uidList.value.trim();
    uidList.value = existing ? existing + "\n" + names.join("\n") : names.join("\n");
    chrome.storage.local.set({ savedUids: uidList.value });
    setStatus(`已加载 ${names.length} 个用户名（含小号）`, "success");
  });

  clearBtn.addEventListener("click", () => {
    uidList.value = "";
    resultArea.style.display = "none";
    resultList.innerHTML = "";
    setStatus("就绪", "");
    chrome.storage.local.remove("savedUids");
  });

  blockBtn.addEventListener("click", async () => {
    const entries = parseEntries(uidList.value);
    if (entries.length === 0) {
      setStatus("请输入至少一个用户名或 UID", "error");
      return;
    }

    const delay = Math.max(500, parseInt(delayInput.value) || 1000);
    blockBtn.disabled = true;
    loadListBtn.disabled = true;
    resultArea.style.display = "block";
    resultList.innerHTML = "";

    setStatus(`正在处理 0/${entries.length} ...`, "running");

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      let uid = entry.uid;
      const label = entry.display;

      setStatus(`${i + 1}/${entries.length} — ${label}`, "running");

      // If it's a screen name, resolve to UID first
      if (!uid) {
        try {
          addResult(label, "skip", "正在查询 UID ...");
          const resolved = await chrome.runtime.sendMessage({
            action: "resolveScreenName",
            screenName: entry.screenName,
          });
          if (resolved && resolved.ok) {
            uid = resolved.uid;
            updateLastResult(label, "skip", `UID: ${uid}，正在拉黑...`);
          } else {
            failCount++;
            const errMsg = resolved ? (resolved.msg || JSON.stringify(resolved)) : "无响应";
            updateLastResult(label, "fail", errMsg);
            if (i < entries.length - 1) await sleep(delay);
            continue;
          }
        } catch (err) {
          failCount++;
          updateLastResult(label, "fail", err.message || "查询异常");
          if (i < entries.length - 1) await sleep(delay);
          continue;
        }
        await sleep(Math.min(delay, 800)); // small gap between resolve and block
      }

      // Block the user
      try {
        const result = await chrome.runtime.sendMessage({
          action: "blockUser",
          uid: uid,
        });
        if (result && result.ok) {
          successCount++;
          updateLastResult(label, "success", `已拉黑 (UID: ${uid})`);
        } else {
          failCount++;
          updateLastResult(label, "fail", (result && result.msg) || "拉黑失败");
        }
      } catch (err) {
        failCount++;
        updateLastResult(label, "fail", err.message || "请求异常");
      }

      if (i < entries.length - 1) {
        await sleep(delay);
      }
    }

    setStatus(
      `完成！成功 ${successCount}，失败 ${failCount}`,
      successCount > 0 && failCount === 0 ? "success" : failCount > 0 ? "error" : ""
    );
    blockBtn.disabled = false;
    loadListBtn.disabled = false;
  });

  // Parse input: each line can be a UID, a URL, or a screen name
  function parseEntries(text) {
    return text
      .split(/[\n]+/)
      .map((line) => {
        line = line.trim();
        if (!line) return null;

        // URL with numeric UID
        const urlMatch = line.match(/weibo\.com\/u\/(\d+)/);
        if (urlMatch) return { uid: urlMatch[1], display: urlMatch[1] };

        const urlMatch2 = line.match(/weibo\.com\/(\d+)/);
        if (urlMatch2) return { uid: urlMatch2[1], display: urlMatch2[1] };

        // Plain numeric UID
        if (/^\d+$/.test(line)) return { uid: line, display: line };

        // Otherwise treat as screen name
        return { screenName: line, uid: null, display: line };
      })
      .filter((e) => e !== null);
  }

  function setStatus(text, type) {
    statusText.textContent = text;
    statusBar.className = "status-bar" + (type ? ` ${type}` : "");
  }

  function addResult(label, type, message) {
    const div = document.createElement("div");
    div.className = `result-item ${type}`;
    div.dataset.label = label;
    const icon = type === "success" ? "✅" : type === "fail" ? "❌" : "⏳";
    div.textContent = `${icon} ${label}: ${message}`;
    resultList.appendChild(div);
    resultList.scrollTop = resultList.scrollHeight;
  }

  function updateLastResult(label, type, message) {
    // Update the last result item matching this label
    const items = resultList.querySelectorAll(`[data-label="${CSS.escape(label)}"]`);
    const last = items[items.length - 1];
    if (last) {
      last.className = `result-item ${type}`;
      const icon = type === "success" ? "✅" : type === "fail" ? "❌" : "⏳";
      last.textContent = `${icon} ${label}: ${message}`;
    } else {
      addResult(label, type, message);
    }
    resultList.scrollTop = resultList.scrollHeight;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Dev: reload extension
  document.getElementById("reloadBtn").addEventListener("click", () => {
    chrome.runtime.reload();
  });
});
