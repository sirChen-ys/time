// 指定图表的配置项和数据
var option = null;
// 图表实例
var myChart = null;
// 后台探测结果
var bgStatus = "";
// 当前展示的是“今日”还是“总计”
var currentFlag = "today";
// 当前钻取的分组（null 表示汇总视图）
var drillGroup = null;

// 探测后台 Service Worker 是否存活
function pingBackground(cb) {
    try {
        chrome.runtime.sendMessage({ type: "ping" }, function (resp) {
            if (chrome.runtime.lastError) {
                bgStatus = "后台无响应：" + chrome.runtime.lastError.message;
            } else {
                bgStatus = "后台正常，版本 " + (resp && resp.version);
            }
            cb && cb();
        });
    } catch (e) {
        bgStatus = "ping 出错：" + (e && e.message);
        cb && cb();
    }
}

// 出错时把错误信息直接显示在页面上，方便排查
function showError(msg) {
    try {
        document.getElementById("main").innerHTML =
            "<div style='padding:20px;color:#c00;font-size:12px;'>错误：" + msg + "</div>";
    } catch (e) {}
}

window.onerror = function (msg, src, line) {
    showError(msg + "（" + (src || "") + ":" + line + "）");
    return false;
};

window.addEventListener("load", function () {
    try {
        // 绑定“今日 / 总计”切换
        $("#today").on("click", function () {
            switchView("today");
        });
        $("#all").on("click", function () {
            switchView("all");
        });

        // 返回汇总视图
        $("#back").on("click", function (e) {
            e.preventDefault();
            drillGroup = null;
            draw(currentFlag);
        });

        // 清空所有数据
        $("#clearData").on("click", function () {
            if (!confirm("确定要清空所有数据吗？此操作不可恢复。")) {
                return;
            }
            chrome.storage.local.clear(function () {
                drillGroup = null;
                // 清空后重新画图，会显示“还没有记录”
                draw("today");
            });
        });

        // 先探测后台，再画图（把探测结果一起显示）
        pingBackground(function () {
            draw("today");
        });
    } catch (e) {
        showError(e && e.message ? e.message : String(e));
    }
});

// 切换“今日 / 总计”
function switchView(flag) {
    drillGroup = null;
    if (flag === "today") {
        $("#today").addClass("cur");
        $("#all").removeClass("cur");
    } else {
        $("#all").addClass("cur");
        $("#today").removeClass("cur");
    }
    draw(flag);
}

// 在页面画出饼图，flag 有两种值：today 取当日数据，all 取总共数据
function draw(flag) {
    try {
        currentFlag = flag;
        chrome.storage.local.get(["stats", "domains", "show", "timer", "log"], function (data) {
            try {
                var stats = data.stats || {};
                var domains = data.domains || [];
                var showCounts = data.show || 10;
                var timer = data.timer;
                var logArr = data.log || [];

                // 当前正在计时的未提交时长，一并算进展示数据里
                var pending = 0;
                var pendingDomain = null;
                if (timer && timer.domain) {
                    pending = Math.floor((Date.now() - timer.start) / 1000);
                    if (pending > 0) {
                        pendingDomain = timer.domain;
                    }
                }

                initOption();

                // 组装每个域名的时间数据
                var arr = [];
                var i;
                for (i = 0; i < domains.length; i++) {
                    var domain = domains[i];
                    var stat = stats[domain];
                    if (stat == null) {
                        continue;
                    }
                    var value = flag === "today" ? stat.today : stat.all;
                    if (pendingDomain === domain) {
                        value += pending;
                    }
                    if (value != 0) {
                        arr.push({ domain: domain, value: value });
                    }
                }
                // 当前计时的域名若还没被记录过，补上
                if (pendingDomain && domains.indexOf(pendingDomain) < 0) {
                    arr.push({ domain: pendingDomain, value: pending });
                }

                // 还没有记录过任何时间
                if (arr.length === 0) {
                    drillGroup = null;
                    $("#back").hide();
                    var hintHtml = "<div style='padding:20px;color:#999;text-align:center;'>还没有记录，去浏览一些网站吧</div>";
                    hintHtml += "<div style='padding:0 20px;font-size:12px;color:#c60;'>" + bgStatus + "</div>";
                    if (logArr.length > 0) {
                        hintHtml += "<div style='padding:0 20px 10px;font-size:11px;color:#666;max-height:200px;overflow:auto;'>后台日志：<br>" +
                            logArr.slice(-12).join("<br>") + "</div>";
                    }
                    $("#main").html(hintHtml);
                    return;
                }

                // 根据显示个数调整显示样式
                if (showCounts == 15) {
                    $("#main").css("height", "400px");
                    option.legend.height = 400;
                } else if (showCounts == 20) {
                    $("#main").css("height", "500px");
                    option.legend.height = 500;
                }

                // 按访问时长从高到低排序（分组内成员也保持这个顺序）
                arr.sort(compare);

                // 归类汇总：athena04、athena06 -> athena
                var groups = buildGroups(arr);

                // 钻取的分组若已不存在，回到汇总视图
                if (drillGroup != null && !groups.map[drillGroup]) {
                    drillGroup = null;
                }

                var items;
                if (drillGroup == null) {
                    // 汇总视图：按分组总时长排序，取前 showCounts 个分组
                    var groupOrder = groups.order.slice();
                    groupOrder.sort(function (a, b) {
                        return groups.map[b].total - groups.map[a].total;
                    });
                    groupOrder = groupOrder.slice(0, showCounts);

                    items = [];
                    for (i = 0; i < groupOrder.length; i++) {
                        var groupName = groupOrder[i];
                        items.push({ name: groupName, value: groups.map[groupName].total, isGroup: true });
                    }
                } else {
                    // 钻取视图：展示该分组下的具体域名
                    items = groups.map[drillGroup].members.map(function (m) {
                        return { name: m.domain, value: m.value, isGroup: false };
                    });
                }

                // 显示/隐藏“返回汇总”
                $("#back").toggle(drillGroup != null);

                for (i = 0; i < items.length; i++) {
                    option.legend.data.push(items[i].name);
                    option.series[0].data.push({
                        value: items[i].value,
                        name: items[i].name,
                        isGroup: items[i].isGroup,
                        url: "http://" + items[i].name
                    });
                }

                renderChart(option);
            } catch (e) {
                showError(e && e.message ? e.message : String(e));
            }
        });
    } catch (e) {
        showError(e && e.message ? e.message : String(e));
    }
}

