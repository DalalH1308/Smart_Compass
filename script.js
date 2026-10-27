/* ===== Smart Compass – לוגיקה =====
 * JavaScript רגיל, ללא שרת וללא מפתח API.
 * מקורות כיוון מוחלט (ביחס לצפון המגנטי):
 *   1. iOS Safari:  event.webkitCompassHeading
 *   2. Android Chrome: אירוע deviceorientationabsolute (alpha מוחלט)
 *   3. דפדפנים אחרים: deviceorientation עם event.absolute === true
 * נתון יחסי (absolute=false) לעולם אינו מוצג כצפון אמיתי.
 */
(function () {
  'use strict';

  const DIRECTIONS = ['צפון', 'צפון-מזרח', 'מזרח', 'דרום-מזרח', 'דרום', 'דרום-מערב', 'מערב', 'צפון-מערב'];
  const NO_DATA_TIMEOUT_MS = 4000; // זמן המתנה לנתון מוחלט לפני הצגת הודעת שגיאה
  const SMOOTHING = 0.35;          // החלקת רעידות החיישן (1 = ללא החלקה)

  // הפניות לאלמנטים
  const $ = (id) => document.getElementById(id);
  const els = {
    card: $('compassCard'),
    dial: $('dial'),
    ticks: $('ticks'),
    degrees: $('degrees'),
    direction: $('directionText'),
    status: $('status'),
    badge: $('modeBadge'),
    startBtn: $('startBtn'),
    demoToggle: $('demoToggle'),
    demoSlider: $('demoSlider'),
    demoValue: $('demoValue'),
    watermark: $('demoWatermark'),
  };

  const state = {
    mode: 'idle',          // idle | sensor | demo
    listening: false,
    gotAbsolute: false,
    sawRelative: false,
    rotation: 0,           // סיבוב מצטבר של החוגה (למניעת "קפיצה" במעבר 359°→0°)
    pendingHeading: null,
    rafId: null,
    timeoutId: null,
  };

  /* ---------- בניית שנתות החוגה ---------- */
  function buildTicks() {
    const ns = 'http://www.w3.org/2000/svg';
    const cx = 150, cy = 150;
    for (let deg = 0; deg < 360; deg += 5) {
      const major = deg % 30 === 0;
      const rad = (deg * Math.PI) / 180;
      const r1 = 140, r2 = major ? 124 : 132;
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', cx + r1 * Math.sin(rad));
      line.setAttribute('y1', cy - r1 * Math.cos(rad));
      line.setAttribute('x2', cx + r2 * Math.sin(rad));
      line.setAttribute('y2', cy - r2 * Math.cos(rad));
      line.setAttribute('class', major ? 'tick tick-major' : 'tick');
      els.ticks.appendChild(line);

      // מספרי מעלות כל 30°, למעט נקודות הרוח הראשיות
      if (major && deg % 90 !== 0) {
        const t = document.createElementNS(ns, 'text');
        t.setAttribute('x', cx + 113 * Math.sin(rad));
        t.setAttribute('y', cy - 113 * Math.cos(rad));
        t.setAttribute('class', 'tick-num');
        t.textContent = deg;
        els.ticks.appendChild(t);
      }
    }
  }

  /* ---------- עזרי תצוגה ---------- */
  const normalize = (deg) => ((deg % 360) + 360) % 360;
  const headingToText = (h) => DIRECTIONS[Math.round(h / 45) % 8];

  function setStatus(type, message) {
    els.status.className = 'status status-' + type;
    els.status.textContent = message;
  }

  function setMode(mode) {
    state.mode = mode;
    const badges = {
      idle: ['mode-idle', 'המצפן אינו פעיל'],
      sensor: ['mode-sensor', '● נתון חיישן אמיתי · צפון מגנטי'],
      demo: ['mode-demo', '⚠ מצב הדגמה – אינו נתון חיישן אמיתי'],
    };
    els.badge.className = 'mode-badge ' + badges[mode][0];
    els.badge.textContent = badges[mode][1];
    els.card.classList.toggle('is-demo', mode === 'demo');
    els.watermark.hidden = mode !== 'demo';
    els.startBtn.classList.toggle('is-running', mode === 'sensor' || state.listening);
    els.startBtn.textContent = state.listening ? 'עצור מצפן' : 'הפעל מצפן';
  }

  function clearReadout() {
    els.degrees.textContent = '--°';
    els.direction.textContent = '—';
  }

  // מסובב את החוגה בכיוון ההפוך לכיוון הטלפון, כך שהצפון בחוגה מצביע לצפון האמיתי
  function render(heading, smooth) {
    const target = -heading;
    const delta = normalize(target - state.rotation + 180) - 180; // הדרך הקצרה ביותר
    state.rotation += smooth ? delta * SMOOTHING : delta;
    els.dial.style.transform = 'rotate(' + state.rotation + 'deg)';

    const shown = Math.round(heading) % 360;
    els.degrees.textContent = shown + '°';
    els.direction.textContent = headingToText(heading);
  }

  // עדכון אחד לכל פריים – חוסך עבודה כשהחיישן שולח אירועים בקצב גבוה
  function scheduleRender(heading) {
    state.pendingHeading = heading;
    if (state.rafId) return;
    state.rafId = requestAnimationFrame(() => {
      state.rafId = null;
      if (state.mode === 'sensor' && state.pendingHeading !== null) {
        render(state.pendingHeading, true);
      }
    });
  }

  // זווית סיבוב המסך (לאורך/לרוחב) לתיקון הכיוון
  function screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    if (typeof window.orientation === 'number') return window.orientation;
    return 0;
  }

  /* ---------- טיפול באירועי חיישן ---------- */
  function onOrientation(e) {
    let heading = null;
    let source = '';

    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      // iOS: כבר בכיוון השעון ביחס לצפון המגנטי
      heading = e.webkitCompassHeading;
      source = 'iOS · webkitCompassHeading';
    } else if ((e.type === 'deviceorientationabsolute' || e.absolute === true) && typeof e.alpha === 'number') {
      // alpha גדל נגד כיוון השעון, לכן הופכים אותו לכיוון מצפן
      heading = 360 - e.alpha;
      source = e.type === 'deviceorientationabsolute' ? 'deviceorientationabsolute' : 'deviceorientation (absolute)';
    } else if (typeof e.alpha === 'number') {
      // נתון יחסי בלבד – אינו מייצג צפון, ולכן לא מוצג
      state.sawRelative = true;
      return;
    } else {
      return; // אירוע ריק (נפוץ במחשבים ללא חיישנים)
    }

    heading = normalize(heading + screenAngle());

    if (!state.gotAbsolute) {
      state.gotAbsolute = true;
      clearTimeout(state.timeoutId);
      setMode('sensor');
      setStatus('success', 'המצפן פעיל. מקור הנתונים: ' + source + '. החזיקו את הטלפון שטוח לקבלת קריאה מדויקת.');
    }

    // ב-iOS ניתן לזהות דיוק נמוך ולהמליץ על כיול
    if (typeof e.webkitCompassAccuracy === 'number' && e.webkitCompassAccuracy > 30) {
      setStatus('warn', 'דיוק המצפן נמוך (±' + Math.round(e.webkitCompassAccuracy) + '°). כיילו בתנועת "שמונה" והתרחקו ממתכות.');
    }

    scheduleRender(heading);
  }

  function addListeners() {
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', onOrientation);
    }
    window.addEventListener('deviceorientation', onOrientation);
    state.listening = true;
  }

  function removeListeners() {
    window.removeEventListener('deviceorientationabsolute', onOrientation);
    window.removeEventListener('deviceorientation', onOrientation);
    clearTimeout(state.timeoutId);
    state.listening = false;
    state.gotAbsolute = false;
    state.sawRelative = false;
  }

  /* ---------- הפעלה / עצירה ---------- */
  async function startCompass() {
    disableDemo();

    // חיישני התנועה זמינים רק בהקשר מאובטח (HTTPS או localhost)
    if (!window.isSecureContext) {
      setStatus('error', 'האתר נטען ללא HTTPS ולכן הדפדפן חוסם את החיישנים. פתחו אותו בכתובת https:// (למשל GitHub Pages).');
      return;
    }
    if (!('DeviceOrientationEvent' in window)) {
      setStatus('error', 'הדפדפן או המכשיר אינם תומכים ב-DeviceOrientation API. נסו בטלפון עם דפדפן עדכני, או השתמשו במצב ההדגמה.');
      return;
    }

    // iOS 13+: יש לבקש הרשאה במפורש, ורק בתגובה ללחיצה
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const result = await DeviceOrientationEvent.requestPermission();
        if (result !== 'granted') {
          setStatus('error', 'ההרשאה לחיישני התנועה נדחתה. כדי לאפשר: סגרו את הלשונית ופתחו אותה מחדש, ואשרו את הבקשה. ניתן גם לבדוק בהגדרות Safari.');
          return;
        }
      } catch (err) {
        setStatus('error', 'לא ניתן לבקש הרשאה לחיישנים: ' + (err && err.message ? err.message : err));
        return;
      }
    }

    addListeners();
    setMode('idle');
    els.startBtn.textContent = 'עצור מצפן';
    els.startBtn.classList.add('is-running');
    clearReadout();
    setStatus('info', 'ממתין לנתוני כיוון מהחיישן…');

    // אם לא התקבל נתון מוחלט בזמן סביר – מסבירים למה
    state.timeoutId = setTimeout(() => {
      if (state.gotAbsolute || !state.listening) return;
      if (state.sawRelative) {
        setStatus('warn', 'המכשיר מספק רק נתוני סיבוב יחסיים, ללא התייחסות לצפון. כדי לא להטעות – הכיוון אינו מוצג. נסו דפדפן אחר (Chrome באנדרואיד / Safari באייפון) או השתמשו במצב ההדגמה.');
      } else {
        setStatus('error', 'לא התקבלו נתונים מהחיישן. ייתכן שהמכשיר (למשל מחשב) אינו כולל מצפן, או שהגישה לחיישנים חסומה בהגדרות הדפדפן.');
      }
    }, NO_DATA_TIMEOUT_MS);
  }

  function stopCompass() {
    removeListeners();
    setMode('idle');
    clearReadout();
    setStatus('info', 'המצפן הופסק. לחצו על "הפעל מצפן" כדי להפעיל מחדש.');
  }

  /* ---------- מצב הדגמה ---------- */
  function enableDemo() {
    if (state.listening) removeListeners();
    els.demoSlider.disabled = false;
    setMode('demo');
    setStatus('warn', 'מצב הדגמה פעיל: הכיוון נקבע ידנית בסליידר ואינו נתון חיישן אמיתי.');
    updateDemo();
  }

  function disableDemo() {
    if (state.mode !== 'demo') return;
    els.demoToggle.checked = false;
    els.demoSlider.disabled = true;
    setMode('idle');
    clearReadout();
  }

  function updateDemo() {
    const value = Number(els.demoSlider.value);
    els.demoValue.textContent = value + '°';
    if (state.mode === 'demo') render(value, false);
  }

  /* ---------- חיבור אירועי ממשק ---------- */
  els.startBtn.addEventListener('click', () => {
    if (state.listening) stopCompass();
    else startCompass();
  });

  els.demoToggle.addEventListener('change', () => {
    if (els.demoToggle.checked) {
      enableDemo();
    } else {
      disableDemo();
      setStatus('info', 'מצב ההדגמה כובה. לחצו על "הפעל מצפן" לשימוש בחיישן האמיתי.');
    }
  });

  els.demoSlider.addEventListener('input', updateDemo);

  // הודעה מוקדמת אם האתר אינו מאובטח
  if (!window.isSecureContext) {
    setStatus('warn', 'שימו לב: האתר נטען ללא HTTPS. החיישנים יעבדו רק בכתובת https:// או ב-localhost. מצב ההדגמה זמין גם כך.');
  }

  buildTicks();
})();
