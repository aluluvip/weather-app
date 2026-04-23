let cityData = null;
let featuredCities = [];
let lastQuery = null;

const provinceSelect = document.getElementById("provinceSelect");
const citySelect = document.getElementById("citySelect");
const districtSelect = document.getElementById("districtSelect");
const queryBtn = document.getElementById("queryBtn");
const searchInput = document.getElementById("searchInput");
const searchBtn = document.getElementById("searchBtn");
const searchResults = document.getElementById("searchResults");
const locateBtn = document.getElementById("locateBtn");
const refreshBtn = document.getElementById("refreshBtn");
const featuredCitiesContainer = document.getElementById("featuredCities");
const heroStatus = document.getElementById("heroStatus");
const errorMsg = document.getElementById("errorMsg");

document.addEventListener("DOMContentLoaded", async () => {
    try {
        await bootstrap();
        setupEventListeners();
        renderFeaturedCities();
        updateHeroStatus("已连接本地后端，正在尝试定位当前位置。");
        tryLocate();
    } catch (error) {
        console.error("初始化失败:", error);
        showError("初始化失败，请确认已运行 python3 app.py");
        updateHeroStatus("未连接到本地后端。");
    }
});

async function bootstrap() {
    const response = await fetch("/api/bootstrap");
    if (!response.ok) {
        throw new Error("bootstrap failed");
    }

    const data = await response.json();
    cityData = data.cityTree;
    featuredCities = data.featuredCities || [];
    initProvinceSelect();
}

function setupEventListeners() {
    provinceSelect.addEventListener("change", handleProvinceChange);
    citySelect.addEventListener("change", handleCityChange);
    districtSelect.addEventListener("change", handleDistrictChange);
    queryBtn.addEventListener("click", queryFromSelection);
    searchBtn.addEventListener("click", performSearch);
    searchInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            performSearch();
        }
    });
    locateBtn.addEventListener("click", tryLocate);
    refreshBtn.addEventListener("click", refreshWeather);
    document.addEventListener("click", (event) => {
        if (!event.target.closest(".search-card")) {
            searchResults.classList.add("hidden");
        }
    });
}

function initProvinceSelect() {
    cityData.provinces.forEach((province) => {
        const option = document.createElement("option");
        option.value = province.adcode;
        option.textContent = province.name;
        option.dataset.isDirect = province.is_direct;
        provinceSelect.appendChild(option);
    });
}

function renderFeaturedCities() {
    featuredCitiesContainer.innerHTML = featuredCities
        .map(
            (city) => `
                <button class="city-chip" type="button" data-adcode="${city.adcode}" data-name="${city.name}">
                    ${city.name}
                </button>
            `
        )
        .join("");

    featuredCitiesContainer.querySelectorAll(".city-chip").forEach((button) => {
        button.addEventListener("click", () => {
            fetchWeather(button.dataset.adcode, button.dataset.name, {
                source: "热门城市",
            });
        });
    });
}

function handleProvinceChange() {
    const selectedProvince = provinceSelect.options[provinceSelect.selectedIndex];
    const provinceAdcode = provinceSelect.value;
    const isDirect = selectedProvince.dataset.isDirect === "true";

    citySelect.innerHTML = '<option value="">选择城市</option>';
    districtSelect.innerHTML = '<option value="">选择区县</option>';
    citySelect.disabled = true;
    districtSelect.disabled = true;
    queryBtn.disabled = true;

    if (!provinceAdcode) {
        return;
    }

    const province = cityData.provinces.find((item) => item.adcode === provinceAdcode);
    if (!province) {
        return;
    }

    if (isDirect) {
        districtSelect.disabled = false;
        province.districts.forEach((district) => {
            const option = document.createElement("option");
            option.value = district.adcode;
            option.textContent = district.name;
            districtSelect.appendChild(option);
        });
    } else {
        citySelect.disabled = false;
        province.cities.forEach((city) => {
            const option = document.createElement("option");
            option.value = city.adcode;
            option.textContent = city.name;
            option.dataset.cityData = JSON.stringify(city);
            citySelect.appendChild(option);
        });
    }
}

function handleCityChange() {
    districtSelect.innerHTML = '<option value="">选择区县</option>';
    districtSelect.disabled = true;
    queryBtn.disabled = true;

    if (!citySelect.value) {
        return;
    }

    const selectedOption = citySelect.options[citySelect.selectedIndex];
    const cityInfo = JSON.parse(selectedOption.dataset.cityData);

    districtSelect.disabled = false;
    cityInfo.districts.forEach((district) => {
        const option = document.createElement("option");
        option.value = district.adcode;
        option.textContent = district.name;
        districtSelect.appendChild(option);
    });
}

function handleDistrictChange() {
    queryBtn.disabled = !districtSelect.value;
}

function queryFromSelection() {
    if (!districtSelect.value) {
        return;
    }

    fetchWeather(districtSelect.value, districtSelect.options[districtSelect.selectedIndex].textContent, {
        source: "手动选择",
    });
}

async function performSearch() {
    const keyword = searchInput.value.trim();
    if (!keyword) {
        showError("请输入要搜索的城市或区县。");
        return;
    }

    try {
        updateHeroStatus(`正在搜索“${keyword}”...`);
        const response = await fetch(`/api/search?q=${encodeURIComponent(keyword)}`);
        const data = await response.json();
        renderSearchResults(data.results || [], keyword);
    } catch (error) {
        console.error("搜索失败:", error);
        showError("搜索失败，请稍后重试。");
    }
}

