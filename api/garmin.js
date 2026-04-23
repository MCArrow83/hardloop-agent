// api/garmin.js
// Uploadt workouts naar Garmin Connect via de inofficiële sessie-API
// Credentials worden alleen tijdens de request gebruikt en nooit opgeslagen

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email, password, workouts } = req.body;
  if (!email || !password || !workouts?.length) {
    return res.status(400).json({ error: "email, password en workouts zijn verplicht" });
  }

  try {
    // Stap 1: Login bij Garmin SSO
    const token = await garminLogin(email, password);

    // Stap 2: Upload elke workout
    let uploaded = 0;
    const errors = [];
    for (const workout of workouts) {
      try {
        const workoutId = await createWorkout(token, workout);
        if (workout.scheduledDate) {
          await scheduleWorkout(token, workoutId, workout.scheduledDate);
        }
        uploaded++;
      } catch (e) {
        errors.push(e.message);
      }
    }

    res.json({ success: true, uploaded, errors });
  } catch (e) {
    res.status(401).json({ success: false, error: e.message });
  }
}

// --- Garmin SSO login ---
async function garminLogin(email, password) {
  const SSO_URL = "https://sso.garmin.com/sso/signin";
  const SERVICE_URL = "https://connect.garmin.com/modern/";

  // Stap 1a: Haal CSRF token op
  const initResp = await fetch(`${SSO_URL}?service=${encodeURIComponent(SERVICE_URL)}&webhost=olaxpw-conctmodern&source=${encodeURIComponent(SERVICE_URL)}&redirectAfterAccountLoginUrl=${encodeURIComponent(SERVICE_URL)}&redirectAfterAccountCreationUrl=${encodeURIComponent(SERVICE_URL)}&gauthHost=${encodeURIComponent(SSO_URL)}&locale=nl_NL&id=gauth-widget&cssUrl=https://static.garmincdn.com/com.garmin.connect/ui/css/gauth-custom-v1.2-min.css&clientId=GarminConnect&rememberMeShown=true&rememberMeChecked=false&createAccountShown=true&openCreateAccount=false&displayNameShown=false&consumeServiceTicket=false&initialFocus=true&embedWidget=false&generateExtraServiceTicket=true&generateTwoExtraServiceTickets=false&generateNoServiceTicket=false&displayNameShown=false&globalOptInShown=true&globalOptInChecked=false&mobile=false&connectLegalTerms=true&showTermsOfUse=false&showPrivacyPolicy=false&showConnectLegalAge=false&locationPromptShown=true&showPassword=true&useCustomHeader=false&mfaRequired=false&performMFACheck=false&rememberMyBrowserShown=false&rememberMyBrowserChecked=false`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "text/html,application/xhtml+xml",
    }
  });

  const initHtml = await initResp.text();
  const csrfMatch = initHtml.match(/name="_csrf"\s+value="([^"]+)"/);
  const csrf = csrfMatch ? csrfMatch[1] : "";
  const cookies = initResp.headers.get("set-cookie") || "";

  // Stap 1b: POST login
  const loginBody = new URLSearchParams({
    username: email,
    password: password,
    embed: "false",
    _csrf: csrf
  });

  const loginResp = await fetch(`${SSO_URL}?service=${encodeURIComponent(SERVICE_URL)}&webhost=olaxpw-conctmodern&source=${encodeURIComponent(SERVICE_URL)}&redirectAfterAccountLoginUrl=${encodeURIComponent(SERVICE_URL)}&redirectAfterAccountCreationUrl=${encodeURIComponent(SERVICE_URL)}&gauthHost=${encodeURIComponent(SSO_URL)}&locale=nl_NL&id=gauth-widget&cssUrl=https://static.garmincdn.com/com.garmin.connect/ui/css/gauth-custom-v1.2-min.css&clientId=GarminConnect&rememberMeShown=true&rememberMeChecked=false&createAccountShown=true&openCreateAccount=false&displayNameShown=false&consumeServiceTicket=false&initialFocus=true&embedWidget=false&generateExtraServiceTicket=true&generateTwoExtraServiceTickets=false&generateNoServiceTicket=false&displayNameShown=false&globalOptInShown=true&globalOptInChecked=false&mobile=false&connectLegalTerms=true&showTermsOfUse=false&showPrivacyPolicy=false&showConnectLegalAge=false&locationPromptShown=true&showPassword=true&useCustomHeader=false&mfaRequired=false&performMFACheck=false&rememberMyBrowserShown=false&rememberMyBrowserChecked=false`, {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": cookies,
      "Origin": "https://sso.garmin.com",
      "Referer": SSO_URL
    },
    body: loginBody.toString(),
    redirect: "manual"
  });

  // Haal ticket uit redirect
  const location = loginResp.headers.get("location") || "";
  const ticketMatch = location.match(/ticket=([^&]+)/);
  if (!ticketMatch) throw new Error("Login mislukt — controleer e-mail en wachtwoord");

  const ticket = ticketMatch[1];
  const loginCookies = loginResp.headers.get("set-cookie") || "";

  // Stap 1c: Wissel ticket voor Connect sessie
  const connectResp = await fetch(`${SERVICE_URL}?ticket=${ticket}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Cookie": loginCookies
    },
    redirect: "manual"
  });

  const connectCookies = connectResp.headers.get("set-cookie") || "";
  const allCookies = [loginCookies, connectCookies].filter(Boolean).join("; ");

  // Haal GARMIN-JWT of session cookie op
  const sessionMatch = allCookies.match(/GARMIN-SSO-GUID=([^;,]+)/);
  if (!sessionMatch) throw new Error("Sessie ophalen mislukt");

  return allCookies; // Return alle cookies als auth token
}

// --- Maak workout aan in Garmin Connect ---
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

  const stepTypeMap = {
    warmup: 1, interval: 3, recovery: 4, cooldown: 2, rest: 5, other: 7
  };

  const sport = sportTypeMap[workout.sport] || sportTypeMap.running;

  const steps = (workout.steps || []).map((step, i) => {
    const base = {
      stepId: i + 1,
      stepOrder: i + 1,
      stepType: { stepTypeId: stepTypeMap[step.type] || 3, stepTypeKey: step.type },
      endCondition: {
        conditionTypeId: step.durationType === "distance" ? 3 : 2,
        conditionTypeKey: step.durationType === "distance" ? "distance" : "time",
        conditionValue: step.durationValue,
        conditionValueType: null
      },
      endConditionValue: step.durationValue
    };

    // Target
    if (step.target?.type === "heart.rate.zone") {
      base.targetType = { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone" };
      base.targetValueOne = step.target.zoneNumber;
      base.targetValueTwo = null;
    } else if (step.target?.type === "pace.zone") {
      base.targetType = { workoutTargetTypeId: 6, workoutTargetTypeKey: "pace.zone" };
      base.targetValueOne = step.target.zoneNumber;
      base.targetValueTwo = null;
    } else {
      base.targetType = { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" };
      base.targetValueOne = null;
      base.targetValueTwo = null;
    }

    return base;
  });

  const body = {
    sportType: sport,
    subSportType: null,
    workoutName: workout.workoutName,
    description: workout.description || "",
    estimatedDurationInSecs: steps.reduce((acc, s) => acc + (s.endConditionValue || 0), 0),
    estimatedDistanceInMeters: null,
    workoutSegments: [{
      segmentOrder: 1,
      sportType: sport,
      workoutSteps: steps
    }]
  };

  const resp = await fetch("https://connect.garmin.com/workout-service/workout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": cookieString,
      "NK": "NT",
      "X-App-Ver": "4.73.1.0",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Workout aanmaken mislukt (${resp.status}): ${err.slice(0, 100)}`);
  }

  const data = await resp.json();
  return data.workoutId;
}

// --- Plan workout op een datum ---
async function scheduleWorkout(cookieString, workoutId, date) {
  const body = { date };

  const resp = await fetch(`https://connect.garmin.com/workout-service/schedule/${workoutId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": cookieString,
      "NK": "NT",
      "X-App-Ver": "4.73.1.0",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) throw new Error(`Inplannen mislukt (${resp.status})`);
  return await resp.json();
}
