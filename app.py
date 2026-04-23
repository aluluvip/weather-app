from __future__ import annotations

import json
import mimetypes
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import requests


BASE_DIR = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 8000
API_KEY_PATH = BASE_DIR / "amap-api-key.txt"
CITY_TREE_PATH = BASE_DIR / "city_tree.json"
SEARCH_INDEX_PATH = BASE_DIR / "search_index.json"
REQUEST_HEADERS = {"User-Agent": "WeatherApp/1.0", "Accept": "application/json"}

WEATHER_CODE_MAP = {
    0: "晴",
    1: "晴间多云",
    2: "局部多云",
    3: "阴",
    45: "雾",
    48: "冻雾",
    51: "小毛毛雨",
    53: "毛毛雨",
    55: "浓毛毛雨",
    56: "冻毛毛雨",
    57: "强冻毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    66: "冻雨",
    67: "强冻雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    77: "雪粒",
    80: "阵雨",
    81: "较强阵雨",
    82: "暴雨阵雨",
    85: "阵雪",
    86: "强阵雪",
    95: "雷阵雨",
    96: "雷阵雨夹冰雹",
    99: "强雷阵雨夹冰雹",
}


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


CITY_TREE = load_json(CITY_TREE_PATH)
SEARCH_INDEX = load_json(SEARCH_INDEX_PATH)
API_KEY = API_KEY_PATH.read_text(encoding="utf-8").strip()


def amap_get(path: str, params: dict[str, str]) -> dict:
    response = requests.get(
        f"https://restapi.amap.com{path}",
        params=params,
        headers=REQUEST_HEADERS,
        timeout=10,
    )
    response.raise_for_status()
    return response.json()


def weather_response(adcode: str) -> dict:
    data = amap_get(
        "/v3/weather/weatherInfo",
        {"city": adcode, "key": API_KEY, "extensions": "base"},
    )
    if data.get("status") != "1" or not data.get("lives"):
        raise ValueError(data.get("info", "未找到天气信息"))
    return data["lives"][0]


def reverse_geocode(lng: str, lat: str) -> dict:
    data = amap_get(
        "/v3/geocode/regeo",
        {"location": f"{lng},{lat}", "key": API_KEY, "extensions": "base"},
    )
    if data.get("status") != "1" or not data.get("regeocode"):
        raise ValueError(data.get("info", "定位失败"))
    return data["regeocode"]


def osm_reverse_geocode(lng: str, lat: str) -> dict:
    response = requests.get(
        "https://nominatim.openstreetmap.org/reverse",
        params={
            "lat": lat,
            "lon": lng,
            "format": "jsonv2",
            "accept-language": "zh-CN",
        },
        headers={"User-Agent": "WeatherApp/1.0"},
        timeout=10,
    )
    response.raise_for_status()
    return response.json()


def osm_search_place(name: str) -> dict:
    response = requests.get(
        "https://nominatim.openstreetmap.org/search",
        params={
            "q": name,
            "format": "jsonv2",
            "limit": 1,
            "accept-language": "zh-CN",
        },
        headers={"User-Agent": "WeatherApp/1.0"},
        timeout=10,
    )
    response.raise_for_status()
    data = response.json()
    if not data:
        raise ValueError("未找到该地区的天气坐标")
    return data[0]


def open_meteo_weather(lat: str, lng: str) -> dict:
    response = requests.get(
        "https://api.open-meteo.com/v1/forecast",
        params={
            "latitude": lat,
            "longitude": lng,
            "current": "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m",
        },
        headers=REQUEST_HEADERS,
        timeout=10,
    )
    response.raise_for_status()
    data = response.json()
    current = data.get("current", {})
    if not current:
        raise ValueError("未获取到天气数据")
    return current


def wind_direction_text(degrees: float | int | None) -> str:
    if degrees is None:
        return "--"
    labels = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"]
    index = round(float(degrees) / 45) % 8
    return labels[index]


def open_meteo_to_live(current: dict, label: str) -> dict:
    return {
        "province": label,
        "city": label,
        "weather": WEATHER_CODE_MAP.get(current.get("weather_code"), "未知"),
        "temperature": str(round(float(current.get("temperature_2m", 0)))),
        "humidity": str(round(float(current.get("relative_humidity_2m", 0)))),
        "winddirection": wind_direction_text(current.get("wind_direction_10m")),
        "windpower": str(round(float(current.get("wind_speed_10m", 0)))),
        "reporttime": current.get("time", ""),
    }


def fallback_weather_by_name(name: str) -> dict:
    place = osm_search_place(name)
    current = open_meteo_weather(place["lat"], place["lon"])
    return open_meteo_to_live(current, name)


