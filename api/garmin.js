// api/garmin.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email, password, workouts } = req.body || {};
  if (!email || !password || !workouts?.length) {
    return res.status(400).json({ error: "email, password en workouts zijn verplicht" });
  }

  try {
    const cookies = await garminLogin(email, password);
    let uploaded = 0;
    const errors = [];
    for (const workout of workouts) {
      try {
        const workoutId = await createWorkout(cookies, workout);
        if (workout.scheduledDate) await scheduleWorkout(cookies, workoutId, workout.scheduledDate);
        uploaded++;
      } catch (e) {
        errors.push(e.message);
      }
    }
    return res.status(200).json({ success: true, uploaded, errors });
  } catch (e) {
    return res.status(200).json({ success: false, error: e.message });
  }
}

async function garminLogin(email, password) {
  const SERVICE = "https://connect.garmin.com/modern/";
  const SSO = "https://sso.garmin.com/sso/signin";
  const params = new URLSearchParams({
    service: SERVICE, webhost: "olaxpw-conctmodern", source: SERVICE,
    redirectAfterAccountLoginUrl: SERVICE, redirectAfterAccountCreationUrl: SERVICE,
    gauthHost: SSO, locale: "nl_NL", id: "gauth-widget", clientId: "GarminConnect",
    rememberMeShown: "true", rememberMeChecked: "false", createAccountShown: "true",
    openCreateAccount: "false", consumeServiceTicket: "false", initialFocus: "true",
    embedWidget: "false", generateExtraServiceTicket: "true",
    generateTwoExtraServiceTickets: "false", generateNoServiceTicket: "false",
    globalOptInShown: "true", globalOptInChecked: "false", mobile: "false",
    connectLegalTerms: "true", showTermsOfUse: "false", showPrivacyPolicy: "false",
    showConnectLegalAge: "false", locationPromptShown: "true", showPassword: "true",
    useCustomHeader: "false", mfaRequired: "false", performMFACheck: "false",
    rememberMyBrowserShown: "false", rememberMyBrowserChecked: "false"
  });
  const ssoUrl = `${SSO}?${params}`;
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // Stap 1: CSRF token ophalen
  const initResp = await fetch(ssoUrl, {
    headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "nl-NL,nl;q=0.9" }
  });
  const html = await initResp.text();
  const csrfMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
  const csrf = csrfMatch ? csrfMatch[1] : "";
  const initCookies = parseCookieHeader(initResp.headers.get("set-cookie") || "");

  // Stap 2: Inloggen
  const loginResp = await fetch(ssoUrl, {
    method: "POST",
    headers: {
      "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": initCookies, "Origin": "https://sso.garmin.com", "Referer": ssoUrl,
      "Accept": "text/html,application/xhtml+xml", "Accept-Language": "nl-NL,nl;q=0.9"
    },
    body: new URLSearchParams({ username: email, password, embed: "false", _csrf: csrf }).toString(),
    redirect: "manual"
  });

  const location = loginResp.headers.get("location") || "";
  const ticketMatch = location.match(/ticket=([^&]+)/);
  if (!ticketMatch) throw new Error("Login mislukt — controleer e-mail en wachtwoord");

  const ticket = ticketMatch[1];
  const loginCookies = mergeCookies(initCookies, parseCookieHeader(loginResp.headers.get("set-cookie") || ""));

  // Stap 3: Ticket inwisselen
  const connectResp = await fetch(`${SERVICE}?ticket=${ticket}`, {
    headers: { "User-Agent": UA, "Cookie": loginCookies, "Accept": "text/html,application/xhtml+xml" },
    redirect: "manual"
  });
  const allCookies = mergeCookies(loginCookies, parseCookieHeader(connectResp.headers.get("set-cookie") || ""));

  if (allCookies.length < 10) throw new Error("Sessie aanmaken mislukt");
  return allCookies;
}

function parseCookieHeader(header) {
  if (!header) return "";
  return header.split(/,(?=[^ ].*?=)/).map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");
}

function mergeCookies(existing, newCookies) {
  const map = {};
  for (const part of (existing + "; " + newCookies).split("; ")) {
    const idx = part.indexOf("=");
    if (idx > 0) map[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function createWorkout(cookieString, workout) {
  const sportTypeMap = {
    running: { sportTypeId: 1, sportTypeKey: "running" },
    cycling: { sportTypeId: 2, sportTypeKey: "cycling" },
    swimming: { sportTypeId: 5, sportTypeKey: "swimming" },
    strength_training: { sportTypeId: 4, sportTypeKey: "strength_training" },
    cardio: { sportTypeId: 26, sportTypeKey: "cardio" },
    yoga: { sportTypeId: 43, sportTypeKey: "yoga" },
    walking: { sportTypeId: 3, sportTypeKey: "walking" }
  };
  const stepTypeMap = { warmup: 1, cooldown: 2, interval: 3, recovery: 4, rest: 5, other: 7 };
  const sport = sportTypeMap[workout.sport] || sportTypeMap.running;
  const steps = (workout.steps || []).map((step, i) => {
    const s = {
      stepId: i + 1, stepOrder: i + 1,
      stepType: { stepTypeId: stepTypeMap[step.type] || 3, stepTypeKey: step.type || "interval" },
      endCondition: {
        conditionTypeId: step.durationType === "distance" ? 3 : 2,
        conditionTypeKey: step.durationType === "distance" ? "distance" : "time",
        conditionValue: step.durationValue || 600, conditionValueType: null
      },
      endConditionValue: step.durationValue || 600
    };
    if (step.target?.type === "heart.rate.zone") {
      s.targetType = { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone" };
      s.targetValueOne = step.target.zoneNumber || 2;
      s.targetValueTwo = null;
    } else {
      s.targetType = { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" };
      s.targetValueOne = null; s.targetValueTwo = null;
    }
    return s;
  });

  const body = {
    sportType: sport, subSportType: null,
    workoutName: workout.workoutName || "Training",
    description: workout.description || "",
    estimatedDurationInSecs: steps.reduce((a, s) => a + (s.endConditionValue || 0), 0),
    estimatedDistanceInMeters: null,
    workoutSegments: [{ segmentOrder: 1, sportType: sport, workoutSteps: steps }]
  };

  const resp = await fetch("https://connect.garmin.com/workout-service/workout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "Cookie": cookieString, "NK": "NT",
      "X-App-Ver": "4.73.1.0",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "application/json", "Origin": "https://connect.garmin.com",
      "Referer": "https://connect.garmin.com/modern/workout/create/running"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => String(resp.status));
    throw new Error(`Workout aanmaken mislukt (${resp.status}): ${err.slice(0, 120)}`);
  }
  const data = await resp.json();
  return data.workoutId;
}

async function scheduleWorkout(cookieString, workoutId, date) {
  const resp = await fetch(`https://connect.garmin.com/workout-service/schedule/${workoutId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "Cookie": cookieString, "NK": "NT",
      "X-App-Ver": "4.73.1.0",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "application/json", "Origin": "https://connect.garmin.com"
    },
    body: JSON.stringify({ date })
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => String(resp.status));
    throw new Error(`Inplannen mislukt (${resp.status}): ${err.slice(0, 80)}`);
  }
  return true;
}
