const $ = (id) => document.getElementById(id);

const map = L.map("map").setView([33.3152, 44.3661], 12);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

const DEFAULT_SETTINGS = {
  voiceEnabled: true,
  voiceSpeed: "0.9",
  distanceUnits: "km",
  themeMode: "light",
  avoidTolls: false,
  keepScreenOn: false
};

function loadSettings() {
  try {
    return {
      ...DEFAULT_SETTINGS,
      ...JSON.parse(localStorage.getItem("darbSettings") || "{}")
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let settings = loadSettings();
let currentPosition = null;
let destination = null;
let currentMarker = null;
let destinationMarker = null;
let routeLayers = [];
let availableRoutes = [];
let selectedRouteIndex = 0;
let routeSteps = [];
let navigationWatchId = null;
let navigationActive = false;
let nextStepIndex = 0;
let announcedSteps = new Set();
let searchResults = [];
let lastSearchTime = 0;
let wakeLock = null;

const routeColors = ["#1769e0", "#e58b18", "#8b5cf6"];

function setStatus(message) {
  $("status").textContent = message;
}

function saveSettings() {
  localStorage.setItem("darbSettings", JSON.stringify(settings));
}

function loadSavedPlace(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function savePlace(key, place) {
  localStorage.setItem(key, JSON.stringify(place));
}

function getSavedPlaceName(place) {
  return place?.name || "ما محفوظ عنوان";
}

function updateSavedPlaceLabels() {
  $("homeAddress").textContent = getSavedPlaceName(loadSavedPlace("darbHome"));
  $("workAddress").textContent = getSavedPlaceName(loadSavedPlace("darbWork"));
}

function applyTheme() {
  let dark = settings.themeMode === "dark";

  if (settings.themeMode === "system") {
    dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches || false;
  }

  document.body.classList.toggle("dark", dark);
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#0c1220" : "#101827");
}

function syncSettingsUI() {
  $("voiceEnabled").checked = settings.voiceEnabled;
  $("voiceSpeed").value = settings.voiceSpeed;
  $("distanceUnits").value = settings.distanceUnits;
  $("themeMode").value = settings.themeMode;
  $("avoidTolls").checked = settings.avoidTolls;
  $("keepScreenOn").checked = settings.keepScreenOn;
  applyTheme();
  updateSavedPlaceLabels();
}

function openSettings() {
  $("settingsPage").hidden = false;
}

function closeSettings() {
  $("settingsPage").hidden = true;
}

$("settingsButton").addEventListener("click", openSettings);
$("closeSettingsButton").addEventListener("click", closeSettings);
$("doneSettingsButton").addEventListener("click", closeSettings);

$("settingsPage").addEventListener("click", (event) => {
  if (event.target === $("settingsPage")) closeSettings();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSettings();
});

function onSettingChange(key, value) {
  settings[key] = value;
  saveSettings();

  if (key === "themeMode") applyTheme();

  if (key === "voiceEnabled" && !value && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }

  if (key === "avoidTolls" && value) {
    setStatus("تنبيه: خدمة الطرق الحالية لا تضمن تجنّب الطرق المدفوعة.");
  }

  if (key === "keepScreenOn") {
    updateWakeLock();
  }

  refreshRouteDisplay();
}

$("voiceEnabled").addEventListener("change", (event) => {
  onSettingChange("voiceEnabled", event.target.checked);
});

$("voiceSpeed").addEventListener("change", (event) => {
  onSettingChange("voiceSpeed", event.target.value);
});

$("distanceUnits").addEventListener("change", (event) => {
  onSettingChange("distanceUnits", event.target.value);
});

$("themeMode").addEventListener("change", (event) => {
  onSettingChange("themeMode", event.target.value);
});

$("avoidTolls").addEventListener("change", (event) => {
  onSettingChange("avoidTolls", event.target.checked);
});

$("keepScreenOn").addEventListener("change", (event) => {
  onSettingChange("keepScreenOn", event.target.checked);
});

async function updateWakeLock() {
  if (!settings.keepScreenOn) {
    if (wakeLock) {
      try {
        await wakeLock.release();
      } catch {}
      wakeLock = null;
    }
    return;
  }

  if (!("wakeLock" in navigator)) {
    setStatus("متصفحك لا يدعم إبقاء الشاشة مفتوحة. تقدر تغيّر إعدادات الشاشة بالجهاز.");
    return;
  }

  if (document.visibilityState !== "visible") return;

  try {
    wakeLock = await navigator.wakeLock.request("screen");

    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    setStatus("ما قدرنا نخلي الشاشة مفتوحة. تأكد من دعم المتصفح.");
  }
}

document.addEventListener("visibilitychange", () => {
  if (settings.keepScreenOn && document.visibilityState === "visible") {
    updateWakeLock();
  }
});

function formatDistance(meters) {
  if (settings.distanceUnits === "mi") {
    const miles = meters / 1609.344;
    return `${miles.toFixed(miles < 10 ? 1 : 0)} ميل`;
  }

  if (meters < 1000) return `${Math.round(meters)} متر`;
  return `${(meters / 1000).toFixed(1)} كم`;
}

function formatDuration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));

  if (minutes < 60) return `${minutes} دقيقة`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  return remainingMinutes
    ? `${hours} ساعة و ${remainingMinutes} دقيقة`
    : `${hours} ساعة`;
}

function formatArrivalTime(seconds) {
  const arrival = new Date(Date.now() + seconds * 1000);

  return arrival.toLocaleTimeString("ar-IQ", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character]);
}