def fallback_weather_by_coords(lat: str, lng: str) -> tuple[dict, dict]:
    location = osm_reverse_geocode(lng, lat)
    current = open_meteo_weather(lat, lng)
    address = location.get("address", {})
    label = (
        address.get("suburb")
        or address.get("city_district")
        or address.get("city")
        or address.get("town")
        or address.get("state")
        or "当前位置"
    )
    return open_meteo_to_live(current, label), location


def city_search(keyword: str) -> list[dict]:
    if not keyword:
        return []
    keyword = keyword.strip()
    lower_keyword = keyword.lower()
    matches = [
        item
        for item in SEARCH_INDEX
        if keyword in item["name"] or lower_keyword in item.get("pinyin", "").lower()
    ]
    return matches[:12]


class WeatherRequestHandler(BaseHTTPRequestHandler):
    server_version = "WeatherAppHTTP/1.0"

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/":
            return self.serve_file(BASE_DIR / "index.html")

        if parsed.path == "/api/bootstrap":
            return self.handle_bootstrap()

        if parsed.path == "/api/search":
            return self.handle_search(parsed.query)

        if parsed.path == "/api/weather":
            return self.handle_weather(parsed.query)

        if parsed.path == "/api/weather/by-location":
            return self.handle_weather_by_location(parsed.query)

        candidate = (BASE_DIR / parsed.path.lstrip("/")).resolve()
        if BASE_DIR in candidate.parents or candidate == BASE_DIR:
            if candidate.is_file():
                return self.serve_file(candidate)

        self.send_error(HTTPStatus.NOT_FOUND, "Not Found")

    def log_message(self, format: str, *args):
        print(f"[{self.log_date_time_string()}] {self.address_string()} {format % args}")

    def handle_bootstrap(self):
        self.send_json(
            {
                "cityTree": CITY_TREE,
                "featuredCities": [
                    {"name": "北京", "adcode": "110101"},
                    {"name": "上海", "adcode": "310101"},
                    {"name": "广州", "adcode": "440106"},
                    {"name": "深圳", "adcode": "440303"},
                    {"name": "杭州", "adcode": "330106"},
                    {"name": "成都", "adcode": "510104"},
                ],
            }
        )

    def handle_search(self, query: str):
        params = parse_qs(query)
        keyword = params.get("q", [""])[0]
        self.send_json({"results": city_search(unquote(keyword))})

    def handle_weather(self, query: str):
        params = parse_qs(query)
        adcode = params.get("adcode", [""])[0].strip()
        city_name = params.get("name", [""])[0].strip()
        if not adcode:
            return self.send_json({"error": "缺少 adcode 参数"}, status=HTTPStatus.BAD_REQUEST)

        try:
            live = weather_response(adcode)
            self.send_json({"live": live, "cityName": city_name or live.get("city") or live.get("province")})
        except (ValueError, requests.RequestException):
            try:
                live = fallback_weather_by_name(city_name or adcode)
                self.send_json({"live": live, "cityName": city_name or live.get("city")})
            except (ValueError, requests.RequestException) as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_GATEWAY)

    def handle_weather_by_location(self, query: str):
        params = parse_qs(query)
        lat = params.get("lat", [""])[0].strip()
        lng = params.get("lng", [""])[0].strip()
        if not lat or not lng:
            return self.send_json({"error": "缺少经纬度参数"}, status=HTTPStatus.BAD_REQUEST)

        try:
            regeocode = reverse_geocode(lng, lat)
            component = regeocode.get("addressComponent", {})
            adcode = component.get("adcode", "")
            if not adcode:
                raise ValueError("未获取到当前位置的行政区编码")

            live = weather_response(adcode)
            self.send_json(
                {
                    "live": live,
                    "cityName": (
                        component.get("district")
                        or component.get("city")
                        or component.get("province")
                        or live.get("city")
                    ),
                    "formattedAddress": regeocode.get("formatted_address", ""),
                    "adcode": adcode,
                }
            )
        except (ValueError, requests.RequestException):
            try:
                live, location = fallback_weather_by_coords(lat, lng)
                address = location.get("address", {})
                city_name = (
                    address.get("suburb")
                    or address.get("city_district")
                    or address.get("city")
                    or address.get("town")
                    or address.get("state")
                    or "当前位置"
                )
                self.send_json(
                    {
                        "live": live,
                        "cityName": city_name,
                        "formattedAddress": location.get("display_name", ""),
                        "adcode": "",
                    }
                )
            except (ValueError, requests.RequestException) as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_GATEWAY)

    def serve_file(self, file_path: Path):
        content_type, _ = mimetypes.guess_type(file_path.name)
        with file_path.open("rb") as file:
            payload = file.read()

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    server = ThreadingHTTPServer((HOST, PORT), WeatherRequestHandler)
    print(f"Weather app running at http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
