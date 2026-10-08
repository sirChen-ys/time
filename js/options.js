function init() {
    chrome.storage.local.get(["version", "show"], function (data) {
        var versionSpan = $("#version");
        versionSpan.text("版本：" + (data.version || ""));

        // select 变动事件
        var select = $("#selectShowCounts");
        select.val(data.show || 10);
        select.on("change", function (event) {
            chrome.storage.local.set({ show: event.target.value });

            var savingDiv = $("#saving");
            savingDiv.removeClass("invisible");
            setTimeout(function () {
                savingDiv.addClass("invisible");
            }, 600);
        });
    });
}
window.addEventListener("load", init, false);