function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("المتصفح ما يدعم تحديد الموقع."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        currentPosition = {
          lat: position.coords.latitude,
          lon: position.coords.longitude
        };
        updateCurrentMarker();
        resolve(currentPosition);
      },
      (error) => {
        const messages = {
          1: "لازم تسمح للموقع بالوصول إلى موقعك.",
          2: "ما قدرنا نحدد موقعك. حاول بمكان مفتوح.",
          3: "انتهى وقت تحديد الموقع. حاول مرة ثانية."
        };
        reject(new Error(messages[error.code] || "تعذر تحديد الموقع."));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
  });
}

function updateCurrentMarker() {
  if (!currentPosition) return;
  const latlng = [currentPosition.lat, currentPosition.lon];

  if (currentMarker) {
    currentMarker.setLatLng(latlng);
  } else {
    currentMarker = L.marker(latlng).addTo(map).bindPopup("موقعك الحالي");
  }
}

$("locateButton").addEventListener("click", async () => {
  setStatus("جاري تحديد موقعك...");
  try {
    await getCurrentLocation();
    map.setView([currentPosition.lat, currentPosition.lon], 15);
    setStatus("تم تحديد موقعك.");
  } catch (error) {
    setStatus(error.message);
  }
});

$("searchForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  const query = $("destinationInput").value.trim();
  if (query.length < 2) {
    setStatus("اكتب اسم مكان أو عنوان بشكل أوضح.");
    return;
  }

  if (Date.now() - lastSearchTime < 1100) {
    setStatus("انتظر لحظة قصيرة ثم حاول مرة ثانية.");
    return;
  }

  lastSearchTime = Date.now();
  $("searchResults").replaceChildren();
  setStatus("جاري البحث عن المكان...");

  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "6");
    url.searchParams.set("countrycodes", "iq");
    url.searchParams.set("accept-language", "ar");

    const response = await fetch(url);
    if (!response.ok) throw new Error("خدمة البحث ما استجابت. حاول بعد قليل.");

    searchResults = await response.json();

    if (!searchResults.length) {
      setStatus("ما لكينا المكان. جرّب اسم ثاني أو اكتبه بالإنكليزي.");
      return;
    }

    searchResults.forEach((place, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "result-item";
      button.textContent = place.display_name;
      button.addEventListener("click", () => chooseDestination(index));
      $("searchResults").appendChild(button);
    });

    setStatus("اختار المكان الصحيح من النتائج.");
  } catch (error) {
    setStatus(error.message || "صار خطأ أثناء البحث.");
  }
});