function renderSearchResults(results, keyword) {
    if (!results.length) {
        searchResults.innerHTML = '<div class="result-empty">没有找到匹配结果</div>';
    } else {
        searchResults.innerHTML = results
            .map(
                (item) => `
                    <button class="result-item" type="button" data-adcode="${item.adcode}" data-name="${item.name}">
                        <strong>${highlightMatch(item.name, keyword)}</strong>
                        <span>${item.citycode && item.citycode !== "\\\\N" ? `区号 ${item.citycode}` : "行政区编码查询"}</span>
                    </button>
                `
            )
            .join("");

        searchResults.querySelectorAll(".result-item").forEach((button) => {
            button.addEventListener("click", () => {
                searchResults.classList.add("hidden");
                searchInput.value = button.dataset.name;
                fetchWeather(button.dataset.adcode, button.dataset.name, {
                    source: "搜索结果",
                });
            });
        });
    }

    searchResults.classList.remove("hidden");
}

function highlightMatch(text, keyword) {
    const regex = new RegExp(`(${escapeRegExp(keyword)})`, "gi");
    return text.replace(regex, "<mark>$1</mark>");
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function tryLocate() {
    if (!navigator.geolocation) {
        showError("当前浏览器不支持定位，请手动查询。");
        updateHeroStatus("浏览器不支持定位。");
        return;
    }

    updateHeroStatus("正在请求定位权限...");

    navigator.geolocation.getCurrentPosition(
        async ({ coords }) => {
            try {
                updateHeroStatus("已获取定位，正在加载当前位置天气...");
                await fetchWeatherByLocation(coords.latitude, coords.longitude);
            } catch (error) {
                console.error("定位天气失败:", error);
                showError("定位成功，但天气获取失败，请手动查询。");
                updateHeroStatus("定位成功，但天气获取失败。");
            }
        },
        () => {
            showError("定位未开启，请手动查询或允许浏览器定位。");
            updateHeroStatus("定位未开启，你仍然可以手动查询天气。");
        },
        {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 300000,
        }
    );
}

async function fetchWeatherByLocation(lat, lng) {
    const response = await fetch(`/api/weather/by-location?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`);
    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || "定位天气获取失败");
    }

    renderWeather(data.live, data.cityName, {
        source: "当前位置",
        subline: data.formattedAddress || "自动定位成功",
    });
    lastQuery = {
        type: "location",
        lat,
        lng,
    };
}

async function fetchWeather(adcode, cityName, meta = {}) {
    try {
        setLoadingState(true);
        updateHeroStatus(`正在获取${cityName}天气...`);
        const response = await fetch(`/api/weather?adcode=${encodeURIComponent(adcode)}&name=${encodeURIComponent(cityName)}`);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "天气获取失败");
        }

        renderWeather(data.live, data.cityName || cityName, meta);
        lastQuery = {
            type: "adcode",
            adcode,
            cityName: data.cityName || cityName,
            meta,
        };
    } catch (error) {
        console.error("天气查询失败:", error);
        showError(error.message || "天气查询失败，请稍后重试。");
        updateHeroStatus("天气查询失败，请稍后再试。");
    } finally {
        setLoadingState(false);
    }
}

async function refreshWeather() {
    if (!lastQuery) {
        tryLocate();
        return;
    }

    if (lastQuery.type === "location") {
        return fetchWeatherByLocation(lastQuery.lat, lastQuery.lng);
    }

    return fetchWeather(lastQuery.adcode, lastQuery.cityName, lastQuery.meta);
}

function renderWeather(live, cityName, meta = {}) {
    document.getElementById("cityName").textContent = cityName;
    document.getElementById("locationMeta").textContent = meta.subline || `${meta.source || "手动查询"} · 实时天气`;
    document.getElementById("temperature").textContent = live.temperature || "--";
    document.getElementById("weatherText").textContent = live.weather || "--";
    document.getElementById("humidity").textContent = live.humidity ? `${live.humidity}%` : "--";
    document.getElementById("windDirection").textContent = live.winddirection || "--";
    document.getElementById("windPower").textContent = live.windpower ? `${live.windpower}级` : "--";
    document.getElementById("reportTime").textContent = simplifyReportTime(live.reporttime);
    document.getElementById("weatherBadge").textContent = meta.source || "实时";
    document.getElementById("heroWeather").classList.add("is-loaded");
    updateHeroStatus(`${cityName}天气已更新。`);
    hideError();
}

function simplifyReportTime(value) {
    if (!value) {
        return "--";
    }

    if (value.includes("T")) {
        const timePart = value.split("T")[1] || "";
        return timePart.slice(0, 5) || value;
    }

    if (value.includes(" ")) {
        const timePart = value.split(" ")[1] || "";
        return timePart.slice(0, 5) || value;
    }

    return value;
}

function setLoadingState(isLoading) {
    locateBtn.disabled = isLoading;
    refreshBtn.disabled = isLoading;
    queryBtn.disabled = isLoading || !districtSelect.value;
    searchBtn.disabled = isLoading;
    document.body.classList.toggle("is-loading", isLoading);
}

function updateHeroStatus(text) {
    heroStatus.textContent = text;
}

function showError(message) {
    errorMsg.textContent = message;
    errorMsg.classList.remove("hidden");
}

function hideError() {
    errorMsg.classList.add("hidden");
}
