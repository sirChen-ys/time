// 时间都去哪儿了 —— 后台 Service Worker（MV3）
// 只追踪“当前获得焦点窗口”里的活动标签页，累计每个网站域名的访问时长。
// 数据统一存放在 chrome.storage.local 中（Service Worker 里没有 localStorage）。
// 所有 chrome.* 异步 API 都通过回调包成 Promise，兼容不支持 Promise 返回值的内核。
// 不依赖任何内存状态（Service Worker 会休眠，内存变量会丢失），需要判断时直接查 chrome API。

// ---- 回调 -> Promise 的封装（兼容所有 Chromium 内核）----
function storageGet(key) {
    return new Promise(function (resolve) {
        chrome.storage.local.get(key, function (result) {
            resolve(result || {});
        });
    });
}
function storageSet(obj) {
    return new Promise(function (resolve) {
        chrome.storage.local.set(obj, function () {
            resolve();
        });
    });
}
function tabsQuery(query) {
    return new Promise(function (resolve) {
        chrome.tabs.query(query, function (tabs) {
            resolve(tabs || []);
        });
    });
}
function tabsGet(id) {
    return new Promise(function (resolve) {
        chrome.tabs.get(id, function (tab) {
            resolve(tab);
        });
    });
}
function windowsGet(id) {
    return new Promise(function (resolve) {
        chrome.windows.get(id, function (win) {
            resolve(win);
        });
    });
}
function windowsGetLastFocused() {
    return new Promise(function (resolve) {
        chrome.windows.getLastFocused(function (win) {
            resolve(win);
        });
    });
}

// 诊断日志：写入 storage，供弹窗展示，方便排查（后续可删除）
async function log(msg) {
    try {
        const { log } = await storageGet("log");
        const arr = log && log.slice ? log : [];
        arr.push(new Date().toLocaleTimeString() + " " + msg);
        while (arr.length > 30) {
            arr.shift();
        }
        await storageSet({ log: arr });
    } catch (e) {}
}

init();

// 首次使用/字段缺失时做初始化
async function init() {
    await log("init 开始");

    const state = await storageGet(["today", "show", "stats", "domains", "timer"]);

    // 补齐缺失的字段
    const patch = {};
    if (state.today == null) {
        patch.today = getDateString();
    }
    if (state.show == null) {
        // 插件默认显示前10个网站的访问时间
        patch.show = 10;
    }
    if (state.stats == null) {
        patch.stats = {};
    }
    if (state.domains == null) {
        patch.domains = [];
    }
    if (state.timer === undefined) {
        patch.timer = null;
    }
    // 存储版本号
    patch.version = chrome.runtime.getManifest().version;

    if (Object.keys(patch).length) {
        await storageSet(patch);
    }

    // Service Worker 可能因休眠被重启，重新为聚焦窗口恢复计时
    try {
        const win = await windowsGetLastFocused();
        if (win && win.focused && win.state !== "minimized") {
            await log("init 聚焦窗口 id=" + win.id);
            await startTimer(win.id);
        } else {
            await log("init 无聚焦窗口 focused=" + (win && win.focused) + " state=" + (win && win.state));
        }
    } catch (e) {
        await log("init getLastFocused 出错 " + (e && e.message));
    }

    // 空闲检测的灵敏度（最小 60 秒）
    chrome.idle.setDetectionInterval(60);

    // 周期任务：定期提交计时（避免意外退出丢失过多时间）+ 跨日检测
    chrome.alarms.create("tick", { periodInMinutes: 1 });

    await log("init 完成");
}

// 焦点窗口变化：切换窗口时，结束上一个窗口的计时，开始新窗口的计时
chrome.windows.onFocusChanged.addListener(async function (windowId) {
    await stopTimer();

    if (windowId !== chrome.windows.WINDOW_ID_NONE) {
        await startTimer(windowId);
    }
});

// 切换标签：如果发生在当前聚焦的窗口里，切换计时
chrome.tabs.onActivated.addListener(async function (activeInfo) {
    const win = await windowsGet(activeInfo.windowId);
    if (!win || !win.focused) {
        return;
    }

    const tab = await tabsGet(activeInfo.tabId);
    await stopTimer();
    await startTimerForTab(activeInfo.windowId, activeInfo.tabId, tab.url);
});

// 标签更新：如果活动标签的 url 改变了，就切换到新的网站计时
chrome.tabs.onUpdated.addListener(async function (tabId, changeInfo, tab) {
    // 这个 tab 不是最前端的，就不作处理
    if (!tab.active || changeInfo.url == null) {
        return;
    }

    const win = await windowsGet(tab.windowId);
    if (!win || !win.focused) {
        return;
    }

    await stopTimer();
    await startTimerForTab(tab.windowId, tabId, changeInfo.url);
});

// 窗口关闭：如果关闭的是正在计时的窗口，结束计时
chrome.windows.onRemoved.addListener(async function (windowId) {
    const { timer } = await storageGet("timer");
    if (timer && timer.windowId === windowId) {
        await stopTimer();
    }
});