async function chooseDestination(index) {
  const place = searchResults[index];
  if (!place) return;

  destination = {
    lat: Number(place.lat),
    lon: Number(place.lon),
    name: place.display_name
  };

  if (destinationMarker) map.removeLayer(destinationMarker);

  destinationMarker = L.marker([destination.lat, destination.lon])
    .addTo(map)
    .bindPopup(escapeHtml(destination.name));

  $("destinationInput").value = destination.name;
  $("searchResults").replaceChildren();

  try {
    if (!currentPosition) {
      setStatus("جاري تحديد موقعك أولاً...");
      try {
        await getCurrentLocation();
      } catch (error) {
        map.setView([destination.lat, destination.lon], 14);
        setStatus(error.message + " فعّل الموقع لحساب المسار.");
        return;
      }
    }
    await calculateRoute();
  } catch (error) {
    setStatus(error.message || "تعذر حساب المسار.");
  }
}

async function calculateRoute() {
  if (!currentPosition || !destination) {
    setStatus("حدد موقعك والوجهة أولاً.");
    return;
  }

  stopNavigation(false);
  removeRouteLayers();
  availableRoutes = [];
  routeSteps = [];
  $("routeOptions").replaceChildren();
  $("tripInfo").hidden = true;
  setStatus("جاري حساب المسارات...");

  const coordinates =
    `${currentPosition.lon},${currentPosition.lat};${destination.lon},${destination.lat}`;

  const url = new URL(`https://router.project-osrm.org/route/v1/driving/${coordinates}`);
  url.searchParams.set("alternatives", "true");
  url.searchParams.set("steps", "true");
  url.searchParams.set("overview", "full");
  url.searchParams.set("geometries", "geojson");

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("خدمة حساب الطريق غير متاحة حالياً.");

    const data = await response.json();
    if (data.code !== "Ok" || !data.routes?.length) {
      throw new Error("ما قدرنا نلقى طريق بين الموقعين.");
    }

    availableRoutes = data.routes;

    availableRoutes.forEach((route, index) => {
      const latlngs = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      const layer = L.polyline(latlngs, {
        color: routeColors[index % routeColors.length],
        weight: 5,
        opacity: 0.6
      }).addTo(map);
      routeLayers.push(layer);
    });

    map.fitBounds(L.featureGroup(routeLayers).getBounds(), { padding: [30, 30] });
    renderRouteOptions();
    $("tripInfo").hidden = false;
    selectRoute(0, false);

    setStatus(
      availableRoutes.length > 1
        ? `لكينا ${availableRoutes.length} مسارات. اختار الأنسب إلك.`
        : "تم حساب الطريق."
    );
  } catch (error) {
    removeRouteLayers();
    availableRoutes = [];
    setStatus(error.message || "تعذر الاتصال بخدمة الطرق. حاول بعد قليل.");
  }
}

function renderRouteOptions() {
  const container = $("routeOptions");
  container.replaceChildren();

  availableRoutes.forEach((route, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "route-card";

    const title = document.createElement("span");
    title.className = "route-title";
    title.textContent = index === 0 ? "المسار الأول — المقترح" : `المسار البديل ${index + 1}`;

    const details = document.createElement("span");
    details.className = "route-details";
    details.textContent =
      `${formatDistance(route.distance)} • ${formatDuration(route.duration)} • الوصول ${formatArrivalTime(route.duration)}`;

    button.append(title, details);
    button.addEventListener("click", () => selectRoute(index));
    container.appendChild(button);
  });
}