// 基于准备好的 dom 初始化 echarts 实例并渲染（实例和点击事件只初始化一次）
function renderChart(option) {
    if (myChart == null) {
        myChart = echarts.init($("#main")[0], "macarons");

        // 点击分组下钻看具体域名，点击具体域名跳转
        myChart.on("click", function (e) {
            var d = e.data;
            if (d && d.isGroup) {
                drillGroup = d.name;
                draw(currentFlag);
            } else if (d && d.url) {
                window.open(d.url);
            }
        });
    }

    myChart.clear();
    myChart.setOption(option);
}

// 初始化 option 参数
function initOption() {
    option = {
        title: {
            show: false,
            x: "center"
        },
        tooltip: {
            trigger: "item",
            formatter: function (params) {
                return echarts.format.truncateText(params.name, 200) + "<br/>" + secondsToTimeStr(params.value) + "(" + params.percent + "%)";
            }
        },
        legend: {
            orient: "vertical",
            left: "left",
            top: "middle",
            // 数组内容由 series.data 中的所有对象的 name 组成
            data: [],
            formatter: function (name) {
                return echarts.format.truncateText(name, 200);
            }
        },
        series: [{
            name: "时间",
            type: "pie",
            radius: [0, 110],
            label: {
                normal: {
                    show: false
                }
            },
            center: [350, "50%"],
            // 数组内容是一个个对象，对象内属性有 value 和 name
            data: [],
            itemStyle: {
                emphasis: {
                    shadowBlur: 10,
                    shadowOffsetX: 5,
                    shadowOffsetY: 5,
                    shadowColor: "rgba(0, 0, 0, 0.5)"
                }
            }
        }]
    };
}

function compare(obj1, obj2) {
    if (obj1.value < obj2.value) {
        return 1;
    } else if (obj1.value > obj2.value) {
        return -1;
    }

    return 0;
}

// 把域名归类，如 athena04:3013、athena06:3022 -> athena
function getGroup(domain) {
    var host = domain;
    var idx = domain.lastIndexOf(":");
    // 形如 athena04:3013，把端口去掉，只按主机名归类
    if (idx > 0 && /^\d+$/.test(domain.slice(idx + 1))) {
        host = domain.slice(0, idx);
    }
    // 只对不含点的单段主机名归类，避免误伤 google.com、10.0.0.1 等
    if (host.indexOf(".") === -1) {
        var base = host.replace(/\d+$/, "");
        if (base) {
            return base;
        }
    }
    return domain;
}

// 把按域名统计的数据汇总成分组
function buildGroups(arr) {
    var map = {};
    var order = [];
    for (var i = 0; i < arr.length; i++) {
        var item = arr[i];
        var g = getGroup(item.domain);
        if (!map[g]) {
            map[g] = { total: 0, members: [] };
            order.push(g);
        }
        map[g].total += item.value;
        map[g].members.push({ domain: item.domain, value: item.value });
    }
    return { map: map, order: order };
}

// 秒数转时间字符串
function secondsToTimeStr(seconds) {
    var days = 0;
    var hours = 0;
    var minutes = 0;

    if (seconds >= 86400) {
        days = parseInt(seconds / 86400);
        seconds -= 86400 * days;
    }

    if (seconds >= 3600) {
        hours = parseInt(seconds / 3600);
        seconds -= 3600 * hours;
    }

    if (seconds >= 60) {
        minutes = parseInt(seconds / 60);
        seconds -= 60 * minutes;
    }

    if (days != 0) {
        return days + "天<br>" + hours + "时" + minutes + "分" + seconds + "秒";
    } else if (hours != 0) {
        return hours + "时" + minutes + "分" + seconds + "秒";
    } else if (minutes != 0) {
        return minutes + "分" + seconds + "秒";
    } else {
        return seconds + "秒";
    }
}
