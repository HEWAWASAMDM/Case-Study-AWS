(function () {
  // ---- CONFIG ----
  const INGESTION_API = "http://108.131.159.52:30081/events"; 
  // ^ placeholder for now — will become the K8s service URL after Step 8.5

  // ---- SESSION ID ----
  // Persists per browser tab visit so we can group events from the same visitor
  function getSessionId() {
    let sid = sessionStorage.getItem("analytics_session_id");
    if (!sid) {
      sid = "sess-" + Date.now() + "-" + Math.random().toString(36).substr(2, 9);
      sessionStorage.setItem("analytics_session_id", sid);
    }
    return sid;
  }

  const SESSION_ID = getSessionId();
  const DEVICE_TYPE = /Mobi|Android/i.test(navigator.userAgent) ? "mobile" : "desktop";

  // ---- SEND FUNCTION ----
  function sendEvent(payload) {
    const body = JSON.stringify({
      session_id: SESSION_ID,
      page_url: window.location.pathname,
      device_type: DEVICE_TYPE,
      referrer: document.referrer || "direct",
      section_name: "",
      time_spent_seconds: 0,
      track_name: "",
      ...payload,
    });

    // navigator.sendBeacon is preferred: works even if the user navigates away
    if (navigator.sendBeacon) {
      navigator.sendBeacon(INGESTION_API, new Blob([body], { type: "application/json" }));
    } else {
      fetch(INGESTION_API, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true });
    }
  }

  // ---- METRIC 1: PAGE VIEW ----
  window.addEventListener("load", function () {
    sendEvent({ event_type: "page_view" });
  });

  // ---- METRIC 2: SECTION ENGAGEMENT TIME ----
  const sectionTimers = {};
  const sections = document.querySelectorAll("section[id]");

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const id = entry.target.id;
        if (entry.isIntersecting) {
          sectionTimers[id] = Date.now();
        } else if (sectionTimers[id]) {
          const seconds = (Date.now() - sectionTimers[id]) / 1000;
          if (seconds > 1) { // ignore accidental flicker-scrolls
            sendEvent({
              event_type: "section_view",
              section_name: id,
              time_spent_seconds: Math.round(seconds * 10) / 10,
            });
          }
          delete sectionTimers[id];
        }
      });
    },
    { threshold: 0.4 } // fires once 40% of the section is visible
  );

  sections.forEach((section) => observer.observe(section));

  // ---- METRIC 3: PROGRAM TRACK INTEREST ----
  document.querySelectorAll('#program .nav-tabs a[data-toggle="tab"]').forEach((tab) => {
    tab.addEventListener("click", function () {
      sendEvent({
        event_type: "track_click",
        track_name: this.textContent.trim(),
        section_name: "program",
      });
    });
  });

  // ---- METRIC 4: REGISTRATION INTENT ----
  const registerBtn = document.querySelector('#register form input[type="submit"]');
  if (registerBtn) {
    registerBtn.addEventListener("click", function () {
      sendEvent({
        event_type: "register_click",
        section_name: "register",
      });
    });
  }
})();