function selectRoute(index, updateStatus = true) {
  const route = availableRoutes[index];
  if (!route) return;

  selectedRouteIndex = index;
  routeSteps = (route.legs || []).flatMap((leg) => leg.steps || []);

  $("distance").textContent = formatDistance(route.distance);
  $("duration").textContent = formatDuration(route.duration);
  $("arrivalTime").textContent = formatArrivalTime(route.duration);

  routeLayers.forEach((layer, layerIndex) => {
    layer.setStyle({
      color: routeColors[layerIndex % routeColors.length],
      weight: layerIndex === index ? 8 : 5,
      opacity: layerIndex === index ? 1 : 0.4
    });
    if (layerIndex === index) layer.bringToFront();
  });

  document.querySelectorAll(".route-card").forEach((card, cardIndex) => {
    card.classList.toggle("selected", cardIndex === index);
  });

  if (navigationActive) {
    stopNavigation(false);
    setStatus("تغيّر المسار. ابدأ الملاحة من جديد.");
  } else if (updateStatus) {
    setStatus(`تم اختيار المسار ${index + 1}.`);
  }
}

function refreshRouteDisplay() {
  if (!availableRoutes.length) return;
  renderRouteOptions();
  selectRoute(selectedRouteIndex, false);
}

function removeRouteLayers() {
  routeLayers.forEach((layer) => map.removeLayer(layer));
  routeLayers = [];
}

function clearTrip() {
  stopNavigation(false);
  removeRouteLayers();

  if (destinationMarker) {
    map.removeLayer(destinationMarker);
    destinationMarker = null;
  }

  destination = null;
  availableRoutes = [];
  routeSteps = [];
  selectedRouteIndex = 0;

  $("destinationInput").value = "";
  $("searchResults").replaceChildren();
  $("routeOptions").replaceChildren();
  $("tripInfo").hidden = true;
  $("navigationInfo").hidden = true;
  setStatus("تم مسح الرحلة. ابحث عن وجهة جديدة.");
}

$("clearButton").addEventListener("click", clearTrip);

function getManeuverText(step) {
  const maneuver = step.maneuver || {};
  const type = maneuver.type || "";
  const modifier = maneuver.modifier || "";
  const road = step.name ? ` باتجاه ${step.name}` : "";

  if (type === "arrive") return "وصلت إلى وجهتك.";
  if (type === "depart") return `ابدأ السير${road}.`;
  if (type === "roundabout" || type === "rotary") return `ادخل الدوار${road}.`;
  if (type === "merge") return `اندمج مع الطريق${road}.`;
  if (type === "fork") return `خذ التفرع ${modifier}${road}.`;
  if (type === "end of road") return `بنهاية الطريق انعطف ${modifier}${road}.`;
  if (type === "turn") return `انعطف ${modifier || "حسب الطريق"}${road}.`;
  if (type === "new name" || type === "continue") return `استمر بالطريق${road}.`;
  return `استمر بحذر${road}.`;
}

