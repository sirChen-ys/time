// 指定图表的配置项和数据
var option = null;
// 图表实例
var myChart = null;
// 后台探测结果
var bgStatus = "";

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

                // 只显示访问时间前几的网站
                arr.sort(compare);
                arr = arr.slice(0, showCounts);

                for (i = 0; i < arr.length; i++) {
                    option.legend.data.push(arr[i].domain);
                    option.series[0].data.push({ value: arr[i].value, name: arr[i].domain, url: "http://" + arr[i].domain });
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

        // 点击饼图，跳转到对应网站
        myChart.on("click", function (e) {
            window.open(e.data.url);
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