// 空闲/锁屏检测：进入 idle/locked 停止计时，恢复 active 重新计时
chrome.idle.onStateChanged.addListener(async function (state) {
    if (state === "idle" || state === "locked") {
        await stopTimer();
    } else if (state === "active") {
        const win = await windowsGetLastFocused();
        if (win && win.focused && win.state !== "minimized") {
            await startTimer(win.id);
        }
    }
});

// 周期任务
chrome.alarms.onAlarm.addListener(async function (alarm) {
    if (alarm.name !== "tick") {
        return;
    }

    // 焦点窗口被最小化/失去焦点时，该停止计时
    await checkTimerWindow();
    // 提交当前计时并继续
    await commitTimer();
    // 跨日处理
    await checkDayRollover();
});

// 弹窗探测：返回当前状态，用于诊断后台是否存活
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.type === "ping") {
        sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    }
});

// 开始为某个窗口的活动标签页计时
async function startTimer(windowId) {
    const tabs = await tabsQuery({ windowId: windowId, active: true });
    if (!tabs || tabs.length === 0) {
        await log("startTimer 窗口无活动标签 windowId=" + windowId);
        return;
    }
    const tab = tabs[0];
    await startTimerForTab(windowId, tab.id, tab.url);
}

// 为具体某个标签页开始计时
async function startTimerForTab(windowId, tabId, url) {
    // 某些页面不需要计时，在此处过滤
    if (filterUrl(url)) {
        await log("过滤不计时 url=" + url);
        return;
    }

    const domain = extractDomain(url);
    await log("开始计时 domain=" + domain);
    await storageSet({
        timer: { windowId: windowId, tabId: tabId, domain: domain, start: Date.now() }
    });
}

// 提交当前计时：把这段时间累加到域名上，并把 start 重置为当前时间（继续计时）
async function commitTimer() {
    const { timer } = await storageGet("timer");
    if (!timer) {
        return;
    }

    const elapsed = Math.floor((Date.now() - timer.start) / 1000);
    if (elapsed > 0) {
        await addTime(timer.domain, elapsed);
    }

    timer.start = Date.now();
    await storageSet({ timer: timer });
}

// 停止当前计时：把这段时间累加到域名上，并清空计时状态
async function stopTimer() {
    const { timer } = await storageGet("timer");
    if (!timer) {
        return;
    }

    const elapsed = Math.floor((Date.now() - timer.start) / 1000);
    if (elapsed > 0) {
        await addTime(timer.domain, elapsed);
    }

    await storageSet({ timer: null });
}

// 给某个域名累加 seconds 秒，today 和 all 同时累加
async function addTime(domain, seconds) {
    const { stats, domains } = await storageGet(["stats", "domains"]);
    const s = stats || {};
    const d = domains || [];

    if (s[domain] == null) {
        s[domain] = { today: 0, all: 0 };
        if (d.indexOf(domain) < 0) {
            d.push(domain);
        }
    }

    s[domain].today += seconds;
    s[domain].all += seconds;

    await log("累加 domain=" + domain + " +" + seconds + "s");

    await storageSet({ stats: s, domains: d });
}

// 检查正在计时的窗口是否最小化/失去焦点，是则停止计时
async function checkTimerWindow() {
    const { timer } = await storageGet("timer");
    if (!timer) {
        return;
    }

    try {
        const win = await windowsGet(timer.windowId);
        if (win.state === "minimized" || win.focused === false) {
            await stopTimer();
        }
    } catch (e) {
        // 窗口已不存在
        await stopTimer();
    }
}

// 跨日处理：日期变了，就把每个域名的今日访问时间清零
async function checkDayRollover() {
    const today = getDateString();
    const state = await storageGet(["today", "stats"]);

    if (state.today !== today) {
        const stats = state.stats || {};
        for (const domain of Object.keys(stats)) {
            stats[domain].today = 0;
        }
        await storageSet({ today: today, stats: stats });
    }
}

function filterUrl(url) {
    if (url == null || url === "") {
        return true;
    }

    // 浏览器内置页面、扩展页面、本地文件等，不用计时
    if (url.startsWith("chrome://") ||
        url.startsWith("chrome-extension://") ||
        url.startsWith("edge://") ||
        url.startsWith("about:") ||
        url.startsWith("file://")) {
        return true;
    }
    // 下载链接类型
    if (url.startsWith("ed2k://")) {
        return true;
    }

    return false;
}

// 返回根据 url 求出的域名（去掉 www 前缀，保留非默认端口）
function extractDomain(url) {
    try {
        return new URL(url).host.replace(/^www\./, "");
    } catch (e) {
        return url;
    }
}

// 返回一个时间，格式：2018/1/25
function getDateString(millis) {
    if (millis != null) {
        return new Date(millis).toLocaleDateString("zh-Hans-CN");
    } else {
        return new Date().toLocaleDateString("zh-Hans-CN");
    }
}