function speak(text) {
  if (!settings.voiceEnabled || !("speechSynthesis" in window)) return;

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ar-IQ";
  utterance.rate = Number(settings.voiceSpeed) || 0.9;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

$("startButton").addEventListener("click", async () => {
  if (!destination || !availableRoutes[selectedRouteIndex]) {
    setStatus("ابحث عن وجهتك واحسب الطريق أولاً.");
    return;
  }

  try {
    if (!currentPosition) await getCurrentLocation();
    if (!navigator.geolocation) throw new Error("المتصفح ما يدعم تحديد الموقع.");

    stopNavigation(false);
    navigationActive = true;
    nextStepIndex = 0;
    announcedSteps = new Set();

    $("navigationInfo").hidden = false;
    $("startButton").hidden = true;
    $("stopButton").hidden = false;
    setStatus("بدأت الملاحة. خلي الموقع مفعّل واسمح بالوصول إليه.");

    if (routeSteps.length) {
      const instruction = getManeuverText(routeSteps[0]);
      $("nextInstruction").textContent = instruction;
      speak("بدأت الملاحة. " + instruction);
    }

    await updateWakeLock();

    navigationWatchId = navigator.geolocation.watchPosition(
      onPositionUpdate,
      () => setStatus("تعذر تحديث موقعك. تأكد من تفعيل GPS وصلاحية الموقع."),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
  } catch (error) {
    setStatus(error.message || "تعذر بدء الملاحة.");
  }
});

function distanceBetween(lat1, lon1, lat2, lon2) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const earthRadius = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function onPositionUpdate(position) {
  if (!navigationActive) return;

  currentPosition = {
    lat: position.coords.latitude,
    lon: position.coords.longitude
  };
  updateCurrentMarker();

  if (destination) {
    const remaining = distanceBetween(
      currentPosition.lat, currentPosition.lon,
      destination.lat, destination.lon
    );

    if (remaining < 40) {
      $("nextInstruction").textContent = "وصلت تقريباً إلى وجهتك.";
      speak("وصلت تقريباً إلى وجهتك.");
      stopNavigation(false);
      setStatus("انتهت الملاحة. تأكد من المكان حولك.");
      return;
    }
  }

  updateNavigationInstruction();
}

function updateNavigationInstruction() {
  if (!routeSteps.length || !currentPosition) return;

  while (nextStepIndex < routeSteps.length) {
    const step = routeSteps[nextStepIndex];
    const location = step.maneuver?.location;

    if (!location) {
      nextStepIndex++;
      continue;
    }

    const distance = distanceBetween(
      currentPosition.lat, currentPosition.lon,
      location[1], location[0]
    );

    if (distance < 35) {
      if (!announcedSteps.has(nextStepIndex)) {
        const instruction = getManeuverText(step);
        $("nextInstruction").textContent = instruction;
        speak(instruction);
        announcedSteps.add(nextStepIndex);
      }
      nextStepIndex++;
    } else {
      const instruction = getManeuverText(step);
      $("nextInstruction").textContent =
        `${instruction} — بعد ${formatDistance(distance)}`;
      break;
    }
  }

  if (nextStepIndex >= routeSteps.length && destination) {
    $("nextInstruction").textContent = "تابع إلى وجهتك.";
  }
}

function stopNavigation(showMessage = true) {
  navigationActive = false;

  if (navigationWatchId !== null) {
    navigator.geolocation.clearWatch(navigationWatchId);
    navigationWatchId = null;
  }

  if ("speechSynthesis" in window) window.speechSynthesis.cancel();

  $("startButton").hidden = false;
  $("stopButton").hidden = true;

  if (!settings.keepScreenOn) updateWakeLock();
  if (showMessage) setStatus("تم إيقاف الملاحة.");
}

$("stopButton").addEventListener("click", () => {
  stopNavigation(true);
  $("navigationInfo").hidden = true;
});

function saveCurrentDestination(key) {
  if (!destination) {
    setStatus("ابحث عن وجهة واختارها أولاً حتى تحفظها.");
    closeSettings();
    return;
  }

  savePlace(key, { ...destination });
  updateSavedPlaceLabels();
  setStatus(key === "darbHome" ? "تم حفظ عنوان المنزل." : "تم حفظ عنوان العمل.");
}

$("saveHomeButton").addEventListener("click", () => saveCurrentDestination("darbHome"));
$("saveWorkButton").addEventListener("click", () => saveCurrentDestination("darbWork"));

async function goToSavedPlace(key) {
  const place = loadSavedPlace(key);

  if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) {
    setStatus("ماكو عنوان محفوظ. احفظ وجهة أولاً من الإعدادات.");
    return;
  }

  destination = { ...place };

  if (destinationMarker) map.removeLayer(destinationMarker);
  destinationMarker = L.marker([destination.lat, destination.lon])
    .addTo(map)
    .bindPopup(escapeHtml(destination.name));

  $("destinationInput").value = destination.name;
  closeSettings();

  try {
    if (!currentPosition) await getCurrentLocation();
    await calculateRoute();
  } catch (error) {
    setStatus(error.message || "تعذر حساب الطريق إلى العنوان المحفوظ.");
  }
}

$("goHomeButton").addEventListener("click", () => goToSavedPlace("darbHome"));
$("goWorkButton").addEventListener("click", () => goToSavedPlace("darbWork"));

syncSettingsUI();
getCurrentLocation()
  .then(() => setStatus("الخريطة جاهزة. ابحث عن وجهتك حتى نحسب الطريق."))
  .catch(() => setStatus("الخريطة جاهزة. فعّل صلاحية الموقع لحساب المسار من مكانك."));